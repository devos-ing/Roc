import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import type { CliRuntime, SchedulerRunInput } from "../../src/cli/types";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { saveRocSettings } from "../../src/settings";
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
      await runCli(["scheduler", "run", "--concurrency", "3"], io, runtime),
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
