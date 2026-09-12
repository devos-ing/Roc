import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import type { TaskStatus } from "../domain/schemas";
import { safeTaskPathComponent } from "../domain/task-path";

export type TaskWorkspace = {
  taskId: string;
  path: string;
  branch: string;
  baseCommit: string;
};

export type TaskBranchRefresh = {
  expectedHead: string;
  expectedBase: string;
  targetBase: string;
  baseBranch: string;
};

export type TaskBranchManager = {
  /** Rebases a retained trusted patch and lease-pushes only its owned task branch. */
  refresh(taskId: string, input: TaskBranchRefresh): Promise<string>;
  /**
   * Creates or validates the retained worktree for the task. The optional
   * branch is a chain override: the ticket continues work on its predecessor's
   * branch instead of its own deterministic task branch.
   */
  prepare(
    taskId: string,
    baseCommit?: string,
    branch?: string,
  ): Promise<TaskWorkspace>;
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

/** Terminal task states whose worktrees --all may also remove. */
const OTHER_TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "rejected",
  "failed_infra",
  "retired",
];

export type RemovedTaskWorktree = {
  task: string;
  path: string;
};

export type KeptTaskWorktree = {
  task: string;
  path: string;
  reason: string;
};

export type TaskWorktreeCleanupResult = {
  /** Worktrees removed, or that a dry run would remove. */
  removed: RemovedTaskWorktree[];
  /** Worktrees retained on disk, each with the reason it was kept. */
  kept: KeptTaskWorktree[];
  /** Counts attempted removals that failed; those worktrees stay listed in kept. */
  failures: number;
};

/** Reads the absolute paths Git registers as worktrees of this checkout. */
async function registeredWorktrees(git: SimpleGit): Promise<Set<string>> {
  const output = await git.raw(["worktree", "list", "--porcelain"]);
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).trim();
    if (path === "") continue;
    try {
      paths.add(await realpath(path));
    } catch {
      // Prunable registrations that no longer resolve on disk are ignored.
    }
  }
  return paths;
}

/**
 * Enumerates task worktrees under the shared root and removes only the ones
 * whose task state is finished. Removal always runs `git worktree remove` from
 * the main checkout so Git prunes its own admin metadata; task branches are
 * never deleted, dirty worktrees are always kept, and unknown or non-worktree
 * entries under the root are reported but untouched.
 */
export async function cleanupTaskWorktrees(
  repoPath: string,
  taskStatuses: ReadonlyMap<string, TaskStatus>,
  options: { dryRun?: boolean; all?: boolean } = {},
): Promise<TaskWorktreeCleanupResult> {
  const canonicalRepo = await realpath(resolve(repoPath));
  const sourceGit = gitAt(canonicalRepo);
  if ((await sourceGit.revparse("--show-toplevel")).trim() !== canonicalRepo) {
    throw new Error("Repository path is not the Git checkout root");
  }
  const root = `${canonicalRepo}.agile-worktrees`;
  const result: TaskWorktreeCleanupResult = {
    removed: [],
    kept: [],
    failures: 0,
  };
  const rootKind = await pathKind(root);
  if (rootKind === "missing") return result;
  if (rootKind === "other")
    throw new Error("Task worktree root is not a real directory");
  let worktrees = await registeredWorktrees(sourceGit);
  for (const name of (await readdir(root)).sort()) {
    const path = resolve(root, name);
    /** Records one retained entry together with the reason its worktree was kept. */
    const keep = (reason: string) => {
      result.kept.push({ task: name, path, reason });
    };
    const kind = await pathKind(path);
    // Entries that vanished between listing and inspection are neither removed nor kept.
    if (kind === "missing") continue;
    if (kind === "other") {
      keep("Entry is not a task worktree directory");
      continue;
    }
    if (!worktrees.has(path)) {
      keep("Directory is not a registered Git worktree of this checkout");
      continue;
    }
    const status = taskStatuses.get(name);
    if (status === undefined) {
      keep("Task has no GitHub checkpoint in this repository");
      continue;
    }
    const removable =
      status === "done" ||
      (options.all === true && OTHER_TERMINAL_TASK_STATUSES.includes(status));
    if (!removable) {
      keep(
        OTHER_TERMINAL_TASK_STATUSES.includes(status)
          ? `Task status is ${status}; rerun with --all to remove its worktree`
          : `Task status is ${status}; worktrees of unfinished tasks are retained`,
      );
      continue;
    }
    const checkoutGit = gitAt(path);
    const porcelain = await checkoutGit.raw([
      "--no-optional-locks",
      "status",
      "--porcelain",
    ]);
    if (porcelain.trim() !== "") {
      keep("Worktree has uncommitted changes");
      continue;
    }
    if (options.dryRun === true) {
      result.removed.push({ task: name, path });
      continue;
    }
    try {
      await sourceGit.raw(["worktree", "remove", path]);
      worktrees = await registeredWorktrees(sourceGit);
      if (worktrees.has(path))
        throw new Error("Git still lists the worktree after removal");
      result.removed.push({ task: name, path });
    } catch (error) {
      result.failures += 1;
      keep(
        `Worktree removal failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return result;
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

/** Creates one native Git worktree per task without sharing working directories. */
export async function createTaskBranchManager(
  repoPath: string,
  baseRef: string,
): Promise<TaskBranchManager> {
  const canonicalRepo = await realpath(resolve(repoPath));
  const sourceGit = gitAt(canonicalRepo);
  if ((await sourceGit.revparse("--show-toplevel")).trim() !== canonicalRepo) {
    throw new Error("Repository path is not the Git checkout root");
  }
  const defaultBase = await fullCommit(sourceGit, baseRef);
  const root = `${canonicalRepo}.agile-worktrees`;
  if ((await pathKind(root)) === "other")
    throw new Error("Task worktree root is not a real directory");
  await mkdir(root, { recursive: true });
  const managers = new Map<
    string,
    { base: string; value: Promise<TaskBranchManager> }
  >();
  /** Resolves one task manager and rejects a changed persisted base within the session. */
  function manager(
    taskId: string,
    persistedBase?: string,
    branchOverride?: string,
  ): Promise<TaskBranchManager> {
    const safeId = safeTaskPathComponent(taskId);
    const base = persistedBase ?? defaultBase;
    if (!FULL_SHA.test(base)) throw new Error("Invalid persisted base commit");
    const existing = managers.get(safeId);
    if (existing) {
      if (existing.base !== base)
        throw new Error("Task base changed during execution");
      return existing.value;
    }
    const value = createWorktreeManager(
      canonicalRepo,
      sourceGit,
      root,
      safeId,
      base,
      branchOverride,
    );
    managers.set(safeId, { base, value });
    return value;
  }
  return {
    /** Advances the cached base only after the retained worktree and lease-push are confirmed. */
    async refresh(id, input) {
      if (
        (await pathKind(resolve(root, safeTaskPathComponent(id)))) !==
        "directory"
      )
        throw new Error("Base refresh requires a retained Roc-owned worktree");
      const value = await manager(id, input.expectedBase);
      const head = await value.refresh(id, input);
      managers.set(safeTaskPathComponent(id), {
        base: input.targetBase,
        value: Promise.resolve(value),
      });
      return head;
    },
    /** Creates or validates the retained worktree for the task. */
    async prepare(id, base, branch) {
      return (await manager(id, base, branch)).prepare(id, base);
    },
    /** Restores only the approved source changes into this task's worktree. */
    async restoreChanges(id, source, base) {
      return (await manager(id, base)).restoreChanges(id, source, base);
    },
    /** Creates or reuses the task's trusted final commit. */
    async commitChanges(id, base) {
      return (await manager(id, base)).commitChanges(id, base);
    },
    /** Verifies a commit belongs to the task branch. */
    async assertCommit(id, commit, base) {
      return (await manager(id, base)).assertCommit(id, commit, base);
    },
    /** Requires the clean task branch to match the reviewed commit exactly. */
    async assertReviewReady(id, commit, base) {
      return (await manager(id, base)).assertReviewReady(id, commit, base);
    },
    /** Reads the status of this task without switching another worktree. */
    async status(id, base) {
      return (await manager(id, base)).status(id, base);
    },
  };
}

/** Attaches a task branch to its own directory and verifies shared Git ownership. */
async function createWorktreeManager(
  canonicalRepo: string,
  sourceGit: SimpleGit,
  root: string,
  taskId: string,
  baseCommit: string,
  branchOverride?: string,
): Promise<TaskBranchManager> {
  const worktreeDir = branchOverride
    ? branchOverride.replace(/^agile\//, "")
    : taskId;
  const checkoutPath = resolve(root, worktreeDir);
  const branch = branchOverride ?? taskBranchName(taskId);
  const kind = await pathKind(checkoutPath);
  if (kind === "other")
    throw new Error("Task worktree path is not a real directory");
  await sourceGit.raw(["cat-file", "-e", `${baseCommit}^{commit}`]);
  if (kind === "missing") {
    const exists = (await sourceGit.branchLocal()).all.includes(branch);
    const remote = await fullCommit(
      sourceGit,
      `refs/remotes/origin/${branch}`,
    ).catch(() => undefined);
    await sourceGit.raw(
      exists
        ? ["worktree", "add", checkoutPath, branch]
        : ["worktree", "add", "-b", branch, checkoutPath, remote ?? baseCommit],
    );
  }
  const checkoutGit = gitAt(checkoutPath, true);
  const identityGit = gitAt(checkoutPath);
  const reportedRoot = (await identityGit.revparse("--show-toplevel")).trim();
  const sourceCommon = await realpath(
    resolve(
      canonicalRepo,
      (await sourceGit.revparse("--git-common-dir")).trim(),
    ),
  );
  const taskCommon = await realpath(
    resolve(
      checkoutPath,
      (await identityGit.revparse("--git-common-dir")).trim(),
    ),
  );
  if (
    reportedRoot !== checkoutPath ||
    sourceCommon !== taskCommon ||
    (await identityGit.status()).current !== branch
  ) {
    throw new Error(
      "Task worktree belongs to a different repository or branch",
    );
  }
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
      branch,
      baseCommit: taskBaseCommit,
    };
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
    const parents = (
      await checkoutGit.raw(["show", "-s", "--format=%P", commitSha])
    ).trim();
    if (parents !== candidate.baseCommit)
      throw new Error(
        "Trusted task commit must have exactly the recorded base as its parent",
      );
    return commitSha;
  }

  return {
    /** Replays only a clean single trusted commit onto a freshly verified target with an exact remote lease. */
    async refresh(taskId, input) {
      const candidate = workspace(taskId, input.expectedBase);
      if (
        ![input.expectedHead, input.expectedBase, input.targetBase].every(
          (sha) => FULL_SHA.test(sha),
        )
      )
        throw new Error("Invalid base refresh commit identity");
      await checkoutGit.raw([
        "check-ref-format",
        `refs/heads/${input.baseBranch}`,
      ]);
      if (
        candidate.branch === input.baseBranch ||
        input.targetBase === input.expectedBase
      )
        throw new Error("Base refresh must advance a distinct target branch");
      for (const name of [
        "rebase-merge",
        "rebase-apply",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
      ]) {
        const path = (await checkoutGit.revparse(["--git-path", name])).trim();
        if ((await pathKind(resolve(checkoutPath, path))) !== "missing")
          throw new Error(
            "Interrupted Git operation requires reconciliation before base refresh",
          );
      }
      if ((await validatedSingleCommit(candidate)) !== input.expectedHead)
        throw new Error("Task HEAD changed before base refresh");
      const targetRef = `refs/remotes/origin/${input.baseBranch}`;
      await checkoutGit.raw([
        "fetch",
        "--no-tags",
        "origin",
        `refs/heads/${input.baseBranch}:${targetRef}`,
      ]);
      if ((await fullCommit(checkoutGit, targetRef)) !== input.targetBase)
        throw new Error(
          "Target changed again before base refresh; replan required",
        );
      await checkoutGit.raw([
        "merge-base",
        "--is-ancestor",
        input.expectedBase,
        input.targetBase,
      ]);
      /** Reads the remote task ref without trusting a cached remote-tracking branch. */
      async function remoteHead(): Promise<string> {
        const output = (
          await checkoutGit.raw([
            "ls-remote",
            "--exit-code",
            "origin",
            `refs/heads/${candidate.branch}`,
          ])
        ).trim();
        const [sha, ref, extra] = output.split(/\s+/);
        if (
          !sha ||
          !FULL_SHA.test(sha) ||
          ref !== `refs/heads/${candidate.branch}` ||
          extra
        )
          throw new Error("Remote task head is missing or unreadable");
        return sha;
      }
      if ((await remoteHead()) !== input.expectedHead)
        throw new Error("External PR head changed before base refresh");
      if ((await validatedSingleCommit(candidate)) !== input.expectedHead)
        throw new Error("Task HEAD changed before base refresh");
      // Retain the old patch even if a later push or readback fails; never reset external work.
      await checkoutGit.raw([
        "update-ref",
        `refs/agile-refresh/${candidate.taskId}/${input.expectedHead}`,
        input.expectedHead,
        "0".repeat(40),
      ]);
      try {
        await checkoutGit.raw([
          "rebase",
          "--onto",
          input.targetBase,
          input.expectedBase,
          "--no-autostash",
          "--no-update-refs",
          "--no-rebase-merges",
          "--reapply-cherry-picks",
          "--empty=keep",
        ]);
      } catch {
        await checkoutGit.raw(["rebase", "--abort"]);
        throw new Error(
          "Base refresh conflicted; original task work preserved; replan required",
        );
      }
      const refreshed = workspace(taskId, input.targetBase);
      const head = await validatedSingleCommit(refreshed);
      if (
        (
          await checkoutGit.raw([
            "diff",
            "--stat",
            input.targetBase,
            head,
            "--",
          ])
        ).trim() === ""
      )
        throw new Error(
          "Base refresh produced an empty patch; replan required",
        );
      await checkoutGit.raw([
        "push",
        `--force-with-lease=refs/heads/${candidate.branch}:${input.expectedHead}`,
        "origin",
        `${head}:refs/heads/${candidate.branch}`,
      ]);
      if (
        (await remoteHead()) !== head ||
        (await validatedSingleCommit(refreshed)) !== head
      )
        throw new Error(
          "Base refresh push could not be confirmed; reconcile task history",
        );
      baseCommit = input.targetBase;
      return head;
    },
    /** Activates or creates the isolated branch for a task workspace. */
    async prepare(
      taskId: string,
      persistedBaseCommit?: string,
    ): Promise<TaskWorkspace> {
      const candidate = workspace(taskId, persistedBaseCommit);
      try {
        await checkoutGit.raw([
          "cat-file",
          "-e",
          `${candidate.baseCommit}^{commit}`,
        ]);
      } catch {
        await checkoutGit.raw(["fetch", "origin", "--prune"]);
        await checkoutGit.raw([
          "cat-file",
          "-e",
          `${candidate.baseCommit}^{commit}`,
        ]);
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

    /** Converts task changes into the single trusted final commit. */
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
      await sourceGit.raw(["update-ref", reviewRef, commitSha]);
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
