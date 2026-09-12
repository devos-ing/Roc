import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import type { CliRuntime } from "../../src/cli/types";
import type { StoredTask, TaskStatus } from "../../src/domain/schemas";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { createTaskBranchManager } from "../../src/workspace/task-branch";
import { git } from "../helpers/git";

/** Builds a minimal stored task so snapshots stay cheap to seed. */
function storedTask(id: string, status: TaskStatus): StoredTask {
  return {
    id,
    cycleId: "2026-W37",
    title: `Task ${id}`,
    priority: 0,
    approvalRequired: true,
    approved: true,
    status,
    spec: {
      problem: `Problem for ${id}`,
      desiredOutcome: `Outcome for ${id}`,
      scope: ["src/"],
      nonGoals: [],
      acceptanceCriteria: ["Acceptance criterion"],
      validation: ["bun test"],
      dependencies: [],
      risk: "medium",
      contextCandidates: [],
      tokenCeiling: 10000,
    },
  };
}

/** Returns whether a path still exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates a seeded repository with a task branch manager and its worktree root. */
async function createFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "roc-task-cleanup-")),
  );
  await git(["init", "--initial-branch=main"], root);
  await git(["config", "user.name", "Roc Test"], root);
  await git(["config", "user.email", "roc@example.test"], root);
  await writeFile(join(root, "value.txt"), "base\n");
  await git(["add", "."], root);
  await git(["commit", "-m", "seed"], root);
  const base = await git(["rev-parse", "HEAD"], root);
  const manager = await createTaskBranchManager(root, base);
  const worktreeRoot = `${root}.agile-worktrees`;
  return {
    root,
    base,
    worktreeRoot,
    /** Prepares one real task worktree and returns its path. */
    async prepare(taskId: string): Promise<string> {
      return (await manager.prepare(taskId, base)).path;
    },
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
      await rm(worktreeRoot, { recursive: true, force: true });
      await rm(`${root}.agile-checkout.lock`, { force: true });
    },
  };
}

type CleanupPlan = {
  removed: Array<{ task: string; path: string }>;
  kept: Array<{ task: string; path: string; reason: string }>;
};

/** Runs the cleanup command through the CLI with a fake GitHub task store. */
async function runCleanup(
  root: string,
  tasks: StoredTask[],
  args: string[],
  runtimeOverrides: Partial<CliRuntime> = {},
): Promise<{
  code: number;
  out: string[];
  errors: string[];
  plan: CleanupPlan | undefined;
  summary: string | undefined;
}> {
  const out: string[] = [];
  const errors: string[] = [];
  const runtime: CliRuntime = {
    projectRoot: root,
    async runScheduler() {},
    async readTasks() {
      return { ...githubTaskSnapshot([]), tasks };
    },
    ...runtimeOverrides,
  };
  const code = await runCli(
    ["task", "cleanup", ...args],
    {
      out: (text) => out.push(text),
      err: (text) => errors.push(text),
    },
    runtime,
  );
  return {
    code,
    out,
    errors,
    plan:
      out[0] === undefined ? undefined : (JSON.parse(out[0]) as CleanupPlan),
    summary: out.at(1),
  };
}

test("task cleanup dry-run plans without mutating, then removes only done worktrees and never branches", async () => {
  const f = await createFixture();
  try {
    const donePath = await f.prepare("issue-1");
    const activePath = await f.prepare("issue-2");
    const rejectedPath = await f.prepare("issue-3");
    const doneHead = await git(["rev-parse", "agile/issue-1"], f.root);
    const tasks = [
      storedTask("issue-1", "done"),
      storedTask("issue-2", "implementing"),
      storedTask("issue-3", "rejected"),
    ];

    const dry = await runCleanup(f.root, tasks, ["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.errors).toEqual([]);
    expect(dry.plan?.removed.map((entry) => entry.task)).toEqual(["issue-1"]);
    expect(dry.plan?.removed[0]?.path).toBe(donePath);
    const plannedKeeps = new Map(
      dry.plan?.kept.map((entry) => [entry.task, entry.reason]),
    );
    expect(plannedKeeps.get("issue-2")).toBe(
      "Task status is implementing; worktrees of unfinished tasks are retained",
    );
    expect(plannedKeeps.get("issue-3")).toBe(
      "Task status is rejected; rerun with --all to remove its worktree",
    );
    expect(dry.summary).toContain("Dry run");
    expect(dry.summary).toContain("would remove 1 task worktree(s)");
    expect(await exists(donePath)).toBe(true);
    expect(await git(["worktree", "list", "--porcelain"], f.root)).toContain(
      donePath,
    );

    const run = await runCleanup(f.root, tasks, []);
    expect(run.code).toBe(0);
    expect(run.errors).toEqual([]);
    expect(run.plan?.removed.map((entry) => entry.task)).toEqual(["issue-1"]);
    expect(run.plan?.kept.map((entry) => entry.task)).toEqual([
      "issue-2",
      "issue-3",
    ]);
    expect(run.summary).toContain("Removed 1 task worktree(s)");
    expect(run.summary).toContain("Task branches are never deleted");
    expect(await exists(donePath)).toBe(false);
    expect(await exists(activePath)).toBe(true);
    expect(await exists(rejectedPath)).toBe(true);
    const listing = await git(["worktree", "list", "--porcelain"], f.root);
    expect(listing).not.toContain(donePath);
    expect(listing).toContain(activePath);
    expect(listing).toContain(rejectedPath);
    expect(await git(["rev-parse", "agile/issue-1"], f.root)).toBe(doneHead);
  } finally {
    await f.cleanup();
  }
});

test("task cleanup --all also removes rejected, failed_infra and retired worktrees but keeps unfinished ones", async () => {
  const f = await createFixture();
  try {
    const paths = new Map<string, string>();
    for (const id of [
      "issue-11",
      "issue-12",
      "issue-13",
      "issue-14",
      "issue-15",
    ])
      paths.set(id, await f.prepare(id));
    const heads = new Map<string, string>(
      await Promise.all(
        [...paths.keys()].map(
          async (id) =>
            [id, await git(["rev-parse", `agile/${id}`], f.root)] as const,
        ),
      ),
    );
    const run = await runCleanup(
      f.root,
      [
        storedTask("issue-11", "done"),
        storedTask("issue-12", "rejected"),
        storedTask("issue-13", "failed_infra"),
        storedTask("issue-14", "retired"),
        storedTask("issue-15", "claimed"),
      ],
      ["--all"],
    );
    expect(run.code).toBe(0);
    expect(run.errors).toEqual([]);
    expect(run.plan?.removed.map((entry) => entry.task)).toEqual([
      "issue-11",
      "issue-12",
      "issue-13",
      "issue-14",
    ]);
    expect(run.plan?.kept.map((entry) => entry.task)).toEqual(["issue-15"]);
    expect(run.plan?.kept[0]?.reason).toContain("claimed");
    const listing = await git(["worktree", "list", "--porcelain"], f.root);
    for (const id of ["issue-11", "issue-12", "issue-13", "issue-14"]) {
      const path = paths.get(id);
      expect(path && (await exists(path))).toBe(false);
      expect(listing).not.toContain(path ?? "");
    }
    const claimedPath = paths.get("issue-15");
    expect(claimedPath && (await exists(claimedPath))).toBe(true);
    expect(listing).toContain(claimedPath ?? "");
    for (const [id, head] of heads)
      expect(await git(["rev-parse", `agile/${id}`], f.root)).toBe(head);
  } finally {
    await f.cleanup();
  }
});

test("task cleanup skips dirty worktrees and keeps unknown tasks and non-worktree entries", async () => {
  const f = await createFixture();
  try {
    const dirtyPath = await f.prepare("issue-21");
    await writeFile(join(dirtyPath, "scratch.txt"), "uncommitted\n");
    const unknownPath = await f.prepare("issue-22");
    const foreignDir = join(f.worktreeRoot, "issue-23");
    await mkdir(foreignDir);
    const strayFile = join(f.worktreeRoot, "notes.txt");
    await writeFile(strayFile, "not a worktree\n");
    const run = await runCleanup(f.root, [storedTask("issue-21", "done")], []);
    expect(run.code).toBe(0);
    expect(run.errors).toEqual([]);
    expect(run.plan?.removed).toEqual([]);
    const keeps = new Map(
      run.plan?.kept.map((entry) => [entry.task, entry.reason]),
    );
    expect(keeps.get("issue-21")).toBe("Worktree has uncommitted changes");
    expect(keeps.get("issue-22")).toBe(
      "Task has no GitHub checkpoint in this repository",
    );
    expect(keeps.get("issue-23")).toBe(
      "Directory is not a registered Git worktree of this checkout",
    );
    expect(keeps.get("notes.txt")).toBe(
      "Entry is not a task worktree directory",
    );
    expect(await exists(dirtyPath)).toBe(true);
    expect(await exists(unknownPath)).toBe(true);
    expect(await exists(foreignDir)).toBe(true);
    expect(await exists(strayFile)).toBe(true);
    expect(await git(["worktree", "list", "--porcelain"], f.root)).toContain(
      dirtyPath,
    );
  } finally {
    await f.cleanup();
  }
});

test("task cleanup fails safely without GitHub task reads", async () => {
  const f = await createFixture();
  try {
    const path = await f.prepare("issue-31");
    const run = await runCleanup(f.root, [storedTask("issue-31", "done")], [], {
      readTasks: undefined,
    });
    expect(run.code).toBe(1);
    expect(run.errors).toEqual(["GitHub task reads are unavailable"]);
    expect(await exists(path)).toBe(true);
  } finally {
    await f.cleanup();
  }
});

/** Writes a foreign checkout guard so cleanup sees the checkout as owned. */
async function holdCheckoutGuard(root: string): Promise<string> {
  const lockPath = `${root}.agile-checkout.lock`;
  await writeFile(
    lockPath,
    JSON.stringify({
      version: 1,
      runId: "foreign-run",
      ownerPid: process.pid,
      acquiredAt: new Date().toISOString(),
      ownerToken: "foreign-owner-token",
    }),
  );
  return lockPath;
}

test("a held checkout guard blocks real removal without deleting anything", async () => {
  const f = await createFixture();
  try {
    const path = await f.prepare("issue-41");
    const lockPath = await holdCheckoutGuard(f.root);
    const guard = await readFile(lockPath, "utf8");
    const run = await runCleanup(f.root, [storedTask("issue-41", "done")], []);
    expect(run.code).toBe(1);
    expect(run.errors).toEqual(["Scheduler checkout is already in use"]);
    expect(run.out).toEqual([]);
    expect(await exists(path)).toBe(true);
    expect(await git(["worktree", "list", "--porcelain"], f.root)).toContain(
      path,
    );
    expect(await readFile(lockPath, "utf8")).toBe(guard);
  } finally {
    await f.cleanup();
  }
});

test("dry-run ignores a held guard and a successful real run releases its own guard", async () => {
  const f = await createFixture();
  try {
    const path = await f.prepare("issue-42");
    const lockPath = await holdCheckoutGuard(f.root);
    const guard = await readFile(lockPath, "utf8");
    const dry = await runCleanup(
      f.root,
      [storedTask("issue-42", "done")],
      ["--dry-run"],
    );
    expect(dry.code).toBe(0);
    expect(dry.errors).toEqual([]);
    expect(dry.plan?.removed.map((entry) => entry.task)).toEqual(["issue-42"]);
    expect(dry.summary).toContain("Dry run");
    expect(await exists(path)).toBe(true);
    expect(await readFile(lockPath, "utf8")).toBe(guard);

    await rm(lockPath);
    const run = await runCleanup(f.root, [storedTask("issue-42", "done")], []);
    expect(run.code).toBe(0);
    expect(run.errors).toEqual([]);
    expect(run.plan?.removed.map((entry) => entry.task)).toEqual(["issue-42"]);
    expect(await exists(path)).toBe(false);
    expect(await exists(lockPath)).toBe(false);
    // A follow-up real run proves the guard was released instead of leaked.
    const again = await runCleanup(
      f.root,
      [storedTask("issue-42", "done")],
      [],
    );
    expect(again.code).toBe(0);
    expect(again.errors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
