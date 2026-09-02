import { expect, test } from "bun:test";
import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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

  expect(
    (await git(["check-ignore", ...artifacts], process.cwd())).split("\n"),
  ).toEqual(artifacts);
});

test("preserves a GitHub source origin in new and legacy scheduler checkouts", async () => {
  const sourceOrigin = "https://github.com/agile-agents/roc.git";
  const root = await createRepository();
  try {
    await git(["remote", "add", "origin", sourceOrigin], root);
    const manager = await createTaskBranchManager(root, "HEAD");
    const newCheckout = (await manager.prepare("T1")).path;
    expect(
      await git(["config", "--get", "remote.origin.url"], newCheckout),
    ).toBe(sourceOrigin);

    await rm(`${root}.agile-checkout`, { recursive: true, force: true });
    const legacyCheckout = `${root}.agile-checkout`;
    await git(["clone", root, legacyCheckout], root);
    await appendFile(
      join(legacyCheckout, ".git", "config"),
      `\n[url "file://${root}"]\n\tinsteadOf = ${sourceOrigin}\n`,
    );
    const legacy = await createTaskBranchManager(root, "HEAD");
    const legacyCheckoutPath = (await legacy.prepare("T1")).path;
    expect(
      await git(["config", "--get", "remote.origin.url"], legacyCheckoutPath),
    ).toBe(sourceOrigin);
    await expect(
      (await createTaskBranchManager(root, "HEAD")).prepare("T1"),
    ).resolves.toMatchObject({ path: legacyCheckoutPath });
  } finally {
    await removeRepository(root);
  }
}, 30_000);

test("recognizes a no-user SCP SSH alias when restarting a scheduler checkout", async () => {
  const sourceOrigin = "github-work:agile-agents/roc.git";
  const root = await createRepository();
  const sshCommand = join(root, "ssh");
  const priorPath = process.env.PATH;
  try {
    await git(["remote", "add", "origin", sourceOrigin], root);
    const manager = await createTaskBranchManager(root, "HEAD");
    const checkout = (await manager.prepare("T1")).path;
    await writeFile(sshCommand, `#!/bin/sh\nexec git-upload-pack "${root}"\n`);
    await chmod(sshCommand, 0o755);
    process.env.PATH = `${root}:${priorPath ?? "/usr/bin:/bin"}`;

    const restarted = await createTaskBranchManager(root, "HEAD");
    expect((await restarted.prepare("T1")).path).toBe(checkout);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    await removeRepository(root);
  }
});

test("uses global Git configuration when fetching a legacy scheduler checkout", async () => {
  const sourceOrigin = "https://127.0.0.1:1/agile-agents/roc.git";
  const root = await createRepository();
  const globalConfig = join(root, "gitconfig");
  const priorGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
  try {
    await git(["remote", "add", "origin", sourceOrigin], root);
    const checkout = `${root}.agile-checkout`;
    await git(["clone", root, checkout], root);
    await writeFile(
      globalConfig,
      `[url "file://${root}"]\n\tinsteadOf = ${sourceOrigin}\n`,
    );
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    const restarted = await createTaskBranchManager(root, "HEAD");
    expect((await restarted.prepare("T1")).path).toBe(checkout);
    await expect(
      (await createTaskBranchManager(root, "HEAD")).prepare("T1"),
    ).resolves.toMatchObject({ path: checkout });
  } finally {
    if (priorGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = priorGlobalConfig;
    await removeRepository(root);
  }
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
    expect(await Bun.file(join(second.path, "answer.txt")).exists()).toBe(
      false,
    );
    expect(await git(["branch", "--show-current"], second.path)).toBe(
      "agile/T2",
    );

    const restarted = await createTaskBranchManager(root, "HEAD");
    const reopened = await restarted.prepare("T1", first.baseCommit);
    expect(await readFile(join(reopened.path, "answer.txt"), "utf8")).toBe(
      "42\n",
    );
    await expect(
      restarted.assertCommit("T1", firstCommit, first.baseCommit),
    ).resolves.toBeUndefined();

    expect(await git(["branch", "--show-current"], root)).toBe(sourceBranch);
    expect(await git(["rev-parse", "HEAD"], root)).toBe(sourceHead);
    expect(await git(["status", "--porcelain"], root)).toBe("");
    expect(await Bun.file(join(root, "answer.txt")).exists()).toBe(false);
    await expect(manager.prepare("../escape")).rejects.toThrow(
      "Unsafe task path component",
    );
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
    expect(
      await git(["show", "-s", "--format=%s", "agile/T1"], first.path),
    ).toBe("agile(T1): WIP checkpoint");

    await manager.prepare("T1", first.baseCommit);
    await writeFile(join(first.path, "final.txt"), "done\n");
    const commit = await manager.commitChanges("T1", first.baseCommit);

    expect(
      await git(
        ["rev-list", "--count", `${first.baseCommit}..agile/T1`],
        first.path,
      ),
    ).toBe("1");
    expect(await git(["show", "-s", "--format=%s", commit], first.path)).toBe(
      "agile(T1): implement ticket",
    );
    expect(await manager.commitChanges("T1", first.baseCommit)).toBe(commit);
  } finally {
    await removeRepository(root);
  }
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
    expect(await git(["branch", "--list", "agile/T1"], root)).toBe("");
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
    await expect(nextManager.prepare("T1")).rejects.toThrow(
      /does not descend from its base commit/i,
    );
  } finally {
    await removeRepository(root);
  }
});
