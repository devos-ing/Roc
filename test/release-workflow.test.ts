import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

type WorkflowStep = {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
};

type ReleaseJob = {
  permissions?: unknown;
  steps?: WorkflowStep[];
};

type ReleaseWorkflow = {
  jobs?: Record<string, ReleaseJob>;
  on?: { push?: { tags?: string[] } };
  permissions?: Record<string, string>;
};

/** Reads a repository file relative to the project root. */
async function readProjectFile(path: string): Promise<string> {
  return readFile(resolve(projectRoot, path), "utf8");
}

/** Parses the release workflow at its YAML boundary. */
function parseReleaseWorkflow(source: string): ReleaseWorkflow {
  return Bun.YAML.parse(source) as ReleaseWorkflow;
}

/** Returns the one release job, failing clearly if its required steps are absent. */
function releaseSteps(workflow: ReleaseWorkflow): WorkflowStep[] {
  const steps = workflow.jobs?.release?.steps;
  if (!steps) {
    throw new Error("Release workflow must define release job steps");
  }
  return steps;
}

/** Finds a release step by its stable name. */
function stepNamed(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Release workflow is missing step: ${name}`);
  }
  return step;
}

/** Returns a named step's required shell script. */
function stepRun(steps: WorkflowStep[], name: string): string {
  const run = stepNamed(steps, name).run;
  if (!run) {
    throw new Error(`Release workflow step has no run script: ${name}`);
  }
  return run;
}

test("release workflow keeps the stable-tag, immutable-action, and ordered-release contract", async () => {
  const source = await readProjectFile(".github/workflows/release.yml");
  const workflow = parseReleaseWorkflow(source);
  const steps = releaseSteps(workflow);

  expect(workflow.on).toEqual({ push: { tags: ["v*.*.*"] } });
  expect(workflow.permissions).toEqual({
    contents: "write",
    "id-token": "write",
  });
  expect(
    Object.values(workflow.jobs ?? {}).every((job) => !job.permissions),
  ).toBe(true);
  expect(steps.map((step) => step.name)).toEqual([
    "Check out tagged source",
    "Set up Node and npm registry",
    "Install trusted-publishing npm CLI",
    "Set up Bun",
    "Validate tag and package version",
    "Install locked dependencies",
    "Run release checks",
    "Pack tagged source",
    "Check npm publication state",
    "Publish package through npm OIDC",
    "Verify published package integrity",
    "Create GitHub Release",
  ]);
  expect(steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  ]);
  expect(
    steps
      .filter((step) => step.uses)
      .every((step) => step.uses?.match(/^[^@]+@[0-9a-f]{40}$/)),
  ).toBe(true);
  expect(stepNamed(steps, "Publish package through npm OIDC").if).toBe(
    "steps.registry.outputs.publish == 'true'",
  );
  expect(JSON.stringify(workflow)).not.toContain("NPM_TOKEN");

  const validation = stepRun(steps, "Validate tag and package version");
  expect(validation).toContain(
    'if [[ ! "$tag" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then',
  );
  expect(validation).toContain('if [[ "$tag" != "v$version" ]]; then');

  const registry = stepRun(steps, "Check npm publication state");
  expect(registry).toContain(
    'if published_integrity="$(npm view "roc-it@$VERSION" dist.integrity 2>"$error_file")"; then',
  );
  expect(registry).toContain('echo "publish=false" >> "$GITHUB_OUTPUT"');
  const integrityMismatch = registry.indexOf(
    'if [[ "$published_integrity" != "$EXPECTED_INTEGRITY" ]]; then',
  );
  const skipPublish = registry.indexOf(
    'echo "publish=false" >> "$GITHUB_OUTPUT"',
  );
  expect(integrityMismatch).toBeGreaterThanOrEqual(0);
  expect(registry.slice(integrityMismatch, skipPublish)).toContain("exit 1");
  expect(integrityMismatch).toBeLessThan(skipPublish);
  expect(registry).toContain('elif grep -q "E404" "$error_file"; then');
  expect(registry).toContain('echo "publish=true" >> "$GITHUB_OUTPUT"');
  expect(registry).toContain('else\n  cat "$error_file" >&2\n  exit 1');

  const verification = stepRun(steps, "Verify published package integrity");
  expect(verification).toContain('error_file="$(mktemp)"');
  expect(verification).toContain('2>"$error_file"');
  expect(verification).toContain("grep -Eq '\\bE(401|403)\\b' \"$error_file\"");
  expect(verification).toContain('cat "$error_file" >&2');
  expect(
    verification.indexOf("does not match the tagged archive"),
  ).toBeLessThan(verification.indexOf("sleep 5"));

  const release = stepRun(steps, "Create GitHub Release");
  expect(release.indexOf('gh release view "$GITHUB_REF_NAME"')).toBeLessThan(
    release.indexOf('gh release create "$GITHUB_REF_NAME"'),
  );
  expect(release).toContain("--generate-notes");

  const runScripts = steps.map((step) => step.run ?? "").join("\n");
  expect(runScripts.match(/\bnpm publish\b/g)).toHaveLength(1);
  expect(runScripts.match(/\bgh release create\b/g)).toHaveLength(1);
  expect(stepRun(steps, "Publish package through npm OIDC")).toContain(
    "npm publish --access public",
  );
  expect(release).toContain('gh release create "$GITHUB_REF_NAME"');
});

test("README leads with npx production commands and explains tagged releases", async () => {
  const readme = await readProjectFile("README.md");

  expect(readme.indexOf("npx roc-it@latest help")).toBeLessThan(
    readme.indexOf("bunx roc-it@latest help"),
  );
  expect(readme).toContain("npx roc-it@latest init");
  expect(readme).toContain("npx roc-it@latest task list");
  expect(readme).toContain("npx roc-it@latest tokens");
  expect(readme).toContain(
    "npx roc-it@latest scheduler run --backend codex --repo /absolute/path/to/project",
  );
  expect(readme).toContain("npm install -g roc-it@latest");
  const packageRunnerCommands =
    readme.match(/^(?:npx|bunx) roc-it(?:@\S+)?(?: .*)?$/gm) ?? [];
  expect(packageRunnerCommands.length).toBeGreaterThan(0);
  expect(
    packageRunnerCommands.every((command) =>
      /^(?:npx|bunx) roc-it@latest(?: |$)/.test(command),
    ),
  ).toBe(true);
  expect(readme).toContain(
    "Run without a global install (Roc still requires Bun at runtime):",
  );
  expect(readme).toContain("`bunx` as Bun's package runner");
  expect(readme).toContain("https://github.com/devos-ing/Roc/releases");
  expect(readme).toContain("commits `bun.lock` only if Bun changes it");
  expect(readme).toContain("git tag vX.Y.Z");
  expect(readme).toContain("git push origin vX.Y.Z");
});

test("README explains the agile Scout, Implement, Review loop", async () => {
  const readme = await readProjectFile("README.md");
  const start = readme.indexOf("## How it works");
  const end = readme.indexOf("## Commands", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const howItWorks = readme.slice(start, end);

  expect(howItWorks).toContain("Roc follows a small agile loop");
  expect(howItWorks).toContain("B[Ready backlog] --> S[Scout]");
  expect(howItWorks).toContain("S --> I[Implement]");
  expect(howItWorks).toContain("I --> R[Review]");
  expect(howItWorks).toContain("R -->|Accepted| D[Done]");
  expect(howItWorks).toContain("R -->|Changes needed| F[Draft follow-up]");
  expect(howItWorks).toContain("F -->|Approved| B[Ready backlog]");
  expect(howItWorks).toMatch(/\*\*Scout:\*\* Understands the task/);
  expect(howItWorks).toMatch(
    /\*\*Implement:\*\* Writes the code[\s\S]+trusted\s+Harness validates the result and saves it as a commit/,
  );
  expect(howItWorks).toMatch(
    /\*\*Review:\*\* Independently checks that exact commit[\s\S]+unapproved draft follow-up/,
  );
  expect(howItWorks).toContain("Roc works on one small task at a time");
  expect(howItWorks).toContain("ready backlog only after approval");
  expect(howItWorks).toContain("Roc saves progress");
  expect(howItWorks).not.toContain("Token ledger");
  expect(howItWorks).not.toContain("GitHub Release");
});
