import { expect, test } from "bun:test";
import type { ZcodeClientApi } from "../../../src/agents/zcode/client";
import { createZcodeHarness } from "../../../src/agents/zcode/harness";
import type {
  AgentHarness,
  HarnessEvent,
  HarnessStepRequest,
} from "../../../src/harness/contracts";
import { AgileError } from "../../../src/runtime/errors";
import type { TaskBranchManager } from "../../../src/workspace/task-branch";

type ServerMessage = Awaited<ReturnType<ZcodeClientApi["nextServerMessage"]>>;

class RecordedZcodeClient implements ZcodeClientApi {
  readonly sessionModel = Object.freeze({
    providerId: "bigmodel",
    modelId: "GLM-5.3",
  });
  readonly requests: { method: string; params: unknown }[] = [];
  readonly responseErrors: {
    id: string | number;
    code: number;
    message: string;
  }[] = [];
  private readonly messages: ServerMessage[];
  private sessionCounter = 0;
  private reviewStatus = "";

  constructor(messages: ServerMessage[] = []) {
    this.messages = messages;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "session/create") {
      this.sessionCounter += 1;
      return {
        session: { sessionId: `sess-${this.sessionCounter}` },
      };
    }
    if (method === "session/subscribe") return { eventSeq: 0 };
    if (method === "session/send") return { accepted: true };
    if (method === "session/stop") {
      this.reviewStatus = "stopped";
      return { stopped: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  notify(): void {}
  respond(): void {}
  respondError(id: string | number, code: number, message: string): void {
    this.responseErrors.push({ id, code, message });
  }

  async nextServerMessage(): Promise<ServerMessage> {
    const message = this.messages.shift();
    if (!message) throw new Error("Recorded ZCode messages exhausted");
    return message;
  }

  enqueue(...messages: ServerMessage[]): void {
    this.messages.push(...messages);
  }

  async close(): Promise<void> {}
}

const ticket = {
  id: "T1",
  cycleId: "2026-W35",
  title: "Add a ZCode harness",
  spec: {
    problem: "The scheduler has no ZCode provider",
    desiredOutcome: "Role turns run through the ZCode app-server",
    scope: ["src/agents/zcode"],
    nonGoals: ["Skill policy"],
    acceptanceCriteria: ["Structured outputs are validated"],
    validation: ["bun test test/zcode/harness.test.ts"],
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
  files: ["src/agents/zcode/harness.ts"],
  tests: ["test/zcode/harness.test.ts"],
  risks: ["The app-server protocol is undocumented"],
};

function makeScoutRequest(attemptId = "attempt-scout"): HarnessStepRequest {
  return {
    mode: "dispatch",
    attempt: {
      attemptId,
      taskId: ticket.id,
      role: "scout",
      retryIndex: 0,
      modelProfile: "luna",
      model: "GLM-5.3",
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
      model: "GLM-5.3",
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
      model: "GLM-5.3",
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
        path: `/tmp/agile-zcode-${taskId}`,
        branch: `agile/${taskId}`,
        baseCommit: "a".repeat(40),
      };
    },
    async commitChanges() {
      return "b".repeat(40);
    },
    async restoreChanges() {},
    async assertCommit() {},
    async assertReviewReady() {},
    async status() {
      return "";
    },
    ...overrides,
  };
}

function turnCompleted(
  sessionId: string,
  output: unknown,
  options: {
    fence?: boolean;
    resultType?: string;
    usage?: Record<string, number>;
    rawResponse?: string;
  } = {},
): ServerMessage {
  let response = options.rawResponse ?? JSON.stringify(output);
  if (options.fence) {
    response = "```json\n" + response + "\n```";
  }
  return {
    method: "session/event",
    params: {
      sessionId,
      type: "turn.completed",
      payload: {
        response,
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          reasoningTokens: 20,
          cacheReadTokens: 400,
          ...(options.usage ?? {}),
        },
        resultType: options.resultType ?? "success",
        toolCallCount: 0,
      },
    },
  };
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

test("scout dispatch completes with usage, output, and completion", async () => {
  const client = new RecordedZcodeClient();
  const harness = createZcodeHarness({
    client,
    branches: memoryBranches(),
    now: () => "2026-08-27T00:00:00.000Z",
  });

  const started = await harness.step(makeScoutRequest());
  expect(started.kind).toBe("event");
  if (started.kind !== "event") throw new Error("unreachable");
  expect(started.event).toMatchObject({
    type: "attempt.started",
    threadId: "sess-1",
  });

  client.enqueue(turnCompleted("sess-1", scoutOutput));
  const { events } = await collect(harness, {
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
  expect(usage.inputTokens).toBe(1000);
  expect(usage.cachedInputTokens).toBe(400);
  expect(usage.reasoningOutputTokens).toBe(20);
  const output = events.find(
    (event): event is Extract<HarnessEvent, { type: "attempt.output" }> =>
      event.type === "attempt.output",
  );
  if (output === undefined) throw new Error("unreachable");
  expect(output.output).toEqual(scoutOutput);

  const create = client.requests.find((r) => r.method === "session/create");
  expect(create?.params).toMatchObject({
    workspace: {
      workspacePath: "/tmp/agile-zcode-T1",
      workspaceKey: "/tmp/agile-zcode-T1",
    },
    mode: "yolo",
  });
  expect(
    client.requests.find((r) => r.method === "session/subscribe")?.params,
  ).toMatchObject({ sessionId: "sess-1", deliveryKind: "desktop-continuous" });
});

test("implement commits through the trusted harness and tolerates fences", async () => {
  const client = new RecordedZcodeClient();
  const commits: string[] = [];
  const harness = createZcodeHarness({
    client,
    branches: memoryBranches({
      async commitChanges() {
        const sha = "b".repeat(40);
        commits.push(sha);
        return sha;
      },
    }),
  });

  const started = await harness.step(makeImplementRequest());
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(
    turnCompleted(
      "sess-1",
      {
        kind: "implement",
        validation: ["bun test"],
        risks: [],
        limitations: [],
      },
      { fence: true },
    ),
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

test("restores a ticket source commit before starting Implement", async () => {
  const restored: string[] = [];
  const client = new RecordedZcodeClient();
  const harness = createZcodeHarness({
    client,
    branches: memoryBranches({
      async restoreChanges(_taskId, sourceCommit) {
        restored.push(sourceCommit);
      },
    }),
  });
  const request = makeImplementRequest("attempt-source-restore");
  if (request.input.role !== "implement") throw new Error("unreachable");
  request.input.ticket = {
    ...request.input.ticket,
    baseCommit: "a".repeat(40),
    spec: {
      ...request.input.ticket.spec,
      sourceCommit: "c".repeat(40),
    },
  };

  await expect(harness.step(request)).resolves.toMatchObject({
    kind: "event",
    event: { type: "attempt.started" },
  });
  expect(restored).toEqual(["c".repeat(40)]);
});

test("review verifies the workspace stayed untouched and completes", async () => {
  const client = new RecordedZcodeClient();
  let statusCalls = 0;
  const harness = createZcodeHarness({
    client,
    branches: memoryBranches({
      async status() {
        statusCalls += 1;
        return "clean";
      },
    }),
  });

  const started = await harness.step(
    makeReviewRequest({ commitSha: "b".repeat(40) }),
  );
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(
    turnCompleted("sess-1", {
      kind: "review",
      decision: "accepted",
      findings: [],
      remainingGaps: [],
    }),
  );
  const { events } = await collect(harness, {
    ...makeReviewRequest({ commitSha: "b".repeat(40) }),
    backendCursor: started.nextCursor,
  });
  expect(statusCalls).toBe(2);
  expect(events.at(-1)?.type).toBe("attempt.completed");
});

test("review fails closed when the workspace changed during the turn", async () => {
  const client = new RecordedZcodeClient();
  const statuses = ["clean", "dirty"];
  const harness = createZcodeHarness({
    client,
    branches: memoryBranches({
      async status() {
        return statuses.shift() ?? "clean";
      },
    }),
  });

  const started = await harness.step(
    makeReviewRequest({ commitSha: "b".repeat(40) }),
  );
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(
    turnCompleted("sess-1", {
      kind: "review",
      decision: "accepted",
      findings: [],
      remainingGaps: [],
    }),
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

test("interaction requests block policy and stop the session", async () => {
  const client = new RecordedZcodeClient();
  const harness = createZcodeHarness({ client, branches: memoryBranches() });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue({
    id: "server-9",
    method: "interaction/requestPermission",
    params: { sessionId: "sess-1" },
  });
  const { events } = await collect(harness, {
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(events.at(-1)).toMatchObject({
    type: "attempt.blocked_policy",
    code: "approval_required",
  });
  expect(
    client.requests.find((r) => r.method === "session/stop")?.params,
  ).toMatchObject({ sessionId: "sess-1" });
  expect(client.responseErrors[0]).toMatchObject({ id: "server-9" });
});

test("non-success result types fail as retryable infra failures", async () => {
  const client = new RecordedZcodeClient();
  const harness = createZcodeHarness({ client, branches: memoryBranches() });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(
    turnCompleted("sess-1", scoutOutput, { resultType: "failed" }),
  );
  const { events } = await collect(harness, {
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(events.at(-1)).toMatchObject({
    type: "attempt.failed_infra",
    code: "turn_failed",
    retryable: true,
  });
});

test("reconcile completes persisted outputs and retries in-flight turns", async () => {
  const client = new RecordedZcodeClient();
  const harness = createZcodeHarness({ client, branches: memoryBranches() });

  const deliveredCursor = JSON.stringify({
    version: 1,
    nextSequence: 4,
    sessionId: "sess-9",
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

test("provider rpc rejection text never reaches the durable failure event", async () => {
  class SendRejectingClient extends RecordedZcodeClient {
    async request(method: string, params: unknown): Promise<unknown> {
      if (method === "session/send") {
        // Exactly the error the production client builds: a fixed message
        // with the raw provider text only in the non-persisted cause.
        throw new AgileError({
          code: "ZCODE_APP_SERVER_RPC_ERROR",
          category: "protocol",
          retryable: false,
          component: "zcode-client",
          message: "ZCode app-server rejected the request",
          cause: {
            code: -32000,
            message: "provider failure detail zcode-secret-sentinel-0e7a",
          },
        });
      }
      return super.request(method, params);
    }
  }

  const client = new SendRejectingClient();
  const harness = createZcodeHarness({ client, branches: memoryBranches() });

  const failed = await harness.step(makeScoutRequest());
  if (failed.kind !== "event") throw new Error("expected an event delivery");
  expect(failed.event).toMatchObject({
    type: "attempt.failed_infra",
    code: "ZCODE_APP_SERVER_RPC_ERROR",
    message: "ZCode app-server rejected the request",
    retryable: false,
  });
  // The serialized durable event never carries the provider's raw text, and
  // stderr renders the same fixed message field.
  expect(JSON.stringify(failed.event)).not.toContain("zcode-secret-sentinel");
});

test("a JSON-less final response gets an in-session retry before completing", async () => {
  const client = new RecordedZcodeClient();
  const harness = createZcodeHarness({
    client,
    branches: memoryBranches(),
    now: () => "2026-08-27T00:00:00.000Z",
  });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");

  client.enqueue(
    turnCompleted("sess-1", undefined, {
      rawResponse:
        "The repository inspection went well.\nNo structured payload in this reply.",
    }),
  );
  client.enqueue(turnCompleted("sess-1", scoutOutput));
  const { events } = await collect(harness, {
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(events.map((event) => event.type)).toEqual([
    "attempt.usage_delta",
    "attempt.output",
    "attempt.completed",
  ]);

  const sends = client.requests.filter((r) => r.method === "session/send");
  expect(sends).toHaveLength(2);
  const correction = sends[1]?.params as { sessionId?: string; content?: string };
  expect(correction.sessionId).toBe("sess-1");
  expect(correction.content).toContain("no JSON object");
  expect(correction.content).toContain("exactly one JSON object");
});

test("persistently JSON-less responses exhaust retries and fail the attempt", async () => {
  const client = new RecordedZcodeClient();
  const harness = createZcodeHarness({
    client,
    branches: memoryBranches(),
    now: () => "2026-08-27T00:00:00.000Z",
  });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");

  for (let index = 0; index < 3; index += 1) {
    client.enqueue(
      turnCompleted("sess-1", undefined, {
        rawResponse: `Prose report ${index}: findings in paragraph form only.`,
      }),
    );
  }
  const { events } = await collect(harness, {
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(events.map((event) => event.type)).toEqual(["attempt.failed_infra"]);
  const failure = events[0] as Extract<
    HarnessEvent,
    { type: "attempt.failed_infra" }
  >;
  expect(failure.code).toBe("invalid_structured_output");

  const sends = client.requests.filter((r) => r.method === "session/send");
  expect(sends).toHaveLength(3); // prompt + two corrections, then give up
});

test("a schema-violating JSON final response gets an in-session retry before completing", async () => {
  const client = new RecordedZcodeClient();
  const harness = createZcodeHarness({
    client,
    branches: memoryBranches(),
    now: () => "2026-08-27T00:00:00.000Z",
  });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");

  // Observed live failure shape: the model embeds the prompt's JSON-schema
  // metadata as a "$schema" key, which the strict role schema rejects.
  const polluted = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...scoutOutput,
  };
  client.enqueue(turnCompleted("sess-1", undefined, {
    rawResponse: JSON.stringify(polluted),
  }));
  client.enqueue(turnCompleted("sess-1", scoutOutput));
  const { events } = await collect(harness, {
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(events.map((event) => event.type)).toEqual([
    "attempt.usage_delta",
    "attempt.output",
    "attempt.completed",
  ]);

  const sends = client.requests.filter((r) => r.method === "session/send");
  expect(sends).toHaveLength(2);
  const correction = sends[1]?.params as { sessionId?: string; content?: string };
  expect(correction.sessionId).toBe("sess-1");
  expect(correction.content).toContain("no JSON object");
  expect(correction.content).toContain('"$schema"');
});

test("mixed JSON-less and schema-violating responses exhaust retries and fail the attempt", async () => {
  const client = new RecordedZcodeClient();
  const harness = createZcodeHarness({
    client,
    branches: memoryBranches(),
    now: () => "2026-08-27T00:00:00.000Z",
  });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");

  client.enqueue(
    turnCompleted("sess-1", undefined, {
      rawResponse: "Prose report: findings in paragraph form only.",
    }),
  );
  client.enqueue(
    turnCompleted("sess-1", undefined, {
      rawResponse: JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...scoutOutput,
      }),
    }),
  );
  client.enqueue(
    turnCompleted("sess-1", undefined, {
      rawResponse: JSON.stringify({ kind: "scout" }), // missing required fields
    }),
  );
  const { events } = await collect(harness, {
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(events.map((event) => event.type)).toEqual(["attempt.failed_infra"]);
  const failure = events[0] as Extract<
    HarnessEvent,
    { type: "attempt.failed_infra" }
  >;
  expect(failure.code).toBe("invalid_structured_output");

  // Both failure shapes share one retry budget: prompt + two corrections.
  const sends = client.requests.filter((r) => r.method === "session/send");
  expect(sends).toHaveLength(3);
});
