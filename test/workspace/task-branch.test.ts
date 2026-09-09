import { expect, test } from "bun:test";
import {
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
  await rm(`${root}.agile-worktrees`, { recursive: true, force: true });
}

/** Publishes a trusted task patch to a bare origin and advances its target independently. */
async function refreshFixture(conflict = false) {
  const root = await createRepository();
  const origin = await mkdtemp(join(tmpdir(), "agile-refresh-origin-"));
  await git(["init", "--bare"], origin);
  await git(["branch", "-M", "main"], root);
  await git(["remote", "add", "origin", origin], root);
  await git(["push", "origin", "main"], root);
  const expectedBase = await git(["rev-parse", "HEAD"], root);
  const manager = await createTaskBranchManager(root, expectedBase);
  const workspace = await manager.prepare("T1", expectedBase);
  await writeFile(join(workspace.path, "README.md"), "trusted patch\n");
  const expectedHead = await manager.commitChanges("T1", expectedBase);
  await git(["push", "origin", workspace.branch], workspace.path);
  await writeFile(
    join(root, conflict ? "README.md" : "target.txt"),
    "other task\n",
  );
  await git(["add", "-A"], root);
  await git(["commit", "-m", "advance target"], root);
  await git(["push", "origin", "main"], root);
  const targetBase = await git(["rev-parse", "HEAD"], root);
  return {
    root,
    origin,
    manager,
    workspace,
    input: { expectedHead, expectedBase, targetBase, baseBranch: "main" },
    async cleanup() {
      await removeRepository(root);
      await rm(origin, { recursive: true, force: true });
    },
  };
}

test("clean base refresh preserves the patch, lease-pushes the task ref and advances only the confirmed cached base", async () => {
  const f = await refreshFixture();
  try {
    const patch = await git(
      ["diff", f.input.expectedBase, f.input.expectedHead],
      f.root,
    );
    const head = await f.manager.refresh("T1", f.input);
    expect(head).not.toBe(f.input.expectedHead);
    expect(await git(["diff", f.input.targetBase, head], f.root)).toBe(patch);
    expect(await git(["rev-parse", "agile/T1"], f.origin)).toBe(head);
    expect(await git(["rev-parse", "main"], f.origin)).toBe(f.input.targetBase);
    expect(await git(["rev-parse", "HEAD"], f.root)).toBe(f.input.targetBase);
    expect(await git(["status", "--porcelain"], f.workspace.path)).toBe("");
    await f.manager.assertReviewReady("T1", head, f.input.targetBase);
    await expect(f.manager.prepare("T1", f.input.expectedBase)).rejects.toThrow(
      "base changed",
    );
    expect((await f.manager.prepare("T1", f.input.targetBase)).baseCommit).toBe(
      f.input.targetBase,
    );
    expect(
      await git(
        ["rev-parse", `refs/agile-refresh/T1/${f.input.expectedHead}`],
        f.root,
      ),
    ).toBe(f.input.expectedHead);

    await writeFile(join(f.root, "second-target.txt"), "another merge\n");
    await git(["add", "-A"], f.root);
    await git(["commit", "-m", "second target advance"], f.root);
    await git(["push", "origin", "main"], f.root);
    const nextBase = await git(["rev-parse", "HEAD"], f.root);
    const next = await f.manager.refresh("T1", {
      expectedHead: head,
      expectedBase: f.input.targetBase,
      targetBase: nextBase,
      baseBranch: "main",
    });
    expect(await git(["diff", nextBase, next], f.root)).toBe(patch);
    await f.manager.assertReviewReady("T1", next, nextBase);
    const restarted = await createTaskBranchManager(f.root, nextBase);
    await restarted.assertReviewReady("T1", next, nextBase);
  } finally {
    await f.cleanup();
  }
});

test("conflicting base refresh aborts without losing the original trusted patch or changing origin", async () => {
  const f = await refreshFixture(true);
  try {
    await expect(f.manager.refresh("T1", f.input)).rejects.toThrow(
      "conflicted",
    );
    expect(await git(["rev-parse", "HEAD"], f.workspace.path)).toBe(
      f.input.expectedHead,
    );
    expect(await git(["rev-parse", "agile/T1"], f.origin)).toBe(
      f.input.expectedHead,
    );
    expect(await readFile(join(f.workspace.path, "README.md"), "utf8")).toBe(
      "trusted patch\n",
    );
    expect(await git(["status", "--porcelain"], f.workspace.path)).toBe("");
    await f.manager.assertReviewReady(
      "T1",
      f.input.expectedHead,
      f.input.expectedBase,
    );
  } finally {
    await f.cleanup();
  }
});

test("dirty files, unexpected history, external heads and interrupted Git operations refuse refresh without discarding work", async () => {
  for (const change of [
    "dirty",
    "history",
    "external",
    "interrupted",
  ] as const) {
    const f = await refreshFixture();
    try {
      if (change === "dirty")
        await writeFile(
          join(f.workspace.path, "untracked.txt"),
          "someone else's work\n",
        );
      if (change === "history") {
        await writeFile(
          join(f.workspace.path, "extra.txt"),
          "external history\n",
        );
        await git(["add", "-A"], f.workspace.path);
        await git(["commit", "-m", "external edit"], f.workspace.path);
      }
      if (change === "external")
        await git(
          ["update-ref", "refs/heads/agile/T1", f.input.targetBase],
          f.origin,
        );
      if (change === "interrupted") {
        const path = await git(
          [
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "CHERRY_PICK_HEAD",
          ],
          f.workspace.path,
        );
        await writeFile(path, `${f.input.expectedHead}\n`);
      }
      const before = await git(["rev-parse", "HEAD"], f.workspace.path);
      const status = await git(["status", "--porcelain"], f.workspace.path);
      const remote = await git(["rev-parse", "agile/T1"], f.origin);
      await expect(f.manager.refresh("T1", f.input)).rejects.toThrow();
      expect(await git(["rev-parse", "HEAD"], f.workspace.path)).toBe(before);
      expect(await git(["status", "--porcelain"], f.workspace.path)).toBe(
        status,
      );
      expect(await git(["rev-parse", "agile/T1"], f.origin)).toBe(remote);
      if (change === "dirty")
        expect(
          await readFile(join(f.workspace.path, "untracked.txt"), "utf8"),
        ).toBe("someone else's work\n");
    } finally {
      await f.cleanup();
    }
  }
});

test("an exact old-head lease refuses an external push racing after preflight and retains both versions", async () => {
  const f = await refreshFixture();
  try {
    const script = join(f.origin, "racing-receive-pack");
    await writeFile(
      script,
      `#!/bin/sh\nunset GIT_CONFIG_PARAMETERS\ngit --git-dir='${f.origin}' update-ref refs/heads/agile/T1 ${f.input.targetBase}\nexec git-receive-pack "$@"\n`,
    );
    await chmod(script, 0o700);
    await git(["config", "remote.origin.receivepack", script], f.root);
    await expect(f.manager.refresh("T1", f.input)).rejects.toThrow();
    expect(await git(["rev-parse", "agile/T1"], f.origin)).toBe(
      f.input.targetBase,
    );
    const retained = await git(["rev-parse", "HEAD"], f.workspace.path);
    expect(retained).not.toBe(f.input.expectedHead);
    expect(await git(["diff", f.input.targetBase, retained], f.root)).toBe(
      await git(["diff", f.input.expectedBase, f.input.expectedHead], f.root),
    );
    expect(
      await git(
        ["rev-parse", `refs/agile-refresh/T1/${f.input.expectedHead}`],
        f.root,
      ),
    ).toBe(f.input.expectedHead);
  } finally {
    await f.cleanup();
  }
});

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
