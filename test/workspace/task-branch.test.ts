import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createTaskBranchManager } from "../../src/workspace/task-branch";

async function git(args: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agile-branch-repo-"));
  await git(["init"], root);
  await git(["config", "user.name", "Agile Tests"], root);
  await git(["config", "user.email", "agile@example.test"], root);
  await writeFile(join(root, "README.md"), "seed\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: seed"], root);
  return realpath(root);
}

async function removeRepository(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await rm(`${root}.agile-checkout`, { recursive: true, force: true });
}

test("project ignores Codex sandbox and test artifacts before task commits", async () => {
  const artifacts = [
    ".scratch/agile-codex-harness-example",
    ".scratch/agile-codex-harness-example.agile-checkout",
    ".tmp-agile-tests/agile-codex-harness-example",
    ".tmp-agile-token-future.db-shm",
    ".tmp-agile-token-future.db-wal",
    "agile-codex-harness-example",
    "agile-codex-harness-example.agile-checkout",
    "agile-branch-repo-example",
    "agile-branch-repo-example.agile-checkout",
    "xcrun_db",
  ];

  expect((await git(["check-ignore", ...artifacts], process.cwd())).split("\n")).toEqual(artifacts);
});

test("switches retained task branches in a scheduler-owned checkout", async () => {
  const root = await createRepository();
  try {
    const sourceBranch = await git(["branch", "--show-current"], root);
    const sourceHead = await git(["rev-parse", "HEAD"], root);
    const manager = await createTaskBranchManager(root, "HEAD");

    const first = await manager.prepare("T1");
    expect(first.path).toBe(`${root}.agile-checkout`);
    expect(first.branch).toBe("agile/T1");
    await writeFile(join(first.path, "answer.txt"), "42\n");
    const firstCommit = await manager.commitChanges("T1", first.baseCommit);

    const second = await manager.prepare("T2");
    expect(second.path).toBe(first.path);
    expect(await Bun.file(join(second.path, "answer.txt")).exists()).toBe(false);
    expect(await git(["branch", "--show-current"], second.path)).toBe("agile/T2");

    const restarted = await createTaskBranchManager(root, "HEAD");
    const reopened = await restarted.prepare("T1", first.baseCommit);
    expect(await readFile(join(reopened.path, "answer.txt"), "utf8")).toBe("42\n");
    await expect(restarted.assertCommit("T1", firstCommit, first.baseCommit)).resolves.toBeUndefined();

    expect(await git(["branch", "--show-current"], root)).toBe(sourceBranch);
    expect(await git(["rev-parse", "HEAD"], root)).toBe(sourceHead);
    expect(await git(["status", "--porcelain"], root)).toBe("");
    expect(await Bun.file(join(root, "answer.txt")).exists()).toBe(false);
    await expect(manager.prepare("../escape")).rejects.toThrow("Unsafe task path component");
  } finally {
    await removeRepository(root);
  }
});

test("checkpoints interrupted work and folds it into one final task commit", async () => {
  const root = await createRepository();
  try {
    const manager = await createTaskBranchManager(root, "HEAD");
    const first = await manager.prepare("T1");
    await writeFile(join(first.path, "partial.txt"), "partial\n");

    await manager.prepare("T2");
    expect(await git(["show", "-s", "--format=%s", "agile/T1"], first.path)).toBe(
      "agile(T1): WIP checkpoint",
    );

    await manager.prepare("T1", first.baseCommit);
    await writeFile(join(first.path, "final.txt"), "done\n");
    const commit = await manager.commitChanges("T1", first.baseCommit);

    expect(await git(["rev-list", "--count", `${first.baseCommit}..agile/T1`], first.path)).toBe("1");
    expect(await git(["show", "-s", "--format=%s", commit], first.path)).toBe(
      "agile(T1): implement ticket",
    );
    expect(await manager.commitChanges("T1", first.baseCommit)).toBe(commit);
  } finally {
    await removeRepository(root);
  }
});

test("requires Review to inspect the exact clean implementation commit", async () => {
  const root = await createRepository();
  try {
    const manager = await createTaskBranchManager(root, "HEAD");
    const workspace = await manager.prepare("T1");
    await writeFile(join(workspace.path, "implementation.txt"), "implemented\n");
    const commit = await manager.commitChanges("T1", workspace.baseCommit);

    await expect(
      manager.assertReviewReady("T1", commit, workspace.baseCommit),
    ).resolves.toBeUndefined();

    await writeFile(join(workspace.path, "implementation.txt"), "dirty\n");
    await expect(
      manager.assertReviewReady("T1", commit, workspace.baseCommit),
    ).rejects.toThrow(/must be clean/i);
  } finally {
    await removeRepository(root);
  }
});

test("rejects reuse of a task branch with a different base identity", async () => {
  const root = await createRepository();
  try {
    const firstManager = await createTaskBranchManager(root, "HEAD");
    const first = await firstManager.prepare("T1");

    await writeFile(join(root, "new-base.txt"), "new base\n");
    await git(["add", "new-base.txt"], root);
    await git(["commit", "-m", "test: advance base"], root);

    const nextManager = await createTaskBranchManager(root, "HEAD");
    await expect(nextManager.prepare("T1", first.baseCommit)).resolves.toEqual(first);
    await expect(nextManager.prepare("T1")).rejects.toThrow(/does not descend from its base commit/i);
  } finally {
    await removeRepository(root);
  }
});
