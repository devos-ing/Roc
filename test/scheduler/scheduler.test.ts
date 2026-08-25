import { expect, test } from "bun:test";
import type { AgentHarness, HarnessEvent, HarnessStepRequest } from "../../src/harness/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const rejectedReviewOutput = {
  kind: "review" as const,
  decision: "rejected" as const,
  findings: ["validation failed"],
  remainingGaps: ["follow-up fixes validation"],
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
  output: Extract<HarnessEvent, { type: "attempt.output" }>["output"],
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

function infraFailureDelivery(
  key: string,
  attemptId: string,
  code: string,
  retryable: boolean,
) {
  return [{
    nextCursor: "1",
    event: {
      type: "attempt.failed_infra" as const,
      eventId: `${key}:failed`,
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
      code,
      message: "Fake infrastructure failure",
      retryable,
    },
  }];
}

function setupAcceptedTask(
  finalReviewOutput: Extract<
    Extract<HarnessEvent, { type: "attempt.output" }>["output"],
    { kind: "review" }
  > = reviewOutput,
) {
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
    { taskId: "T1", role: "review", retryIndex: 0, expect: { model: "sol", effort: "high", contextRef: inheritedContext }, deliveries: roleDeliveries("review", "attempt-3", finalReviewOutput) },
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

test("reconciles from the committed cursor after a post-commit crash", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agile-agents-scheduler-crash-"));
  const databasePath = join(directory, "scheduler.db");
  const db = openDatabase(databasePath);
  let reopened: ReturnType<typeof openDatabase> | undefined;
  try {
    const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
    planning.createWeek({
      id: "2026-W35", goal: "Reconcile", nonGoals: [], tokenBudget: 100_000, ticketIds: ["T1"],
    });
    planning.createTask({
      id: "T1",
      weekId: "2026-W35",
      title: "Reconcile after a crash",
      spec: {
        problem: "A scheduler can crash after commit",
        desiredOutcome: "Resume from the durable cursor",
        scope: ["scheduler"],
        nonGoals: [],
        acceptanceCriteria: ["the event is not redelivered"],
        validation: ["bun test"],
        dependencies: [],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 10_000,
      },
      priority: 0,
      approvalRequired: false,
      approved: true,
    });
    planning.transitionTask("T1", "ready", "T1:ready");
    const counters: Record<string, number> = {};
    const repo = new OrchestrationRepository(
      db,
      () => "2026-08-25T00:00:01.000Z",
      (kind) => `${kind}-${counters[kind] = (counters[kind] ?? 0) + 1}`,
    );
    const event = {
      type: "attempt.started" as const,
      eventId: "scout:started",
      attemptId: "attempt-1",
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
      threadId: "thread-scout",
    };
    const scheduler = new Scheduler(repo, {
      async step() {
        return { kind: "event", nextCursor: "cursor-1", event };
      },
      async cancel() {},
    }, (point) => {
      if (point === "after_delivery_commit") throw new Error(`crash:${point}`);
    });

    expect(await scheduler.tick()).toEqual({ kind: "task_claimed", taskId: "T1" });
    expect(await scheduler.tick()).toEqual({ kind: "attempt_started", attemptId: "attempt-1" });
    await expect(scheduler.tick()).rejects.toThrow("crash:after_delivery_commit");
    db.close();

    reopened = openDatabase(databasePath);
    const resumedRepo = new OrchestrationRepository(reopened);
    const resumedRequests: HarnessStepRequest[] = [];
    const resumed = new Scheduler(resumedRepo, {
      async step(request) {
        resumedRequests.push(request);
        return { kind: "idle" };
      },
      async cancel() {},
    });

    expect(await resumed.tick()).toEqual({ kind: "idle" });
    expect(resumedRequests).toMatchObject([{
      mode: "reconcile",
      backendCursor: "cursor-1",
      attempt: { attemptId: "attempt-1" },
    }]);
    expect(reopened.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM events WHERE idempotency_key = ?
    `).get(event.eventId)?.count).toBe(1);
    expect(reopened.query<{ thread_id: string | null; backend_cursor: string | null }, [string]>(`
      SELECT thread_id, backend_cursor FROM attempts WHERE id = ?
    `).get(event.attemptId)).toEqual({
      thread_id: "thread-scout",
      backend_cursor: "cursor-1",
    });
  } finally {
    if (reopened) reopened.close();
    else db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejected Review creates one draft follow-up without rerunning the original task", async () => {
  const { db, repo, scheduler, fake } = setupAcceptedTask(rejectedReviewOutput);
  try {
    await scheduler.runUntilIdle(40);

    expect(repo.inspectTask("T1")).toMatchObject({ status: "rejected" });
    expect(repo.listReviews("T1")).toMatchObject([{
      decision: "rejected",
      findings: ["validation failed"],
    }]);
    expect(repo.listTasksByRoot("T1")).toMatchObject([
      { id: "T1", status: "rejected" },
      {
        id: "task-1",
        status: "draft",
        parentTaskId: "T1",
        rootTaskId: "T1",
        approved: false,
      },
    ]);
    expect(repo.listAttempts("T1")).toHaveLength(3);
    expect(repo.listAttempts("task-1")).toEqual([]);
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});

test("caps retryable Scout infrastructure failures and upgrades only the final retry", async () => {
  const { db, repo } = setupAcceptedTask();
  const fake = createFakeHarness({ attempts: [
    { taskId: "T1", role: "scout", retryIndex: 0, expect: { model: "luna", effort: "high", contextRef: inheritedContext }, deliveries: infraFailureDelivery("scout-0", "attempt-1", "backend_unavailable", true) },
    { taskId: "T1", role: "scout", retryIndex: 1, expect: { model: "luna", effort: "high", contextRef: inheritedContext }, deliveries: infraFailureDelivery("scout-1", "attempt-2", "backend_unavailable", true) },
    { taskId: "T1", role: "scout", retryIndex: 2, expect: { model: "terra", effort: "high", contextRef: inheritedContext }, deliveries: infraFailureDelivery("scout-2", "attempt-3", "backend_unavailable", true) },
  ] });
  const scheduler = new Scheduler(repo, fake.harness);
  try {
    await scheduler.runUntilIdle(12);

    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", retryIndex: 0, model: "luna", status: "failed_infra" },
      { role: "scout", retryIndex: 1, model: "luna", status: "failed_infra" },
      { role: "scout", retryIndex: 2, model: "terra", status: "failed_infra" },
    ]);
    expect(repo.inspectTask("T1")).toMatchObject({ status: "failed_infra" });
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});

test("retries a model-unavailable Scout with Terra immediately", async () => {
  const { db, repo } = setupAcceptedTask();
  const fake = createFakeHarness({ attempts: [
    { taskId: "T1", role: "scout", retryIndex: 0, expect: { model: "luna", effort: "high", contextRef: inheritedContext }, deliveries: infraFailureDelivery("scout-0", "attempt-1", "model_unavailable", true) },
    { taskId: "T1", role: "scout", retryIndex: 1, expect: { model: "terra", effort: "high", contextRef: inheritedContext }, deliveries: infraFailureDelivery("scout-1", "attempt-2", "backend_unavailable", false) },
  ] });
  const scheduler = new Scheduler(repo, fake.harness);
  try {
    await scheduler.runUntilIdle(8);

    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", retryIndex: 0, model: "luna", status: "failed_infra" },
      { role: "scout", retryIndex: 1, model: "terra", status: "failed_infra" },
    ]);
    expect(repo.inspectTask("T1")).toMatchObject({ status: "failed_infra" });
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});

test("terminalizes a non-retryable Scout infrastructure failure", async () => {
  const { db, repo } = setupAcceptedTask();
  const fake = createFakeHarness({ attempts: [
    { taskId: "T1", role: "scout", retryIndex: 0, expect: { model: "luna", effort: "high", contextRef: inheritedContext }, deliveries: infraFailureDelivery("scout-0", "attempt-1", "backend_unavailable", false) },
  ] });
  const scheduler = new Scheduler(repo, fake.harness);
  try {
    await scheduler.runUntilIdle(6);

    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", retryIndex: 0, model: "luna", status: "failed_infra" },
    ]);
    expect(repo.inspectTask("T1")).toMatchObject({ status: "failed_infra" });
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});
