import { describe, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiClientApi } from "../../../src/agents/pi/client";
import { createPiHarness } from "../../../src/agents/pi/harness";
import { createTaskBranchManager } from "../../../src/workspace/task-branch";
import { git } from "../../helpers/git";
import type { ConformanceRole } from "../conformance";
import {
  type AdapterConformanceFixture,
  defineAdapterConformance,
  defineNormalizedConformance,
  type MintCursorInput,
  normalizedUsage,
  type ProtocolDriver,
  type RoleStartObservation,
  roleOutputs,
  type ScriptedUsage,
} from "../conformance";

type PiEvent = Awaited<ReturnType<PiClientApi["nextEvent"]>>;

type QueuedEvent = {
  event: PiEvent;
  sideEffect?: () => Promise<void>;
};

/**
 * One scripted Pi child process. The real backend spawns a fresh process per
 * attempt — the working directory is process-level state — so every dispatch
 * gets its own client with its own event queue, and nothing written to a
 * closed process's queue can reach the next attempt.
 */
class ScriptedPiClient implements PiClientApi {
  readonly requests: { command: string; params?: Record<string, unknown> }[] =
    [];
  readonly sent: Record<string, unknown>[] = [];
  readonly roleStarts: {
    role: ConformanceRole;
    model?: string;
    effort?: string;
  }[] = [];
  closeCount = 0;
  private readonly queue: QueuedEvent[] = [];
  private pendingRole: ConformanceRole | undefined;
  private lastModel: { provider: string; modelId: string } | undefined;
  private lastThinkingLevel: string | undefined;

  constructor(
    readonly sessionId: string,
    private readonly onPrompt?:
      | ((params?: Record<string, unknown>) => void | Promise<void>)
      | undefined,
  ) {}

  setPendingRole(role: ConformanceRole | undefined): void {
    this.pendingRole = role;
  }

  enqueue(entry: QueuedEvent): void {
    this.queue.push(entry);
  }

  async request(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.requests.push({ command, params });
    if (command === "set_model") {
      const provider = params?.provider;
      const modelId = params?.modelId;
      if (
        this.pendingRole !== undefined &&
        typeof provider === "string" &&
        typeof modelId === "string"
      ) {
        this.roleStarts.push({
          role: this.pendingRole,
          model: `${provider}/${modelId}`,
        });
      }
      this.lastModel = {
        provider: typeof provider === "string" ? provider : "",
        modelId: typeof modelId === "string" ? modelId : "",
      };
      return { ...(params ?? {}) };
    }
    if (command === "set_thinking_level") {
      const level = params?.level;
      const last = this.roleStarts.at(-1);
      if (last !== undefined && last.effort === undefined) {
        last.effort = String(level);
      }
      this.lastThinkingLevel = String(level);
      return undefined;
    }
    if (command === "get_state") {
      return {
        sessionId: this.sessionId,
        sessionFile: `/tmp/pi-conformance/${this.sessionId}.jsonl`,
        model:
          this.lastModel === undefined
            ? {}
            : { id: this.lastModel.modelId, provider: this.lastModel.provider },
        thinkingLevel: this.lastThinkingLevel,
        isStreaming: false,
      };
    }
    if (command === "prompt") {
      // The hook lets a scripted role act on its workspace during the turn,
      // the way a real implement agent edits the prepared checkout.
      await this.onPrompt?.(params);
      return undefined;
    }
    if (command === "get_entries") {
      return { entries: [], leafId: `entry-${this.sessionId}-3` };
    }
    if (command === "abort") return undefined;
    throw new Error(`Unexpected command: ${command}`);
  }

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
  }

  async nextEvent(): Promise<PiEvent> {
    const entry = this.queue.shift();
    if (!entry) throw new Error("Scripted Pi events exhausted");
    if (entry.sideEffect !== undefined) await entry.sideEffect();
    return entry.event;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** Hands out one fresh scripted process per dispatch, sharing a script pool. */
class ScriptedPiProcessPool {
  private sessionCounter = 0;
  private pendingQueue: QueuedEvent[] = [];
  private pendingRole: ConformanceRole | undefined;
  private pendingPrompt:
    | ((params?: Record<string, unknown>) => void | Promise<void>)
    | undefined;
  readonly clients: ScriptedPiClient[] = [];

  peekNextSessionId(): string {
    return `sess-${this.sessionCounter + 1}`;
  }

  setPendingRole(role: ConformanceRole | undefined): void {
    this.pendingRole = role;
  }

  setPromptHook(
    hook:
      | ((params?: Record<string, unknown>) => void | Promise<void>)
      | undefined,
  ): void {
    this.pendingPrompt = hook;
  }

  enqueuePending(entry: QueuedEvent): void {
    this.pendingQueue.push(entry);
  }

  clientBySession(sessionId: string): ScriptedPiClient | undefined {
    return this.clients.find((client) => client.sessionId === sessionId);
  }

  async start(): Promise<ScriptedPiClient> {
    this.sessionCounter += 1;
    const client = new ScriptedPiClient(
      `sess-${this.sessionCounter}`,
      this.pendingPrompt,
    );
    client.setPendingRole(this.pendingRole);
    for (const entry of this.pendingQueue) client.enqueue(entry);
    this.pendingQueue = [];
    this.pendingRole = undefined;
    this.pendingPrompt = undefined;
    this.clients.push(client);
    return client;
  }
}

/** Maps scheduler usage totals back onto native Pi usage fields. */
function piUsage(usage: ScriptedUsage | undefined) {
  return {
    // Pi's native input excludes cache reads; the scheduler total folds them
    // back in (see mapPiUsage).
    input: (usage?.inputTokens ?? 0) - (usage?.cachedInputTokens ?? 0),
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.cachedInputTokens ?? 0,
    cacheWrite: 0,
    reasoning: usage?.reasoningTokens ?? 0,
  };
}

class PiProtocolDriver implements ProtocolDriver {
  constructor(
    private readonly pool: ScriptedPiProcessPool,
    private readonly workspacePath: string,
  ) {}

  peekNextRef(): string {
    return this.pool.peekNextSessionId();
  }

  scriptSuccessfulTurn(
    role: ConformanceRole,
    options?: {
      usage?: ScriptedUsage;
      mutateWorkspace?: boolean;
      invalidOutput?: boolean;
    },
  ): string {
    const sessionId = this.pool.peekNextSessionId();
    this.pool.setPendingRole(role);
    if (options?.mutateWorkspace === true) {
      // The scripted role touches the checkout while its prompt is in flight,
      // after the dispatch-time snapshot and before the settled turn commits
      // or the Review status comparison runs.
      this.pool.setPromptHook(async () => {
        await writeFile(
          join(this.workspacePath, `conformance-mutation-${role}.txt`),
          "mutated during the turn\n",
        );
      });
    }
    const output =
      options?.invalidOutput === true
        ? { ...roleOutputs.scout, unexpected: true }
        : roleOutputs[role];
    this.pool.enqueuePending({
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify(output) }],
          provider: "conformance",
          model: sessionId,
          usage: piUsage(options?.usage),
          stopReason: "stop",
        },
      } as PiEvent,
    });
    this.pool.enqueuePending({ event: { type: "agent_settled" } as PiEvent });
    return sessionId;
  }

  scriptInteractionRequest(): void {
    this.pool.enqueuePending({
      event: {
        type: "extension_ui_request",
        id: "conformance-ui-1",
        method: "dialog/confirm",
      } as PiEvent,
    });
  }

  scriptForeignTurnNotification(ref: string): void {
    // A late notification stays in its own process's stream: each attempt
    // owns one child process, so the next attempt never drains it. Queueing
    // it on the closed process proves the isolation instead of assuming it.
    const client = this.pool.clientBySession(ref);
    if (client === undefined) {
      throw new Error(`No scripted Pi session for ref ${ref}`);
    }
    client.enqueue({
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify(roleOutputs.scout) }],
          provider: "conformance",
          model: ref,
          usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
          stopReason: "stop",
        },
      } as PiEvent,
    });
  }

  mintCursor(input: MintCursorInput): string {
    return JSON.stringify({
      version: 1,
      nextSequence: input.nextSequence ?? 2,
      sessionId: input.ref,
      sessionFile: `/tmp/pi-conformance/${input.ref}.jsonl`,
      ...(input.outputDelivered === true ? { outputDelivered: true } : {}),
      usage: normalizedUsage(input.usage),
    });
  }

  roleStartRequests(): RoleStartObservation[] {
    return this.pool.clients.flatMap((client) =>
      client.roleStarts.map((entry) => ({
        role: entry.role,
        model: entry.model ?? "",
        effort: entry.effort ?? "",
      })),
    );
  }

  interactionRejections(): number {
    return this.pool.clients.reduce(
      (total, client) =>
        total +
        client.sent.filter(
          (message) => message.type === "extension_ui_response",
        ).length,
      0,
    );
  }

  interruptionRequestCount(): number {
    return this.pool.clients.reduce(
      (total, client) =>
        total + client.requests.filter((r) => r.command === "abort").length,
      0,
    );
  }

  cursorNextSequence(cursor: string): number {
    const parsed = JSON.parse(cursor) as { nextSequence?: unknown };
    if (typeof parsed.nextSequence !== "number") {
      throw new Error(`pi cursor has no nextSequence: ${cursor}`);
    }
    return parsed.nextSequence;
  }

  cursorUsage(cursor: string) {
    const parsed = JSON.parse(cursor) as {
      usage?: ReturnType<typeof normalizedUsage>;
    };
    if (parsed.usage === undefined) {
      throw new Error(`pi cursor has no usage: ${cursor}`);
    }
    return parsed.usage;
  }
}

async function createFixture(): Promise<AdapterConformanceFixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agile-pi-conformance-")),
  );
  await git(["init"], root);
  await git(["config", "user.name", "Agile Tests"], root);
  await git(["config", "user.email", "agile@example.test"], root);
  await writeFile(join(root, "README.md"), "seed\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: seed"], root);
  const branches = await createTaskBranchManager(root, "HEAD");
  const workspace = await branches.prepare("T1");
  const pool = new ScriptedPiProcessPool();
  const driver = new PiProtocolDriver(pool, workspace.path);
  const harness = createPiHarness({
    branches,
    startClient: () => pool.start(),
    now: () => "2026-09-01T00:00:00.000Z",
  });
  return {
    harness,
    branches,
    driver,
    sourceRoot: root,
    workspace,
    async dispose() {
      await rm(`${root}.agile-checkout`, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

const cases = [
  ...defineNormalizedConformance({ createFixture }),
  ...defineAdapterConformance({ reconcileInFlight: "orphan", createFixture }),
];

describe("pi backend conformance", () => {
  for (const group of new Set(cases.map((entry) => entry.group))) {
    describe(group, () => {
      for (const entry of cases.filter((item) => item.group === group)) {
        test(entry.name, () => entry.run());
      }
    });
  }
});
