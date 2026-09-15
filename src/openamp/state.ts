import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  parseActivity,
  parseTaskPlan,
  reconcileToolActivity,
} from "./progress.js";

export const STATE_VERSION = 1;

export type AgentRole = "researcher" | "writer" | "reviewer" | "oracle";
export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancelling"
  | "cancelled"
  | "interrupted"
  | "completed"
  | "failed";

export interface AgentRun {
  id: string;
  role: AgentRole;
  prompt: string;
  status: RunStatus;
  parentSessionId: string | null;
  deliveryOnly: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cwd: string | null;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  resultId: string | null;
  requestedModel?: string;
  requestedEffort?: "high";
  sessionFile?: string;
  inputGeneration?: number;
  failure?: string;
}

export interface AgentResult {
  id: string;
  runId: string;
  role: AgentRole;
  summary: string;
  cwd: string;
  baseCommit: string | null;
  commit: string | null;
  changed: boolean;
  createdAt: string;
  deliveredSessionId: string | null;
}

export interface CommandLedgerEntry {
  id: string;
  action: string;
  command?: string;
  startedAt?: string;
  finishedAt?: string;
  status: "pending" | "completed" | "unknown" | "failed" | "cancelled";
  exitCode?: number;
}

export interface ReviewFinding {
  severity: "blocking" | "nonblocking";
  message: string;
}

export interface ReviewDecision {
  decision: "accepted" | "rejected";
  findings: ReviewFinding[];
  summary?: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "blocked" | "completed";
  note?: string;
}

export interface TaskPlan {
  revision: number;
  updatedAt: string;
  items: ChecklistItem[];
}

export interface ToolActivity {
  owner: "main" | AgentRole;
  runId?: string;
  tool: string;
  status: "running" | "completed" | "failed" | "interrupted";
  at: string;
}

export interface ChangeState {
  version: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  repoRoot: string | null;
  commonDir: string | null;
  sourceCwd: string;
  workspace: string;
  branch: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  mainHead: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  observationPack: boolean;
  oracleModel?: string;
  plan?: TaskPlan;
  activity?: ToolActivity;
  inputGeneration: number;
  phase: string;
  runs: Record<string, AgentRun>;
  results: Record<string, AgentResult>;
  integratedResultIds: string[];
  review:
    | (ReviewDecision & {
        head: string;
        base: string;
        specHash: string;
        inputGeneration: number;
      })
    | null;
  publication: {
    status: "pending" | "published" | "cancelled" | "reconcile_required";
    repository?: string | null;
    branch?: string | null;
    baseBranch?: string | null;
    baseCommit?: string;
    head?: string;
    specHash?: string;
    inputGeneration?: number;
    pullRequestNumber?: number | null;
    pullRequestUrl?: string | null;
  } | null;
  commandLedger: CommandLedgerEntry[];
  integration?: {
    resultId: string;
    expectedHead: string | null;
    status: "pending" | "integrated" | "unknown" | "conflict";
    head?: string;
    error?: string;
  };
  validation?: {
    head: string;
    commands: Array<{ command: string; exitCode: number; output: string }>;
  };
}

/** Returns whether an unknown JSON value is an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Rejects symbolic links at a durable state target. */
async function assertSafeTarget(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`OpenAmp state target is not a regular file: ${path}`);
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
}

/** Rejects symbolic-link directories in an absolute durable-state path. */
async function assertSafeParents(path: string): Promise<void> {
  const absolute = resolve(path);
  if (!isAbsolute(absolute))
    throw new Error("OpenAmp state path must be absolute");
  const root = parse(absolute).root;
  const relativeParts = dirname(absolute)
    .slice(root.length)
    .split(/[\\/]/u)
    .filter(Boolean);
  let current = root;
  for (const part of relativeParts) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `OpenAmp state parent is not a real directory: ${current}`,
      );
    }
  }
}

/** Writes JSON through an exclusive temporary file and atomic rename. */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertSafeParents(path);
  await assertSafeTarget(path);
  const temporary = join(parent, `.${process.pid}-${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Loads and minimally validates one versioned OpenAmp change record. */
export async function readChange(path: string): Promise<ChangeState> {
  await assertSafeTarget(path);
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isRecord(value) ||
    value.version !== STATE_VERSION ||
    typeof value.id !== "string" ||
    typeof value.workspace !== "string" ||
    !isRecord(value.runs) ||
    !isRecord(value.results)
  ) {
    throw new Error(`Invalid OpenAmp change state: ${path}`);
  }
  if (value.plan !== undefined) value.plan = parseTaskPlan(value.plan);
  if (value.activity !== undefined)
    value.activity = parseActivity(value.activity);
  return value as unknown as ChangeState;
}

/** Serializes state updates so one process remains the sole metadata writer. */
export class ChangeStore {
  #pending: Promise<unknown> = Promise.resolve();
  #observer?: () => void;

  readonly path: string;
  readonly state: ChangeState;

  /** Creates a store for one durable change file and initial state. */
  constructor(path: string, state: ChangeState) {
    this.path = path;
    this.state = state;
  }

  /** Installs the current UI observer and returns teardown that cannot detach its replacement. */
  observeChanges(observer: () => void): () => void {
    this.#observer = observer;
    return () => {
      if (this.#observer === observer) this.#observer = undefined;
    };
  }

  /** Persists the current state after applying one synchronous mutation. */
  async update(mutate: (state: ChangeState) => void): Promise<ChangeState> {
    const operation = this.#pending.then(async () => {
      mutate(this.state);
      reconcileToolActivity(this.state);
      this.state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.path, this.state);
      try {
        this.#observer?.();
      } catch {
        process.stderr.write("OpenAmp: progress display could not refresh.\n");
      }
      return this.state;
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  /** Waits until all queued state writes have settled successfully. */
  async flush(): Promise<void> {
    await this.#pending;
  }
}
