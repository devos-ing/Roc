import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

type PackageManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  description?: string;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  publishConfig?: Record<string, string>;
  scripts?: Record<string, string>;
};

type PackResult = {
  files: Array<{ path: string }>;
};

const stableVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

async function readManifest(): Promise<PackageManifest> {
  const text = await readFile(resolve(projectRoot, "package.json"), "utf8");
  return JSON.parse(text) as PackageManifest;
}

test("package metadata exposes roc-it as a public Bun CLI", async () => {
  const manifest = await readManifest();

  expect(manifest.name).toBe("roc-it");
  expect(manifest.version).toMatch(stableVersionPattern);
  expect(manifest.private).toBeUndefined();
  expect(manifest.license).toBe("Apache-2.0");
  expect(manifest.bin).toEqual({
    "roc-it": "./src/cli/main.ts",
    agile: "./src/cli/main.ts",
  });
  expect(manifest.files).toEqual([
    "src",
    "skills",
    "README.md",
    "README.zh-HK.md",
    "README.details.md",
    "README.details.zh-HK.md",
    "LICENSE",
  ]);
  expect(manifest.engines).toEqual({ bun: ">=1.3.0", node: ">=22.19.0" });
  expect(manifest.publishConfig).toEqual({ access: "public" });
  expect(manifest.scripts?.dev).toBe("bun src/cli/main.ts");
  expect(manifest.scripts?.prepublishOnly).toBe("bun run check");
});

test("a representative next stable version satisfies the package boundary", () => {
  expect("0.0.3").toMatch(stableVersionPattern);
});

test("Roc development PR review helpers pass their Python suites", async () => {
  for (const script of ["test_evidence.py", "test_ledger.py"]) {
    const child = Bun.spawn(
      [
        "python3",
        "-B",
        resolve(
          projectRoot,
          ".agents",
          "skills",
          "pr-review-to-closure",
          "scripts",
          script,
        ),
      ],
      { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, `${script}\n${stdout}\n${stderr}`).toBe(0);
  }
});

test("roc-create-tasks stays GitHub-only through a persistent merge handoff", async () => {
  const [local, shipped] = await Promise.all([
    readFile(
      resolve(projectRoot, ".agents/skills/roc-create-tasks/SKILL.md"),
      "utf8",
    ),
    readFile(resolve(projectRoot, "skills/roc-create-tasks/SKILL.md"), "utf8"),
  ]);

  expect(local).toBe(shipped);
  const prose = shipped.replace(/\s+/g, " ");
  expect(prose).not.toMatch(/\btask\s+import\b|\*\*Local queue/i);
  for (const requirement of [
    "the user explicitly invoked `roc-create-tasks`",
    "Use the installed `grilling` skill for requirement discovery",
    "approval of the complete task set and repository",
    "Write and publish exactly the approved manifest",
    "GitHub Issues are the only execution destination",
    "npx roc-it@latest task publish-github FILE",
    'bun "$ROC_CLI_ENTRY"',
    "Respect the user's chosen merge mode and existing execution consent",
    "Task-plan approval is not permission to start execution or enable automatic merge",
    "Reuse prior consent for this execution",
    "If execution consent is missing, ask before starting",
    "manual merge is the default",
    "Never enable `--auto-merge` without that choice",
    "confirm its repository, base branch, and merge mode",
    "Keep one daemon per repository",
    "Reuse an existing daemon when its configuration matches",
    "Never implicitly start a duplicate daemon or restart one to change its mode",
    "without `--auto-merge`",
    "`--once` processes one eligible task and exits",
    "readable classic branch protection",
    "at least one required status check",
    "strict up-to-date checks",
    "administrator enforcement",
    "Human reviews remain required when configured",
    "Never bypass or silently modify repository protection",
    "PR creation does not establish completion",
    "An open PR stays `awaiting_merge`",
    "visible wait reasons",
    "npx roc-it@latest scheduler inspect",
    "confirmed `done` only after",
    "PR is confirmed merged into the selected target branch",
    "verified the merge commit is present in the fetched target",
  ]) {
    expect(prose).toContain(requirement);
  }

  const schedulerCommands = shipped.match(
    /^npx roc-it@latest scheduler run .+$/gm,
  );
  expect(schedulerCommands).toEqual([
    "npx roc-it@latest scheduler run --base-branch SELECTED_BASE --concurrency 1 --auto-merge",
  ]);
  expect(schedulerCommands?.join("\n")).not.toContain("--once");
});

test("npm archive contains only runtime files", async () => {
  const npmCache = resolve(projectRoot, ".tmp-agile-tests", "npm-cache");
  await mkdir(npmCache, { recursive: true });
  const child = Bun.spawn(
    ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: projectRoot,
      env: { ...process.env, npm_config_cache: npmCache },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`npm pack failed: ${stderr}`);
  }

  const output = JSON.parse(stdout) as
    | PackResult[]
    | Record<string, PackResult>;
  const results = Array.isArray(output) ? output : Object.values(output);
  expect(results).toHaveLength(1);

  const paths = results[0]!.files.map((file) => file.path).sort();
  const allowedRootFiles = new Set([
    "LICENSE",
    "README.md",
    "README.zh-HK.md",
    "README.details.md",
    "README.details.zh-HK.md",
    "package.json",
  ]);
  const unexpected = paths.filter(
    (path) =>
      !allowedRootFiles.has(path) &&
      !path.startsWith("src/") &&
      !path.startsWith("skills/"),
  );

  expect(unexpected).toEqual([]);
  expect(paths).toContain("LICENSE");
  expect(paths).toContain("README.md");
  expect(paths).toContain("README.zh-HK.md");
  expect(paths).toContain("README.details.md");
  expect(paths).toContain("README.details.zh-HK.md");
  expect(paths).not.toContain("CONTRIBUTING.md");
  expect(paths).toContain("package.json");
  expect(paths).toContain("src/cli/main.ts");
  expect(paths).toContain("skills/roc-create-tasks/SKILL.md");
  expect(paths.some((path) => path.includes("pr-review-to-closure"))).toBe(
    false,
  );
});
