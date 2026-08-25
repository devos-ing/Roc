import { expect, test } from "bun:test";
import type { AgentHarness, HarnessStepRequest } from "../../src/harness/contracts";
import { createFakeHarness } from "../../src/harness/fake";
import { Scheduler } from "../../src/scheduler/scheduler";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

const scoutOutput = {
  kind: "scout" as const,
  summary: "Found the scheduler boundary",
  files: ["src/scheduler/scheduler.ts"],
  tests: ["bun test"],
  risks: [],
};

const implementOutput = {
  kind: "implement" as const,
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  validation: ["bun test"],
  risks: [],
  limitations: [],
};

const reviewOutput = {
  kind: "review" as const,
  decision: "accepted" as const,
  findings: [],
  remainingGaps: [],
};

const inheritedContext = {
  threadId: "thread-C",
  anchorId: "anchor-C",
  sourceTaskId: "C",
  gitCommit: "cccccccccccccccccccccccccccccccccccccccc",
  summaryArtifact: "artifacts/C-summary.md",
};

function roleDeliveries(
  key: string,
  attemptId: string,
  output: typeof scoutOutput | typeof implementOutput | typeof reviewOutput,
) {
  return [
    {
      nextCursor: "1",
      event: {
        type: "attempt.started" as const,
        eventId: `${key}:started`,
        attemptId,
        sequence: 1,
        occurredAt: "2026-08-25T00:00:02.000Z",
        threadId: `thread-${key}`,
      },
    },
    {
      nextCursor: "2",
      event: {
        type: "attempt.output" as const,
        eventId: `${key}:output`,
        attemptId,
        sequence: 2,
        occurredAt: "2026-08-25T00:00:03.000Z",
        output,
      },
    },
    {
      nextCursor: "3",
      event: {
        type: "attempt.completed" as const,
        eventId: `${key}:completed`,
        attemptId,
        sequence: 3,
        occurredAt: "2026-08-25T00:00:04.000Z",
      },
    },
  ];
}

function setupAcceptedTask() {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
  planning.createWeek({
    id: "2026-W34", goal: "Prior context", nonGoals: [], tokenBudget: 50_000, ticketIds: ["C"],
  });
  planning.createTask({
    id: "C",
    weekId: "2026-W34",
    title: "Prior task C",
    spec: {
      problem: "Prior task context",
      desiredOutcome: "Provide an immutable context anchor",
      scope: ["context"],
      nonGoals: [],
      acceptanceCriteria: ["context can be inherited"],
      validation: ["bun test"],
      dependencies: [],
      risk: "medium",
      contextCandidates: [],
      tokenCeiling: 5_000,
    },
    priority: 0,
    approvalRequired: false,
    approved: true,
  });
  planning.createWeek({
    id: "2026-W35", goal: "Run roles", nonGoals: [], tokenBudget: 100_000, ticketIds: ["T1"],
  });
  planning.createTask({
    id: "T1",
    weekId: "2026-W35",
    title: "Run roles",
    spec: {
      problem: "No role pipeline",
      desiredOutcome: "Complete all roles",
      scope: ["scheduler"],
      nonGoals: [],
      acceptanceCriteria: ["task reaches done"],
      validation: ["bun test"],
      dependencies: [],
      risk: "medium",
      contextCandidates: [inheritedContext],
      tokenCeiling: 10_000,
    },
    priority: 0,
    approvalRequired: false,
    approved: true,
  });
  planning.transitionTask("T1", "ready", "T1:ready");
  db.query(`
    INSERT INTO contexts(id, thread_id, anchor_id, source_task_id, git_commit, summary_artifact)
    VALUES('context-C', $threadId, $anchorId, $sourceTaskId, $gitCommit, $summaryArtifact)
  `).run(inheritedContext);
  db.query("UPDATE tasks SET context_id = 'context-C' WHERE id = 'T1'").run();

  const counters: Record<string, number> = {};
  const repo = new OrchestrationRepository(
    db,
    () => "2026-08-25T00:00:01.000Z",
    (kind) => `${kind}-${counters[kind] = (counters[kind] ?? 0) + 1}`,
  );
  const fake = createFakeHarness({ attempts: [
    { taskId: "T1", role: "scout", retryIndex: 0, expect: { model: "luna", effort: "high", contextRef: inheritedContext }, deliveries: roleDeliveries("scout", "attempt-1", scoutOutput) },
    { taskId: "T1", role: "implement", retryIndex: 0, expect: { model: "terra", effort: "high", contextRef: inheritedContext }, deliveries: roleDeliveries("implement", "attempt-2", implementOutput) },
    { taskId: "T1", role: "review", retryIndex: 0, expect: { model: "sol", effort: "high", contextRef: inheritedContext }, deliveries: roleDeliveries("review", "attempt-3", reviewOutput) },
  ] });
  const requests: HarnessStepRequest[] = [];
  const harness: AgentHarness = {
    async step(input) {
      requests.push(input);
      return fake.harness.step(input);
    },
    cancel: (attemptId) => fake.harness.cancel(attemptId),
  };
  const scheduler = new Scheduler(repo, harness);
  return { db, repo, scheduler, fake, requests };
}

test("runs Scout, Implement, and isolated Review to done", async () => {
  const { db, repo, scheduler, fake, requests } = setupAcceptedTask();
  try {
    await scheduler.runUntilIdle(40);
    expect(repo.inspectTask("T1")).toMatchObject({ status: "done" });
    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", model: "luna", effort: "high", status: "succeeded" },
      { role: "implement", model: "terra", effort: "high", status: "succeeded" },
      { role: "review", model: "sol", effort: "high", status: "succeeded" },
    ]);
    expect(repo.listReviews("T1")).toMatchObject([{ decision: "accepted" }]);
    const reviewRequest = requests.find((request) => request.attempt.role === "review");
    expect(reviewRequest?.input).toEqual({
      role: "review",
      ticket: expect.objectContaining({ id: "T1" }),
      scout: scoutOutput,
      implementation: implementOutput,
    });
    expect(requests.every((request) => request.attempt.contextRef?.sourceTaskId === "C")).toBe(true);
    expect(JSON.stringify(reviewRequest)).not.toContain("thread-implement");
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});
