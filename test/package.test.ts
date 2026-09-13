import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  dependencies?: Record<string, string>;
};

type PackResult = {
  filename: string;
  files: Array<{ path: string }>;
};

const stableVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** Returns a package-test environment without inherited Git repository overrides. */
function packageEnvironment(extra: Record<string, string> = {}) {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    ...extra,
  };
  for (const name of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) {
    delete environment[name];
  }
  return environment;
}

/** Reads the package manifest from the repository root. */
async function readManifest(): Promise<PackageManifest> {
  const text = await readFile(resolve(projectRoot, "package.json"), "utf8");
  return JSON.parse(text) as PackageManifest;
}

/** Runs one subprocess and returns its complete output. */
async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: packageEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("package metadata exposes only the public Node OpenAmp CLI", async () => {
  const manifest = await readManifest();

  expect(manifest.name).toBe("openamp");
  expect(manifest.version).toMatch(stableVersionPattern);
  expect(manifest.private).toBeUndefined();
  expect(manifest.license).toBe("Apache-2.0");
  expect(manifest.bin).toEqual({ openamp: "./src/openamp/main.mjs" });
  expect(manifest.files).toEqual([
    "src/openamp",
    "README.md",
    "README.zh-HK.md",
    "LICENSE",
  ]);
  expect(manifest.engines).toEqual({ node: ">=22.19.0" });
  expect(manifest.publishConfig).toEqual({ access: "public" });
  expect(manifest.scripts?.dev).toBe("node src/openamp/main.mjs");
  expect(manifest.scripts?.prepublishOnly).toBe("bun run check");
  expect(manifest.dependencies).toEqual({
    "@earendil-works/pi-coding-agent": "0.82.1",
    typebox: "1.1.38",
  });
});

test("OpenAmp development PR review helpers pass their Python suites", async () => {
  for (const script of ["test_evidence.py", "test_ledger.py"]) {
    const result = await run(
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
      projectRoot,
    );
    expect(
      result.exitCode,
      `${script}\n${result.stdout}\n${result.stderr}`,
    ).toBe(0);
  }
});

test("npm archive installs a working Node CLI without Roc runtime paths", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "openamp-pack-"));
  try {
    const npmCache = resolve(root, "npm-cache");
    const archiveDirectory = resolve(root, "archive");
    const installDirectory = resolve(root, "install");
    await Promise.all([
      mkdir(npmCache, { recursive: true }),
      mkdir(archiveDirectory, { recursive: true }),
      mkdir(installDirectory, { recursive: true }),
    ]);
    const child = Bun.spawn(
      [
        "npm",
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        archiveDirectory,
      ],
      {
        cwd: projectRoot,
        env: packageEnvironment({ npm_config_cache: npmCache }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = (JSON.parse(stdout) as PackResult[])[0];
    if (!result) throw new Error("npm pack returned no archive");
    const paths = result.files.map((file) => file.path).sort();
    expect(paths).toContain("src/openamp/main.mjs");
    expect(paths).not.toContain("src/cli/main.ts");
    expect(paths.some((path) => path.startsWith("src/scheduler/"))).toBeFalse();
    expect(paths.some((path) => path.startsWith("skills/"))).toBeFalse();
    expect(paths.some((path) => path.includes("README.details"))).toBeFalse();

    const archive = resolve(archiveDirectory, result.filename);
    const installed = await run(
      ["npm", "install", "--ignore-scripts", "--no-audit", archive],
      installDirectory,
    );
    expect(installed.exitCode, installed.stderr).toBe(0);
    const help = await run(
      [resolve(installDirectory, "node_modules/.bin/openamp"), "--help"],
      installDirectory,
    );
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout).toContain(
      "OpenAmp - interactive Pi agent collaboration",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
