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
    "LICENSE",
  ]);
  expect(manifest.engines).toEqual({ bun: ">=1.3.0" });
  expect(manifest.publishConfig).toEqual({ access: "public" });
  expect(manifest.scripts?.dev).toBe("bun src/cli/main.ts");
  expect(manifest.scripts?.prepublishOnly).toBe("bun run check");
});

test("a representative next stable version satisfies the package boundary", () => {
  expect("0.0.3").toMatch(stableVersionPattern);
});

test("packaged PR review helpers pass their Python suites", async () => {
  for (const script of ["test_evidence.py", "test_ledger.py"]) {
    const child = Bun.spawn(
      [
        "python3",
        "-B",
        resolve(
          projectRoot,
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
  expect(paths).not.toContain("CONTRIBUTING.md");
  expect(paths).toContain("package.json");
  expect(paths).toContain("src/cli/main.ts");
  expect(paths).toContain("skills/roc-create-tasks/SKILL.md");
  expect(paths).toEqual(
    expect.arrayContaining([
      "skills/pr-review-to-closure/SKILL.md",
      "skills/pr-review-to-closure/agents/openai.yaml",
      "skills/pr-review-to-closure/references/ledger-schema.md",
      "skills/pr-review-to-closure/scripts/evidence.py",
      "skills/pr-review-to-closure/scripts/ledger.py",
      "skills/pr-review-to-closure/scripts/test_evidence.py",
      "skills/pr-review-to-closure/scripts/test_ledger.py",
    ]),
  );
});
