import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskBranchManager } from "../../src/workspace/task-branch";
import { git } from "../helpers/git";

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
  await rm(`${root}.agile-worktrees`, { recursive: true, force: true });
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

  expect(
    (await git(["check-ignore", ...artifacts], process.cwd())).split("\n"),
  ).toEqual(artifacts);
});

test("restores an approved source commit as uncommitted task changes", async () => {
  const root = await createRepository();
  try {
    await writeFile(join(root, "removed.txt"), "remove me\n");
    await git(["add", "-A"], root);
    await git(["commit", "-m", "test: shared source base"], root);
    const sourceBase = await git(["rev-parse", "HEAD"], root);
    const mainBranch = await git(["branch", "--show-current"], root);
    await git(["checkout", "-b", "source-implementation"], root);
    await writeFile(join(root, "README.md"), "restored\n");
    await writeFile(join(root, "restored.txt"), "from source commit\n");
    await rm(join(root, "removed.txt"));
    await git(["add", "-A"], root);
    await git(["commit", "-m", "test: source implementation"], root);
    const sourceCommit = await git(["rev-parse", "HEAD"], root);
    await git(["checkout", mainBranch], root);
    await writeFile(join(root, "new-base.txt"), "preserve newer base work\n");
    await git(["add", "-A"], root);
    await git(["commit", "-m", "test: advance task base"], root);
    const baseCommit = await git(["rev-parse", "HEAD"], root);

    const manager = await createTaskBranchManager(root, baseCommit);
    const workspace = await manager.prepare("T1", baseCommit);
    const sourcePaths = ["README.md", "restored.txt", "removed.txt"];
    await manager.restoreChanges("T1", sourceCommit, baseCommit);

    expect(await readFile(join(workspace.path, "README.md"), "utf8")).toBe(
      "restored\n",
    );
    expect(await readFile(join(workspace.path, "restored.txt"), "utf8")).toBe(
      "from source commit\n",
    );
    expect(await Bun.file(join(workspace.path, "removed.txt")).exists()).toBe(
      false,
    );
    expect(await readFile(join(workspace.path, "new-base.txt"), "utf8")).toBe(
      "preserve newer base work\n",
    );
    expect(await git(["rev-parse", "HEAD"], workspace.path)).toBe(baseCommit);
    expect(await git(["status", "--porcelain"], workspace.path)).not.toBe("");
    const restoredDiff = await git(
      ["diff", "--binary", "HEAD"],
      workspace.path,
    );
    await manager.restoreChanges("T1", sourceCommit, baseCommit);
    expect(await git(["diff", "--binary", "HEAD"], workspace.path)).toBe(
      restoredDiff,
    );

    const finalCommit = await manager.commitChanges("T1", baseCommit);
    expect(
      await git(
        ["diff", "--binary", baseCommit, finalCommit, "--", ...sourcePaths],
        workspace.path,
      ),
    ).toBe(
      await git(
        ["diff", "--binary", sourceBase, sourceCommit, "--", ...sourcePaths],
        root,
      ),
    );
  } finally {
    await removeRepository(root);
  }
});

test("refuses unmarked task work before restoring an approved source commit", async () => {
  const root = await createRepository();
  try {
    const mainBranch = await git(["branch", "--show-current"], root);
    await git(["checkout", "-b", "source-implementation"], root);
    await writeFile(join(root, "README.md"), "approved source\n");
    await git(["add", "-A"], root);
    await git(["commit", "-m", "test: source implementation"], root);
    const sourceCommit = await git(["rev-parse", "HEAD"], root);
    await git(["checkout", mainBranch], root);
    const baseCommit = await git(["rev-parse", "HEAD"], root);

    const manager = await createTaskBranchManager(root, baseCommit);
    const workspace = await manager.prepare("T1", baseCommit);
    await writeFile(join(workspace.path, "README.md"), "existing task work\n");
    const existingDiff = await git(
      ["diff", "--binary", "HEAD"],
      workspace.path,
    );

    await expect(
      manager.restoreChanges("T1", sourceCommit, baseCommit),
    ).rejects.toThrow("has unmarked work before approved source restoration");
    expect(await git(["diff", "--binary", "HEAD"], workspace.path)).toBe(
      existingDiff,
    );
    expect(await readFile(join(workspace.path, "README.md"), "utf8")).toBe(
      "existing task work\n",
    );
  } finally {
    await removeRepository(root);
  }
});

test("cleans the checkout and marker after a source patch conflict", async () => {
  const root = await createRepository();
  try {
    const mainBranch = await git(["branch", "--show-current"], root);
    await git(["checkout", "-b", "source-implementation"], root);
    await writeFile(join(root, "README.md"), "approved source\n");
    await git(["add", "-A"], root);
    await git(["commit", "-m", "test: source implementation"], root);
    const sourceCommit = await git(["rev-parse", "HEAD"], root);
    await git(["checkout", mainBranch], root);
    await writeFile(join(root, "README.md"), "new base conflict\n");
    await git(["add", "-A"], root);
    await git(["commit", "-m", "test: advance conflicting base"], root);
    const baseCommit = await git(["rev-parse", "HEAD"], root);

    const manager = await createTaskBranchManager(root, baseCommit);
    const workspace = await manager.prepare("T1", baseCommit);

    await expect(
      manager.restoreChanges("T1", sourceCommit, baseCommit),
    ).rejects.toThrow("Approved source commit patch did not apply cleanly");
    expect(await git(["status", "--porcelain"], workspace.path)).toBe("");
    expect(await readFile(join(workspace.path, "README.md"), "utf8")).toBe(
      "new base conflict\n",
    );
    expect(
      await git(
        ["show-ref", "--verify", "refs/agile-source/T1"],
        workspace.path,
        true,
      ),
    ).toBe("");
  } finally {
    await removeRepository(root);
  }
});

test("reports when an Implement turn leaves no commit-worthy changes", async () => {
  const root = await createRepository();
  try {
    const manager = await createTaskBranchManager(root, "HEAD");
    const workspace = await manager.prepare("T1");

    await expect(
      manager.commitChanges("T1", workspace.baseCommit),
    ).rejects.toThrow("has no uncommitted changes");
  } finally {
    await removeRepository(root);
  }
});

test("requires Review to inspect the exact clean implementation commit", async () => {
  const root = await createRepository();
  try {
    const sourceBranch = await git(["branch", "--show-current"], root);
    const sourceHead = await git(["rev-parse", "HEAD"], root);
    const sourceStatus = await git(["status", "--porcelain"], root);
    const manager = await createTaskBranchManager(root, "HEAD");
    const workspace = await manager.prepare("T1");
    await writeFile(
      join(workspace.path, "implementation.txt"),
      "implemented\n",
    );
    const commit = await manager.commitChanges("T1", workspace.baseCommit);

    await expect(
      manager.assertReviewReady("T1", commit, workspace.baseCommit),
    ).resolves.toBeUndefined();
    expect(
      await git(["rev-parse", "--verify", "refs/agile-review/T1"], root),
    ).toBe(commit);
    expect(await git(["cat-file", "-e", `${commit}^{commit}`], root)).toBe("");
    expect(await git(["branch", "--list", "agile/T1"], root)).toContain(
      "agile/T1",
    );
    expect(await git(["branch", "--show-current"], root)).toBe(sourceBranch);
    expect(await git(["rev-parse", "HEAD"], root)).toBe(sourceHead);
    expect(await git(["status", "--porcelain"], root)).toBe(sourceStatus);

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
    await expect(nextManager.prepare("T1", first.baseCommit)).resolves.toEqual(
      first,
    );
    await expect(nextManager.prepare("T1")).rejects.toThrow(/base changed/i);
  } finally {
    await removeRepository(root);
  }
});
