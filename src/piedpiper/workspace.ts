import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { runGit } from "./command.js";
import {
  type ChangeState,
  ChangeStore,
  readChange,
  STATE_VERSION,
  writeJsonAtomic,
} from "./state.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const CHANGE_ID = /^[a-z0-9][a-z0-9-]{5,63}$/u;
const SESSION_ID = /^[a-z0-9][a-z0-9._-]*$/iu;

/** Identifies the repository root and shared Git metadata directory. */
interface RepositoryIdentity {
  repoRoot: string;
  commonDir: string;
}

export interface AgentWorkspace {
  path: string;
  branch: string;
  baseCommit: string;
}

/** Returns whether a path exists without following its value into application logic. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the repository root and common Git directory for a working path. */
async function repositoryIdentity(
  cwd: string,
): Promise<RepositoryIdentity | undefined> {
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
async function resolveBase(
  identity: RepositoryIdentity,
  requested?: string,
): Promise<{ baseCommit: string; baseBranch?: string }> {
  const ref = requested ?? "refs/remotes/origin/HEAD";
  let resolved = await runGit(
    identity.repoRoot,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { allowFailure: true },
  );
  let baseBranch: string | undefined;
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
    throw new Error(`Cannot resolve Pied Piper base ref: ${ref}`);
  }
  return { baseCommit: resolved.stdout, baseBranch };
}

/** Returns the durable change-state path for one repository identity. */
function repositoryStatePath(identity: RepositoryIdentity, id: string): string {
  return join(identity.commonDir, "piedpiper", "changes", `${id}.json`);
}

/** Returns the repository state path used before the technical rename. */
function legacyRepositoryStatePath(
  identity: RepositoryIdentity,
  id: string,
): string {
  return join(identity.commonDir, "openamp", "changes", `${id}.json`);
}

/** Returns the fallback state path used for a conversation outside Git. */
function globalStatePath(id: string): string {
  return join(homedir(), ".piedpiper", "changes", `${id}.json`);
}

/** Returns the global state path used before the technical rename. */
function legacyGlobalStatePath(id: string): string {
  return join(homedir(), ".openamp", "changes", `${id}.json`);
}

/** Returns the main or child Pi session directory for a change. */
export function sessionDirectory(
  state: Pick<ChangeState, "commonDir">,
  agents = false,
): string {
  const root = state.commonDir
    ? join(state.commonDir, "piedpiper")
    : join(homedir(), ".piedpiper");
  return join(root, "sessions", ...(agents ? ["agents"] : []));
}

/** Returns whether a candidate path stays inside an expected parent directory. */
function isInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

/** Creates an owned private directory while rejecting symlinked destinations. */
async function ensurePrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Pied Piper session destination conflicts: ${path}`);
    }
    await chmod(path, 0o700);
    return;
  }
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

/** Creates and validates the private session directory owned by Pied Piper. */
async function ensureSessionDirectory(state: ChangeState): Promise<string> {
  let current = state.commonDir ?? (await realpath(homedir()));
  for (const segment of [
    state.commonDir ? "piedpiper" : ".piedpiper",
    "sessions",
  ]) {
    current = join(current, segment);
    await ensurePrivateDirectory(current);
  }
  return current;
}

/** Copies a session file or archive while rejecting links and conflicting bytes. */
async function copySessionPath(
  source: string,
  destination: string,
): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Pied Piper session source cannot be a symlink: ${source}`);
  }
  if (sourceStat.isDirectory()) {
    await ensurePrivateDirectory(dirname(destination));
    await ensurePrivateDirectory(destination);
    for (const entry of await readdir(source)) {
      await copySessionPath(join(source, entry), join(destination, entry));
    }
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(
      `Pied Piper session source is not a regular file: ${source}`,
    );
  }
  const destinationStat = await lstat(destination).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  });
  if (destinationStat) {
    if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
      throw new Error(
        `Pied Piper session destination conflicts: ${destination}`,
      );
    }
    const [sourceBytes, destinationBytes] = await Promise.all([
      readFile(source),
      readFile(destination),
    ]);
    if (!sourceBytes.equals(destinationBytes)) {
      throw new Error(
        `Pied Piper session destination conflicts: ${destination}`,
      );
    }
  } else {
    await copyFile(source, destination);
  }
  await chmod(destination, 0o600);
}

/** Copies a legacy active session and its archive into Pied Piper storage. */
async function migrateLegacySession(state: ChangeState): Promise<void> {
  if (!state.sessionFile) return;
  if (state.sessionId && !SESSION_ID.test(state.sessionId)) {
    throw new Error("Pied Piper session ID is unsafe");
  }
  const source = resolve(state.sessionFile);
  const legacyRoot = state.commonDir
    ? join(state.commonDir, "openamp", "sessions")
    : join(homedir(), ".openamp", "changes", "sessions");
  const [sourceStat, resolvedLegacyRoot, resolvedSource] = await Promise.all([
    lstat(source),
    realpath(legacyRoot),
    realpath(source),
  ]);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error("Pied Piper legacy session must be a regular file");
  }
  if (!isInside(resolvedLegacyRoot, resolvedSource)) {
    throw new Error("Pied Piper legacy session is outside its session root");
  }
  const destinationRoot = await ensureSessionDirectory(state);
  const destination = join(destinationRoot, basename(resolvedSource));
  await copySessionPath(resolvedSource, destination);
  if (state.sessionId) {
    const archive = join(dirname(resolvedSource), "sol-pi", state.sessionId);
    if (await exists(archive)) {
      const archiveRoot = join(destinationRoot, "sol-pi");
      await ensurePrivateDirectory(archiveRoot);
      await copySessionPath(archive, join(archiveRoot, state.sessionId));
    }
  }
  state.sessionFile = destination;
}

/** Reconciles a crash between a completed cherry-pick and its durable receipt. */
async function reconcilePendingIntegration(state: ChangeState): Promise<void> {
  const integration = state.integration;
  if (!state.repoRoot || integration?.status !== "pending") return;
  const result = state.results[integration.resultId];
  const currentHead = (await runGit(state.workspace, ["rev-parse", "HEAD"]))
    .stdout;
  if (currentHead === integration.expectedHead) return;
  const status = (await runGit(state.workspace, ["status", "--porcelain"]))
    .stdout;
  let reconciled = false;
  if (
    status === "" &&
    integration.expectedHead &&
    result?.commit &&
    result?.baseCommit
  ) {
    const [ancestry, currentCount, resultCount, currentDiff, resultDiff] =
      await Promise.all([
        runGit(
          state.workspace,
          [
            "merge-base",
            "--is-ancestor",
            integration.expectedHead,
            currentHead,
          ],
          { allowFailure: true },
        ),
        runGit(state.workspace, [
          "rev-list",
          "--count",
          `${integration.expectedHead}..${currentHead}`,
        ]),
        runGit(state.workspace, [
          "rev-list",
          "--count",
          `${result.baseCommit}..${result.commit}`,
        ]),
        runGit(state.workspace, [
          "diff",
          "--binary",
          integration.expectedHead,
          currentHead,
        ]),
        runGit(state.workspace, [
          "diff",
          "--binary",
          result.baseCommit,
          result.commit,
        ]),
      ]);
    reconciled =
      ancestry.exitCode === 0 &&
      currentCount.stdout === resultCount.stdout &&
      currentDiff.stdout === resultDiff.stdout;
  }
  if (reconciled) {
    state.mainHead = currentHead;
    if (!state.integratedResultIds.includes(integration.resultId)) {
      state.integratedResultIds.push(integration.resultId);
    }
    state.integration = {
      ...integration,
      status: "integrated",
      head: currentHead,
    };
    state.review = null;
    state.phase = "active";
    return;
  }
  state.phase = "needs_attention";
  state.integration = {
    ...integration,
    status: "unknown",
    error: "Feature head changed while integration receipt was pending",
  };
}

/** Marks crash-interrupted remote mutations unknown when publication still requires reconciliation. */
function reconcilePendingPublicationLedger(state: ChangeState): void {
  if (state.publication?.status !== "reconcile_required") return;
  const finishedAt = new Date().toISOString();
  for (const entry of state.commandLedger) {
    if (
      entry.status === "pending" &&
      ["push", "create-pr", "update-pr"].includes(entry.action)
    ) {
      entry.status = "unknown";
      entry.finishedAt = finishedAt;
    }
  }
}

/** Opens an existing change after validating its durable workspace identity. */
export async function resumeChange(
  cwd: string,
  id: string,
): Promise<ChangeStore> {
  if (!CHANGE_ID.test(id))
    throw new Error(`Invalid Pied Piper change ID: ${id}`);
  const identity = await repositoryIdentity(cwd);
  const candidates = [
    ...(identity
      ? [
          {
            path: repositoryStatePath(identity, id),
            destination: repositoryStatePath(identity, id),
            legacy: false,
          },
          {
            path: legacyRepositoryStatePath(identity, id),
            destination: repositoryStatePath(identity, id),
            legacy: true,
          },
        ]
      : []),
    {
      path: globalStatePath(id),
      destination: globalStatePath(id),
      legacy: false,
    },
    {
      path: legacyGlobalStatePath(id),
      destination: globalStatePath(id),
      legacy: true,
    },
  ];
  let selected: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    if (await exists(candidate.path)) {
      selected = candidate;
      break;
    }
  }
  if (!selected) throw new Error(`Pied Piper change not found: ${id}`);
  const state = await readChange(selected.path);
  if (state.id !== id) {
    throw new Error(`Pied Piper change ID does not match: ${selected.path}`);
  }
  if (!(await exists(state.workspace))) {
    throw new Error(`Pied Piper workspace is missing: ${state.workspace}`);
  }
  if (state.repoRoot) {
    const actual = await repositoryIdentity(state.workspace);
    if (
      !actual ||
      actual.repoRoot !== state.repoRoot ||
      actual.commonDir !== state.commonDir
    ) {
      throw new Error("Pied Piper workspace belongs to a different repository");
    }
    const branch = (await runGit(state.workspace, ["branch", "--show-current"]))
      .stdout;
    if (branch !== state.branch) {
      throw new Error(
        `Pied Piper workspace branch changed: ${branch || "detached"}`,
      );
    }
    await reconcilePendingIntegration(state);
  } else if (state.commonDir) {
    throw new Error(
      "Pied Piper non-repository state has a repository identity",
    );
  }
  reconcilePendingPublicationLedger(state);
  for (const run of Object.values(state.runs)) {
    if (["starting", "running", "cancelling"].includes(run.status)) {
      run.status = "interrupted";
      run.finishedAt = new Date().toISOString();
    }
  }
  if (selected.legacy) await migrateLegacySession(state);
  const store = new ChangeStore(selected.destination, state);
  if (selected.legacy) {
    await writeJsonAtomic(selected.destination, state);
  }
  await store.update(() => undefined);
  return store;
}

/** Creates a dedicated feature workspace while preserving the source checkout untouched. */
export async function createChange(
  cwd: string,
  options: { id?: string; base?: string; observationPack?: boolean } = {},
): Promise<ChangeStore> {
  const id = options.id ?? `change-${crypto.randomUUID().slice(0, 12)}`;
  if (!CHANGE_ID.test(id))
    throw new Error(`Invalid Pied Piper change ID: ${id}`);
  const identity = await repositoryIdentity(cwd);
  const now = new Date().toISOString();
  if (!identity) {
    const path = globalStatePath(id);
    const state: ChangeState = {
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
      observationPack: options.observationPack === true,
      inputGeneration: 0,
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
  const branch = `piedpiper/${id}`;
  const worktreeRoot = `${identity.repoRoot}.piedpiper-worktrees`;
  const workspace = join(worktreeRoot, id);
  await mkdir(worktreeRoot, { recursive: true });
  if (await exists(workspace)) {
    throw new Error(`Pied Piper workspace already exists: ${workspace}`);
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
  const state: ChangeState = {
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
    observationPack: options.observationPack === true,
    inputGeneration: 0,
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

/** Owns local Git mutations for one Pied Piper feature workspace. */
export class ChangeWorkspace {
  readonly store: ChangeStore;

  /** Binds workspace operations to a durable change store. */
  constructor(store: ChangeStore) {
    this.store = store;
  }

  /** Returns the current full feature-branch head. */
  async head(): Promise<string | null> {
    if (!this.store.state.repoRoot) return null;
    return (await runGit(this.store.state.workspace, ["rev-parse", "HEAD"]))
      .stdout;
  }

  /** Returns the feature workspace's porcelain status. */
  async status(): Promise<string> {
    if (!this.store.state.repoRoot) return "";
    return (await runGit(this.store.state.workspace, ["status", "--porcelain"]))
      .stdout;
  }

  /** Commits pending main-agent changes and records the resulting checkpoint. */
  async checkpoint(
    message = "piedpiper: checkpoint conversation changes",
  ): Promise<string | null> {
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
  async createAgentWorkspace(runId: string): Promise<AgentWorkspace> {
    if (!this.store.state.repoRoot) {
      throw new Error(
        "Writing delegation is unavailable outside a Git repository",
      );
    }
    const baseCommit = await this.checkpoint();
    if (!baseCommit) throw new Error("Writer workspace requires a Git head");
    const root = `${this.store.state.repoRoot}.piedpiper-agents`;
    const path = join(root, this.store.state.id, runId);
    const branch = `piedpiper-agent/${this.store.state.id}/${runId}`;
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
  async finalizeAgentWorkspace(
    workspace: AgentWorkspace,
    runId: string,
  ): Promise<AgentWorkspace & { head: string; changed: boolean }> {
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
        `piedpiper(${runId}): delegated changes`,
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
  async integrate(resultId: string): Promise<string | null> {
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
        if (draft.integration) {
          draft.integration.status = "conflict";
          draft.integration.error = applied.stderr || applied.stdout;
        }
      });
      throw new Error(
        "Integration conflicted; worktrees and conflict state were preserved",
      );
    }
    const head = await this.head();
    if (!head) throw new Error("Integrated feature workspace has no Git head");
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
  async assertReady(): Promise<string> {
    if (!this.store.state.repoRoot)
      throw new Error("Delivery requires a Git repository");
    if ((await this.status()) !== "")
      throw new Error("Feature workspace is not clean");
    const head = await this.head();
    if (head !== this.store.state.mainHead) {
      throw new Error("Feature workspace head does not match durable state");
    }
    if (!head) throw new Error("Feature workspace has no Git head");
    return head;
  }
}
