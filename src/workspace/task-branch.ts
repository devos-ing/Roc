import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import { safeTaskPathComponent } from "../domain/task-path";

export type TaskWorkspace = {
  taskId: string;
  path: string;
  branch: string;
  baseCommit: string;
};

export type TaskBranchManager = {
  prepare(taskId: string, baseCommit?: string): Promise<TaskWorkspace>;
  /** Restores an approved source commit as uncommitted task work when the branch is untouched. */
  restoreChanges(
    taskId: string,
    sourceCommit: string,
    baseCommit?: string,
  ): Promise<void>;
  commitChanges(taskId: string, baseCommit?: string): Promise<string>;
  assertCommit(
    taskId: string,
    commitSha: string,
    baseCommit?: string,
  ): Promise<void>;
  assertReviewReady(
    taskId: string,
    commitSha: string,
    baseCommit?: string,
  ): Promise<void>;
  status(taskId: string, baseCommit?: string): Promise<string>;
};

const FULL_SHA = /^[0-9a-f]{40}$/;
const TASK_BRANCH_PREFIX = "agile/";

/** Parses Git's NUL-delimited path output without losing whitespace in filenames. */
function nulDelimitedPaths(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

/** Applies a trusted patch to the scheduler checkout without invoking a shell. */
async function applySourcePatch(
  checkoutPath: string,
  patch: string,
): Promise<void> {
  const subprocess = Bun.spawn({
    cmd: [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "apply",
      "--3way",
      "--index",
      "-",
    ],
    cwd: checkoutPath,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await subprocess.stdin.write(patch);
  await subprocess.stdin.end();
  const [exitCode] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error("Approved source commit patch did not apply cleanly");
  }
}

/** Returns the deterministic remote branch name owned by a task. */
export function taskBranchName(taskId: string): string {
  return `${TASK_BRANCH_PREFIX}${safeTaskPathComponent(taskId)}`;
}

/** Creates a noninteractive SimpleGit client that can optionally use global credentials. */
function gitAt(baseDir: string, useGlobalConfig = false): SimpleGit {
  return simpleGit({
    baseDir,
    maxConcurrentProcesses: 1,
    trimmed: false,
    config: [
      "core.hooksPath=/dev/null",
      "core.fsmonitor=false",
      "commit.gpgSign=false",
      "user.name=Agile Agents",
      "user.email=agile-agents@local",
    ],
    unsafe: {
      allowUnsafeConfigPaths: true,
      allowUnsafeFsMonitor: true,
      allowUnsafeHooksPath: true,
    },
  }).env({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    ...(useGlobalConfig
      ? {
          HOME: process.env.HOME ?? homedir(),
          ...(process.env.XDG_CONFIG_HOME === undefined
            ? {}
            : { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }),
          ...(process.env.GIT_CONFIG_GLOBAL === undefined
            ? {}
            : { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }),
        }
      : { GIT_CONFIG_GLOBAL: "/dev/null" }),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Agile Agents",
    GIT_AUTHOR_EMAIL: "agile-agents@local",
    GIT_COMMITTER_NAME: "Agile Agents",
    GIT_COMMITTER_EMAIL: "agile-agents@local",
  });
}

/** Classifies a path as missing, a real directory, or an unsafe other entry. */
async function pathKind(
  path: string,
): Promise<"missing" | "directory" | "other"> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? "directory" : "other";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "missing";
    throw error;
  }
}

/** Resolves a Git ref to a validated full commit SHA. */
async function fullCommit(git: SimpleGit, ref: string): Promise<string> {
  const commit = (await git.revparse(["--verify", `${ref}^{commit}`])).trim();
  if (!FULL_SHA.test(commit)) {
    throw new Error(`Git did not resolve ref to a full commit: ${ref}`);
  }
  return commit;
}

/** Builds the trusted final commit subject for a task. */
function finalMessage(taskId: string): string {
  return `agile(${taskId}): implement ticket`;
}

/** Builds the temporary checkpoint commit subject for a task. */
function checkpointMessage(taskId: string): string {
  return `agile(${taskId}): WIP checkpoint`;
}

/** Reports whether a Git remote uses a URL rather than a local filesystem path. */
function isRemoteUrl(remote: string): boolean {
  return (
    /^[a-z][a-z\d+.-]*:\/\//i.test(remote) ||
    /^(?:[^/\s:@]+@)?[^/\s:]+:(?![\\/]).+$/.test(remote)
  );
}

/** Verifies that a local remote points to the source scheduler repository. */
async function isSourceRepositoryRemote(
  remote: string,
  checkoutPath: string,
  canonicalRepo: string,
): Promise<boolean> {
  if (isRemoteUrl(remote)) return false;
  return (
    (await realpath(resolve(dirname(checkoutPath), remote))) === canonicalRepo
  );
}

/** Creates a branch manager backed by a dedicated validated scheduler checkout. */
export async function createTaskBranchManager(
  repoPath: string,
  baseRef: string,
): Promise<TaskBranchManager> {
  const canonicalRepo = await realpath(resolve(repoPath));
  const sourceGit = gitAt(canonicalRepo);
  const reportedRoot = (await sourceGit.revparse("--show-toplevel")).trim();
  if (reportedRoot !== canonicalRepo) {
    throw new Error(
      `Repository path is not the Git checkout root: ${canonicalRepo}`,
    );
  }
  const sourceOrigin = (await sourceGit.getRemotes()).some(
    (remote) => remote.name === "origin",
  )
    ? (
        await sourceGit.raw(["config", "--local", "--get", "remote.origin.url"])
      ).trim()
    : undefined;

  const baseCommit = await fullCommit(sourceGit, baseRef);
  const checkoutPath = `${canonicalRepo}.agile-checkout`;
  const checkoutKind = await pathKind(checkoutPath);
  if (checkoutKind === "other") {
    throw new Error(
      `Scheduler checkout path is not a real directory: ${checkoutPath}`,
    );
  }

  if (checkoutKind === "missing") {
    await sourceGit.clone(canonicalRepo, checkoutPath, ["--no-checkout"]);
  }

  const checkoutGit = gitAt(checkoutPath, true);
  const checkoutIdentityGit = gitAt(checkoutPath);
  const checkoutRoot = (await checkoutGit.revparse("--show-toplevel")).trim();
  if (checkoutRoot !== checkoutPath) {
    throw new Error(
      `Scheduler checkout path is not its Git root: ${checkoutPath}`,
    );
  }
  const origin = (
    await checkoutIdentityGit.raw([
      "config",
      "--local",
      "--get",
      "remote.origin.url",
    ])
  ).trim();
  const sourceRepositoryRemote = await isSourceRepositoryRemote(
    origin,
    checkoutPath,
    canonicalRepo,
  );
  if (sourceOrigin === undefined && !sourceRepositoryRemote) {
    throw new Error(
      `Scheduler checkout belongs to a different repository: ${checkoutPath}`,
    );
  }
  if (
    sourceOrigin !== undefined &&
    origin !== sourceOrigin &&
    !sourceRepositoryRemote
  ) {
    throw new Error(
      `Scheduler checkout belongs to a different repository: ${checkoutPath}`,
    );
  }
  if (sourceOrigin !== undefined && origin !== sourceOrigin) {
    await checkoutGit.raw(["remote", "set-url", "origin", sourceOrigin]);
  }

  if (checkoutKind === "missing") {
    await checkoutGit.checkout(baseCommit, ["--detach"]);
  } else {
    await checkoutGit.raw(["fetch", "origin", "--prune"]);
  }
  await checkoutGit.raw(["cat-file", "-e", `${baseCommit}^{commit}`]);

  /** Builds and validates the workspace identity for a task branch. */
  function workspace(
    taskId: string,
    persistedBaseCommit?: string,
  ): TaskWorkspace {
    const safeTaskId = safeTaskPathComponent(taskId);
    const taskBaseCommit = persistedBaseCommit ?? baseCommit;
    if (!FULL_SHA.test(taskBaseCommit)) {
      throw new Error(`Invalid persisted base commit: ${taskBaseCommit}`);
    }
    return {
      taskId: safeTaskId,
      path: checkoutPath,
      branch: taskBranchName(safeTaskId),
      baseCommit: taskBaseCommit,
    };
  }

  /** Reports whether a local task branch already exists. */
  async function branchExists(branch: string): Promise<boolean> {
    return (await checkoutGit.branchLocal()).all.includes(branch);
  }

  /** Returns the checkout's raw porcelain status without trailing whitespace. */
  async function porcelainStatus(): Promise<string> {
    return (await checkoutGit.raw(["status", "--porcelain"])).trimEnd();
  }

  /** Returns the subject line for a commit reference. */
  async function subject(ref = "HEAD"): Promise<string> {
    return (await checkoutGit.raw(["show", "-s", "--format=%s", ref])).trim();
  }

  /** Verifies that a task branch descends from its persisted base commit. */
  async function assertBase(candidate: TaskWorkspace): Promise<void> {
    await checkoutGit.raw([
      "cat-file",
      "-e",
      `${candidate.baseCommit}^{commit}`,
    ]);
    const mergeBase = (
      await checkoutGit.raw([
        "merge-base",
        candidate.baseCommit,
        `refs/heads/${candidate.branch}`,
      ])
    ).trim();
    if (mergeBase !== candidate.baseCommit) {
      throw new Error(
        `Task branch ${candidate.branch} does not descend from its base commit`,
      );
    }
  }

  /** Verifies that a task branch is active and still based on its expected commit. */
  async function assertActive(candidate: TaskWorkspace): Promise<void> {
    const current = (await checkoutGit.status()).current;
    if (current !== candidate.branch) {
      throw new Error(
        `Task branch ${candidate.branch} is not active in the scheduler checkout`,
      );
    }
    await assertBase(candidate);
  }

  /** Counts commits introduced by a task branch after its base commit. */
  async function taskCommitCount(candidate: TaskWorkspace): Promise<number> {
    const encoded = (
      await checkoutGit.raw([
        "rev-list",
        "--count",
        `${candidate.baseCommit}..refs/heads/${candidate.branch}`,
      ])
    ).trim();
    if (!/^\d+$/.test(encoded)) {
      throw new Error(
        `Git returned an invalid task commit count for ${candidate.branch}`,
      );
    }
    return Number(encoded);
  }

  /** Checkpoints dirty work on the active task branch before switching branches. */
  async function checkpointBeforeSwitch(nextBranch: string): Promise<void> {
    const status = await checkoutGit.status();
    if (status.current === nextBranch || status.isClean()) return;
    if (
      status.current === null ||
      !status.current.startsWith(TASK_BRANCH_PREFIX)
    ) {
      throw new Error("Scheduler checkout is dirty outside a task branch");
    }

    const activeTaskId = safeTaskPathComponent(
      status.current.slice(TASK_BRANCH_PREFIX.length),
    );
    const currentSubject = await subject();
    if (currentSubject === finalMessage(activeTaskId)) {
      throw new Error(`Completed task branch ${status.current} became dirty`);
    }

    await checkoutGit.add("-A");
    if (currentSubject === checkpointMessage(activeTaskId)) {
      await checkoutGit.raw(["commit", "--amend", "--no-edit"]);
    } else {
      await checkoutGit.commit(checkpointMessage(activeTaskId));
    }
  }

  /** Verifies that a full commit SHA is reachable from the expected task branch. */
  async function assertReachableCommit(
    candidate: TaskWorkspace,
    commitSha: string,
  ): Promise<void> {
    if (!FULL_SHA.test(commitSha)) {
      throw new Error(`Invalid full commit SHA: ${commitSha}`);
    }
    await checkoutGit.raw(["cat-file", "-e", `${commitSha}^{commit}`]);
    const containing = (
      await checkoutGit.raw([
        "branch",
        "--format=%(refname:short)",
        "--contains",
        commitSha,
      ])
    )
      .split("\n")
      .map((branch) => branch.trim())
      .filter(Boolean);
    if (!containing.includes(candidate.branch)) {
      throw new Error(
        `Commit is not reachable from ${candidate.branch}: ${commitSha}`,
      );
    }
  }

  /** Returns the trusted final commit after validating branch history and cleanliness. */
  async function validatedSingleCommit(
    candidate: TaskWorkspace,
  ): Promise<string> {
    await assertActive(candidate);
    const count = await taskCommitCount(candidate);
    if (count !== 1) {
      throw new Error(
        `Task branch ${candidate.branch} must contain exactly one task commit; found ${count}`,
      );
    }
    if ((await porcelainStatus()) !== "") {
      throw new Error(`Task branch ${candidate.branch} must be clean`);
    }
    if (
      (await subject(`refs/heads/${candidate.branch}`)) !==
      finalMessage(candidate.taskId)
    ) {
      throw new Error(
        `Task branch ${candidate.branch} does not contain the trusted final commit`,
      );
    }
    const commitSha = await fullCommit(
      checkoutGit,
      `refs/heads/${candidate.branch}`,
    );
    await assertReachableCommit(candidate, commitSha);
    return commitSha;
  }

  return {
    /** Activates or creates the isolated branch for a task workspace. */
    async prepare(
      taskId: string,
      persistedBaseCommit?: string,
    ): Promise<TaskWorkspace> {
      const candidate = workspace(taskId, persistedBaseCommit);
      await checkoutGit.raw([
        "cat-file",
        "-e",
        `${candidate.baseCommit}^{commit}`,
      ]);
      await checkpointBeforeSwitch(candidate.branch);

      if (await branchExists(candidate.branch)) {
        await assertBase(candidate);
        await checkoutGit.checkout(candidate.branch);
      } else {
        await checkoutGit.checkoutBranch(
          candidate.branch,
          candidate.baseCommit,
        );
      }
      await assertActive(candidate);
      return candidate;
    },

    /** Restores an approved source commit into an untouched task branch without creating a commit. */
    async restoreChanges(
      taskId: string,
      sourceCommit: string,
      persistedBaseCommit?: string,
    ): Promise<void> {
      const candidate = workspace(taskId, persistedBaseCommit);
      await assertActive(candidate);
      if (!FULL_SHA.test(sourceCommit)) {
        throw new Error(`Invalid full source commit SHA: ${sourceCommit}`);
      }
      await sourceGit.raw(["cat-file", "-e", `${sourceCommit}^{commit}`]);
      const sourceRef = `refs/agile-source/${candidate.taskId}`;
      const recordedSourceCommit = await fullCommit(
        checkoutGit,
        sourceRef,
      ).catch(() => undefined);
      if (
        (await taskCommitCount(candidate)) !== 0 ||
        (await porcelainStatus()) !== ""
      ) {
        if (recordedSourceCommit === sourceCommit) return;
        throw new Error(
          `Task branch ${candidate.branch} has unmarked work before approved source restoration`,
        );
      }
      const ancestry = (
        await sourceGit.raw(["rev-list", "--parents", "-n", "1", sourceCommit])
      )
        .trim()
        .split(/\s+/);
      if (ancestry.length !== 2 || ancestry[0] !== sourceCommit) {
        throw new Error(
          `Source commit ${sourceCommit} must have exactly one parent`,
        );
      }
      const sourceParent = ancestry[1];
      if (sourceParent === undefined || !FULL_SHA.test(sourceParent)) {
        throw new Error(`Source commit ${sourceCommit} has an invalid parent`);
      }

      const sourceChangedPaths = new Set(
        nulDelimitedPaths(
          await sourceGit.raw([
            "diff",
            "--name-only",
            "-z",
            sourceParent,
            sourceCommit,
            "--",
          ]),
        ),
      );
      const changedPaths = nulDelimitedPaths(
        await sourceGit.raw([
          "diff",
          "--name-only",
          "-z",
          candidate.baseCommit,
          sourceCommit,
          "--",
        ]),
      ).filter((path) => sourceChangedPaths.has(path));
      if (changedPaths.length === 0) {
        throw new Error(
          `Source commit ${sourceCommit} has no changes from task base ${candidate.baseCommit}`,
        );
      }

      const patch = await sourceGit.raw([
        "diff",
        "--binary",
        sourceParent,
        sourceCommit,
        "--",
        ...changedPaths,
      ]);
      if (patch === "") {
        throw new Error(`Source commit ${sourceCommit} produced no patch`);
      }

      await checkoutGit.raw([
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        canonicalRepo,
        sourceCommit,
      ]);
      try {
        await applySourcePatch(checkoutPath, patch);
        await checkoutGit.raw(["update-ref", sourceRef, sourceCommit]);
      } catch (error) {
        await checkoutGit.raw(["reset", "--hard", "HEAD"]);
        await checkoutGit.raw(["update-ref", "-d", sourceRef]);
        throw error;
      }
      if ((await porcelainStatus()) === "") {
        throw new Error(
          `Source commit ${sourceCommit} did not restore task changes`,
        );
      }
    },

    /** Converts task changes or a checkpoint into the single trusted final commit. */
    async commitChanges(
      taskId: string,
      persistedBaseCommit?: string,
    ): Promise<string> {
      const candidate = workspace(taskId, persistedBaseCommit);
      await assertActive(candidate);
      const count = await taskCommitCount(candidate);
      const dirty = (await porcelainStatus()) !== "";

      if (count === 0) {
        if (!dirty) {
          throw new Error(
            `Task branch ${candidate.branch} has no uncommitted changes`,
          );
        }
        await checkoutGit.add("-A");
        await checkoutGit.commit(finalMessage(candidate.taskId));
      } else if (
        count === 1 &&
        (await subject()) === checkpointMessage(candidate.taskId)
      ) {
        if (dirty) await checkoutGit.add("-A");
        await checkoutGit.raw([
          "commit",
          "--amend",
          "-m",
          finalMessage(candidate.taskId),
        ]);
      } else if (count !== 1) {
        throw new Error(
          `Task branch ${candidate.branch} must contain exactly one task commit; found ${count}`,
        );
      } else if (dirty) {
        throw new Error(`Task branch ${candidate.branch} must be clean`);
      }

      return validatedSingleCommit(candidate);
    },

    /** Verifies that a reported implementation commit belongs to the active task branch. */
    async assertCommit(
      taskId: string,
      commitSha: string,
      persistedBaseCommit?: string,
    ): Promise<void> {
      const candidate = workspace(taskId, persistedBaseCommit);
      await assertActive(candidate);
      await assertReachableCommit(candidate, commitSha);
    },

    /** Verifies that review targets the exact trusted final task commit. */
    async assertReviewReady(
      taskId: string,
      commitSha: string,
      persistedBaseCommit?: string,
    ): Promise<void> {
      const candidate = workspace(taskId, persistedBaseCommit);
      const branchCommit = await validatedSingleCommit(candidate);
      if (branchCommit !== commitSha) {
        throw new Error(
          `Task branch ${candidate.branch} HEAD is not the exact implementation commit ${commitSha}`,
        );
      }
      const reviewRef = `refs/agile-review/${candidate.taskId}`;
      await sourceGit.raw([
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        checkoutPath,
        `refs/heads/${candidate.branch}:${reviewRef}`,
      ]);
      if ((await fullCommit(sourceGit, reviewRef)) !== commitSha) {
        throw new Error(
          `Detached Review ref is not the exact implementation commit ${commitSha}`,
        );
      }
    },

    /** Returns the porcelain status for an active validated task workspace. */
    async status(
      taskId: string,
      persistedBaseCommit?: string,
    ): Promise<string> {
      const candidate = workspace(taskId, persistedBaseCommit);
      await assertActive(candidate);
      return porcelainStatus();
    },
  };
}
