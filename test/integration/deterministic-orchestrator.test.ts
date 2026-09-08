import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskBoardSnapshot } from "../../src/cli/task-board-model";
import { renderTaskBoard } from "../../src/cli/task-board-renderer";
import type { TaskPublisher } from "../../src/github/pr-publisher";
import type { HarnessEvent } from "../../src/harness/contracts";
import { createFakeHarness } from "../../src/harness/fake";
import { Scheduler } from "../../src/scheduler/scheduler";
import { openDatabase } from "../../src/store/database";
import {
  type IdFactory,
  OrchestrationRepository,
} from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

const usage = {
  inputTokens: 10,
  cachedInputTokens: 2,
  outputTokens: 4,
  reasoningOutputTokens: 1,
};

function deliveries(
  key: string,
  attemptId: string,
  output: Extract<HarnessEvent, { type: "attempt.output" }>["output"],
  includesUsage: boolean,
) {
  const events: Array<{ nextCursor: string; event: HarnessEvent }> = [
    {
      nextCursor: "1",
      event: {
        type: "attempt.started" as const,
        eventId: `${key}:started`,
        attemptId,
        sequence: 1,
        occurredAt: "2026-08-25T00:00:01.000Z",
        threadId: `thread-${key}`,
      },
    },
  ];
  if (includesUsage) {
    events.push({
      nextCursor: "2",
      event: {
        type: "attempt.usage_delta" as const,
        eventId: `${key}:usage`,
        attemptId,
        sequence: 2,
        occurredAt: "2026-08-25T00:00:02.000Z",
        ...usage,
      },
    });
  }
  const sequence = includesUsage ? 3 : 2;
  events.push({
    nextCursor: String(sequence),
    event: {
      type: "attempt.output" as const,
      eventId: `${key}:output`,
      attemptId,
      sequence,
      occurredAt: "2026-08-25T00:00:03.000Z",
      output,
    },
  });
  events.push({
    nextCursor: String(sequence + 1),
    event: {
      type: "attempt.completed" as const,
      eventId: `${key}:completed`,
      attemptId,
      sequence: sequence + 1,
      occurredAt: "2026-08-25T00:00:04.000Z",
    },
  });
  return events;
}

function scenario() {
  const scout = (taskId: string, attemptId: string) => ({
    taskId,
    role: "scout" as const,
    retryIndex: 0 as const,
    expect: { model: "luna", effort: "high" as const },
    deliveries: deliveries(
      `${taskId}:scout`,
      attemptId,
      {
        kind: "scout" as const,
        summary: `${taskId} scout capsule`,
        files: ["src/scheduler/scheduler.ts"],
        tests: ["bun test"],
        risks: [],
      },
      true,
    ),
  });
  const implement = (taskId: string, attemptId: string) => ({
    taskId,
    role: "implement" as const,
    retryIndex: 0 as const,
    expect: { model: "terra", effort: "high" as const },
    deliveries: deliveries(
      `${taskId}:implement`,
      attemptId,
      {
        kind: "implement" as const,
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        validation: ["bun test"],
        risks: [],
        limitations: [],
      },
      true,
    ),
  });
  const review = (
    taskId: string,
    attemptId: string,
    decision: "accepted" | "rejected",
  ) => ({
    taskId,
    role: "review" as const,
    retryIndex: 0 as const,
    expect: { model: "sol", effort: "high" as const },
    deliveries: deliveries(
      `${taskId}:review`,
      attemptId,
      {
        kind: "review" as const,
        decision,
        findings: decision === "rejected" ? ["validation failed"] : [],
        remainingGaps: decision === "rejected" ? ["fix validation"] : [],
      },
      false,
    ),
  });
  return {
    attempts: [
      scout("T1", "attempt-1"),
      implement("T1", "attempt-2"),
      review("T1", "attempt-3", "rejected"),
      scout("T2", "attempt-4"),
      implement("T2", "attempt-5"),
      review("T2", "attempt-6", "accepted"),
      scout("T3", "attempt-7"),
      implement("T3", "attempt-8"),
      review("T3", "attempt-9", "accepted"),
    ],
  };
}

function createIds(): IdFactory {
  const counts: Record<string, number> = {};
  return (kind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (kind === "task") return "T1-follow-up";
    return `${kind}-${counts[kind]}`;
  };
}

function fakePublisher(calls: string[]): TaskPublisher {
  return {
    baseBranch: "main",
    async publish(input) {
      calls.push(input.task.id);
      return {
        number: calls.length,
        url: `https://example.test/pull/${calls.length}`,
        state: "OPEN",
      };
    },
  };
}

test("three-task deterministic scheduler gate rejects, recovers, and accounts exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-orchestrator-gate-"));
  const databasePath = join(root, "state.db");
  const ids = createIds();
  const fake = createFakeHarness(scenario());
  let db = openDatabase(databasePath);
  try {
    const planning = new PlanningRepository(
      db,
      () => "2026-08-25T00:00:00.000Z",
    );
    planning.createCycle({
      id: "2026-W35",
      goal: "Prove deterministic orchestration",
      nonGoals: [],
      tokenBudget: 100_000,
      ticketIds: ["T1", "T2", "T3"],
    });
    for (const id of ["T1", "T2", "T3"]) {
      planning.createTask({
        id,
        cycleId: "2026-W35",
        title: `Task ${id}`,
        spec: {
          problem: `Complete ${id}`,
          desiredOutcome: `${id} reaches review`,
          scope: ["scheduler"],
          nonGoals: [],
          acceptanceCriteria: ["review completes"],
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
      planning.transitionTask(id, "ready", `${id}:ready`);
    }

    const repo = new OrchestrationRepository(
      db,
      () => "2026-08-25T00:00:05.000Z",
      ids,
    );
    const publicationCalls: string[] = [];
    const publisher = fakePublisher(publicationCalls);
    const first = new Scheduler(
      repo,
      fake.harness,
      () => {},
      undefined,
      publisher,
    );
    for (
      let tick = 0;
      repo.inspectTask("T1")?.status !== "rejected" && tick < 40;
      tick += 1
    ) {
      await first.tick();
    }
    expect(repo.inspectTask("T1")).toEqual({ id: "T1", status: "rejected" });
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM tasks WHERE discovered_from_review_id IS NOT NULL",
        )
        .get()?.count,
    ).toBe(1);
    expect(repo.inspectTask("T1-follow-up")).toEqual({
      id: "T1-follow-up",
      status: "draft",
    });
    expect(
      db
        .query<
          {
            id: string;
            status: string;
            approved: number;
            approval_required: number;
            parent_task_id: string | null;
            root_task_id: string | null;
            discovered_from_review_id: string | null;
          },
          [string]
        >(`
      SELECT id, status, approved, approval_required,
             parent_task_id, root_task_id, discovered_from_review_id
      FROM tasks WHERE id = ?
    `)
        .get("T1-follow-up"),
    ).toEqual({
      id: "T1-follow-up",
      status: "draft",
      approved: 0,
      approval_required: 1,
      parent_task_id: "T1",
      root_task_id: "T1",
      discovered_from_review_id: expect.any(String),
    });

    expect(await first.tick()).toEqual({ kind: "task_claimed", taskId: "T2" });
    expect(await first.tick()).toEqual({
      kind: "attempt_started",
      attemptId: "attempt-4",
    });
    let crashed = false;
    const crashing = new Scheduler(
      repo,
      fake.harness,
      (point) => {
        if (point === "after_delivery_commit" && !crashed) {
          crashed = true;
          throw new Error("simulated post-commit crash");
        }
      },
      undefined,
      publisher,
    );
    await expect(crashing.tick()).rejects.toThrow(
      "simulated post-commit crash",
    );
    expect(crashed).toBe(true);
    db.close();

    db = openDatabase(databasePath);
    const resumedRepo = new OrchestrationRepository(
      db,
      () => "2026-08-25T00:00:05.000Z",
      ids,
    );
    const resumed = new Scheduler(
      resumedRepo,
      fake.harness,
      () => {},
      undefined,
      publisher,
    );
    await resumed.runUntilIdle(100);

    const snapshot = resumedRepo.inspect();
    expect(snapshot.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "T1", status: "rejected" },
      { id: "T1-follow-up", status: "draft" },
      { id: "T2", status: "done" },
      { id: "T3", status: "done" },
    ]);
    expect(publicationCalls).toEqual(["T2", "T3"]);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM task_publications",
        )
        .get()?.count,
    ).toBe(2);
    expect(
      snapshot.tasks
        .filter((task) => ["T1", "T2", "T3"].includes(task.id))
        .map((task) => ({
          id: task.id,
          actual: task.actual,
        })),
    ).toEqual([
      {
        id: "T1",
        actual: {
          inputTokens: 20,
          cachedInputTokens: 4,
          outputTokens: 8,
          reasoningOutputTokens: 2,
        },
      },
      {
        id: "T2",
        actual: {
          inputTokens: 20,
          cachedInputTokens: 4,
          outputTokens: 8,
          reasoningOutputTokens: 2,
        },
      },
      {
        id: "T3",
        actual: {
          inputTokens: 20,
          cachedInputTokens: 4,
          outputTokens: 8,
          reasoningOutputTokens: 2,
        },
      },
    ]);
    expect(snapshot.cycles[0]?.actual).toEqual({
      inputTokens: 60,
      cachedInputTokens: 12,
      outputTokens: 24,
      reasoningOutputTokens: 6,
    });
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM tasks WHERE discovered_from_review_id IS NOT NULL",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM events GROUP BY idempotency_key HAVING COUNT(*) > 1",
        )
        .all(),
    ).toEqual([]);
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("activity survives rollback and restart without leaking into retries or accepting a rejected review", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-progress-"));
  const databasePath = join(root, "state.db");
  let db = openDatabase(databasePath);
  try {
    const planning = new PlanningRepository(db);
    planning.createCycle({
      id: "2026-W35",
      goal: "Visible execution",
      nonGoals: [],
      tokenBudget: 100_000,
      ticketIds: ["T1"],
    });
    planning.createTask({
      id: "T1",
      cycleId: "2026-W35",
      title: "Progress test",
      spec: {
        problem: "Waiting without feedback",
        desiredOutcome: "Show actual execution",
        scope: ["TUI"],
        nonGoals: [],
        acceptanceCriteria: ["Activity follows the attempt"],
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
    const original = scenario().attempts.slice(0, 3);
    const scout = original[0];
    if (scout === undefined) throw new Error("Missing Scout script");
    const activity: HarnessEvent = {
      type: "attempt.activity",
      eventId: "failed-scout:activity",
      attemptId: "attempt-1",
      sequence: 2,
      occurredAt: "2026-08-25T00:00:02.000Z",
      activity: {
        itemId: "read",
        action: "read",
        summary: "Read old.ts",
        status: "running",
      },
    };
    const script = {
      attempts: [
        {
          ...scout,
          deliveries: [
            {
              nextCursor: "1",
              event: {
                ...scout.deliveries[0]?.event,
                type: "attempt.started",
                eventId: "failed-scout:started",
                attemptId: "attempt-1",
                sequence: 1,
                occurredAt: "2026-08-25T00:00:01.000Z",
              },
            },
            { nextCursor: "2", event: activity },
            {
              nextCursor: "3",
              event: {
                type: "attempt.failed_infra",
                eventId: "failed-scout:failure",
                attemptId: "attempt-1",
                sequence: 3,
                occurredAt: "2026-08-25T00:00:03.000Z",
                code: "transport_failed",
                message: "Connection closed",
                retryable: true,
              },
            },
          ],
        },
        { ...scout, retryIndex: 1 },
        ...original.slice(1),
      ],
    };
    const ids = createIds();
    let failInsert = false;
    let repo = new OrchestrationRepository(
      db,
      () => "2026-08-25T00:00:01.000Z",
      ids,
      (point) => {
        if (point === "after_event_insert" && failInsert) {
          failInsert = false;
          throw new Error("Progress transaction interrupted");
        }
      },
    );
    let fake = createFakeHarness(script);
    let scheduler = new Scheduler(repo, fake.harness);
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    failInsert = true;
    await expect(scheduler.tick()).rejects.toThrow(
      "Progress transaction interrupted",
    );
    expect(repo.inspect().tasks[0]?.attempts[0]?.activity).toBeUndefined();
    expect(repo.getRunningAttempt()?.backendCursor).toBe("1");
    await scheduler.tick();
    repo.applyHarnessEvent("attempt-1", "2", activity);
    expect(repo.inspect().tasks[0]?.attempts[0]?.activity?.summary).toBe(
      "Read old.ts",
    );
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM events WHERE type = 'attempt.activity'",
        )
        .get()?.count,
    ).toBe(1);
    db.close();
    db = openDatabase(databasePath);
    repo = new OrchestrationRepository(
      db,
      () => "2026-08-25T00:00:04.000Z",
      ids,
    );
    fake = createFakeHarness(script);
    scheduler = new Scheduler(repo, fake.harness);
    const frame = (now: number) =>
      renderTaskBoard(
        buildTaskBoardSnapshot({
          tasks: new PlanningRepository(db).listTasks(),
          inspection: repo.inspect(),
          currentCycleId: "2026-W35",
        }),
        {
          width: 80,
          color: false,
          detailTaskId: "T1",
          detailMode: "full",
          now,
        },
      );
    expect(frame(Date.parse("2026-08-25T00:00:03.000Z"))).toContain(
      "Running: Read old.ts",
    );
    await scheduler.tick();
    const failed = frame(Date.parse("2026-08-25T00:00:04.000Z"));
    expect(failed).toContain("Scout · Failed");
    expect(failed).toContain("Reason: Connection closed");
    expect(failed).toContain("Last activity: Read old.ts");
    expect(failed).not.toContain("Running: Read old.ts");
    await scheduler.tick();
    const retried = frame(Date.parse("2026-08-25T00:00:05.000Z"));
    expect(retried).toContain("Scout · Running");
    expect(retried).toContain("retry 1");
    expect(retried).not.toContain("old.ts");
    await scheduler.runUntilIdle(50);
    const final = frame(Date.parse("2026-08-25T00:01:00.000Z"));
    expect(final).toContain("× Review · Rejected");
    expect(final).not.toContain("✓ Review");
    expect(frame(Date.parse("2026-08-25T01:00:00.000Z"))).toBe(final);
    expect(
      repo
        .inspect()
        .tasks.find((task) => task.id === "T1")
        ?.attempts.at(-1),
    ).toMatchObject({
      status: "succeeded",
      reviewDecision: "rejected",
      endedAt: "2026-08-25T00:00:04.000Z",
    });
    fake.assertComplete();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
