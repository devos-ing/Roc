import { expect, test } from "bun:test";
import { buildTaskBoardSnapshot } from "../../src/cli/task-board-model";
import { renderTaskBoard } from "../../src/cli/task-board-renderer";
import {
  ExecutionRecordSchema,
  initialExecution,
} from "../../src/github/execution-store";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { memoryGitHub } from "../helpers/github-native";
import { memoryPlan } from "../helpers/github-plan";

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
          retryIndex: 0 as const,
          modelProfile: "terra" as const,
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

test("projects saved rejected Review findings into the monitor failure reason", async () => {
  const remote = memoryGitHub();
  const task = await remote.store().get(41);
  const startedAt = "2026-09-09T00:00:00.000Z";
  task.execution = ExecutionRecordSchema.parse({
    ...initialExecution(task, "main", "a".repeat(40)),
    phase: "rejected",
    attempts: [
      {
        descriptor: {
          attemptId: "rejected-review",
          taskId: "issue-41",
          role: "review",
          retryIndex: 0,
          modelProfile: "terra",
          model: "test/model",
          effort: "high",
        },
        status: "succeeded",
        startedAt,
        endedAt: startedAt,
        sequence: 1,
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
          findings: ["missing regression"],
          remainingGaps: ["repair the monitor"],
        },
      },
    ],
  });
  task.task.status = "rejected";
  task.execution.failure = "Review rejected";
  const inspected = githubTaskSnapshot([task]).inspection.tasks[0];
  expect(inspected?.attempts[0]).toMatchObject({
    reviewDecision: "rejected",
    failure: "missing regression; repair the monitor",
  });
  expect(inspected?.failure).toContain(
    "missing regression; repair the monitor",
  );

  task.execution.failure = undefined;
  task.task.status = "implementing";
  expect(
    githubTaskSnapshot([task]).inspection.tasks[0]?.failure,
  ).toBeUndefined();
});

test("renders current rejected Review findings for needs_replan and suppresses superseded Reviews", async () => {
  const remote = memoryGitHub();
  const task = await remote.store().get(41);
  const at = "2026-09-09T00:00:00.000Z";
  const review = (
    id: string,
    decision: "accepted" | "rejected",
    status: "succeeded" | "running" = "succeeded",
  ) => ({
    descriptor: {
      attemptId: id,
      taskId: "issue-41",
      role: "review" as const,
      retryIndex: 0 as const,
      modelProfile: "terra" as const,
      model: "test/model",
      effort: "high" as const,
    },
    status,
    startedAt: at,
    ...(status === "succeeded"
      ? {
          endedAt: at,
          output: {
            kind: "review" as const,
            decision,
            findings: ["rebase finding"],
            remainingGaps: ["repair it"],
          },
        }
      : {}),
    sequence: 1,
    events: {},
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    usageKnown: true,
  });
  task.execution = ExecutionRecordSchema.parse({
    ...initialExecution(task, "main", "a".repeat(40)),
    phase: "needs_replan",
    attempts: [review("rejected", "rejected")],
  });
  task.task.status = "needs_replan";
  const snapshot = githubTaskSnapshot([task]);
  const board = buildTaskBoardSnapshot({
    tasks: snapshot.tasks,
    inspection: snapshot.inspection,
    currentCycleId: task.task.cycleId,
  });
  expect(
    renderTaskBoard(board, {
      width: 80,
      detailTaskId: task.task.id,
      detailMode: "full",
      color: false,
    }),
  ).toContain("rebase finding");
  task.execution.attempts.push(review("accepted", "accepted"));
  expect(
    githubTaskSnapshot([task]).inspection.tasks[0]?.failure ?? "",
  ).not.toContain("rebase finding");
  task.execution.attempts.pop();
  task.execution.attempts.push(review("pending", "rejected", "running"));
  expect(
    githubTaskSnapshot([task]).inspection.tasks[0]?.failure ?? "",
  ).not.toContain("rebase finding");
});

test("cleanup membership maps same-plan local chain IDs onto runtime Issue worktree owners", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"]]);
  const { tasks } = await remote.store.list();
  const first = tasks[0];
  const second = tasks[1];
  if (!first || !second) throw Error("Missing plan fixture tasks");
  first.envelope.task.id = "A";
  second.envelope.task.id = "B";
  second.envelope.task.spec.continues = { task: "A" };
  const snapshot = githubTaskSnapshot([first, second]);
  expect(first.task.id).toBe("issue-41");
  expect(second.task.id).toBe("issue-42");
  expect(snapshot.incompleteChainWorktrees.size).toBe(0);
  expect(snapshot.chainMembers.get("issue-41")).toEqual([
    "issue-41",
    "issue-42",
  ]);
  expect(snapshot.tasks[1]?.spec.continues).toEqual({ task: "issue-41" });
});
