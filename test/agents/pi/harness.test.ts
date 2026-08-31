import { expect, test } from "bun:test";
import type { PiClientApi } from "../../../src/agents/pi/client";
import { createPiHarness } from "../../../src/agents/pi/harness";
import type { PiBackendCursor } from "../../../src/agents/pi/protocol";
import type {
  AgentHarness,
  HarnessEvent,
  HarnessStepRequest,
} from "../../../src/harness/contracts";
import type { TaskBranchManager } from "../../../src/workspace/task-branch";

type PiEvent = Awaited<ReturnType<PiClientApi["nextEvent"]>>;

class RecordedPiClient implements PiClientApi {
  readonly requests: { command: string; params?: Record<string, unknown> }[] =
    [];
  readonly sent: Record<string, unknown>[] = [];
  closeCount = 0;
  private readonly events: PiEvent[];
  private sessionCounter = 0;

  constructor(events: PiEvent[] = []) {
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
        thinkingLevel: "high",
        isStreaming: false,
      };
    }
    if (
      command === "set_thinking_level" ||
      command === "prompt" ||
      command === "abort"
    ) {
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

const scoutOutput = {
  kind: "scout" as const,
  summary: "The provider seam is AgentHarness",
  files: ["src/agents/pi/harness.ts"],
  tests: ["test/agents/pi/harness.test.ts"],
  risks: ["The Pi RPC protocol is undocumented"],
};

const catalogModel = "anthropic/claude-sonnet-4-6";

function makeScoutRequest(attemptId = "attempt-scout"): HarnessStepRequest {
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

function makeImplementRequest(
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

function makeReviewRequest(
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

function backendCursor(sessionId: string, nextSequence = 2): string {
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

function memoryBranches(
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

function messageEnd(
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

async function collect(
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

test("scout dispatch accumulates per-message usage and completes", async () => {
  const client = new RecordedPiClient();
  const clientCwds: string[] = [];
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async (cwd) => {
      clientCwds.push(cwd);
      return client;
    },
    now: () => "2026-08-31T00:00:00.000Z",
  });

  const started = await harness.step(makeScoutRequest());
  expect(started.kind).toBe("event");
  if (started.kind !== "event") throw new Error("unreachable");
  expect(started.event).toMatchObject({
    type: "attempt.started",
    threadId: "sess-1",
  });
  // The Pi working directory is process-level state, so the child must be
  // rooted at the prepared task workspace.
  expect(clientCwds).toEqual(["/tmp/agile-pi-T1"]);
  expect(client.requests).toMatchObject([
    {
      command: "set_model",
      params: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      },
    },
    { command: "set_thinking_level", params: { level: "high" } },
    { command: "get_state" },
    { command: "prompt" },
  ]);

  // A tool loop settles only after multiple assistant messages; every
  // message_end usage accumulates into the attempt totals.
  client.enqueue(
    messageEnd({
      usage: { input: 1000, output: 50, reasoning: 20, cacheRead: 400 },
    }),
    messageEnd({
      text: `\`\`\`json\n${JSON.stringify(scoutOutput)}\n\`\`\``,
      usage: { input: 500, output: 30, reasoning: 10, cacheRead: 200 },
    }),
    { type: "agent_settled" },
  );
  const { events, cursors } = await collect(harness, {
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(events.map((event) => event.type)).toEqual([
    "attempt.usage_delta",
    "attempt.output",
    "attempt.completed",
  ]);
  const usage = events.find(
    (event): event is Extract<HarnessEvent, { type: "attempt.usage_delta" }> =>
      event.type === "attempt.usage_delta",
  );
  if (usage === undefined) throw new Error("unreachable");
  expect(usage.inputTokens).toBe(1500);
  expect(usage.cachedInputTokens).toBe(600);
  expect(usage.outputTokens).toBe(80);
  expect(usage.reasoningOutputTokens).toBe(30);
  const output = events.find(
    (event): event is Extract<HarnessEvent, { type: "attempt.output" }> =>
      event.type === "attempt.output",
  );
  if (output === undefined) throw new Error("unreachable");
  expect(output.output).toEqual(scoutOutput);
  // The output delivery's cursor carries the durable session anchors.
  const cursor = JSON.parse(cursors[1] ?? "") as PiBackendCursor;
  expect(cursor).toMatchObject({
    sessionId: "sess-1",
    sessionFile: "/tmp/pi-fixture/sess-1.jsonl",
    entryAnchor: "entry-1-3",
    outputDelivered: true,
  });
});

test("implement commits through the trusted harness", async () => {
  const client = new RecordedPiClient();
  const commits: string[] = [];
  const harness = createPiHarness({
    branches: memoryBranches({
      async commitChanges() {
        const sha = "b".repeat(40);
        commits.push(sha);
        return sha;
      },
    }),
    startClient: async () => client,
  });

  const started = await harness.step(makeImplementRequest());
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(
    messageEnd({
      text: JSON.stringify({
        kind: "implement",
        validation: ["bun test"],
        risks: [],
        limitations: [],
      }),
    }),
    { type: "agent_settled" },
  );
  const { events } = await collect(harness, {
    ...makeImplementRequest(),
    backendCursor: started.nextCursor,
  });
  expect(commits).toEqual(["b".repeat(40)]);
  const output = events.find((event) => event.type === "attempt.output");
  if (output?.type !== "attempt.output") throw new Error("unreachable");
  expect(output.output).toMatchObject({
    kind: "implement",
    commitSha: "b".repeat(40),
  });
});

test("non-JSON final output fails as invalid structured output", async () => {
  const client = new RecordedPiClient();
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(
    messageEnd({ text: "I looked at the repo and it seems fine." }),
    { type: "agent_settled" },
  );
  const { events } = await collect(harness, {
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(events.at(-1)).toMatchObject({
    type: "attempt.failed_infra",
    code: "invalid_structured_output",
  });
});

test("extension UI requests are cancelled and block policy", async () => {
  const client = new RecordedPiClient();
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue({
    type: "extension_ui_request",
    id: "ui-1",
    method: "confirm",
    title: "Allow this action?",
  });
  const { events } = await collect(harness, {
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(events.at(-1)).toMatchObject({
    type: "attempt.blocked_policy",
    code: "approval_required",
  });
  expect(client.sent).toEqual([
    { type: "extension_ui_response", id: "ui-1", cancelled: true },
  ]);
  expect(
    client.requests.find((request) => request.command === "abort"),
  ).toBeDefined();
  // The per-attempt child is released once the attempt terminalizes.
  expect(client.closeCount).toBeGreaterThan(0);
});

test("aborted settles fail as retryable interrupted turns", async () => {
  const client = new RecordedPiClient();
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(messageEnd({ stopReason: "aborted" }), {
    type: "agent_settled",
  });
  const { events } = await collect(harness, {
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(events.at(-1)).toMatchObject({
    type: "attempt.failed_infra",
    code: "turn_interrupted",
    retryable: true,
  });
});

test("review verifies the workspace stayed untouched and completes", async () => {
  const client = new RecordedPiClient();
  let statusCalls = 0;
  const harness = createPiHarness({
    branches: memoryBranches({
      async status() {
        statusCalls += 1;
        return "clean";
      },
    }),
    startClient: async () => client,
  });

  const started = await harness.step(
    makeReviewRequest({ commitSha: "b".repeat(40) }),
  );
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(
    messageEnd({
      text: JSON.stringify({
        kind: "review",
        decision: "accepted",
        findings: [],
        remainingGaps: [],
      }),
    }),
    { type: "agent_settled" },
  );
  const { events } = await collect(harness, {
    ...makeReviewRequest({ commitSha: "b".repeat(40) }),
    backendCursor: started.nextCursor,
  });
  expect(statusCalls).toBe(2);
  expect(events.at(-1)?.type).toBe("attempt.completed");
});

test("review fails closed when the workspace changed during the turn", async () => {
  const client = new RecordedPiClient();
  const statuses = ["clean", "dirty"];
  const harness = createPiHarness({
    branches: memoryBranches({
      async status() {
        return statuses.shift() ?? "clean";
      },
    }),
    startClient: async () => client,
  });

  const started = await harness.step(
    makeReviewRequest({ commitSha: "b".repeat(40) }),
  );
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(
    messageEnd({
      text: JSON.stringify({
        kind: "review",
        decision: "accepted",
        findings: [],
        remainingGaps: [],
      }),
    }),
    { type: "agent_settled" },
  );
  const { events } = await collect(harness, {
    ...makeReviewRequest({ commitSha: "b".repeat(40) }),
    backendCursor: started.nextCursor,
  });
  expect(events.at(-1)).toMatchObject({
    type: "attempt.failed_infra",
    code: "review_mutated_workspace",
  });
});

test("cancel aborts the role process and reaps it", async () => {
  const client = new RecordedPiClient();
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  await harness.step(makeScoutRequest());
  await harness.cancel("attempt-scout");
  expect(
    client.requests.find((request) => request.command === "abort"),
  ).toBeDefined();
  expect(client.closeCount).toBe(1);
});

test("reconcile completes persisted outputs and retries in-flight turns", async () => {
  const client = new RecordedPiClient();
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  const deliveredCursor = JSON.stringify({
    version: 1,
    nextSequence: 4,
    sessionId: "sess-9",
    sessionFile: "/tmp/pi-fixture/sess-9.jsonl",
    outputDelivered: true,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
  const completed = await harness.step({
    ...makeScoutRequest("attempt-a"),
    mode: "reconcile",
    backendCursor: deliveredCursor,
  });
  expect(completed).toMatchObject({
    kind: "event",
    event: { type: "attempt.completed" },
  });

  const orphaned = await harness.step({
    ...makeScoutRequest("attempt-b"),
    mode: "reconcile",
    backendCursor: backendCursor("sess-8"),
  });
  expect(orphaned).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.failed_infra",
      code: "orphaned_turn",
      retryable: true,
    },
  });
});

test("reconcile without a cursor has no session identity to recover", async () => {
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => new RecordedPiClient(),
  });

  const orphaned = await harness.step({
    ...makeScoutRequest("attempt-c"),
    mode: "reconcile",
  });
  expect(orphaned).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.failed_infra",
      code: "orphaned_turn",
      retryable: true,
    },
  });
});

test("an attempt model without a provider pair fails closed", async () => {
  const client = new RecordedPiClient();
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  const failed = await harness.step({
    ...makeScoutRequest(),
    attempt: {
      ...makeScoutRequest().attempt,
      model: "bare-model-id",
    },
  });
  if (failed.kind !== "event") throw new Error("expected an event delivery");
  expect(failed.event).toMatchObject({
    type: "attempt.failed_infra",
    code: "pi_model_invalid",
  });
});
