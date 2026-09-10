import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import type { CliRuntime, SchedulerRunInput } from "../../src/cli/types";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { rocSettingsPath, saveRocSettings } from "../../src/settings";
import { memoryGitHub } from "../helpers/github-native";

test("public task reads use GitHub, preserve legacy files, and scheduler rejects the removed local queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-github-cli-"));
  const legacy = join(root, ".agile/runtime/agile.db");
  try {
    await saveRocSettings({ cycle: { type: "weekly" } }, root);
    await mkdir(join(root, ".agile/runtime"), { recursive: true });
    await writeFile(legacy, "legacy data must remain untouched");
    const remote = memoryGitHub();
    const out: string[] = [];
    const errors: string[] = [];
    const runs: SchedulerRunInput[] = [];
    let reads = 0;
    const runtime: CliRuntime = {
      projectRoot: root,
      homeRoot: root,
      now: () => new Date("2026-09-08T00:00:00Z"),
      async runScheduler(input) {
        runs.push(input);
      },
      async readTasks(cwd) {
        expect(cwd).toBe(root);
        reads++;
        const data = await remote.store().list();
        return githubTaskSnapshot(data.tasks, data.diagnostics);
      },
    };
    const io = {
      out: (line: string) => out.push(line),
      err: (line: string) => errors.push(line),
    };
    for (const args of [
      ["task", "list", "--all"],
      ["scheduler", "inspect"],
      ["task", "board", "--all"],
      ["tokens", "--no-color"],
    ])
      expect(await runCli(args, io, runtime), errors.join("\n")).toBe(0);
    expect(reads).toBe(4);
    expect(out.join("\n")).toContain("issue-41");
    expect(out.join("\n")).toContain("GitHub");
    expect(errors).toEqual([]);
    expect(await runCli(["scheduler", "run", "--once"], io, runtime)).toBe(0);
    expect(runs).toEqual([
      {
        backend: "pi",
        source: "github",
        repoPath: root,
        baseBranch: undefined,
        once: true,
        autoMerge: undefined,
        concurrency: 2,
      },
    ]);
    expect(
      await runCli(["scheduler", "run", "--source", "local"], io, runtime),
    ).toBe(2);
    expect(runs).toHaveLength(1);
    expect(
      await runCli(["scheduler", "run", "--concurrency", "9"], io, runtime),
    ).toBe(2);
    expect(runs).toHaveLength(1);
    expect(
      await runCli(
        ["scheduler", "run", "--concurrency", "1", "--once", "--auto-merge"],
        io,
        runtime,
      ),
    ).toBe(0);
    expect(runs.at(-1)?.concurrency).toBe(1);
    expect(runs.at(-1)?.autoMerge).toBe(true);
    expect(await readFile(legacy, "utf8")).toBe(
      "legacy data must remain untouched",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub scheduler accepts bounded concurrency from one through eight", async () => {
  for (const value of ["1", "3", "8", "0", "9", "1.5", "NaN"]) {
    const runs: SchedulerRunInput[] = [];
    const valid = ["1", "3", "8"].includes(value);
    const code = await runCli(
      ["scheduler", "run", "--concurrency", value],
      {
        out: () => {},
        err: () => {},
      },
      {
        projectRoot: "/fixture",
        async runScheduler(input) {
          runs.push(input);
        },
      },
    );
    expect(code).toBe(valid ? 0 : 2);
    expect(runs).toHaveLength(valid ? 1 : 0);
    if (valid) expect(runs[0]?.concurrency).toBe(Number(value));
  }
});

test("task board explains invalid settings before remote reads and opens after manual repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-board-settings-"));
  const remote = memoryGitHub();
  const output: string[] = [];
  const errors: string[] = [];
  let reads = 0;
  const runtime: CliRuntime = {
    projectRoot: root,
    homeRoot: root,
    now: () => new Date("2026-09-08T00:00:00Z"),
    async runScheduler() {},
    async readTasks() {
      reads++;
      const data = await remote.store().list();
      return githubTaskSnapshot(data.tasks, data.diagnostics);
    },
  };
  const io = {
    out: (line: string) => output.push(line),
    err: (line: string) => errors.push(line),
  };
  try {
    const path = await saveRocSettings({ cycle: { type: "weekly" } }, root);
    // Top-level models is supported; type is unsupported at the settings root.
    const invalid = Buffer.from(
      '{"cycle":{"type":"weekly"},"type":"SECRET_VALUE"}\n',
    );
    await writeFile(path, invalid);
    expect(await runCli(["task", "board"], io, runtime)).toBe(1);
    expect(reads).toBe(0);
    expect(output).toEqual([]);
    const diagnostic = errors.join("\n");
    expect(diagnostic).toContain("ROC_SETTINGS_INVALID");
    expect(diagnostic).toContain(rocSettingsPath(root));
    expect(diagnostic).toContain("Unsupported fields: type.");
    expect(diagnostic).toContain("Back up this file");
    expect(diagnostic).not.toContain("Run npx roc-it@latest onboard");
    expect(diagnostic).not.toContain("SECRET_VALUE");
    expect(await readFile(path)).toEqual(invalid);

    await saveRocSettings(
      { cycle: { type: "weekly" }, models: { luna: "provider/model" } },
      root,
    );
    errors.length = 0;
    expect(await runCli(["task", "board"], io, runtime)).toBe(0);
    expect(reads).toBe(1);
    expect(output.join("\n")).toContain("GitHub checkpoints");
    expect(output.join("\n")).toContain("Return 42");
    expect(errors).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task acceptance reads recorded criteria without mutating GitHub state", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-task-acceptance-"));
  const remote = memoryGitHub();
  const output: string[] = [];
  const errors: string[] = [];
  try {
    const runtime: CliRuntime = {
      projectRoot: root,
      async runScheduler() {},
      async readTasks() {
        const data = await remote.store().list();
        return githubTaskSnapshot(data.tasks, data.diagnostics);
      },
    };
    const io = {
      out: (line: string) => output.push(line),
      err: (line: string) => errors.push(line),
    };
    expect(await runCli(["task", "acceptance", "#41"], io, runtime)).toBe(0);
    expect(output.join("\n")).toContain("Acceptance checklist for issue-41");
    expect(output.join("\n")).toContain("[ ] answer is 42");
    expect(output.join("\n")).toContain("No item-level evidence recorded.");
    expect(errors).toEqual([]);
    expect(remote.issue.comments).toHaveLength(1);
    expect(
      await runCli(["task", "acceptance", "not-an-issue"], io, runtime),
    ).toBe(1);
    expect(errors.at(-1)).toBe("Use a GitHub Issue number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
