import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { safeTaskPathComponent } from "../domain/task-path";

export type TaskWorkspace = {
  taskId: string;
  path: string;
  branch: string;
  baseCommit: string;
};

export type TaskWorktreeManager = {
  prepare(taskId: string): Promise<TaskWorkspace>;
  commitChanges(taskId: string): Promise<string>;
  assertCommit(taskId: string, commitSha: string): Promise<void>;
  status(taskId: string): Promise<string>;
};

type GitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ListedWorktree = {
  path: string;
  head?: string;
  branch?: string;
};

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function spawnGit(
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<GitResult> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env }),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function git(
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<GitResult> {
  const result = await spawnGit(args, cwd, env);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!isFileError(error, "EEXIST")) throw error;
  }
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`Worktree path component is a symbolic link: ${path}`);
  if (!stats.isDirectory()) throw new Error(`Worktree path component is not a directory: ${path}`);
  if (await realpath(path) !== path) {
    throw new Error(`Worktree path component changed during validation: ${path}`);
  }
}

async function realDirectoryExists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error(`Worktree path is a symbolic link: ${path}`);
    if (!stats.isDirectory()) throw new Error(`Worktree path is not a directory: ${path}`);
    if (await realpath(path) !== path) {
      throw new Error(`Worktree path changed during validation: ${path}`);
    }
    return true;
  } catch (error) {
    if (isFileError(error, "ENOENT")) return false;
    throw error;
  }
}

function parseWorktrees(output: string): ListedWorktree[] {
  const worktrees: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export async function createTaskWorktreeManager(
  repoPath: string,
  baseRef: string,
): Promise<TaskWorktreeManager> {
  const canonicalRepo = await realpath(resolve(repoPath));
  const reportedRoot = (await git(["rev-parse", "--show-toplevel"], canonicalRepo)).stdout.trim();
  if (reportedRoot !== canonicalRepo) {
    throw new Error(`Repository path is not the Git worktree root: ${canonicalRepo}`);
  }

  const baseCommit = (
    await git(["rev-parse", "--verify", `${baseRef}^{commit}`], canonicalRepo)
  ).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(baseCommit)) {
    throw new Error(`Git did not resolve base ref to a full commit: ${baseRef}`);
  }

  const agileDirectory = join(canonicalRepo, ".agile");
  const worktreesDirectory = join(agileDirectory, "worktrees");

  async function validateWorktreeRoot(): Promise<void> {
    await ensureRealDirectory(agileDirectory);
    await ensureRealDirectory(worktreesDirectory);
  }

  function workspace(taskId: string): TaskWorkspace {
    const safeTaskId = safeTaskPathComponent(taskId);
    return {
      taskId: safeTaskId,
      path: join(worktreesDirectory, safeTaskId),
      branch: `agile/${safeTaskId}`,
      baseCommit,
    };
  }

  async function branchExists(branch: string): Promise<boolean> {
    const result = await spawnGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      canonicalRepo,
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`Could not inspect task branch ${branch}: ${result.stderr.trim()}`);
  }

  async function assertReusable(candidate: TaskWorkspace): Promise<void> {
    await validateWorktreeRoot();
    if (!(await realDirectoryExists(candidate.path))) {
      throw new Error(`Task worktree path does not exist: ${candidate.path}`);
    }
    if (!(await branchExists(candidate.branch))) {
      throw new Error(`Task worktree branch does not exist: ${candidate.branch}`);
    }

    const listed = parseWorktrees(
      (await git(["worktree", "list", "--porcelain"], canonicalRepo)).stdout,
    ).find((entry) => entry.path === candidate.path);
    const branchRef = `refs/heads/${candidate.branch}`;
    if (!listed || listed.branch !== branchRef) {
      throw new Error(`Task worktree is not registered to ${candidate.branch}: ${candidate.path}`);
    }

    const branchCommit = (
      await git(["rev-parse", "--verify", `${branchRef}^{commit}`], canonicalRepo)
    ).stdout.trim();
    if (listed.head !== branchCommit) {
      throw new Error(`Task worktree HEAD does not match branch ${candidate.branch}`);
    }

    const mergeBase = (
      await git(["merge-base", candidate.baseCommit, branchCommit], canonicalRepo)
    ).stdout.trim();
    if (mergeBase !== candidate.baseCommit) {
      throw new Error(`Task branch ${candidate.branch} does not descend from its base commit`);
    }
  }

  async function taskCommitCount(candidate: TaskWorkspace): Promise<number> {
    const branchRef = `refs/heads/${candidate.branch}`;
    const encoded = (
      await git(["rev-list", "--count", `${candidate.baseCommit}..${branchRef}`], canonicalRepo)
    ).stdout.trim();
    if (!/^\d+$/.test(encoded)) {
      throw new Error(`Git returned an invalid task commit count for ${candidate.branch}`);
    }
    return Number(encoded);
  }

  async function porcelainStatus(candidate: TaskWorkspace): Promise<string> {
    return (await git(["status", "--porcelain"], candidate.path)).stdout.trimEnd();
  }

  async function assertReachableCommit(
    candidate: TaskWorkspace,
    commitSha: string,
  ): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(commitSha)) {
      throw new Error(`Invalid full commit SHA: ${commitSha}`);
    }
    await git(["cat-file", "-e", `${commitSha}^{commit}`], canonicalRepo);
    const reachable = await spawnGit(
      ["merge-base", "--is-ancestor", commitSha, `refs/heads/${candidate.branch}`],
      canonicalRepo,
    );
    if (reachable.exitCode === 1) {
      throw new Error(`Commit is not reachable from ${candidate.branch}: ${commitSha}`);
    }
    if (reachable.exitCode !== 0) {
      throw new Error(`Could not verify commit reachability: ${reachable.stderr.trim()}`);
    }
  }

  async function validatedSingleCommit(candidate: TaskWorkspace): Promise<string> {
    await assertReusable(candidate);
    const count = await taskCommitCount(candidate);
    if (count !== 1) {
      throw new Error(
        `Task branch ${candidate.branch} must contain exactly one task commit; found ${count}`,
      );
    }
    if ((await porcelainStatus(candidate)) !== "") {
      throw new Error(`Task worktree must be clean when reusing ${candidate.branch}`);
    }
    const branchRef = `refs/heads/${candidate.branch}`;
    const commitSha = (
      await git(["rev-parse", "--verify", `${branchRef}^{commit}`], canonicalRepo)
    ).stdout.trim();
    await assertReachableCommit(candidate, commitSha);
    return commitSha;
  }

  await validateWorktreeRoot();

  return {
    async prepare(taskId: string): Promise<TaskWorkspace> {
      const candidate = workspace(taskId);
      await validateWorktreeRoot();
      const [pathExists, hasBranch] = await Promise.all([
        realDirectoryExists(candidate.path),
        branchExists(candidate.branch),
      ]);

      if (pathExists || hasBranch) {
        if (!pathExists || !hasBranch) {
          throw new Error(`Task worktree path and branch do not both exist for ${candidate.taskId}`);
        }
        await assertReusable(candidate);
        return candidate;
      }

      await git(
        ["worktree", "add", "-b", candidate.branch, candidate.path, candidate.baseCommit],
        canonicalRepo,
      );
      await assertReusable(candidate);
      return candidate;
    },

    async commitChanges(taskId: string): Promise<string> {
      const candidate = workspace(taskId);
      await assertReusable(candidate);
      const count = await taskCommitCount(candidate);

      if (count === 0) {
        if ((await porcelainStatus(candidate)) === "") {
          throw new Error(`Task worktree has no uncommitted changes: ${candidate.path}`);
        }
        await git(["add", "-A"], candidate.path);
        await git(
          [
            "-c",
            "user.name=Agile Agents",
            "-c",
            "user.email=agile-agents@local",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            `agile(${candidate.taskId}): implement ticket`,
          ],
          candidate.path,
          {
            ...process.env,
            GIT_AUTHOR_NAME: "Agile Agents",
            GIT_AUTHOR_EMAIL: "agile-agents@local",
            GIT_COMMITTER_NAME: "Agile Agents",
            GIT_COMMITTER_EMAIL: "agile-agents@local",
          },
        );
      } else if (count !== 1) {
        throw new Error(
          `Task branch ${candidate.branch} must contain exactly one task commit; found ${count}`,
        );
      }

      return validatedSingleCommit(candidate);
    },

    async assertCommit(taskId: string, commitSha: string): Promise<void> {
      const candidate = workspace(taskId);
      await assertReusable(candidate);
      await assertReachableCommit(candidate, commitSha);
    },

    async status(taskId: string): Promise<string> {
      const candidate = workspace(taskId);
      await assertReusable(candidate);
      return porcelainStatus(candidate);
    },
  };
}
