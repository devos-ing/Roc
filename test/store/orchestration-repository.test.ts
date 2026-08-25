import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "../../src/harness/contracts";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

const ticketSpec = {
  problem: "Need deterministic scheduling",
  desiredOutcome: "One task is claimed",
  scope: ["scheduler"],
  nonGoals: [],
  acceptanceCriteria: ["only one task is claimed"],
  validation: ["bun test"],
  dependencies: [],
  risk: "medium" as const,
  contextCandidates: [],
  tokenCeiling: 10_000,
};

const scoutOutput = {
  kind: "scout" as const,
  summary: "Found the repository boundary",
  files: ["src/store/orchestration-repository.ts"],
  tests: ["bun test test/store/orchestration-repository.test.ts"],
  risks: [],
};

const implementOutput = {
  kind: "implement" as const,
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  validation: ["bun test"],
  risks: [],
  limitations: [],
};

function setup(
  path = ":memory:",
  fault: (point: "after_event_insert" | "before_cursor_update") => void = () => {},
  now: () => string = () => "2026-08-25T00:00:01.000Z",
) {
  const db = openDatabase(path);
  const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
  planning.createWeek({
    id: "2026-W35",
    goal: "Deterministic scheduler",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: ["T1", "T2"],
  });
  for (const [id, priority] of [["T1", 0], ["T2", 1]] as const) {
    planning.createTask({
      id,
      weekId: "2026-W35",
      title: id,
      spec: ticketSpec,
      priority,
      approvalRequired: false,
      approved: true,
    });
    planning.transitionTask(id, "ready", `${id}:ready`);
  }
  const counters: Record<string, number> = {};
  const repo = new OrchestrationRepository(
    db,
    now,
    (kind) => `${kind}-${counters[kind] = (counters[kind] ?? 0) + 1}`,
    fault,
  );
  return { db, repo, counters };
}

function expectEventAbsent(db: Database, eventId: string): void {
  expect(db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count FROM events WHERE idempotency_key = ?
  `).get(eventId)?.count).toBe(0);
}

function startScout(repo: OrchestrationRepository): string {
  const claimed = repo.claimNext();
  if (!claimed) throw new Error("Expected a claimable task");
  const attempt = repo.beginNextAttempt();
  if (!attempt || attempt.role !== "scout") throw new Error("Expected a Scout attempt");
  return attempt.attemptId;
}

function applyOutputAndCompletion(
  repo: OrchestrationRepository,
  attemptId: string,
  key: string,
  output: Extract<HarnessEvent, { type: "attempt.output" }>["output"],
): void {
  repo.applyHarnessEvent(attemptId, "1", {
    type: "attempt.output",
    eventId: `${key}:output`,
    attemptId,
    sequence: 1,
    occurredAt: "2026-08-25T00:00:02.000Z",
    output,
  });
  repo.applyHarnessEvent(attemptId, "2", {
    type: "attempt.completed",
    eventId: `${key}:completed`,
    attemptId,
    sequence: 2,
    occurredAt: "2026-08-25T00:00:03.000Z",
  });
}

function startReview(repo: OrchestrationRepository): string {
  const scoutAttemptId = startScout(repo);
  applyOutputAndCompletion(repo, scoutAttemptId, "scout", scoutOutput);
  const implement = repo.beginNextAttempt();
  if (!implement || implement.role !== "implement") throw new Error("Expected an Implement attempt");
  applyOutputAndCompletion(repo, implement.attemptId, "implement", implementOutput);
  const review = repo.beginNextAttempt();
  if (!review || review.role !== "review") throw new Error("Expected a Review attempt");
  return review.attemptId;
}

test("claims the first approved ready task once", () => {
  const { db, repo } = setup();
  try {
    expect(repo.claimNext()).toEqual({ taskId: "T1" });
    expect(repo.claimNext()).toBeUndefined();
    expect(db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get("T1")?.status).toBe("claimed");
    expect(db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get("T2")?.status).toBe("ready");
  } finally {
    db.close();
  }
});

test("skips a task with an unfinished dependency", () => {
  const { db, repo } = setup();
  try {
    db.exec("INSERT INTO task_deps(task_id, depends_on_task_id, kind) VALUES ('T1', 'T2', 'blocks')");
    expect(repo.claimNext()).toEqual({ taskId: "T2" });
  } finally {
    db.close();
  }
});

test("advances the cursor when replaying the identical harness event", () => {
  const { db, repo } = setup();
  try {
    const attemptId = startScout(repo);
    const event = {
      type: "attempt.started" as const,
      eventId: "scout:started",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
      threadId: "thread-scout",
    };
    repo.applyHarnessEvent(attemptId, "cursor-1", event);
    repo.applyHarnessEvent(attemptId, "cursor-replayed", event);

    expect(repo.getRunningAttempt()?.backendCursor).toBe("cursor-replayed");
  } finally {
    db.close();
  }
});

test("rolls back a duplicate delivery cursor when the cursor fault fires", () => {
  let crashBeforeCursorUpdate = false;
  const { db, repo } = setup(":memory:", (point) => {
    if (crashBeforeCursorUpdate && point === "before_cursor_update") {
      throw new Error("crash:before_cursor_update");
    }
  });
  try {
    const attemptId = startScout(repo);
    const event = {
      type: "attempt.started" as const,
      eventId: "scout:started",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
    };
    repo.applyHarnessEvent(attemptId, "cursor-1", event);
    crashBeforeCursorUpdate = true;

    expect(() => repo.applyHarnessEvent(attemptId, "cursor-replayed", event))
      .toThrow("crash:before_cursor_update");
    expect(repo.getRunningAttempt()?.backendCursor).toBe("cursor-1");
    expect(db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM events WHERE idempotency_key = ?
    `).get(event.eventId)?.count).toBe(1);
  } finally {
    db.close();
  }
});

test("rejects an event from the matching owner after its lease expires", () => {
  const { db, repo } = setup(
    ":memory:",
    () => {},
    () => "2026-08-25T00:00:11.000Z",
  );
  try {
    const attemptId = startScout(repo);
    expect(repo.acquireLease(
      "owner-1",
      "2026-08-25T00:00:00.000Z",
      "2026-08-25T00:00:10.000Z",
    )).toBe(true);

    expect(() => repo.applyHarnessEvent(attemptId, "cursor-stale", {
      type: "attempt.started",
      eventId: "scout:stale-started",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:11.000Z",
      threadId: "thread-stale",
    }, "owner-1")).toThrow("Scheduler lease was lost");
    expectEventAbsent(db, "scout:stale-started");
    expect(repo.getRunningAttempt()).toMatchObject({
      backendCursor: undefined,
      descriptor: { attemptId },
    });
    expect(db.query<{ thread_id: string | null }, [string]>(
      "SELECT thread_id FROM attempts WHERE id = ?",
    ).get(attemptId)?.thread_id).toBeNull();
  } finally {
    db.close();
  }
});

for (const faultPoint of ["after_event_insert", "before_cursor_update"] as const) {
  test(`replays once after a crash at ${faultPoint}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "agile-agents-reconcile-"));
    const databasePath = join(directory, "scheduler.db");
    let reopened: Database | undefined;
    const { db, repo } = setup(databasePath, (point) => {
      if (point === faultPoint) throw new Error(`crash:${point}`);
    });
    const attemptId = startScout(repo);
    const event = {
      type: "attempt.started" as const,
      eventId: "scout:started",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
      threadId: "thread-scout",
    };

    try {
      expect(() => repo.applyHarnessEvent(attemptId, "cursor-1", event))
        .toThrow(`crash:${faultPoint}`);
      db.close();

      reopened = openDatabase(databasePath);
      const resumed = new OrchestrationRepository(reopened);
      resumed.applyHarnessEvent(attemptId, "cursor-1", event);

      expect(reopened.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM events WHERE idempotency_key = ?
      `).get(event.eventId)?.count).toBe(1);
      expect(reopened.query<{ thread_id: string | null; backend_cursor: string | null }, [string]>(`
        SELECT thread_id, backend_cursor FROM attempts WHERE id = ?
      `).get(attemptId)).toEqual({
        thread_id: "thread-scout",
        backend_cursor: "cursor-1",
      });
    } finally {
      if (reopened) reopened.close();
      else db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("rejects duplicate event IDs with conflicting payloads or attempts", () => {
  const { db, repo } = setup();
  try {
    const scoutAttemptId = startScout(repo);
    const started = {
      type: "attempt.started" as const,
      eventId: "shared:event",
      attemptId: scoutAttemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
    };
    repo.applyHarnessEvent(scoutAttemptId, "cursor-1", started);

    expect(() => repo.applyHarnessEvent(scoutAttemptId, "cursor-conflict", {
      ...started,
      threadId: "different-thread",
    })).toThrow("Harness event idempotency conflict: shared:event");
    expect(repo.getRunningAttempt()?.backendCursor).toBe("cursor-1");

    repo.applyHarnessEvent(scoutAttemptId, "cursor-2", {
      type: "attempt.output",
      eventId: "scout:output",
      attemptId: scoutAttemptId,
      sequence: 2,
      occurredAt: "2026-08-25T00:00:03.000Z",
      output: scoutOutput,
    });
    repo.applyHarnessEvent(scoutAttemptId, "cursor-3", {
      type: "attempt.completed",
      eventId: "scout:completed",
      attemptId: scoutAttemptId,
      sequence: 3,
      occurredAt: "2026-08-25T00:00:04.000Z",
    });
    const implement = repo.beginNextAttempt();
    if (!implement) throw new Error("Expected an Implement attempt");

    expect(() => repo.applyHarnessEvent(implement.attemptId, "cursor-other-attempt", {
      ...started,
      attemptId: implement.attemptId,
    })).toThrow("Harness event idempotency conflict: shared:event");
    expect(repo.getRunningAttempt()?.backendCursor).toBeUndefined();
  } finally {
    db.close();
  }
});

test("rejects non-monotonic event sequences without advancing the cursor", () => {
  const { db, repo } = setup();
  try {
    const attemptId = startScout(repo);
    repo.applyHarnessEvent(attemptId, "cursor-2", {
      type: "attempt.started",
      eventId: "scout:started",
      attemptId,
      sequence: 2,
      occurredAt: "2026-08-25T00:00:02.000Z",
    });

    expect(() => repo.applyHarnessEvent(attemptId, "cursor-old", {
      type: "attempt.output",
      eventId: "scout:old-output",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:03.000Z",
      output: scoutOutput,
    })).toThrow(`Non-monotonic harness event sequence for ${attemptId}: 1 <= 2`);
    expect(repo.getRunningAttempt()?.backendCursor).toBe("cursor-2");
  } finally {
    db.close();
  }
});

test("rolls back an output whose kind does not match the attempt role", () => {
  const { db, repo } = setup();
  try {
    const attemptId = startScout(repo);
    expect(() => repo.applyHarnessEvent(attemptId, "cursor-mismatch", {
      type: "attempt.output",
      eventId: "scout:wrong-output",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
      output: implementOutput,
    })).toThrow("Harness output role mismatch: implement !== scout");
    expectEventAbsent(db, "scout:wrong-output");
    expect(repo.getRunningAttempt()?.backendCursor).toBeUndefined();
    expect(repo.listAttempts("T1")).toMatchObject([{ role: "scout", status: "running" }]);
  } finally {
    db.close();
  }
});

test("rolls back completion when the attempt has no matching output", () => {
  const { db, repo } = setup();
  try {
    const attemptId = startScout(repo);
    expect(() => repo.applyHarnessEvent(attemptId, "cursor-completed", {
      type: "attempt.completed",
      eventId: "scout:completed",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
    })).toThrow(`Attempt completed without scout output: ${attemptId}`);
    expectEventAbsent(db, "scout:completed");
    expect(repo.getRunningAttempt()?.backendCursor).toBeUndefined();
    expect(repo.listAttempts("T1")).toMatchObject([{ role: "scout", status: "running" }]);
  } finally {
    db.close();
  }
});

for (const unsupportedEvent of [{
  type: "attempt.usage_delta" as const,
  inputTokens: 10,
  cachedInputTokens: 2,
  outputTokens: 3,
  reasoningOutputTokens: 1,
}]) {
  test(`rolls back unsupported ${unsupportedEvent.type}`, () => {
    const { db, repo } = setup();
    try {
      const attemptId = startScout(repo);
      expect(() => repo.applyHarnessEvent(attemptId, "cursor-unsupported", {
        ...unsupportedEvent,
        eventId: `scout:${unsupportedEvent.type}`,
        attemptId,
        sequence: 1,
        occurredAt: "2026-08-25T00:00:02.000Z",
      })).toThrow(`Unsupported harness event in happy-path repository: ${unsupportedEvent.type}`);
      expectEventAbsent(db, `scout:${unsupportedEvent.type}`);
      expect(repo.getRunningAttempt()?.backendCursor).toBeUndefined();
      expect(repo.listAttempts("T1")).toMatchObject([{ role: "scout", status: "running" }]);
    } finally {
      db.close();
    }
  });
}

test("terminal infrastructure failure marks ready dependents for replanning", () => {
  const { db, repo } = setup();
  try {
    db.exec("INSERT INTO task_deps(task_id, depends_on_task_id, kind) VALUES ('T2', 'T1', 'blocks')");
    const attemptId = startScout(repo);

    repo.applyHarnessEvent(attemptId, "cursor-failed", {
      type: "attempt.failed_infra",
      eventId: "scout:failed",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
      code: "backend_unavailable",
      message: "Backend unavailable",
      retryable: false,
    });

    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", retryIndex: 0, status: "failed_infra" },
    ]);
    expect(repo.inspectTask("T1")).toEqual({ id: "T1", status: "failed_infra" });
    expect(repo.inspectTask("T2")).toEqual({ id: "T2", status: "needs_replan" });
    expect(db.query<{ type: string }, []>(`
      SELECT type FROM events WHERE task_id = 'T2' ORDER BY seq DESC LIMIT 1
    `).get()?.type).toBe("task.needs_replan");
  } finally {
    db.close();
  }
});

test("rejected Review creates one idempotent draft follow-up and replans dependents", () => {
  const { db, repo, counters } = setup();
  try {
    db.exec("INSERT INTO task_deps(task_id, depends_on_task_id, kind) VALUES ('T2', 'T1', 'blocks')");
    db.exec(`
      INSERT INTO contexts(id, thread_id, anchor_id, source_task_id, git_commit)
      VALUES('context-T1', 'thread-T1', 'anchor-T1', 'T1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    `);
    db.exec("UPDATE tasks SET context_id = 'context-T1' WHERE id = 'T1'");
    const attemptId = startReview(repo);
    repo.applyHarnessEvent(attemptId, "cursor-output", {
      type: "attempt.output",
      eventId: "review:output",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
      output: {
        kind: "review",
        decision: "rejected",
        findings: ["validation failed"],
        remainingGaps: ["only one task is claimed", "follow-up fixes validation"],
      },
    });

    const completed = {
      type: "attempt.completed",
      eventId: "review:completed",
      attemptId,
      sequence: 2,
      occurredAt: "2026-08-25T00:00:03.000Z",
    } as const;
    repo.applyHarnessEvent(attemptId, "cursor-completed", completed);

    expect(repo.inspectTask("T1")).toMatchObject({ status: "rejected" });
    expect(repo.inspectTask("T2")).toMatchObject({ status: "needs_replan" });
    expect(repo.listAttempts("T1").at(-1)).toMatchObject({ role: "review", status: "succeeded" });
    expect(repo.listReviews("T1")).toMatchObject([{
      decision: "rejected",
      findings: ["validation failed"],
    }]);
    expect(repo.listTasksByRoot("T1")).toMatchObject([
      { id: "T1", status: "rejected", approved: true },
      {
        id: "task-1",
        status: "draft",
        parentTaskId: "T1",
        rootTaskId: "T1",
        approved: false,
      },
    ]);

    const followUp = db.query<{
      week_id: string;
      title: string;
      spec_json: string;
      priority: number;
      risk: string;
      token_ceiling: number;
      approval_required: number;
      context_id: string | null;
      discovered_from_review_id: string | null;
    }, [string]>(`
      SELECT week_id, title, spec_json, priority, risk, token_ceiling,
             approval_required, context_id, discovered_from_review_id
      FROM tasks WHERE id = ?
    `).get("task-1");
    expect(followUp).toMatchObject({
      week_id: "2026-W35",
      title: "T1",
      priority: 0,
      risk: "medium",
      token_ceiling: 10_000,
      approval_required: 1,
      context_id: "context-T1",
      discovered_from_review_id: "review-1",
    });
    expect(JSON.parse(followUp?.spec_json ?? "null")).toMatchObject({
      problem: "Need deterministic scheduling\n\nReview findings:\n- validation failed",
      acceptanceCriteria: ["only one task is claimed", "follow-up fixes validation"],
    });
    expect(db.query<{ depends_on_task_id: string }, []>(`
      SELECT depends_on_task_id FROM task_deps WHERE task_id = 'T2'
    `).all()).toEqual([{ depends_on_task_id: "T1" }]);
    expect(db.query<{ type: string }, []>(`
      SELECT type FROM events
      WHERE type IN ('task.rejected', 'task.follow_up_created', 'task.needs_replan')
      ORDER BY seq
    `).all()).toEqual([
      { type: "task.rejected" },
      { type: "task.follow_up_created" },
      { type: "task.needs_replan" },
    ]);

    const idsAfterCompletion = { ...counters };
    repo.applyHarnessEvent(attemptId, "cursor-replayed", completed);

    expect(counters).toEqual(idsAfterCompletion);
    expect(repo.listTasksByRoot("T1")).toHaveLength(2);
    expect(repo.listReviews("T1")).toHaveLength(1);
    expect(db.query<{ backend_cursor: string | null }, [string]>(`
      SELECT backend_cursor FROM attempts WHERE id = ?
    `).get(attemptId)?.backend_cursor).toBe("cursor-replayed");
  } finally {
    db.close();
  }
});
