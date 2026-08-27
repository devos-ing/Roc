import { expect, test } from "bun:test";
import type {
  AgentHarness,
  HarnessDelivery,
} from "../../src/harness/contracts";
import { SchedulerDaemon } from "../../src/scheduler/daemon";
import { Scheduler } from "../../src/scheduler/scheduler";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

type ControlledWait = {
  milliseconds: number;
  wake(): void;
};

function controlledHeartbeatWaits() {
  const pending: ControlledWait[] = [];
  return {
    pending,
    sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
      if (!signal) throw new Error("Expected a cancellable heartbeat wait");
      return new Promise((resolve, reject) => {
        let settled = false;
        const remove = () => {
          const index = pending.indexOf(wait);
          if (index !== -1) pending.splice(index, 1);
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          if (settled) return;
          settled = true;
          remove();
          reject(signal.reason);
        };
        const wait: ControlledWait = {
          milliseconds,
          wake() {
            if (settled) return;
            settled = true;
            remove();
            resolve();
          },
        };
        pending.push(wait);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  };
}

test("allows one lease owner and takeover only after expiry", () => {
  const db = openDatabase(":memory:");
  const repo = new OrchestrationRepository(db);
  try {
    expect(
      repo.acquireLease(
        "owner-1",
        "2026-08-25T00:00:00.000Z",
        "2026-08-25T00:00:10.000Z",
      ),
    ).toBe(true);
    expect(
      repo.acquireLease(
        "owner-2",
        "2026-08-25T00:00:05.000Z",
        "2026-08-25T00:00:15.000Z",
      ),
    ).toBe(false);
    expect(
      repo.heartbeatLease(
        "owner-1",
        "2026-08-25T00:00:11.000Z",
        "2026-08-25T00:00:21.000Z",
      ),
    ).toBe(false);
    expect(
      repo.acquireLease(
        "owner-2",
        "2026-08-25T00:00:11.000Z",
        "2026-08-25T00:00:21.000Z",
      ),
    ).toBe(true);
    expect(repo.releaseLease("owner-1")).toBe(false);
    expect(repo.releaseLease("owner-2")).toBe(true);
  } finally {
    db.close();
  }
});

test("polls after idle and releases its lease on stop", async () => {
  const calls: string[] = [];
  const heartbeatWaits = controlledHeartbeatWaits();
  let stop = false;
  const scheduler = {
    async tick() {
      calls.push("tick");
      return { kind: "idle" as const };
    },
  };
  const lease = {
    acquireLease() {
      calls.push("acquire");
      return true;
    },
    heartbeatLease() {
      calls.push("heartbeat");
      return true;
    },
    releaseLease() {
      calls.push("release");
      return true;
    },
  };
  const daemon = new SchedulerDaemon(scheduler, lease, {
    ownerId: "owner-1",
    now: () => new Date("2026-08-25T00:00:00.000Z"),
    sleep: async (milliseconds, signal) => {
      if (signal) return heartbeatWaits.sleep(milliseconds, signal);
      expect(milliseconds).toBe(1_000);
      stop = true;
    },
  });

  await daemon.run(() => stop);

  expect(calls).toEqual(["acquire", "tick", "release"]);
  expect(heartbeatWaits.pending).toHaveLength(0);
});

test("heartbeats every three seconds with a ten-second lease", async () => {
  const calls: string[] = [];
  const heartbeatWaits = controlledHeartbeatWaits();
  let now = Date.parse("2026-08-25T00:00:00.000Z");
  let stop = false;
  const scheduler = {
    async tick() {
      calls.push("tick");
      now += 1_000;
      return { kind: "task_claimed" as const, taskId: "T1" };
    },
  };
  const lease = {
    acquireLease(ownerId: string, acquiredAt: string, expiresAt: string) {
      calls.push("acquire");
      expect({ ownerId, acquiredAt, expiresAt }).toEqual({
        ownerId: "owner-1",
        acquiredAt: "2026-08-25T00:00:00.000Z",
        expiresAt: "2026-08-25T00:00:10.000Z",
      });
      return true;
    },
    heartbeatLease(ownerId: string, heartbeatAt: string, expiresAt: string) {
      calls.push("heartbeat");
      expect({ ownerId, heartbeatAt, expiresAt }).toEqual({
        ownerId: "owner-1",
        heartbeatAt: "2026-08-25T00:00:03.000Z",
        expiresAt: "2026-08-25T00:00:13.000Z",
      });
      stop = true;
      return true;
    },
    releaseLease() {
      calls.push("release");
      return true;
    },
  };
  const daemon = new SchedulerDaemon(scheduler, lease, {
    ownerId: "owner-1",
    now: () => new Date(now),
    sleep: heartbeatWaits.sleep,
  });

  await daemon.run(() => stop);

  expect(calls).toEqual([
    "acquire",
    "tick",
    "tick",
    "tick",
    "heartbeat",
    "release",
  ]);
  expect(heartbeatWaits.pending).toHaveLength(0);
});

test("heartbeats while a tick is pending and prevents lease takeover", async () => {
  const db = openDatabase(":memory:");
  const repo = new OrchestrationRepository(db);
  const heartbeatWaits = controlledHeartbeatWaits();
  const epoch = Date.parse("2026-08-25T00:00:00.000Z");
  let now = epoch;
  let stop = false;
  let tickCount = 0;
  let finishTick:
    | ((result: { kind: "task_claimed"; taskId: string }) => void)
    | undefined;
  const scheduler = {
    tick() {
      tickCount += 1;
      return new Promise<{ kind: "task_claimed"; taskId: string }>(
        (resolve) => {
          finishTick = resolve;
        },
      );
    },
  };
  const daemon = new SchedulerDaemon(scheduler, repo, {
    ownerId: "owner-1",
    now: () => new Date(now),
    sleep: heartbeatWaits.sleep,
  });
  const running = daemon.run(() => stop);

  try {
    expect(tickCount).toBe(1);
    expect(heartbeatWaits.pending[0]?.milliseconds).toBe(3_000);
    for (const elapsed of [3_000, 6_000, 9_000]) {
      now = epoch + elapsed;
      heartbeatWaits.pending[0]?.wake();
      await Promise.resolve();
      await Promise.resolve();
      expect(heartbeatWaits.pending[0]?.milliseconds).toBe(3_000);
    }

    now = epoch + 11_000;
    expect(
      repo.acquireLease(
        "owner-2",
        "2026-08-25T00:00:11.000Z",
        "2026-08-25T00:00:21.000Z",
      ),
    ).toBe(false);

    stop = true;
    finishTick?.({ kind: "task_claimed", taskId: "T1" });
    await running;
    expect(tickCount).toBe(1);
    expect(heartbeatWaits.pending).toHaveLength(0);
    expect(
      repo.acquireLease(
        "owner-2",
        "2026-08-25T00:00:11.000Z",
        "2026-08-25T00:00:21.000Z",
      ),
    ).toBe(true);
  } finally {
    stop = true;
    finishTick?.({ kind: "task_claimed", taskId: "T1" });
    await running.catch(() => {});
    repo.releaseLease("owner-2");
    db.close();
  }
});

test("surfaces lease loss during a pending tick without starting another tick", async () => {
  const db = openDatabase(":memory:");
  const repo = new OrchestrationRepository(db);
  const heartbeatWaits = controlledHeartbeatWaits();
  const epoch = Date.parse("2026-08-25T00:00:00.000Z");
  let now = epoch;
  let stop = false;
  let tickCount = 0;
  let finishTick:
    | ((result: { kind: "task_claimed"; taskId: string }) => void)
    | undefined;
  const scheduler = {
    tick() {
      tickCount += 1;
      return new Promise<{ kind: "task_claimed"; taskId: string }>(
        (resolve) => {
          finishTick = resolve;
        },
      );
    },
  };
  const daemon = new SchedulerDaemon(scheduler, repo, {
    ownerId: "owner-1",
    now: () => new Date(now),
    sleep: heartbeatWaits.sleep,
  });
  const running = daemon.run(() => stop);

  try {
    expect(tickCount).toBe(1);
    expect(heartbeatWaits.pending[0]?.milliseconds).toBe(3_000);
    now = epoch + 11_000;
    expect(
      repo.acquireLease(
        "owner-2",
        "2026-08-25T00:00:11.000Z",
        "2026-08-25T00:00:21.000Z",
      ),
    ).toBe(true);
    heartbeatWaits.pending[0]?.wake();

    await expect(running).rejects.toThrow("Scheduler lease was lost");
    expect(tickCount).toBe(1);
    expect(heartbeatWaits.pending).toHaveLength(0);
  } finally {
    stop = true;
    finishTick?.({ kind: "task_claimed", taskId: "T1" });
    await running.catch(() => {});
    repo.releaseLease("owner-2");
    db.close();
  }
});

test("rejects a stale pending delivery after lease takeover without writes", async () => {
  const db = openDatabase(":memory:");
  const epoch = Date.parse("2026-08-25T00:00:00.000Z");
  let now = epoch;
  let stop = false;
  const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
  planning.createCycle({
    id: "2026-W35",
    goal: "Fence stale scheduler writes",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: ["T1"],
  });
  planning.createTask({
    id: "T1",
    cycleId: "2026-W35",
    title: "Fence stale scheduler writes",
    spec: {
      problem: "An expired scheduler can finish a pending delivery",
      desiredOutcome: "Only the current lease owner may commit",
      scope: ["scheduler"],
      nonGoals: [],
      acceptanceCriteria: ["stale events are rejected atomically"],
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
    () => new Date(now).toISOString(),
    (kind) => {
      const count = (counters[kind] ?? 0) + 1;
      counters[kind] = count;
      return `${kind}-${count}`;
    },
  );
  repo.claimNext();
  repo.beginNextAttempt();

  let finishDelivery: ((delivery: HarnessDelivery) => void) | undefined;
  const harness: AgentHarness = {
    step() {
      return new Promise<HarnessDelivery>((resolve) => {
        finishDelivery = resolve;
      });
    },
    async cancel() {},
  };
  const heartbeatWaits = controlledHeartbeatWaits();
  const scheduler = new Scheduler(repo, harness);
  const daemon = new SchedulerDaemon(scheduler, repo, {
    ownerId: "owner-1",
    now: () => new Date(now),
    sleep: heartbeatWaits.sleep,
  });
  const event = {
    type: "attempt.started" as const,
    eventId: "stale:started",
    attemptId: "attempt-1",
    sequence: 1,
    occurredAt: "2026-08-25T00:00:11.000Z",
    threadId: "thread-stale",
  };
  const running = daemon.run(() => stop);

  try {
    expect(heartbeatWaits.pending[0]?.milliseconds).toBe(3_000);
    now = epoch + 11_000;
    expect(
      repo.acquireLease(
        "owner-2",
        "2026-08-25T00:00:11.000Z",
        "2026-08-25T00:00:21.000Z",
      ),
    ).toBe(true);
    finishDelivery?.({ kind: "event", nextCursor: "cursor-stale", event });

    await expect(running).rejects.toThrow("Scheduler lease was lost");
    expect(
      db
        .query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM events WHERE idempotency_key = ?
    `)
        .get(event.eventId)?.count,
    ).toBe(0);
    expect(
      db
        .query<
          { thread_id: string | null; backend_cursor: string | null },
          [string]
        >(`
      SELECT thread_id, backend_cursor FROM attempts WHERE id = ?
    `)
        .get(event.attemptId),
    ).toEqual({
      thread_id: null,
      backend_cursor: null,
    });
  } finally {
    stop = true;
    finishDelivery?.({ kind: "event", nextCursor: "cursor-stale", event });
    await running.catch(() => {});
    repo.releaseLease("owner-2");
    db.close();
  }
});
