import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runGit } from "./command.mjs";
import {
  ChangeStore,
  readChange,
  STATE_VERSION,
  writeJsonAtomic,
} from "./state.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const CHANGE_ID = /^[a-z0-9][a-z0-9-]{5,63}$/u;

/** Returns whether a path exists without following its value into application logic. */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the repository root and common Git directory for a working path. */
async function repositoryIdentity(cwd) {
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  if (root.exitCode !== 0) return undefined;
  const repoRoot = await realpath(root.stdout);
  const common = (await runGit(repoRoot, ["rev-parse", "--git-common-dir"]))
    .stdout;
  return {
    repoRoot,
    commonDir: resolve(repoRoot, common),
  };
}

/** Derives a publishable target branch from a requested or remote-default ref. */
async function resolveBase(identity, requested) {
  const ref = requested ?? "refs/remotes/origin/HEAD";
  let resolved = await runGit(
    identity.repoRoot,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { allowFailure: true },
  );
  let baseBranch;
  if (resolved.exitCode !== 0 && requested === undefined) {
    resolved = await runGit(identity.repoRoot, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    const current = await runGit(identity.repoRoot, [
      "branch",
      "--show-current",
    ]);
    baseBranch = current.stdout || undefined;
  } else if (requested === undefined) {
    const symbolic = await runGit(
      identity.repoRoot,
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { allowFailure: true },
    );
    baseBranch = symbolic.stdout.replace(/^origin\//u, "") || undefined;
  } else if (/^(?:refs\/heads\/)?[A-Za-z0-9._/-]+$/u.test(requested)) {
    baseBranch = requested
      .replace(/^refs\/heads\//u, "")
      .replace(/^origin\//u, "");
  }
  if (resolved.exitCode !== 0 || !FULL_SHA.test(resolved.stdout)) {
    throw new Error(`Cannot resolve OpenAmp base ref: ${ref}`);
  }
  return { baseCommit: resolved.stdout, baseBranch };
}

/** Returns the durable change-state path for one repository identity. */
function repositoryStatePath(identity, id) {
  return join(identity.commonDir, "openamp", "changes", `${id}.json`);
}

/** Returns the fallback state path used for a conversation outside Git. */
function globalStatePath(id) {
  return join(homedir(), ".openamp", "changes", `${id}.json`);
}

/** Opens an existing change after validating its durable workspace identity. */
export async function resumeChange(cwd, id) {
  if (!CHANGE_ID.test(id)) throw new Error(`Invalid OpenAmp change ID: ${id}`);
  const identity = await repositoryIdentity(cwd);
  const candidates = [
    ...(identity ? [repositoryStatePath(identity, id)] : []),
    globalStatePath(id),
  ];
  let resolvedPath;
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      resolvedPath = candidate;
      break;
    }
  }
  if (!resolvedPath) throw new Error(`OpenAmp change not found: ${id}`);
  const state = await readChange(resolvedPath);
  if (!(await exists(state.workspace))) {
    throw new Error(`OpenAmp workspace is missing: ${state.workspace}`);
  }
  if (state.repoRoot) {
    const actual = await repositoryIdentity(state.workspace);
    if (!actual || actual.commonDir !== state.commonDir) {
      throw new Error("OpenAmp workspace belongs to a different repository");
    }
    const branch = (await runGit(state.workspace, ["branch", "--show-current"]))
      .stdout;
    if (branch !== state.branch) {
      throw new Error(
        `OpenAmp workspace branch changed: ${branch || "detached"}`,
      );
    }
  }
  for (const run of Object.values(state.runs)) {
    if (["starting", "running", "cancelling"].includes(run.status)) {
      run.status = "interrupted";
      run.finishedAt = new Date().toISOString();
    }
  }
  const store = new ChangeStore(resolvedPath, state);
  await store.update(() => undefined);
  return store;
}

/** Creates a dedicated feature workspace while preserving the source checkout untouched. */
export async function createChange(cwd, options = {}) {
  const id = options.id ?? `change-${crypto.randomUUID().slice(0, 12)}`;
  if (!CHANGE_ID.test(id)) throw new Error(`Invalid OpenAmp change ID: ${id}`);
  const identity = await repositoryIdentity(cwd);
  const now = new Date().toISOString();
  if (!identity) {
    const path = globalStatePath(id);
    const state = {
      version: STATE_VERSION,
      id,
      createdAt: now,
      updatedAt: now,
      repoRoot: null,
      commonDir: null,
      sourceCwd: resolve(cwd),
      workspace: resolve(cwd),
      branch: null,
      baseBranch: null,
      baseCommit: null,
      mainHead: null,
      sessionId: null,
      sessionFile: null,
      phase: "conversation",
      runs: {},
      results: {},
      integratedResultIds: [],
      review: null,
      publication: null,
      commandLedger: [],
    };
    await writeJsonAtomic(path, state);
    return new ChangeStore(path, state);
  }

  const { baseCommit, baseBranch } = await resolveBase(identity, options.base);
  const branch = `openamp/${id}`;
  const worktreeRoot = `${identity.repoRoot}.openamp-worktrees`;
  const workspace = join(worktreeRoot, id);
  await mkdir(worktreeRoot, { recursive: true });
  if (await exists(workspace)) {
    throw new Error(`OpenAmp workspace already exists: ${workspace}`);
  }
  await runGit(identity.repoRoot, [
    "worktree",
    "add",
    "-b",
    branch,
    workspace,
    baseCommit,
  ]);
  const path = repositoryStatePath(identity, id);
  const state = {
    version: STATE_VERSION,
    id,
    createdAt: now,
    updatedAt: now,
    repoRoot: identity.repoRoot,
    commonDir: identity.commonDir,
    sourceCwd: resolve(cwd),
    workspace,
    branch,
    baseBranch: baseBranch ?? null,
    baseCommit,
    mainHead: baseCommit,
    sessionId: null,
    sessionFile: null,
    phase: "active",
    runs: {},
    results: {},
    integratedResultIds: [],
    review: null,
    publication: null,
    commandLedger: [],
  };
  await writeJsonAtomic(path, state);
  return new ChangeStore(path, state);
}

/** Owns local Git mutations for one OpenAmp feature workspace. */
export class ChangeWorkspace {
  /** Binds workspace operations to a durable change store. */
  constructor(store) {
    this.store = store;
  }

  /** Returns the current full feature-branch head. */
  async head() {
    if (!this.store.state.repoRoot) return null;
    return (await runGit(this.store.state.workspace, ["rev-parse", "HEAD"]))
      .stdout;
  }

  /** Returns the feature workspace's porcelain status. */
  async status() {
    if (!this.store.state.repoRoot) return "";
    return (await runGit(this.store.state.workspace, ["status", "--porcelain"]))
      .stdout;
  }

  /** Commits pending main-agent changes and records the resulting checkpoint. */
  async checkpoint(message = "openamp: checkpoint conversation changes") {
    if (!this.store.state.repoRoot) return null;
    if ((await this.status()) !== "") {
      await runGit(this.store.state.workspace, ["add", "-A"]);
      await runGit(this.store.state.workspace, ["commit", "-m", message]);
    }
    const head = await this.head();
    await this.store.update((state) => {
      state.mainHead = head;
      state.review = null;
    });
    return head;
  }

  /** Creates a writer worktree from a clean, recorded feature checkpoint. */
  async createAgentWorkspace(runId) {
    if (!this.store.state.repoRoot) {
      throw new Error(
        "Writing delegation is unavailable outside a Git repository",
      );
    }
    const baseCommit = await this.checkpoint();
    const root = `${this.store.state.repoRoot}.openamp-agents`;
    const path = join(root, this.store.state.id, runId);
    const branch = `openamp-agent/${this.store.state.id}/${runId}`;
    await mkdir(dirname(path), { recursive: true });
    await runGit(this.store.state.repoRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      path,
      baseCommit,
    ]);
    return { path, branch, baseCommit };
  }

  /** Commits a writer's pending changes and validates its exact branch result. */
  async finalizeAgentWorkspace(workspace, runId) {
    const branch = (await runGit(workspace.path, ["branch", "--show-current"]))
      .stdout;
    if (branch !== workspace.branch)
      throw new Error("Agent worktree branch changed");
    const status = (await runGit(workspace.path, ["status", "--porcelain"]))
      .stdout;
    if (status !== "") {
      await runGit(workspace.path, ["add", "-A"]);
      await runGit(workspace.path, [
        "commit",
        "-m",
        `openamp(${runId}): delegated changes`,
      ]);
    }
    const head = (await runGit(workspace.path, ["rev-parse", "HEAD"])).stdout;
    const ancestry = await runGit(
      workspace.path,
      ["merge-base", "--is-ancestor", workspace.baseCommit, head],
      { allowFailure: true },
    );
    if (ancestry.exitCode !== 0)
      throw new Error("Agent result changed its fixed base history");
    if (
      (await runGit(workspace.path, ["status", "--porcelain"])).stdout !== ""
    ) {
      throw new Error("Agent result worktree is not clean");
    }
    return { ...workspace, head, changed: head !== workspace.baseCommit };
  }

  /** Integrates one verified result exactly once and records uncertain conflicts without replay. */
  async integrate(resultId) {
    const state = this.store.state;
    if (state.integratedResultIds.includes(resultId)) return await this.head();
    const result = state.results[resultId];
    if (!result?.commit || !result?.baseCommit) {
      throw new Error(`Result is not an integrable writer result: ${resultId}`);
    }
    if ((await this.status()) !== "") {
      throw new Error("Feature workspace must be clean before integration");
    }
    const expectedHead = await this.head();
    await this.store.update((draft) => {
      draft.integration = { resultId, expectedHead, status: "pending" };
    });
    const commits = (
      await runGit(state.workspace, [
        "rev-list",
        "--reverse",
        `${result.baseCommit}..${result.commit}`,
      ])
    ).stdout
      .split("\n")
      .filter(Boolean);
    if (commits.length === 0)
      throw new Error("Agent result contains no commits");
    const current = await this.head();
    if (current !== expectedHead)
      throw new Error("Feature head changed before integration");
    const applied = await runGit(state.workspace, ["cherry-pick", ...commits], {
      allowFailure: true,
    });
    if (applied.exitCode !== 0) {
      await this.store.update((draft) => {
        draft.phase = "needs_attention";
        draft.integration.status = "conflict";
        draft.integration.error = applied.stderr || applied.stdout;
      });
      throw new Error(
        "Integration conflicted; worktrees and conflict state were preserved",
      );
    }
    const head = await this.head();
    await this.store.update((draft) => {
      draft.mainHead = head;
      draft.integratedResultIds.push(resultId);
      draft.integration = {
        resultId,
        expectedHead,
        status: "integrated",
        head,
      };
      draft.review = null;
      draft.phase = "active";
    });
    return head;
  }

  /** Requires a clean feature branch at the state-recorded head. */
  async assertReady() {
    if (!this.store.state.repoRoot)
      throw new Error("Delivery requires a Git repository");
    if ((await this.status()) !== "")
      throw new Error("Feature workspace is not clean");
    const head = await this.head();
    if (head !== this.store.state.mainHead) {
      throw new Error("Feature workspace head does not match durable state");
    }
    return head;
  }
}
