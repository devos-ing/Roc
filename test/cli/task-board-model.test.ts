import { expect, test } from "bun:test";
import { buildTaskBoardSnapshot } from "../../src/cli/task-board-model";
import { initialExecution } from "../../src/github/execution-store";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { memoryGitHub } from "../helpers/github-native";

test("an empty remote source produces an empty board without local storage", () => {
  const snapshot = githubTaskSnapshot([]);
  const board = buildTaskBoardSnapshot({
    ...snapshot,
    currentCycleId: "2026-W37",
    remoteCheckpoints: true,
  });
  expect(board.tasks).toEqual([]);
  expect(board.remoteCheckpoints).toBe(true);
});

test("the GitHub board keeps awaiting-merge work in progress and uses Issue identities", async () => {
  const fake = memoryGitHub();
  const task = await fake.store().get(41);
  task.execution = initialExecution(task, "main", "a".repeat(40));
  task.execution.phase = "awaiting_merge";
  task.task.status = "awaiting_merge";
  const snapshot = githubTaskSnapshot([task]);
  const board = buildTaskBoardSnapshot({
    ...snapshot,
    currentCycleId: "2026-W37",
  });
  expect(board.columns.inProgress.map((item) => item.id)).toEqual(["issue-41"]);
  expect(board.columns.done).toEqual([]);
  expect(board.tasks[0]?.rawStatus).toBe("awaiting_merge");
});

test("the GitHub board keeps failed evidence from a current rejected Review", async () => {
  const fake = memoryGitHub();
  const task = await fake.store().get(41);
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  task.execution = initialExecution(task, "main", base);
  task.execution.phase = "rejected";
  task.task.status = "rejected";
  task.execution.attempts.push({
    descriptor: {
      attemptId: "review-1",
      taskId: task.task.id,
      role: "review",
      retryIndex: 0,
      model: "test/model",
      modelProfile: "terra",
      effort: "high",
    },
    reviewTarget: { headSha: head, baseSha: base },
    status: "succeeded",
    startedAt: "2026-09-10T00:00:00.000Z",
    endedAt: "2026-09-10T00:01:00.000Z",
    sequence: 2,
    events: {},
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    usageKnown: true,
    output: {
      kind: "review",
      decision: "rejected",
      findings: ["answer differs"],
      remainingGaps: ["return 42"],
      acceptanceResults: [
        {
          criterionIndex: 0,
          status: "failed",
          evidence: "answer() returned 0",
        },
      ],
    },
  });
  const snapshot = githubTaskSnapshot([task]);
  expect(snapshot.inspection.tasks[0]?.acceptanceChecklist).toEqual([
    {
      criterionIndex: 0,
      criterion: "answer is 42",
      status: "failed",
      evidence: "answer() returned 0",
    },
  ]);
});
