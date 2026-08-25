import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

test("rejects reuse when the existing task branch has a different base identity", async () => {
  const root = await createRepository();
  try {
    const firstManager = await createTaskWorktreeManager(root, "HEAD");
    await firstManager.prepare("T1");

    await writeFile(join(root, "new-base.txt"), "new base\n");
    await git(["add", "new-base.txt"], root);
    await git(["commit", "-m", "test: advance base"], root);

    const conflictingManager = await createTaskWorktreeManager(root, "HEAD");
    await expect(conflictingManager.prepare("T1")).rejects.toThrow(
      "Task branch agile/T1 does not descend from its base commit",
    );
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
