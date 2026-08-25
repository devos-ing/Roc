import { expect, test } from "bun:test";
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

function setup() {
  const db = openDatabase(":memory:");
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
    () => "2026-08-25T00:00:01.000Z",
    (kind) => `${kind}-${counters[kind] = (counters[kind] ?? 0) + 1}`,
  );
  return { db, repo };
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
    expect(repo.getRunningAttempt()?.backendCursor).toBeUndefined();
    expect(repo.listAttempts("T1")).toMatchObject([{ role: "scout", status: "running" }]);
  } finally {
    db.close();
  }
});

for (const unsupportedEvent of [
  {
    type: "attempt.usage_delta" as const,
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 3,
    reasoningOutputTokens: 1,
  },
  {
    type: "attempt.failed_infra" as const,
    code: "backend_unavailable",
    message: "Backend unavailable",
    retryable: true,
  },
]) {
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
      expect(repo.getRunningAttempt()?.backendCursor).toBeUndefined();
      expect(repo.listAttempts("T1")).toMatchObject([{ role: "scout", status: "running" }]);
    } finally {
      db.close();
    }
  });
}

test("rejects a rejected Review completion and rolls back every completion effect", () => {
  const { db, repo } = setup();
  try {
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
        findings: ["Needs O5 follow-up handling"],
        remainingGaps: ["Rejected Review is outside O3"],
      },
    });

    expect(() => repo.applyHarnessEvent(attemptId, "cursor-completed", {
      type: "attempt.completed",
      eventId: "review:completed",
      attemptId,
      sequence: 2,
      occurredAt: "2026-08-25T00:00:03.000Z",
    })).toThrow("Unsupported Review decision in happy-path repository: rejected");
    expect(repo.inspectTask("T1")).toEqual({ id: "T1", status: "reviewing" });
    expect(repo.listAttempts("T1").at(-1)).toMatchObject({ role: "review", status: "running" });
    expect(repo.listReviews("T1")).toEqual([]);
    expect(repo.getRunningAttempt()?.backendCursor).toBe("cursor-output");
  } finally {
    db.close();
  }
});
