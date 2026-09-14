import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  expect(manifest.bin).toEqual({ openamp: "./dist/openamp/main.js" });
  expect(manifest.files).toEqual([
    "dist/openamp",
    "dist/third-party/sol-pi",
    "README.md",
    "README.zh-HK.md",
    "LICENSE",
  ]);
  expect(manifest.engines).toEqual({ node: ">=22.19.0" });
  expect(manifest.publishConfig).toEqual({ access: "public" });
  expect(manifest.scripts?.build).toBe(
    "tsc -p tsconfig.build.json && node tools/write-observation-pack-build-manifest.mjs",
  );
  expect(manifest.scripts?.dev).toBe(
    "bun run build && node dist/openamp/main.js",
  );
  expect(manifest.scripts?.prepack).toBe("bun run build");
  expect(manifest.scripts?.prepublishOnly).toBe("bun run check");
  expect(manifest.dependencies).toEqual({
    "@clack/prompts": "1.7.0",
    "@earendil-works/pi-coding-agent": "0.82.1",
    "@earendil-works/pi-tui": "0.82.1",
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
    expect(paths).toContain("dist/openamp/main.js");
    expect(paths).toContain("dist/openamp/main.d.ts");
    expect(paths).toContain("dist/third-party/sol-pi/PROVENANCE.json");
    expect(paths).toContain("dist/third-party/sol-pi/BUILD-PROVENANCE.json");
    expect(paths.some((path) => path.startsWith("src/openamp/"))).toBeFalse();
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
    const runtimeCheck = await run(
      [
        "node",
        "--input-type=module",
        "--eval",
        "import { createHash } from 'node:crypto'; import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join, resolve } from 'node:path'; const root = resolve('node_modules/openamp'); const piRoot = resolve('node_modules/@earendil-works/pi-coding-agent'); const { createEventBus } = await import(join(piRoot, 'dist/core/event-bus.js')); const { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } = await import(join(piRoot, 'dist/core/extensions/loader.js')); const observation = await import(join(root, 'dist/openamp/observation-pack.js')); await observation.validateObservationPackRuntime(); const parent = await loadExtensionFromFactory(await observation.createOpenAmpObservationPackExtension(), process.cwd(), createEventBus(), createExtensionRuntime()); const child = await loadExtensions([join(root, 'dist/openamp/observation-pack-extension.js')], process.cwd()); if (child.errors.length || !parent.tools.has('obs_recall') || !child.extensions[0]?.tools.has('obs_recall')) throw new Error('ObservationPack tool was not registered'); const sessionDir = await mkdtemp(join(tmpdir(), 'openamp-recall-')); const sessionId = 'session'; const id = 'obs_aaaaaaaaaaaaaaaaaaaaaaaa'; const text = 'recalled text\\n'; const contentHash = createHash('sha256').update(text).digest('hex'); const archive = join(sessionDir, 'sol-pi', sessionId, 'observation-pack'); await mkdir(join(archive, 'objects'), { recursive: true }); await writeFile(join(archive, 'objects', id + '.txt'), text); await writeFile(join(archive, 'ledger.jsonl'), JSON.stringify({ event: 'full', id, contentHash }) + '\\n'); const recall = child.extensions[0].tools.get('obs_recall').definition; const result = await recall.execute('call', { id, offset: 0 }, new AbortController().signal, () => {}, { mode: 'json', sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => sessionId } }); if (result.content[0]?.text !== '[obs_recall id=' + id + ' offset=0 next_offset=14 eof=true]\\n[chunk_bytes=14 chunk_lines=1; use next_offset to continue]\\n' + text) throw new Error('ObservationPack recall did not execute');",
      ],
      installDirectory,
    );
    expect(runtimeCheck.exitCode, runtimeCheck.stderr).toBe(0);
    const vendorEntry = join(
      installDirectory,
      "node_modules/openamp/dist/third-party/sol-pi/extensions/observation-pack/index.js",
    );
    await rename(vendorEntry, `${vendorEntry}.disabled`);
    const disabledHelp = await run(
      [resolve(installDirectory, "node_modules/.bin/openamp"), "--help"],
      installDirectory,
    );
    expect(disabledHelp.exitCode, disabledHelp.stderr).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
