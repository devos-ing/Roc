import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createTaskWorktreeManager } from "../../src/workspace/task-worktree";

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
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
  return { stdout, stderr };
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agile-worktree-repo-"));
  await git(["init"], root);
  await git(["config", "user.name", "Agile Tests"], root);
  await git(["config", "user.email", "agile@example.test"], root);
  await writeFile(join(root, "README.md"), "seed\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: seed"], root);
  return realpath(root);
}

test("prepares an isolated task branch and validates its committed result", async () => {
  const root = await createRepository();
  try {
    const manager = await createTaskWorktreeManager(root, "HEAD");

    const first = await manager.prepare("T1");
    expect(first.path).toBe(join(root, ".agile", "worktrees", "T1"));
    expect(first.branch).toBe("agile/T1");
    expect(first.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await manager.status("T1")).toBe("");
    await Bun.write(join(first.path, "README.md"), "dirty\n");
    expect(await manager.status("T1")).toBe(" M README.md");

    await Bun.write(join(first.path, "answer.txt"), "42\n");
    await git(["add", "answer.txt"], first.path);
    await git(["commit", "-m", "feat: answer"], first.path);
    const commit = (await git(["rev-parse", "HEAD"], first.path)).stdout.trim();
    await expect(manager.assertCommit("T1", commit)).resolves.toBeUndefined();
    await expect(manager.assertCommit("T1", "abc123")).rejects.toThrow(
      "Invalid full commit SHA: abc123",
    );
    await expect(manager.assertCommit("T1", "0".repeat(40))).rejects.toThrow(/git cat-file -e/);
    expect(await manager.prepare("T1")).toEqual(first);

    await Bun.write(join(root, "outside.txt"), "outside task branch\n");
    await git(["add", "outside.txt"], root);
    await git(["commit", "-m", "test: outside task branch"], root);
    const outsideCommit = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
    await expect(manager.assertCommit("T1", outsideCommit)).rejects.toThrow(
      "Commit is not reachable from agile/T1",
    );

    await expect(manager.prepare("../escape")).rejects.toThrow("Unsafe task path component");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commits dirty task changes once and reuses the sole clean task commit", async () => {
  const root = await createRepository();
  try {
    const manager = await createTaskWorktreeManager(root, "HEAD");
    const workspace = await manager.prepare("T1");
    await writeFile(join(workspace.path, "answer.txt"), "42\n");

    const managerModule = new URL(
      "../../src/workspace/task-worktree.ts",
      import.meta.url,
    ).href;
    const commitProcess = Bun.spawn([
      process.execPath,
      "--eval",
      [
        `import { createTaskWorktreeManager } from ${JSON.stringify(managerModule)};`,
        `const manager = await createTaskWorktreeManager(${JSON.stringify(root)}, "HEAD");`,
        `await manager.commitChanges("T1");`,
      ].join("\n"),
    ], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Hostile Author",
        GIT_AUTHOR_EMAIL: "hostile-author@example.test",
        GIT_COMMITTER_NAME: "Hostile Committer",
        GIT_COMMITTER_EMAIL: "hostile-committer@example.test",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [commitExitCode, commitStderr] = await Promise.all([
      commitProcess.exited,
      new Response(commitProcess.stderr).text(),
    ]);
    if (commitExitCode !== 0) {
      throw new Error(`trusted commit subprocess failed: ${commitStderr.trim()}`);
    }
    const firstCommit = (await git(["rev-parse", "HEAD"], workspace.path)).stdout.trim();

    expect(firstCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await manager.status("T1")).toBe("");
    expect((await git([
      "rev-list",
      "--count",
      `${workspace.baseCommit}..refs/heads/${workspace.branch}`,
    ], root)).stdout.trim()).toBe("1");
    expect((await git([
      "show",
      "-s",
      "--format=%an <%ae>%n%cn <%ce>%n%s",
      firstCommit,
    ], root)).stdout.trim()).toBe(
      "Agile Agents <agile-agents@local>\n" +
      "Agile Agents <agile-agents@local>\n" +
      "agile(T1): implement ticket",
    );

    const replayedCommit = await manager.commitChanges("T1");

    expect(replayedCommit).toBe(firstCommit);
    expect((await git([
      "rev-list",
      "--count",
      `${workspace.baseCommit}..refs/heads/${workspace.branch}`,
    ], root)).stdout.trim()).toBe("1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not run worktree-controlled Git hooks from the trusted commit", async () => {
  const root = await createRepository();
  try {
    const manager = await createTaskWorktreeManager(root, "HEAD");
    const workspace = await manager.prepare("T1");
    const hooksPath = join(workspace.path, ".githooks");
    const sentinel = join(root, "untrusted-hook-ran.txt");
    await mkdir(hooksPath);
    await writeFile(
      join(hooksPath, "pre-commit"),
      `#!/bin/sh\nprintf 'ran\\n' > ${JSON.stringify(sentinel)}\n`,
    );
    await chmod(join(hooksPath, "pre-commit"), 0o755);
    await git(["config", "core.hooksPath", hooksPath], root);
    await writeFile(join(workspace.path, "implementation.txt"), "implemented\n");

    await manager.commitChanges("T1");

    expect(await Bun.file(sentinel).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not run hostile checkout hooks while creating a task worktree", async () => {
  const root = await createRepository();
  try {
    const hooksPath = join(root, ".hostile-hooks");
    const sentinel = join(root, "hostile-post-checkout-ran.txt");
    await mkdir(hooksPath);
    await writeFile(
      join(hooksPath, "post-checkout"),
      `#!/bin/sh\nprintf 'ran\\n' > ${JSON.stringify(sentinel)}\n`,
    );
    await chmod(join(hooksPath, "post-checkout"), 0o755);
    await git(["config", "core.hooksPath", hooksPath], root);

    const manager = await createTaskWorktreeManager(root, "HEAD");
    await manager.prepare("T1");

    expect(await Bun.file(sentinel).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects repo-local content filters before creating a trusted worktree", async () => {
  const root = await createRepository();
  try {
    const sentinel = join(root, "hostile-smudge-filter-ran.txt");
    const filter = join(root, "hostile-smudge-filter.sh");
    await writeFile(
      filter,
      `#!/bin/sh\ncat\nprintf 'ran\\n' > ${JSON.stringify(sentinel)}\n`,
    );
    await chmod(filter, 0o755);
    await writeFile(join(root, ".gitattributes"), "README.md filter=hostile\n");
    await git(["add", ".gitattributes"], root);
    await git(["commit", "-m", "test: configure checkout attribute"], root);
    await git(["config", "filter.hostile.smudge", filter], root);
    await git(["config", "filter.hostile.required", "true"], root);

    const manager = await createTaskWorktreeManager(root, "HEAD");

    await expect(manager.prepare("T1")).rejects.toThrow(/content filters/i);
    expect(await Bun.file(sentinel).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for zero clean task commits or more than one task commit", async () => {
  const root = await createRepository();
  try {
    const manager = await createTaskWorktreeManager(root, "HEAD");
    await manager.prepare("T1");
    await expect(manager.commitChanges("T1")).rejects.toThrow(/no uncommitted changes/i);

    const workspace = await manager.prepare("T2");
    await writeFile(join(workspace.path, "first.txt"), "first\n");
    await git(["add", "-A"], workspace.path);
    await git(["commit", "-m", "test: first task commit"], workspace.path);
    await writeFile(join(workspace.path, "second.txt"), "second\n");
    await expect(manager.commitChanges("T2")).rejects.toThrow(/must be clean/i);
    await git(["add", "-A"], workspace.path);
    await git(["commit", "-m", "test: second task commit"], workspace.path);

    await expect(manager.commitChanges("T2")).rejects.toThrow(/exactly one task commit/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects reuse when the existing task branch has a different base identity", async () => {
  const root = await createRepository();
  try {
    const firstManager = await createTaskWorktreeManager(root, "HEAD");
    const first = await firstManager.prepare("T1");

    await writeFile(join(root, "new-base.txt"), "new base\n");
    await git(["add", "new-base.txt"], root);
    await git(["commit", "-m", "test: advance base"], root);

    const conflictingManager = await createTaskWorktreeManager(root, "HEAD");
    await expect(conflictingManager.prepare("T1", first.baseCommit)).resolves.toEqual(first);
    await expect(conflictingManager.prepare("T1")).rejects.toThrow(
      "Task branch agile/T1 does not descend from its base commit",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires Review to inspect the exact sole clean implementation commit", async () => {
  const root = await createRepository();
  try {
    const manager = await createTaskWorktreeManager(root, "HEAD");
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
    await writeFile(join(workspace.path, "implementation.txt"), "implemented\n");

    await writeFile(join(workspace.path, "extra.txt"), "extra\n");
    await git(["add", "extra.txt"], workspace.path);
    await git(["commit", "-m", "test: forbidden second commit"], workspace.path);
    await expect(
      manager.assertReviewReady("T1", commit, workspace.baseCommit),
    ).rejects.toThrow(/exactly one task commit/i);

    const second = await manager.prepare("T2");
    await writeFile(join(second.path, "other.txt"), "other\n");
    const otherCommit = await manager.commitChanges("T2", second.baseCommit);
    await expect(
      manager.assertReviewReady("T2", commit, second.baseCommit),
    ).rejects.toThrow(/exact implementation commit/i);
    await expect(
      manager.assertReviewReady("T2", otherCommit, second.baseCommit),
    ).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked worktree directory without changing its target", async () => {
  const root = await createRepository();
  const external = await mkdtemp(join(tmpdir(), "agile-worktree-external-"));
  try {
    await mkdir(join(root, ".agile"));
    await writeFile(join(external, "sentinel.txt"), "unchanged\n");
    await symlink(external, join(root, ".agile", "worktrees"), "dir");

    await expect(createTaskWorktreeManager(root, "HEAD")).rejects.toThrow(/symbolic link/);

    expect(await readdir(external)).toEqual(["sentinel.txt"]);
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe("unchanged\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
