import { fileURLToPath } from "node:url";
import {
  RpcClient,
  type RpcClientOptions,
  type RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { agentEnvironment } from "./command.js";
import type {
  AgentResult,
  AgentRole,
  AgentRun,
  ChangeState,
  ChangeStore,
} from "./state.js";
import type { AgentWorkspace, ChangeWorkspace } from "./workspace.js";

const BOUNDARY_EXTENSION = fileURLToPath(
  new URL("./boundary.js", import.meta.url),
);
const RPC_ENTRY = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
);

interface ChildClient {
  start(): Promise<void>;
  getState(): Promise<RpcSessionState>;
  prompt(message: string): Promise<unknown>;
  waitForIdle(timeoutMs: number): Promise<unknown>;
  getLastAssistantText(): Promise<string | undefined>;
  steer(message: string): Promise<unknown>;
  abort(): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface SupervisorOptions {
  maxActive?: number;
  clientFactory?: (options: RpcClientOptions) => ChildClient;
}

export interface DelegateInput {
  role: AgentRole;
  prompt: string;
  parentSessionId?: string | null;
  deliveryOnly?: boolean;
}

/** Returns the required durable run for an already-admitted child. */
function requireRun(state: ChangeState, runId: string): AgentRun {
  const run = state.runs[runId];
  if (!run) throw new Error(`Agent run is missing: ${runId}`);
  return run;
}

/** Limits persisted model text so metadata never becomes a second tool transcript. */
function boundedText(value: unknown, limit = 20_000): string {
  if (typeof value !== "string") return "";
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated]`;
}

/** Converts one agent role into its least-privilege Pi tool allowlist. */
function toolsForRole(role: AgentRole): string {
  return role === "writer"
    ? "read,grep,find,ls,bash,edit,write"
    : "read,grep,find,ls";
}

/** Coordinates bounded Pi child processes and durable result ownership. */
export class AgentSupervisor {
  #clients = new Map<string, ChildClient>();
  #completions = new Map<string, Promise<void>>();
  #deliveryHandler?: (result: AgentResult) => Promise<void> | void;
  #draining?: Promise<void>;
  #admitting: Promise<unknown> = Promise.resolve();
  #closing = false;

  readonly store: ChangeStore;
  readonly workspace: ChangeWorkspace;
  readonly maxActive: number;
  readonly clientFactory: (options: RpcClientOptions) => ChildClient;

  /** Binds child lifecycle to one change and workspace. */
  constructor(
    store: ChangeStore,
    workspace: ChangeWorkspace,
    options: SupervisorOptions = {},
  ) {
    this.store = store;
    this.workspace = workspace;
    this.maxActive = options.maxActive ?? 2;
    this.clientFactory =
      options.clientFactory ??
      ((clientOptions) =>
        new RpcClient({
          cliPath: RPC_ENTRY,
          ...clientOptions,
        }) as unknown as ChildClient);
  }

  /** Installs the parent-session result delivery callback. */
  setDeliveryHandler(
    handler: (result: AgentResult) => Promise<void> | void,
  ): void {
    this.#deliveryHandler = handler;
  }

  /** Returns all durable runs in creation order. */
  list(): AgentRun[] {
    return Object.values(this.store.state.runs).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  /** Starts or queues one non-recursive child-agent assignment. */
  async delegate(input: DelegateInput): Promise<AgentRun> {
    const admission = this.#admitting.then(async () => {
      if (this.#closing) throw new Error("OpenAmp supervisor is shutting down");
      if (!["researcher", "writer", "reviewer"].includes(input.role)) {
        throw new Error(`Unsupported agent role: ${input.role}`);
      }
      if (input.role === "writer" && !this.store.state.repoRoot) {
        throw new Error(
          "Writer agents are unavailable outside a Git repository",
        );
      }
      const runId = `run-${crypto.randomUUID().slice(0, 12)}`;
      const active = this.list().filter((candidate) =>
        ["starting", "running", "cancelling"].includes(candidate.status),
      ).length;
      const run: AgentRun = {
        id: runId,
        role: input.role,
        prompt: boundedText(input.prompt, 40_000),
        status: active >= this.maxActive ? "queued" : "starting",
        parentSessionId: input.parentSessionId ?? this.store.state.sessionId,
        deliveryOnly: input.deliveryOnly === true,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        cwd: null,
        sessionId: null,
        model: null,
        effort: null,
        resultId: null,
      };
      await this.store.update((state) => {
        state.runs[runId] = run;
      });
      if (run.status !== "queued") void this.#launch(runId);
      return run;
    });
    this.#admitting = admission.catch(() => undefined);
    return admission;
  }

  /** Sends a targeted steering instruction to one active child. */
  async send(runId: string, message: string): Promise<void> {
    const client = this.#clients.get(runId);
    if (!client) throw new Error(`Agent is not running: ${runId}`);
    await client.steer(message);
  }

  /** Cancels one queued or active child without silently restarting it. */
  async cancel(runId: string): Promise<void> {
    const run = this.store.state.runs[runId];
    if (!run) throw new Error(`Unknown agent: ${runId}`);
    const client = this.#clients.get(runId);
    if (run.status === "queued" || (run.status === "starting" && !client)) {
      await this.store.update((state) => {
        const current = requireRun(state, runId);
        current.status = "cancelled";
        current.finishedAt = new Date().toISOString();
      });
      return;
    }
    if (!client) throw new Error(`Agent is not cancellable: ${runId}`);
    await this.store.update((state) => {
      requireRun(state, runId).status = "cancelling";
    });
    await client.abort().catch(() => undefined);
    await client.stop().catch(() => undefined);
    this.#clients.delete(runId);
    await this.store.update((state) => {
      const current = requireRun(state, runId);
      current.status = "cancelled";
      current.finishedAt = new Date().toISOString();
    });
    await this.#drainQueue();
  }

  /** Waits for a delegated run and returns its durable result. */
  async wait(runId: string): Promise<AgentResult> {
    const deadline = Date.now() + 30 * 60 * 1000;
    let run = this.store.state.runs[runId];
    while (
      run &&
      ["queued", "starting", "running", "cancelling"].includes(run.status) &&
      Date.now() < deadline
    ) {
      await this.#completions.get(runId);
      if (["queued", "starting"].includes(run.status)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      run = this.store.state.runs[runId];
    }
    await this.#completions.get(runId);
    run = this.store.state.runs[runId];
    if (run?.status !== "completed") {
      throw new Error(
        run?.failure ??
          (Date.now() >= deadline
            ? `Agent wait timed out: ${runId}`
            : `Agent did not complete: ${runId}`),
      );
    }
    if (!run.resultId) throw new Error(`Agent result ID is missing: ${runId}`);
    const result = this.store.state.results[run.resultId];
    if (!result) throw new Error(`Agent result is missing: ${run.resultId}`);
    return result;
  }

  /** Runs a delivery-only independent read-only review until completion or caller cancellation. */
  async review(
    prompt: string,
    parentSessionId: string | null,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const run = await this.delegate({
      role: "reviewer",
      prompt,
      parentSessionId,
      deliveryOnly: true,
    });
    let cancellation: Promise<void> | undefined;
    /** Cancels the dedicated reviewer at most once. */
    const cancel = () => {
      cancellation ??= this.cancel(run.id);
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.wait(run.id);
      if (signal?.aborted) throw new Error("Independent review aborted");
      return result;
    } finally {
      signal?.removeEventListener("abort", cancel);
      await cancellation?.catch(() => undefined);
    }
  }

  /** Restarts only work that was durably queued before process exit. */
  async recover(): Promise<void> {
    await this.#drainQueue();
  }

  /** Cancels and reaps all active children before the CLI exits. */
  async shutdown(): Promise<void> {
    this.#closing = true;
    await this.store.update((state) => {
      for (const run of Object.values(state.runs)) {
        if (
          (run.status === "queued" || run.status === "starting") &&
          !this.#clients.has(run.id)
        ) {
          run.status = "cancelled";
          run.finishedAt = new Date().toISOString();
        }
      }
    });
    await Promise.allSettled(
      [...this.#clients.keys()].map((id) => this.cancel(id)),
    );
    await Promise.allSettled([...this.#completions.values()]);
    await this.store.flush();
  }

  /** Launches one persisted run and owns its process through terminal state. */
  async #launch(runId: string): Promise<void> {
    const completion = this.#run(runId).finally(() => {
      this.#completions.delete(runId);
    });
    this.#completions.set(runId, completion);
    await completion;
  }

  /** Returns whether cancellation has claimed a child before result persistence. */
  #isCancelling(runId: string): boolean {
    return ["cancelling", "cancelled"].includes(
      this.store.state.runs[runId]?.status ?? "",
    );
  }

  /** Executes one child assignment and persists its result before delivery. */
  async #run(runId: string): Promise<void> {
    const run = this.store.state.runs[runId];
    if (!run) throw new Error(`Unknown agent: ${runId}`);
    let agentWorkspace: AgentWorkspace | { path: string };
    let client: ChildClient | undefined;
    try {
      agentWorkspace =
        run.role === "writer"
          ? await this.workspace.createAgentWorkspace(runId)
          : { path: this.store.state.workspace };
      if (this.store.state.runs[runId]?.status === "cancelled") return;
      client = this.clientFactory({
        cwd: agentWorkspace.path,
        env: agentEnvironment(),
        args: [
          "--no-extensions",
          "--extension",
          BOUNDARY_EXTENSION,
          "--tools",
          toolsForRole(run.role),
          "--session-dir",
          `${this.store.state.commonDir ?? this.store.path}.sessions`,
          "--approve",
        ],
      });
      this.#clients.set(runId, client);
      await client.start();
      if (this.#isCancelling(runId)) return;
      const rpcState = await client.getState();
      if (this.#isCancelling(runId)) return;
      await this.store.update((state) => {
        Object.assign(requireRun(state, runId), {
          status: "running",
          startedAt: new Date().toISOString(),
          cwd: agentWorkspace.path,
          sessionId: rpcState.sessionId,
          model: rpcState.model
            ? `${rpcState.model.provider}/${rpcState.model.id}`
            : null,
          effort: rpcState.thinkingLevel ?? null,
        });
      });
      if (this.#isCancelling(runId)) return;
      const roleConstraint =
        run.role === "writer"
          ? "Modify only this dedicated worktree. Do not push, publish, merge, or delegate. Leave a coherent working tree; OpenAmp will create the result commit."
          : "This is a read-only assignment. Use only read/search tools. Do not modify files, publish, merge, or delegate.";
      await client.prompt(`${roleConstraint}\n\nAssignment:\n${run.prompt}`);
      if (this.#isCancelling(runId)) return;
      await client.waitForIdle(30 * 60 * 1000);
      if (this.#isCancelling(runId)) return;
      const summary = boundedText(await client.getLastAssistantText());
      if (this.#isCancelling(runId)) return;
      const finalized =
        run.role === "writer" && "branch" in agentWorkspace
          ? await this.workspace.finalizeAgentWorkspace(agentWorkspace, runId)
          : undefined;
      if (this.#isCancelling(runId)) return;
      const resultId = `result-${crypto.randomUUID().slice(0, 12)}`;
      const result: AgentResult = {
        id: resultId,
        runId,
        role: run.role,
        summary,
        cwd: agentWorkspace.path,
        baseCommit: finalized?.baseCommit ?? this.store.state.mainHead,
        commit: finalized?.changed ? finalized.head : null,
        changed: finalized?.changed ?? false,
        createdAt: new Date().toISOString(),
        deliveredSessionId: null,
      };
      await this.store.update((state) => {
        state.results[resultId] = result;
        const current = requireRun(state, runId);
        current.status = "completed";
        current.finishedAt = result.createdAt;
        current.resultId = resultId;
      });
      if (!run.deliveryOnly) await this.#deliveryHandler?.(result);
    } catch (error) {
      if (this.store.state.runs[runId]?.status !== "cancelled") {
        await this.store.update((state) => {
          const current = requireRun(state, runId);
          current.status = "failed";
          current.finishedAt = new Date().toISOString();
          current.failure = boundedText(
            error instanceof Error ? error.message : String(error),
            2_000,
          );
        });
      }
    } finally {
      if (client) await client.stop().catch(() => undefined);
      this.#clients.delete(runId);
      await this.#drainQueue();
    }
  }

  /** Starts queued work in creation order while capacity remains. */
  async #drainQueue(): Promise<void> {
    if (this.#closing) return;
    if (this.#draining) return this.#draining;
    this.#draining = (async () => {
      while (
        this.list().filter((run) =>
          ["starting", "running", "cancelling"].includes(run.status),
        ).length < this.maxActive
      ) {
        const next = this.list().find((run) => run.status === "queued");
        if (!next) return;
        await this.store.update((state) => {
          requireRun(state, next.id).status = "starting";
        });
        void this.#launch(next.id);
      }
    })().finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }
}
