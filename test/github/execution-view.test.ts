import { expect, test } from "bun:test";
import {
  ExecutionRecordSchema,
  initialExecution,
} from "../../src/github/execution-store";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { memoryGitHub } from "../helpers/github-native";

test("inspection freezes completed timing, separates merge waiting and preserves incomplete usage", async () => {
  const remote = memoryGitHub();
  const task = await remote.store().get(41);
  const start = Date.parse("2026-09-09T00:00:00Z");
  const at = (seconds: number) =>
    new Date(start + seconds * 1000).toISOString();
  task.execution = ExecutionRecordSchema.parse({
    ...initialExecution(task, "main", "a".repeat(40)),
    phase: "done",
    updatedAt: at(35),
    timeline: [
      { phase: "claimed", at: at(0) },
      { phase: "implementing", at: at(5) },
      { phase: "awaiting_merge", at: at(20) },
      { phase: "done", at: at(35) },
    ],
    attempts: [
      {
        descriptor: {
          attemptId: "real-attempt",
          taskId: "issue-41",
          role: "implement",
          retryIndex: 0,
          modelProfile: "terra",
          model: "test/model",
          effort: "high",
        },
        status: "succeeded",
        startedAt: at(5),
        endedAt: at(20),
        sequence: 1,
        events: {},
        usage: {
          inputTokens: 10,
          cachedInputTokens: 4,
          outputTokens: 2,
          reasoningOutputTokens: 1,
        },
        usageKnown: false,
        activity: {
          itemId: "read",
          action: "read",
          summary: "Read answer.ts",
          status: "completed",
          occurredAt: at(18),
        },
      },
    ],
  });
  task.task.status = "done";
  const snapshot = githubTaskSnapshot([task], [], start + 500_000);
  const inspected = snapshot.inspection.tasks[0];
  expect(inspected?.timing).toMatchObject({
    elapsedMs: 35_000,
    attemptMs: 15_000,
    waitingMs: 15_000,
  });
  expect(inspected?.usageIncomplete).toBe(true);
  expect(inspected?.attempts[0]?.activity?.summary).toBe("Read answer.ts");
  expect(inspected?.actual.inputTokens).toBe(10);
  task.execution.phase = "awaiting_merge";
  task.execution.timeline?.pop();
  task.execution.updatedAt = at(40);
  task.task.status = "retired";
  expect(
    githubTaskSnapshot([task], [], start + 50_000).inspection.tasks[0]?.timing,
  ).toBeUndefined();
  delete task.execution.timeline;
  expect(
    githubTaskSnapshot([task]).inspection.tasks[0]?.timing,
  ).toBeUndefined();
});
