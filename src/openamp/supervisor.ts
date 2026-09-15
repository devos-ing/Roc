import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  RpcClient,
  type RpcClientOptions,
  type RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { agentEnvironment } from "./command.js";
import {
  OBSERVATION_PACK_TOOL,
  validateObservationPackRuntime,
} from "./observation-pack.js";
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
const OBSERVATION_PACK_EXTENSION = fileURLToPath(
  new URL("./observation-pack-extension.js", import.meta.url),
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
  onEvent?(listener: (event: { type: string }) => void): () => void;
}

export interface SupervisorOptions {
  maxActive?: number;
  clientFactory?: (options: RpcClientOptions) => ChildClient;
  agentDir?: string;
}

/** Splits an explicit Pi provider/model selection without accepting CLI-like values. */
export function parseOracleModel(value: string): {
  provider: string;
  id: string;
} {
  const slash = value.indexOf("/");
  const provider = value.slice(0, slash);
  const id = value.slice(slash + 1);
  if (
    slash < 1 ||
    !/^[a-zA-Z0-9_.-]+$/u.test(provider) ||
    provider.startsWith("-") ||
    !id ||
    id.startsWith("-") ||
    /\s/u.test(id)
  ) {
    throw new Error(
      "Oracle model must be an exact Pi provider/model identifier",
    );
  }
  return { provider, id };
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
export function toolsForRole(role: AgentRole, observationPack = false): string {
  const tools =
    role === "writer"
      ? ["read", "grep", "find", "ls", "bash", "edit", "write"]
      : ["read", "grep", "find", "ls"];
  return [...tools, ...(observationPack ? [OBSERVATION_PACK_TOOL] : [])].join(
    ",",
  );
}

/** Builds one child RPC startup argv with the selected plugin and role boundaries. */
export function childArgsForRole(
  role: AgentRole,
  observationPack: boolean,
  sessionDirectory: string,
): string[] {
  return [
    "--no-extensions",
    "--extension",
    BOUNDARY_EXTENSION,
    ...(observationPack ? ["--extension", OBSERVATION_PACK_EXTENSION] : []),
    "--tools",
    toolsForRole(role, observationPack),
    "--session-dir",
    sessionDirectory,
    "--approve",
  ];
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
  readonly agentDir: string;
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
    this.agentDir = options.agentDir ?? getAgentDir();
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
      if (
        !["researcher", "writer", "reviewer", "oracle"].includes(input.role)
      ) {
        throw new Error(`Unsupported agent role: ${input.role}`);
      }
      if (input.role === "writer" && !this.store.state.repoRoot) {
        throw new Error(
          "Writer agents are unavailable outside a Git repository",
        );
      }
      const requestedModel = ["oracle", "reviewer"].includes(input.role)
        ? this.store.state.oracleModel
        : undefined;
      if (input.role === "oracle" && !requestedModel) {
        throw new Error(
          "Configure an Oracle with --oracle-model <provider/model> before asking it for advice",
        );
      }
      if (requestedModel) parseOracleModel(requestedModel);
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
        ...(requestedModel
          ? { requestedModel, requestedEffort: "high" as const }
          : {}),
        inputGeneration: this.store.state.inputGeneration,
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

  /** Observes one existing run until it settles or this caller's wait expires without stopping it. */
  async waitForStatus(runId: string, timeoutMs = 10_000): Promise<AgentRun> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 60_000
    ) {
      throw new Error("Wait must be between 0 and 60000 milliseconds");
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const run = requireRun(this.store.state, runId);
      if (
        !["queued", "starting", "running", "cancelling"].includes(run.status) ||
        Date.now() >= deadline
      ) {
        return { ...run };
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50, deadline - Date.now())),
      );
    }
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
    if (run.status === "completed" || run.status === "cancelled") return;
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
    try {
      await client.stop();
    } catch {
      await this.store.update((state) => {
        requireRun(state, runId).failure =
          "Child cleanup could not be confirmed; retry cancellation";
        state.phase = "needs_replan";
      });
      throw new Error("Child cancellation could not confirm cleanup");
    }
    this.#clients.delete(runId);
    await this.store.update((state) => {
      const current = requireRun(state, runId);
      current.status = "cancelled";
      current.finishedAt = new Date().toISOString();
    });
    await this.#drainQueue();
  }

  /** Awaits an owned run without turning a caller wait into an execution deadline. */
  async wait(runId: string, signal?: AbortSignal): Promise<AgentResult> {
    let run = requireRun(this.store.state, runId);
    while (
      ["queued", "starting", "running", "cancelling"].includes(run.status)
    ) {
      if (signal?.aborted) throw new Error(`Agent wait cancelled: ${runId}`);
      run = await this.waitForStatus(runId, 250);
    }
    await this.#completions.get(runId);
    run = requireRun(this.store.state, runId);
    if (run.status !== "completed")
      throw new Error(run.failure ?? `Agent did not complete: ${runId}`);
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
      const result = await this.wait(run.id, signal);
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
    if (this.#clients.size > 0) {
      throw new Error(
        "OpenAmp could not confirm all child cleanup; unresolved ownership was preserved",
      );
    }
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
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    let started = false;
    let stopped = false;
    try {
      agentWorkspace =
        run.role === "writer"
          ? await this.workspace.createAgentWorkspace(runId)
          : { path: this.store.state.workspace };
      if (this.store.state.runs[runId]?.status === "cancelled") return;
      const observationPack = this.store.state.observationPack === true;
      if (observationPack) await validateObservationPackRuntime();
      if (run.role === "oracle" && !run.requestedModel) {
        throw new Error("Oracle run is missing its recorded model selection");
      }
      const route = run.requestedModel
        ? parseOracleModel(run.requestedModel)
        : undefined;
      if (route && run.requestedEffort !== "high") {
        throw new Error(
          "Recorded Oracle route must retain high reasoning effort",
        );
      }
      client = this.clientFactory({
        cwd: agentWorkspace.path,
        env: { ...agentEnvironment(), PI_CODING_AGENT_DIR: this.agentDir },
        ...(route ? { provider: route.provider, model: route.id } : {}),
        args: [
          ...childArgsForRole(
            run.role,
            observationPack,
            `${this.store.state.commonDir ?? this.store.path}.sessions`,
          ),
          ...(run.requestedEffort ? ["--thinking", run.requestedEffort] : []),
        ],
      });
      this.#clients.set(runId, client);
      await client.start();
      if (this.#isCancelling(runId)) return;
      const rpcState = await client.getState();
      if (this.#isCancelling(runId)) return;
      const effectiveModel = rpcState.model
        ? `${rpcState.model.provider}/${rpcState.model.id}`
        : null;
      if (
        run.requestedModel &&
        (effectiveModel !== run.requestedModel ||
          rpcState.thinkingLevel !== run.requestedEffort)
      ) {
        throw new Error(
          "Pi did not confirm the requested Oracle model and high reasoning effort; no prompt was sent",
        );
      }
      await this.store.update((state) => {
        Object.assign(requireRun(state, runId), {
          status: "running",
          startedAt: new Date().toISOString(),
          cwd: agentWorkspace.path,
          sessionId: rpcState.sessionId,
          sessionFile: rpcState.sessionFile,
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
          : run.role === "oracle"
            ? "You are a read-only Oracle adviser. Analyze the specific question, inspect relevant code, and return concise advice with evidence and caveats. Do not edit, run shell commands, publish, merge, or delegate. Your answer is advice, not permission to publish."
            : "This is a read-only assignment. Use only read/search tools. Do not modify files, publish, merge, or delegate.";
      unsubscribe = client.onEvent?.((event) => {
        if (event.type === "agent_start") started = true;
        if (event.type === "agent_settled") settled = true;
      });
      await client.prompt(`${roleConstraint}\n\nAssignment:\n${run.prompt}`);
      if (this.#isCancelling(runId)) return;
      if (unsubscribe) {
        while (!settled && !this.#isCancelling(runId)) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (!settled && !this.#isCancelling(runId)) {
            const health = await client.getState();
            if (
              !started &&
              !settled &&
              !health.isStreaming &&
              !health.isCompacting &&
              health.pendingMessageCount === 0
            ) {
              throw new Error(
                "Pi did not start the prompt; check model credentials or prompt preflight",
              );
            }
          }
        }
      } else {
        await client.waitForIdle(30 * 60 * 1000);
      }
      if (this.#isCancelling(runId)) return;
      const summary = boundedText(await client.getLastAssistantText());
      if (run.role === "oracle" && !summary.trim())
        throw new Error("Oracle returned no advice");
      if (this.#isCancelling(runId)) return;
      await client.stop();
      stopped = true;
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
      let saved = false;
      await this.store.update((state) => {
        if (
          ["cancelling", "cancelled"].includes(requireRun(state, runId).status)
        )
          return;
        saved = true;
        state.results[resultId] = result;
        const current = requireRun(state, runId);
        current.status = "completed";
        current.finishedAt = result.createdAt;
        current.resultId = resultId;
      });
      if (saved && !run.deliveryOnly) await this.#deliveryHandler?.(result);
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
      unsubscribe?.();
      if (client && !stopped) {
        try {
          await client.stop();
          stopped = true;
        } catch {
          await this.store.update((state) => {
            const current = requireRun(state, runId);
            current.status = "cancelling";
            current.failure =
              "Child cleanup could not be confirmed; retry cancellation before starting more work";
            state.phase = "needs_replan";
          });
        }
      }
      if (!client || stopped) {
        this.#clients.delete(runId);
        await this.#drainQueue();
      }
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
