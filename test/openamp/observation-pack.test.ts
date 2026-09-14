import { expect, test } from "bun:test";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mainSessionTools, runOpenAmp } from "../../src/openamp/cli";
import {
  createOpenAmpObservationPackExtension,
  OBSERVATION_PACK_TOOL,
  validateObservationPackSnapshot,
} from "../../src/openamp/observation-pack";
import { childArgsForRole, toolsForRole } from "../../src/openamp/supervisor";
import { resumeChange } from "../../src/openamp/workspace";

/** Runs one Git command in a disposable test repository. */
async function git(cwd: string, args: string[]): Promise<void> {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) {
    delete env[name];
  }
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
}

/** Creates the smallest committed repository accepted by OpenAmp's workspace setup. */
async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openamp-observation-pack-"));
  await git(root, ["init", "--initial-branch", "main"]);
  await git(root, ["config", "user.email", "tests@example.test"]);
  await git(root, ["config", "user.name", "OpenAmp Tests"]);
  await writeFile(join(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "fixture"]);
  return root;
}

test("keeps the accepted source snapshot and exposes recall only when enabled", async () => {
  await expect(validateObservationPackSnapshot()).resolves.toBe(
    "7975b4c4b16729c8bcb370f05f192a6c0ac157bb6f0235261181a1e0dc3bfdf9",
  );
  const registered: string[] = [];
  (await createOpenAmpObservationPackExtension())({
    on: () => undefined,
    registerTool: (tool: { name: string }) => registered.push(tool.name),
  } as never);
  expect(registered).toContain(OBSERVATION_PACK_TOOL);
  expect(mainSessionTools(false)).not.toContain(OBSERVATION_PACK_TOOL);
  expect(mainSessionTools(true)).toContain(OBSERVATION_PACK_TOOL);
  expect(toolsForRole("reviewer", false)).not.toContain(OBSERVATION_PACK_TOOL);
  expect(toolsForRole("writer", true)).toContain(OBSERVATION_PACK_TOOL);
  const childArgs = childArgsForRole("reviewer", true, "/tmp/openamp-session");
  expect(
    childArgs.filter((argument) => argument === "--extension"),
  ).toHaveLength(2);
  expect(childArgs).toContain(`read,grep,find,ls,${OBSERVATION_PACK_TOOL}`);
});

test("refuses to bless compiled artifacts from a tampered raw snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "openamp-observation-build-"));
  try {
    const source = join(root, "source");
    await cp(resolve(import.meta.dir, "../../src/third-party/sol-pi"), source, {
      recursive: true,
    });
    await appendFile(join(source, "runtime-paths.ts"), "\n// tampered\n");
    const child = Bun.spawn(
      [
        "node",
        resolve(
          import.meta.dir,
          "../../tools/write-observation-pack-build-manifest.mjs",
        ),
      ],
      {
        env: {
          ...process.env,
          OPENAMP_OBSERVATION_SOURCE_ROOT: source,
          OPENAMP_OBSERVATION_OUTPUT_ROOT: join(root, "output"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists an enabled checkbox choice and leaves it unchanged when selection cancels", async () => {
  const root = await fixtureRepository();
  try {
    class ImmediateMode {
      /** Exits the native TUI after OpenAmp has created its durable session. */
      async run(): Promise<void> {}
    }
    await runOpenAmp([], {
      cwd: root,
      InteractiveMode: ImmediateMode,
      selectPlugins: async () => true,
    });
    const stateFiles = await Array.fromAsync(
      new Bun.Glob("*.json").scan({
        cwd: join(root, ".git", "openamp", "changes"),
      }),
    );
    expect(stateFiles).toHaveLength(1);
    const [stateFile] = stateFiles;
    if (!stateFile) throw new Error("OpenAmp did not persist the change state");
    const state = JSON.parse(
      await readFile(
        join(root, ".git", "openamp", "changes", stateFile),
        "utf8",
      ),
    ) as { id: string };
    await expect(
      runOpenAmp(["--resume", state.id, "--plugins"], {
        cwd: root,
        InteractiveMode: ImmediateMode,
        selectPlugins: async () => undefined,
      }),
    ).rejects.toThrow("plugin selection cancelled");
    expect(
      (await resumeChange(root, state.id)).state.observationPack,
    ).toBeTrue();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
