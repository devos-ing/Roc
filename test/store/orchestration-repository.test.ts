import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "../../src/harness/contracts";
import {
  createModelAdvisor,
  createStaticModelAdvisor,
  type ModelAdvisor,
} from "../../src/scheduler/model-routing";
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
  fault: (
    point: "after_event_insert" | "before_cursor_update",
  ) => void = () => {},
  now: () => string = () => "2026-08-25T00:00:01.000Z",
  advisor: ModelAdvisor = createStaticModelAdvisor(),
) {
  const db = openDatabase(path);
  const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
  planning.createCycle({
    id: "2026-W35",
    goal: "Deterministic scheduler",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: ["T1", "T2"],
  });
  for (const [id, priority] of [
    ["T1", 0],
    ["T2", 1],
  ] as const) {
    planning.createTask({
      id,
      cycleId: "2026-W35",
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
    (kind) => {
      const count = (counters[kind] ?? 0) + 1;
      counters[kind] = count;
      return `${kind}-${count}`;
    },
    fault,
    advisor,
  );
  return { db, repo, counters };
}

function setupInspect() {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
  planning.createCycle({
    id: "2026-W35",
    goal: "Inspect deterministic token usage",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: ["T1"],
  });
  planning.createTask({
    id: "T1",
    cycleId: "2026-W35",
    title: "Inspect token usage",
    spec: ticketSpec,
    priority: 0,
    approvalRequired: false,
    approved: true,
  });
  planning.transitionTask("T1", "ready", "T1:ready");

  const counters: Record<string, number> = {};
  const repo = new OrchestrationRepository(
    db,
    () => "2026-08-25T00:00:01.000Z",
    (kind) => {
      const count = (counters[kind] ?? 0) + 1;
      counters[kind] = count;
      return `${kind}-${count}`;
    },
  );
  const claimed = repo.claimNext();
  if (!claimed) throw new Error("Expected T1 to be claimed");
  const attempt = repo.beginNextAttempt();
  if (!attempt || attempt.role !== "scout")
    throw new Error("Expected a Scout attempt");
  return { db, repo, attemptId: attempt.attemptId };
}

function expectEventAbsent(db: Database, eventId: string): void {
  expect(
    db
      .query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count FROM events WHERE idempotency_key = ?
  `)
      .get(eventId)?.count,
  ).toBe(0);
}

function startScout(repo: OrchestrationRepository): string {
  const claimed = repo.claimNext();
  if (!claimed) throw new Error("Expected a claimable task");
  const attempt = repo.beginNextAttempt();
  if (!attempt || attempt.role !== "scout")
    throw new Error("Expected a Scout attempt");
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
  if (!implement || implement.role !== "implement")
    throw new Error("Expected an Implement attempt");
  applyOutputAndCompletion(
    repo,
    implement.attemptId,
    "implement",
    implementOutput,
  );
  const review = repo.beginNextAttempt();
  if (!review || review.role !== "review")
    throw new Error("Expected a Review attempt");
  return review.attemptId;
}

function startImplement(repo: OrchestrationRepository): string {
  const scoutAttemptId = startScout(repo);
  applyOutputAndCompletion(repo, scoutAttemptId, "scout", scoutOutput);
  const implement = repo.beginNextAttempt();
  if (!implement || implement.role !== "implement") {
    throw new Error("Expected an Implement attempt");
  }
  return implement.attemptId;
}

test("claims the first approved ready task once", () => {
  const { db, repo } = setup();
  try {
    expect(repo.claimNext()).toEqual({ taskId: "T1" });
    expect(repo.claimNext()).toBeUndefined();
    expect(
      db
        .query<{ status: string }, [string]>(
          "SELECT status FROM tasks WHERE id = ?",
        )
        .get("T1")?.status,
    ).toBe("claimed");
    expect(
      db
        .query<{ status: string }, [string]>(
          "SELECT status FROM tasks WHERE id = ?",
        )
        .get("T2")?.status,
    ).toBe("ready");
  } finally {
    db.close();
  }
});

test("a stale lease owner cannot claim or consume generated IDs after takeover", () => {
  let currentNow = "2026-08-25T00:00:01.000Z";
  const { db, repo, counters } = setup(
    ":memory:",
    () => {},
    () => currentNow,
  );
  try {
    expect(
      repo.acquireLease(
        "owner-1",
        "2026-08-25T00:00:00.000Z",
        "2026-08-25T00:00:10.000Z",
      ),
    ).toBe(true);
    currentNow = "2026-08-25T00:00:11.000Z";
    expect(
      repo.acquireLease("owner-2", currentNow, "2026-08-25T00:00:21.000Z"),
    ).toBe(true);
    const eventCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
      .get()?.count;

    expect(() => repo.claimNext("owner-1")).toThrow("Scheduler lease was lost");
    expect(repo.inspectTask("T1")).toEqual({ id: "T1", status: "ready" });
    expect(repo.inspectTask("T2")).toEqual({ id: "T2", status: "ready" });
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
        .get()?.count,
    ).toBe(eventCount);
    expect(counters).toEqual({});
  } finally {
    db.close();
  }
});

test("a stale lease owner cannot begin an attempt or consume generated IDs after takeover", () => {
  let currentNow = "2026-08-25T00:00:01.000Z";
  const { db, repo, counters } = setup(
    ":memory:",
    () => {},
    () => currentNow,
  );
  try {
    expect(
      repo.acquireLease(
        "owner-1",
        "2026-08-25T00:00:00.000Z",
        "2026-08-25T00:00:10.000Z",
      ),
    ).toBe(true);
    expect(repo.claimNext("owner-1")).toEqual({ taskId: "T1" });
    currentNow = "2026-08-25T00:00:11.000Z";
    expect(
      repo.acquireLease("owner-2", currentNow, "2026-08-25T00:00:21.000Z"),
    ).toBe(true);
    const eventCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
      .get()?.count;
    const idsAfterClaim = { ...counters };

    expect(() => repo.beginNextAttempt("owner-1")).toThrow(
      "Scheduler lease was lost",
    );
    expect(repo.inspectTask("T1")).toEqual({ id: "T1", status: "claimed" });
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM attempts")
        .get()?.count,
    ).toBe(0);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM model_decisions",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
        .get()?.count,
    ).toBe(eventCount);
    expect(counters).toEqual(idsAfterClaim);
  } finally {
    db.close();
  }
});

test("two SQLite connections commit only one claim and one audit event", () => {
  const directory = mkdtempSync(join(tmpdir(), "agile-agents-two-claimers-"));
  const databasePath = join(directory, "scheduler.db");
  const { db: firstDb, repo: firstRepo } = setup(databasePath);
  const secondDb = openDatabase(databasePath);
  const secondRepo = new OrchestrationRepository(
    secondDb,
    () => "2026-08-25T00:00:02.000Z",
    (kind) => `second-${kind}`,
  );
  try {
    // Bun's SQLite API is synchronous: connection 1 commits, then connection 2 observes the active claim.
    expect(firstRepo.claimNext()).toEqual({ taskId: "T1" });
    expect(secondRepo.claimNext()).toBeUndefined();
    expect(
      firstDb
        .query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM tasks WHERE status = 'claimed'
    `)
        .get()?.count,
    ).toBe(1);
    expect(
      firstDb
        .query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM events WHERE type = 'task.claimed'
    `)
        .get()?.count,
    ).toBe(1);
  } finally {
    secondDb.close();
    firstDb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("skips a task with an unfinished dependency", () => {
  const { db, repo } = setup();
  try {
    db.exec(
      "INSERT INTO task_deps(task_id, depends_on_task_id, kind) VALUES ('T1', 'T2', 'blocks')",
    );
    expect(repo.claimNext()).toEqual({ taskId: "T2" });
  } finally {
    db.close();
  }
});

test("persists the advisor profile separately from its selected catalog model", () => {
  const { db, repo } = setup(
    ":memory:",
    () => {},
    () => "2026-08-25T00:00:01.000Z",
    createModelAdvisor([
      { id: "gpt-5.6-luna", supportedReasoningEfforts: ["high"] },
      { id: "gpt-5.6-terra", supportedReasoningEfforts: ["high", "xhigh"] },
      { id: "gpt-5.6-sol", supportedReasoningEfforts: ["high", "xhigh"] },
    ]),
  );
  try {
    expect(startScout(repo)).toBe("attempt-1");
    expect(repo.inspect().tasks[0]).toMatchObject({
      modelDecisions: [
        {
          modelProfile: "luna",
          model: "gpt-5.6-luna",
          effort: "high",
          fallbackModels: ["gpt-5.6-terra", "gpt-5.6-sol"],
        },
      ],
      attempts: [
        { modelProfile: "luna", model: "gpt-5.6-luna", effort: "high" },
      ],
    });
  } finally {
    db.close();
  }
});

test("replans without consuming attempt or decision IDs when no compatible model exists", () => {
  const { db, repo, counters } = setup(
    ":memory:",
    () => {},
    () => "2026-08-25T00:00:01.000Z",
    createModelAdvisor([
      { id: "gpt-5.6-luna", supportedReasoningEfforts: ["low"] },
    ]),
  );
  try {
    expect(repo.claimNext()).toEqual({ taskId: "T1" });
    expect(repo.beginNextAttempt()).toBeUndefined();
    expect(repo.inspectTask("T1")).toEqual({
      id: "T1",
      status: "needs_replan",
    });
    expect(repo.listAttempts("T1")).toEqual([]);
    expect(counters.attempt).toBeUndefined();
    expect(counters.decision).toBeUndefined();
    expect(
      db
        .query<{ type: string; payload_json: string }, []>(`
      SELECT type, payload_json FROM events WHERE task_id = 'T1' ORDER BY seq DESC LIMIT 1
    `)
        .get(),
    ).toEqual({
      type: "task.needs_replan",
      payload_json: JSON.stringify({
        reason: "no_compatible_model",
        role: "scout",
        effort: "high",
      }),
    });
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

test("persists started attempt metadata and rejects a conflicting task base commit", () => {
  const { db, repo } = setup();
  try {
    const attemptId = startScout(repo);
    const baseCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    repo.applyHarnessEvent(attemptId, "cursor-started", {
      type: "attempt.started",
      eventId: "scout:started-with-metadata",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-26T00:00:02.000Z",
      threadId: "thread-scout",
      turnId: "turn-scout",
      baseCommit,
    });

    expect(repo.getRunningAttempt()).toMatchObject({
      descriptor: { attemptId, modelProfile: "luna" },
      input: { ticket: { id: "T1", baseCommit } },
      backendCursor: "cursor-started",
    });
    expect(repo.inspect().tasks[0]?.attempts[0]).toMatchObject({
      id: attemptId,
      modelProfile: "luna",
      threadId: "thread-scout",
      turnId: "turn-scout",
    });
    expect(
      db
        .query<{ base_commit: string | null }, [string]>(
          "SELECT base_commit FROM tasks WHERE id = ?",
        )
        .get("T1")?.base_commit,
    ).toBe(baseCommit);

    expect(() =>
      repo.applyHarnessEvent(attemptId, "cursor-conflict", {
        type: "attempt.started",
        eventId: "scout:conflicting-base",
        attemptId,
        sequence: 2,
        occurredAt: "2026-08-26T00:00:03.000Z",
        baseCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).toThrow(
      "Conflicting base commit for task T1: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb !== aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expectEventAbsent(db, "scout:conflicting-base");
    expect(repo.getRunningAttempt()?.backendCursor).toBe("cursor-started");
    expect(
      db
        .query<{ base_commit: string | null }, [string]>(
          "SELECT base_commit FROM tasks WHERE id = ?",
        )
        .get("T1")?.base_commit,
    ).toBe(baseCommit);
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

    expect(() =>
      repo.applyHarnessEvent(attemptId, "cursor-replayed", event),
    ).toThrow("crash:before_cursor_update");
    expect(repo.getRunningAttempt()?.backendCursor).toBe("cursor-1");
    expect(
      db
        .query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM events WHERE idempotency_key = ?
    `)
        .get(event.eventId)?.count,
    ).toBe(1);
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
    expect(
      repo.acquireLease(
        "owner-1",
        "2026-08-25T00:00:00.000Z",
        "2026-08-25T00:00:10.000Z",
      ),
    ).toBe(true);

    expect(() =>
      repo.applyHarnessEvent(
        attemptId,
        "cursor-stale",
        {
          type: "attempt.started",
          eventId: "scout:stale-started",
          attemptId,
          sequence: 1,
          occurredAt: "2026-08-25T00:00:11.000Z",
          threadId: "thread-stale",
        },
        "owner-1",
      ),
    ).toThrow("Scheduler lease was lost");
    expectEventAbsent(db, "scout:stale-started");
    expect(repo.getRunningAttempt()).toMatchObject({
      backendCursor: undefined,
      descriptor: { attemptId },
    });
    expect(
      db
        .query<{ thread_id: string | null }, [string]>(
          "SELECT thread_id FROM attempts WHERE id = ?",
        )
        .get(attemptId)?.thread_id,
    ).toBeNull();
  } finally {
    db.close();
  }
});

for (const faultPoint of [
  "after_event_insert",
  "before_cursor_update",
] as const) {
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
      expect(() =>
        repo.applyHarnessEvent(attemptId, "cursor-1", event),
      ).toThrow(`crash:${faultPoint}`);
      db.close();

      reopened = openDatabase(databasePath);
      const resumed = new OrchestrationRepository(reopened);
      resumed.applyHarnessEvent(attemptId, "cursor-1", event);

      expect(
        reopened
          .query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM events WHERE idempotency_key = ?
      `)
          .get(event.eventId)?.count,
      ).toBe(1);
      expect(
        reopened
          .query<
            { thread_id: string | null; backend_cursor: string | null },
            [string]
          >(`
        SELECT thread_id, backend_cursor FROM attempts WHERE id = ?
      `)
          .get(attemptId),
      ).toEqual({
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

    expect(() =>
      repo.applyHarnessEvent(scoutAttemptId, "cursor-conflict", {
        ...started,
        threadId: "different-thread",
      }),
    ).toThrow("Harness event idempotency conflict: shared:event");
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

    expect(() =>
      repo.applyHarnessEvent(implement.attemptId, "cursor-other-attempt", {
        ...started,
        attemptId: implement.attemptId,
      }),
    ).toThrow("Harness event idempotency conflict: shared:event");
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

    expect(() =>
      repo.applyHarnessEvent(attemptId, "cursor-old", {
        type: "attempt.output",
        eventId: "scout:old-output",
        attemptId,
        sequence: 1,
        occurredAt: "2026-08-25T00:00:03.000Z",
        output: scoutOutput,
      }),
    ).toThrow(`Non-monotonic harness event sequence for ${attemptId}: 1 <= 2`);
    expect(repo.getRunningAttempt()?.backendCursor).toBe("cursor-2");
  } finally {
    db.close();
  }
});

test("rolls back an output whose kind does not match the attempt role", () => {
  const { db, repo } = setup();
  try {
    const attemptId = startScout(repo);
    expect(() =>
      repo.applyHarnessEvent(attemptId, "cursor-mismatch", {
        type: "attempt.output",
        eventId: "scout:wrong-output",
        attemptId,
        sequence: 1,
        occurredAt: "2026-08-25T00:00:02.000Z",
        output: implementOutput,
      }),
    ).toThrow("Harness output role mismatch: implement !== scout");
    expectEventAbsent(db, "scout:wrong-output");
    expect(repo.getRunningAttempt()?.backendCursor).toBeUndefined();
    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", status: "running" },
    ]);
  } finally {
    db.close();
  }
});

test("rolls back completion when the attempt has no matching output", () => {
  const { db, repo } = setup();
  try {
    const attemptId = startScout(repo);
    expect(() =>
      repo.applyHarnessEvent(attemptId, "cursor-completed", {
        type: "attempt.completed",
        eventId: "scout:completed",
        attemptId,
        sequence: 1,
        occurredAt: "2026-08-25T00:00:02.000Z",
      }),
    ).toThrow(`Attempt completed without scout output: ${attemptId}`);
    expectEventAbsent(db, "scout:completed");
    expect(repo.getRunningAttempt()?.backendCursor).toBeUndefined();
    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", status: "running" },
    ]);
  } finally {
    db.close();
  }
});

test("inspects a running Scout role with zero usage", () => {
  const { db, repo } = setupInspect();
  try {
    const snapshot = repo.inspect();

    expect(snapshot.cycles).toEqual([
      {
        id: "2026-W35",
        tokenTarget: 100_000,
        actual: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
    ]);
    expect(snapshot.tasks[0]).toMatchObject({
      id: "T1",
      actual: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      roles: [
        {
          role: "scout",
          actual: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
        },
      ],
      attempts: [
        {
          id: "attempt-1",
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
      ],
    });
  } finally {
    db.close();
  }
});

test("reads raw category usage for one requested cycle", () => {
  const { db, repo } = setup();
  try {
    db.query(`
      INSERT INTO usage(
        id, cycle_id, task_id, category,
        input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
      ) VALUES
        ('usage-scout', '2026-W35', 'T1', 'scout', 100, 80, 20, 10),
        ('usage-grill', '2026-W35', NULL, 'cycle_grilling', 40, 30, 5, 4)
    `).run();

    expect(repo.getCycleCategoryUsage("2026-W35")).toEqual({
      cycleId: "2026-W35",
      categories: [
        { category: "cycle_grilling", inputTokens: 40, outputTokens: 5 },
        { category: "scout", inputTokens: 100, outputTokens: 20 },
      ],
    });
    expect(repo.getCycleCategoryUsage("2026-W34")).toBeUndefined();
  } finally {
    db.close();
  }
});

test("records each token delta once and inspects deterministic usage totals", () => {
  const { db, repo, attemptId } = setupInspect();
  try {
    repo.applyHarnessEvent(attemptId, "1", {
      type: "attempt.started",
      eventId: "scout:started",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
    });
    const firstDelta = {
      type: "attempt.usage_delta" as const,
      eventId: "scout:usage-1",
      attemptId,
      sequence: 2,
      occurredAt: "2026-08-25T00:00:03.000Z",
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      reasoningOutputTokens: 1,
    };
    repo.applyHarnessEvent(attemptId, "2", firstDelta);
    repo.applyHarnessEvent(attemptId, "3", firstDelta);
    repo.applyHarnessEvent(attemptId, "4", {
      type: "attempt.usage_delta",
      eventId: "scout:usage-2",
      attemptId,
      sequence: 3,
      occurredAt: "2026-08-25T00:00:04.000Z",
      inputTokens: 5,
      cachedInputTokens: 1,
      outputTokens: 2,
      reasoningOutputTokens: 1,
    });

    expect(repo.inspect()).toEqual({
      scheduler: { activeTaskId: "T1", activeAttemptId: "attempt-1" },
      cycles: [
        {
          id: "2026-W35",
          tokenTarget: 100_000,
          actual: {
            inputTokens: 15,
            cachedInputTokens: 3,
            outputTokens: 6,
            reasoningOutputTokens: 2,
          },
        },
      ],
      tasks: [
        {
          id: "T1",
          status: "scouting",
          priority: 0,
          tokenTarget: 10_000,
          actual: {
            inputTokens: 15,
            cachedInputTokens: 3,
            outputTokens: 6,
            reasoningOutputTokens: 2,
          },
          modelDecisions: [
            {
              id: "decision-1",
              role: "scout",
              modelProfile: "luna",
              model: "luna",
              effort: "high",
              tokenTarget: 10_000,
              fallbackModels: ["terra", "sol"],
              decidedBy: "rule",
              confidence: 1,
              rationale: ["scout baseline", "medium risk"],
            },
          ],
          roles: [
            {
              role: "scout",
              actual: {
                inputTokens: 15,
                cachedInputTokens: 3,
                outputTokens: 6,
                reasoningOutputTokens: 2,
              },
            },
          ],
          attempts: [
            {
              id: "attempt-1",
              role: "scout",
              modelProfile: "luna",
              model: "luna",
              effort: "high",
              status: "running",
              retryIndex: 0,
              inputTokens: 15,
              cachedInputTokens: 3,
              outputTokens: 6,
              reasoningOutputTokens: 2,
            },
          ],
        },
      ],
    });
  } finally {
    db.close();
  }
});

test("inspection includes the verified Implement commit", () => {
  const { db, repo } = setup();
  try {
    startReview(repo);

    expect(
      repo
        .inspect()
        .tasks[0]?.attempts.find((attempt) => attempt.role === "implement"),
    ).toMatchObject({
      modelProfile: "terra",
      model: "terra",
      gitCommit: implementOutput.commitSha,
    });
  } finally {
    db.close();
  }
});

test("accepted Review waits in publishing until its durable pull request completes", () => {
  const { db, repo } = setup();
  try {
    const attemptId = startReview(repo);
    repo.applyHarnessEvent(attemptId, "review-output", {
      type: "attempt.output",
      eventId: "review:accepted:output",
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
      output: {
        kind: "review",
        decision: "accepted",
        findings: [],
        remainingGaps: [],
      },
    });
    repo.applyHarnessEvent(attemptId, "review-completed", {
      type: "attempt.completed",
      eventId: "review:accepted:completed",
      attemptId,
      sequence: 2,
      occurredAt: "2026-08-25T00:00:03.000Z",
    });

    expect(repo.inspectTask("T1")).toEqual({ id: "T1", status: "publishing" });
    const publishing = repo.listPublishingTasks();
    expect(publishing).toHaveLength(1);
    const publication = repo.beginPublication({
      taskId: "T1",
      branch: "agile/T1",
      baseBranch: "main",
      commitSha: implementOutput.commitSha,
    });
    expect(publication).toMatchObject({
      status: "pending",
      branch: "agile/T1",
    });
    expect(
      repo.beginPublication({
        taskId: "T1",
        branch: "agile/T1",
        baseBranch: "release/2026-W35",
        commitSha: implementOutput.commitSha,
      }),
    ).toEqual(publication);
    expect(repo.getTaskPublication("T1")).toMatchObject({
      baseBranch: "main",
      status: "pending",
    });

    repo.completePublication({
      taskId: "T1",
      pullRequest: {
        number: 1,
        url: "https://example.test/pull/1",
        state: "OPEN",
      },
    });
    expect(repo.inspectTask("T1")).toEqual({ id: "T1", status: "done" });
    expect(repo.getTaskPublication("T1")).toMatchObject({
      status: "published",
      pullRequestNumber: 1,
    });
  } finally {
    db.close();
  }
});

test("an Implement policy block replans its task without retry and leaves the next ready task claimable", () => {
  const { db, repo } = setup();
  try {
    const attemptId = startImplement(repo);
    const event = {
      type: "attempt.blocked_policy",
      eventId: `${attemptId}:turn-implement:blocked_policy:approval_required`,
      attemptId,
      sequence: 1,
      occurredAt: "2026-08-26T00:00:02.000Z",
      code: "approval_required",
      message: "Approval requests are disabled",
    } as const;
    repo.applyHarnessEvent(attemptId, "1", event);
    repo.applyHarnessEvent(attemptId, "replayed", event);

    expect(repo.inspectTask("T1")).toEqual({
      id: "T1",
      status: "needs_replan",
    });
    expect(
      db
        .query<{ status: string }, [string]>(
          "SELECT status FROM attempts WHERE id = ?",
        )
        .get(attemptId)?.status,
    ).toBe("blocked_policy");
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM events WHERE idempotency_key = 'attempt-2:turn-implement:blocked_policy:approval_required'",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM events WHERE task_id = 'T1' AND type = 'task.needs_replan'",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      db
        .query<{ backend_cursor: string | null }, [string]>(
          "SELECT backend_cursor FROM attempts WHERE id = ?",
        )
        .get(attemptId)?.backend_cursor,
    ).toBe("replayed");
    expect(repo.listAttempts("T1")).toHaveLength(2);
    expect(repo.beginNextAttempt()).toBeUndefined();
    expect(repo.claimNext()).toEqual({ taskId: "T2" });
  } finally {
    db.close();
  }
});

test("terminal infrastructure failure marks ready dependents for replanning", () => {
  const { db, repo } = setup();
  try {
    db.exec(
      "INSERT INTO task_deps(task_id, depends_on_task_id, kind) VALUES ('T2', 'T1', 'blocks')",
    );
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
    expect(repo.inspectTask("T1")).toEqual({
      id: "T1",
      status: "failed_infra",
    });
    expect(repo.inspectTask("T2")).toEqual({
      id: "T2",
      status: "needs_replan",
    });
    expect(
      db
        .query<{ type: string }, []>(`
      SELECT type FROM events WHERE task_id = 'T2' ORDER BY seq DESC LIMIT 1
    `)
        .get()?.type,
    ).toBe("task.needs_replan");
  } finally {
    db.close();
  }
});

test("rejected Review creates one idempotent draft follow-up and replans dependents", () => {
  const { db, repo, counters } = setup();
  try {
    db.exec(
      "INSERT INTO task_deps(task_id, depends_on_task_id, kind) VALUES ('T2', 'T1', 'blocks')",
    );
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
        remainingGaps: [
          "only one task is claimed",
          "follow-up fixes validation",
        ],
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
    expect(repo.listAttempts("T1").at(-1)).toMatchObject({
      role: "review",
      status: "succeeded",
    });
    expect(repo.listReviews("T1")).toMatchObject([
      {
        decision: "rejected",
        findings: ["validation failed"],
      },
    ]);
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

    const followUp = db
      .query<
        {
          cycle_id: string;
          title: string;
          spec_json: string;
          priority: number;
          risk: string;
          token_ceiling: number;
          approval_required: number;
          base_commit: string | null;
          context_id: string | null;
          discovered_from_review_id: string | null;
        },
        [string]
      >(`
      SELECT cycle_id, title, spec_json, priority, risk, token_ceiling,
             approval_required, base_commit, context_id, discovered_from_review_id
      FROM tasks WHERE id = ?
    `)
      .get("task-1");
    expect(followUp).toMatchObject({
      cycle_id: "2026-W35",
      title: "T1",
      priority: 0,
      risk: "medium",
      token_ceiling: 10_000,
      approval_required: 1,
      base_commit: implementOutput.commitSha,
      context_id: "context-T1",
      discovered_from_review_id: "review-1",
    });
    expect(JSON.parse(followUp?.spec_json ?? "null")).toMatchObject({
      problem:
        "Need deterministic scheduling\n\nReview findings:\n- validation failed",
      acceptanceCriteria: [
        "only one task is claimed",
        "follow-up fixes validation",
      ],
    });
    expect(
      db
        .query<{ depends_on_task_id: string }, []>(`
      SELECT depends_on_task_id FROM task_deps WHERE task_id = 'T2'
    `)
        .all(),
    ).toEqual([{ depends_on_task_id: "T1" }]);
    expect(
      db
        .query<{ type: string }, []>(`
      SELECT type FROM events
      WHERE type IN ('task.rejected', 'task.follow_up_created', 'task.needs_replan')
      ORDER BY seq
    `)
        .all(),
    ).toEqual([
      { type: "task.rejected" },
      { type: "task.follow_up_created" },
      { type: "task.needs_replan" },
    ]);

    const idsAfterCompletion = { ...counters };
    repo.applyHarnessEvent(attemptId, "cursor-replayed", completed);

    expect(counters).toEqual(idsAfterCompletion);
    expect(repo.listTasksByRoot("T1")).toHaveLength(2);
    expect(repo.listReviews("T1")).toHaveLength(1);
    expect(
      db
        .query<{ backend_cursor: string | null }, [string]>(`
      SELECT backend_cursor FROM attempts WHERE id = ?
    `)
        .get(attemptId)?.backend_cursor,
    ).toBe("cursor-replayed");
  } finally {
    db.close();
  }
});
