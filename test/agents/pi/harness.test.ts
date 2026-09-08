import { expect, test } from "bun:test";
import { createPiHarness } from "../../../src/agents/pi/harness";
import type { PiBackendCursor } from "../../../src/agents/pi/protocol";
import type { HarnessEvent } from "../../../src/harness/contracts";
import {
  backendCursor,
  collect,
  makeImplementRequest,
  makeReviewRequest,
  makeScoutRequest,
  memoryBranches,
  messageEnd,
  RecordedPiClient,
  scoutOutput,
} from "./fixtures";

test("reports bounded Pi tool activity, correlates overlapping calls, and replays uncommitted deliveries", async () => {
  const start = {
    type: "tool_execution_start",
    toolCallId: "tests",
    toolName: "bash",
    args: { command: "bun test --token=do-not-store" },
  };
  const end = {
    type: "tool_execution_end",
    toolCallId: "tests",
    toolName: "bash",
    isError: true,
    result: "do-not-store",
  };
  const client = new RecordedPiClient([
    start,
    start,
    {
      type: "tool_execution_start",
      toolCallId: "read",
      toolName: "read",
      args: { path: "src/main.ts" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "tests",
      toolName: "bash",
      partialResult: "do-not-store",
    },
    end,
    end,
    start,
    {
      type: "tool_execution_end",
      toolCallId: "read",
      toolName: "read",
      isError: false,
      result: "do-not-store",
    },
    {
      type: "tool_execution_start",
      toolCallId: "edit",
      toolName: "write",
      args: {
        path: `src/\u001b[2Jtest\n${"字".repeat(300)}`,
        content: "do-not-store",
      },
    },
    {
      type: "tool_execution_end",
      toolCallId: "edit",
      toolName: "write",
      isError: false,
    },
    {
      type: "tool_execution_end",
      toolCallId: "invalid",
      toolName: "bash",
      isError: "no",
    },
    messageEnd(),
    { type: "agent_settled" },
  ]);
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });
  const request = makeScoutRequest();
  const started = await harness.step(request);
  if (started.kind !== "event") throw new Error("Expected start");
  const pendingRequest = { ...request, backendCursor: started.nextCursor };
  const pending = await harness.step(pendingRequest);
  if (pending.kind !== "event") throw new Error("Expected activity");
  expect(await harness.step(pendingRequest)).toEqual(pending);
  const { events } = await collect(harness, {
    ...request,
    backendCursor: pending.nextCursor,
  });
  const all = [pending.event, ...events];
  const activities = all.filter((event) => event.type === "attempt.activity");
  expect(
    activities.map((event) => [
      event.activity.summary.slice(0, 16),
      event.activity.status,
    ]),
  ).toEqual([
    ["Run tests", "running"],
    ["Read src/main.ts", "running"],
    ["Run tests", "failed"],
    ["Read src/main.ts", "completed"],
    ["Edit src/test 字字", "running"],
    ["Edit src/test 字字", "completed"],
  ]);
  expect(
    activities.every((event) => event.activity.summary.length <= 200),
  ).toBe(true);
  expect(JSON.stringify(activities)).not.toContain("do-not-store");
  expect(JSON.stringify(activities)).not.toContain("\\u001b");
  expect(all.map((event) => event.sequence)).toEqual([
    2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);
  expect(all.at(-1)?.type).toBe("attempt.completed");
});

test("reconciles a persisted Pi activity cursor as an orphaned turn and starts retries without stale activity", async () => {
  const client = new RecordedPiClient([
    {
      type: "tool_execution_start",
      toolCallId: "old",
      toolName: "read",
      args: { path: "old.ts" },
    },
  ]);
  const first = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });
  const request = makeScoutRequest();
  const started = await first.step(request);
  if (started.kind !== "event") throw new Error("Expected start");
  const activity = await first.step({
    ...request,
    backendCursor: started.nextCursor,
  });
  if (activity.kind !== "event") throw new Error("Expected activity");
  const recovered = createPiHarness({
    branches: memoryBranches(),
    startClient: async () =>
      new RecordedPiClient([messageEnd(), { type: "agent_settled" }]),
  });
  expect(
    await recovered.step({
      ...request,
      mode: "reconcile",
      backendCursor: activity.nextCursor,
    }),
  ).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.failed_infra",
      code: "orphaned_turn",
      sequence: 3,
      retryable: true,
    },
  });
  const retry = makeScoutRequest("retry");
  const { events } = await collect(recovered, {
    ...retry,
    attempt: { ...retry.attempt, retryIndex: 1 },
  });
  expect(events.some((event) => event.type === "attempt.activity")).toBe(false);
  expect(events.at(-1)?.type).toBe("attempt.completed");
});

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
  // inputTokens is the full prompt total, so each message's cache reads fold
  // into it: (1000 + 400) + (500 + 200).
  expect(usage.inputTokens).toBe(2100);
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

test("implement restores an approved follow-up source commit before starting Pi", async () => {
  const client = new RecordedPiClient();
  const restorations: Array<[string, string, string]> = [];
  const harness = createPiHarness({
    branches: memoryBranches({
      async restoreChanges(taskId, sourceCommit, baseCommit) {
        if (baseCommit === undefined) throw new Error("missing base commit");
        restorations.push([taskId, sourceCommit, baseCommit]);
      },
    }),
    startClient: async () => client,
  });
  const original = makeImplementRequest();
  if (original.input.role !== "implement") throw new Error("unreachable");
  const request = {
    ...original,
    input: {
      ...original.input,
      ticket: {
        ...original.input.ticket,
        spec: {
          ...original.input.ticket.spec,
          sourceCommit: "c".repeat(40),
        },
      },
    },
  };

  await harness.step(request);

  expect(restorations).toEqual([["T1", "c".repeat(40), "a".repeat(40)]]);
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

test("a retried cursor replays the identical pending delivery", async () => {
  const client = new RecordedPiClient();
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(messageEnd(), { type: "agent_settled" });

  // The settled turn queues a usage delta followed by the output; a
  // repository write failure retries the same cursor and must receive the
  // byte-identical usage delivery, never the output that follows it.
  const usage = await harness.step({
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  const usageRetry = await harness.step({
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  expect(usageRetry).toEqual(usage);
  if (usage.kind !== "event" || usage.event.type !== "attempt.usage_delta") {
    throw new Error("expected the usage delta first");
  }

  // Confirming the usage cursor advances to the output; retrying that
  // cursor replays the identical output delivery too.
  const output = await harness.step({
    ...makeScoutRequest(),
    backendCursor: usage.nextCursor,
  });
  const outputRetry = await harness.step({
    ...makeScoutRequest(),
    backendCursor: usage.nextCursor,
  });
  expect(outputRetry).toEqual(output);
  if (output.kind !== "event" || output.event.type !== "attempt.output") {
    throw new Error("expected the structured output next");
  }

  // Confirming the output cursor finally yields the completion.
  const completed = await harness.step({
    ...makeScoutRequest(),
    backendCursor: output.nextCursor,
  });
  expect(completed).toMatchObject({
    kind: "event",
    event: { type: "attempt.completed" },
  });
});

test("a mutated cursor with the same sequence replays the pending head", async () => {
  const client = new RecordedPiClient();
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(messageEnd(), { type: "agent_settled" });

  const usage = await harness.step({
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  if (usage.kind !== "event") throw new Error("unreachable");

  // A cursor that keeps the delivered sequence but rewrites another field is
  // not an acknowledgement: the head must replay unchanged rather than let
  // the forged cursor skip the unpersisted delivery.
  const mutated = JSON.parse(usage.nextCursor) as Record<string, unknown>;
  const mutatedUsage = mutated.usage as Record<string, number>;
  mutatedUsage.inputTokens = 999_999;
  const replayed = await harness.step({
    ...makeScoutRequest(),
    backendCursor: JSON.stringify(mutated),
  });
  expect(replayed).toEqual(usage);
});

test("a cursor that skips ahead replays the pending head", async () => {
  const client = new RecordedPiClient();
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  const started = await harness.step(makeScoutRequest());
  if (started.kind !== "event") throw new Error("unreachable");
  client.enqueue(messageEnd(), { type: "agent_settled" });

  const usage = await harness.step({
    ...makeScoutRequest(),
    backendCursor: started.nextCursor,
  });
  if (usage.kind !== "event") throw new Error("unreachable");

  // A schema-valid cursor whose sequence jumps past every queued delivery is
  // still not an acknowledgement; the head replays instead of the queue
  // draining.
  const skipped = JSON.parse(usage.nextCursor) as {
    nextSequence?: number;
  };
  skipped.nextSequence = (skipped.nextSequence ?? 0) + 100;
  const replayed = await harness.step({
    ...makeScoutRequest(),
    backendCursor: JSON.stringify(skipped),
  });
  expect(replayed).toEqual(usage);
});

test("dispatch fails closed when the state model differs from the routed pair", async () => {
  const client = new RecordedPiClient([], {
    model: { id: "glm-5.3", provider: "bigmodel" },
  });
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  const failed = await harness.step(makeScoutRequest());
  expect(failed).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.failed_infra",
      code: "model_routing_unverified",
    },
  });
});

test("dispatch fails closed when the thinking level was clamped", async () => {
  const client = new RecordedPiClient([], { thinkingLevel: "medium" });
  const harness = createPiHarness({
    branches: memoryBranches(),
    startClient: async () => client,
  });

  const failed = await harness.step(makeScoutRequest());
  expect(failed).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.failed_infra",
      code: "model_routing_unverified",
    },
  });
});
