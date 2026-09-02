import type { PiClientApi } from "../../../src/agents/pi/client";
import type {
  AgentHarness,
  HarnessEvent,
  HarnessStepRequest,
} from "../../../src/harness/contracts";
import type { TaskBranchManager } from "../../../src/workspace/task-branch";

type PiEvent = Awaited<ReturnType<PiClientApi["nextEvent"]>>;

export class RecordedPiClient implements PiClientApi {
  readonly requests: { command: string; params?: Record<string, unknown> }[] =
    [];
  readonly sent: Record<string, unknown>[] = [];
  closeCount = 0;
  private readonly events: PiEvent[];
  private sessionCounter = 0;

  constructor(
    events: PiEvent[] = [],
    private readonly stateOverrides: {
      model?: unknown;
      thinkingLevel?: unknown;
    } = {},
    private readonly onPrompt?: (
      params?: Record<string, unknown>,
    ) => void | Promise<void>,
  ) {
    this.events = events;
  }

  async request(
    command: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.requests.push({ command, params });
    if (command === "set_model") return { ...params };
    if (command === "get_state") {
      this.sessionCounter += 1;
      return {
        sessionId: `sess-${this.sessionCounter}`,
        sessionFile: `/tmp/pi-fixture/sess-${this.sessionCounter}.jsonl`,
        model:
          this.stateOverrides.model ??
          ({ id: "claude-sonnet-4-6", provider: "anthropic" } as const),
        thinkingLevel: this.stateOverrides.thinkingLevel ?? "high",
        isStreaming: false,
      };
    }
    if (command === "set_thinking_level" || command === "abort") {
      return undefined;
    }
    if (command === "prompt") {
      // The hook lets a scripted role act on its workspace during the turn,
      // the way a real implement agent edits the prepared checkout.
      await this.onPrompt?.(params);
      return undefined;
    }
    if (command === "get_entries") {
      return { entries: [], leafId: `entry-${this.sessionCounter}-3` };
    }
    throw new Error(`Unexpected command: ${command}`);
  }

  send(message: Record<string, unknown>): void {
    this.sent.push(message);
  }

  async nextEvent(): Promise<PiEvent> {
    const event = this.events.shift();
    if (!event) throw new Error("Recorded Pi events exhausted");
    return event;
  }

  enqueue(...events: PiEvent[]): void {
    this.events.push(...events);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

const ticket = {
  id: "T1",
  cycleId: "2026-W35",
  title: "Add a Pi harness",
  spec: {
    problem: "The scheduler has no Pi provider",
    desiredOutcome: "Role turns run through the Pi RPC process",
    scope: ["src/agents/pi"],
    nonGoals: ["Skill policy"],
    acceptanceCriteria: ["Structured outputs are validated"],
    validation: ["bun test test/agents/pi/harness.test.ts"],
    dependencies: [],
    risk: "medium" as const,
    contextCandidates: [],
    tokenCeiling: 10_000,
  },
  priority: 0,
  approvalRequired: false,
  approved: true,
  status: "scouting" as const,
};

export const scoutOutput = {
  kind: "scout" as const,
  summary: "The provider seam is AgentHarness",
  files: ["src/agents/pi/harness.ts"],
  tests: ["test/agents/pi/harness.test.ts"],
  risks: ["The Pi RPC protocol is undocumented"],
};

const catalogModel = "anthropic/claude-sonnet-4-6";

export function makeScoutRequest(
  attemptId = "attempt-scout",
): HarnessStepRequest {
  return {
    mode: "dispatch",
    attempt: {
      attemptId,
      taskId: ticket.id,
      role: "scout",
      retryIndex: 0,
      modelProfile: "luna",
      model: catalogModel,
      effort: "high",
    },
    input: { role: "scout", ticket },
  };
}

export function makeImplementRequest(
  attemptId = "attempt-implement",
): HarnessStepRequest {
  return {
    mode: "dispatch",
    attempt: {
      attemptId,
      taskId: ticket.id,
      role: "implement",
      retryIndex: 0,
      modelProfile: "terra",
      model: catalogModel,
      effort: "high",
    },
    input: {
      role: "implement",
      ticket: { ...ticket, status: "implementing" },
      scout: scoutOutput,
    },
  };
}

export function makeReviewRequest(
  implementation: { commitSha: string },
  attemptId = "attempt-review",
): HarnessStepRequest {
  return {
    mode: "dispatch",
    attempt: {
      attemptId,
      taskId: ticket.id,
      role: "review",
      retryIndex: 0,
      modelProfile: "sol",
      model: catalogModel,
      effort: "high",
    },
    input: {
      role: "review",
      ticket: { ...ticket, status: "reviewing", baseCommit: "a".repeat(40) },
      scout: scoutOutput,
      implementation: {
        kind: "implement",
        commitSha: implementation.commitSha,
        validation: [],
        risks: [],
        limitations: [],
      },
    },
  };
}

export function backendCursor(sessionId: string, nextSequence = 2): string {
  return JSON.stringify({
    version: 1,
    nextSequence,
    sessionId,
    sessionFile: `/tmp/pi-fixture/${sessionId}.jsonl`,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
}

export function memoryBranches(
  overrides: Partial<TaskBranchManager> = {},
): TaskBranchManager {
  return {
    async prepare(taskId) {
      return {
        taskId,
        path: `/tmp/agile-pi-${taskId}`,
        branch: `agile/${taskId}`,
        baseCommit: "a".repeat(40),
      };
    },
    async restoreChanges() {},
    async commitChanges() {
      return "b".repeat(40);
    },
    async assertCommit() {},
    async assertReviewReady() {},
    async status() {
      return "";
    },
    ...overrides,
  };
}

export function messageEnd(
  options: {
    text?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: Record<string, number>;
  } = {},
): PiEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: options.text ?? JSON.stringify(scoutOutput) },
      ],
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        input: 1000,
        output: 50,
        cacheRead: 400,
        cacheWrite: 0,
        reasoning: 20,
        ...(options.usage ?? {}),
      },
      stopReason: options.stopReason ?? "stop",
      ...(options.errorMessage === undefined
        ? {}
        : { errorMessage: options.errorMessage }),
    },
  } as PiEvent;
}

export async function collect(
  harness: AgentHarness,
  request: HarnessStepRequest,
): Promise<{ events: HarnessEvent[]; cursors: string[] }> {
  const events: HarnessEvent[] = [];
  const cursors: string[] = [];
  let current: HarnessStepRequest = request;
  while (true) {
    const delivery = await harness.step(current);
    if (delivery.kind === "idle") {
      cursors.push(delivery.nextCursor ?? "");
      continue;
    }
    if (delivery.kind === "closed") {
      cursors.push(delivery.nextCursor ?? "");
      break;
    }
    events.push(delivery.event);
    cursors.push(delivery.nextCursor);
    const event = delivery.event;
    if (
      event.type === "attempt.completed" ||
      event.type === "attempt.failed_infra" ||
      event.type === "attempt.blocked_policy"
    ) {
      break;
    }
    current = { ...request, backendCursor: delivery.nextCursor };
  }
  return { events, cursors };
}

/** A scripted probe client that never reaches the event stream. */
export class ScriptedProbeClient implements PiClientApi {
  closeCount = 0;

  constructor(
    private readonly models: unknown,
    private readonly stateModel: unknown,
  ) {}

  async request(command: string): Promise<unknown> {
    if (command === "get_available_models") return { models: this.models };
    if (command === "get_state") {
      return {
        sessionId: "sess-probe",
        sessionFile: "/tmp/pi-fixture/sess-probe.jsonl",
        model: this.stateModel,
      };
    }
    throw new Error(`Unexpected probe command: ${command}`);
  }

  send(): void {}

  async nextEvent(): Promise<never> {
    throw new Error("the probe never streams events");
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}
