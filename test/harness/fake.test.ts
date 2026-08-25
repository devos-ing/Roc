import { expect, test } from "bun:test";
import { createFakeHarness } from "../../src/harness/fake";

const scenario = {
  attempts: [{
    taskId: "T1",
    role: "scout",
    retryIndex: 0,
    expect: { model: "luna", effort: "high" },
    deliveries: [
      {
        nextCursor: "1",
        event: {
          type: "attempt.started",
          eventId: "T1:scout:0:started",
          attemptId: "A1",
          sequence: 1,
          occurredAt: "2026-08-25T00:00:00.000Z",
          threadId: "thread-T1",
        },
      },
      {
        nextCursor: "2",
        event: {
          type: "attempt.usage_delta",
          eventId: "T1:scout:0:usage",
          attemptId: "A1",
          sequence: 2,
          occurredAt: "2026-08-25T00:00:01.000Z",
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
      },
      {
        nextCursor: "3",
        event: {
          type: "attempt.usage_delta",
          eventId: "T1:scout:0:usage",
          attemptId: "A1",
          sequence: 2,
          occurredAt: "2026-08-25T00:00:01.000Z",
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
      },
    ],
  }],
};

const ticket = {
  id: "T1",
  weekId: "2026-W35",
  title: "Test task",
  spec: {
    problem: "Need a scripted agent",
    desiredOutcome: "Receive deterministic events",
    scope: ["harness"],
    nonGoals: [],
    acceptanceCriteria: ["events follow the cursor"],
    validation: ["bun test"],
    dependencies: [],
    risk: "low" as const,
    contextCandidates: [],
    tokenCeiling: 1_000,
  },
  priority: 0,
  approvalRequired: false,
  approved: true,
  status: "scouting" as const,
};

const request = {
  mode: "dispatch" as const,
  attempt: {
    attemptId: "A1",
    taskId: "T1",
    role: "scout" as const,
    retryIndex: 0 as const,
    modelProfile: "luna" as const,
    model: "luna",
    effort: "high" as const,
  },
  input: { role: "scout" as const, ticket },
};

test("delivers scripted events by persisted cursor, including duplicate event IDs", async () => {
  const fake = createFakeHarness(scenario);
  const first = await fake.harness.step(request);
  expect(first).toMatchObject({ kind: "event", nextCursor: "1", event: { type: "attempt.started" } });
  const second = await fake.harness.step({ ...request, backendCursor: "1" });
  expect(second).toMatchObject({ kind: "event", nextCursor: "2", event: { eventId: "T1:scout:0:usage" } });
  const duplicate = await fake.harness.step({ ...request, backendCursor: "2" });
  expect(duplicate).toMatchObject({ kind: "event", nextCursor: "3", event: { eventId: "T1:scout:0:usage" } });
  await expect(fake.harness.step({ ...request, backendCursor: "3" }))
    .rejects.toThrow("Unexpected extra fake call for T1:scout:0");
  expect(() => fake.assertComplete()).not.toThrow();
});

test("binds authored event attempt IDs to the active runtime attempt", async () => {
  const fake = createFakeHarness(scenario);
  const runtimeAttemptId = `attempt-${crypto.randomUUID()}`;

  const delivery = await fake.harness.step({
    ...request,
    attempt: { ...request.attempt, attemptId: runtimeAttemptId },
  });

  expect(delivery).toEqual({
    kind: "event" as const,
    nextCursor: "1",
    event: {
      type: "attempt.started" as const,
      eventId: "T1:scout:0:started",
      attemptId: runtimeAttemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:00.000Z",
      threadId: "thread-T1",
    },
  });
});

test("fails fast for a model mismatch, missing script, and unconsumed delivery", async () => {
  const mismatch = createFakeHarness(scenario);
  await expect(mismatch.harness.step({
    ...request,
    attempt: { ...request.attempt, model: "terra" },
  })).rejects.toThrow("Fake expectation failed for T1:scout:0: model terra !== luna");

  const missing = createFakeHarness(scenario);
  await expect(missing.harness.step({
    ...request,
    attempt: { ...request.attempt, taskId: "T2" },
  })).rejects.toThrow("Missing fake script for T2:scout:0");

  const incomplete = createFakeHarness(scenario);
  await incomplete.harness.step(request);
  expect(() => incomplete.assertComplete()).toThrow("Unconsumed fake deliveries for T1:scout:0");

  expect(() => createFakeHarness({
    attempts: [scenario.attempts[0], scenario.attempts[0]],
  })).toThrow("Duplicate fake script for T1:scout:0");
});
