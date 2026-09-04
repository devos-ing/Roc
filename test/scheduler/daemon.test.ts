import { expect, test } from "bun:test";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Option,
  TestClock,
  TestContext,
} from "effect";
import type {
  AgentHarness,
  HarnessDelivery,
} from "../../src/harness/contracts";
import { SchedulerDaemon } from "../../src/scheduler/daemon";
import { Scheduler } from "../../src/scheduler/scheduler";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

test("heartbeat failure wakes idle polling without consuming the drain deadline", async () => {
  const primary = new Error("idle heartbeat failure");
  const entered = Promise.withResolvers<void>();
  let timedOut = false;
  const daemon = new SchedulerDaemon(
    {
      async tick() {
        entered.resolve();
        return { kind: "idle" };
      },
    },
    {
      acquireLease: () => true,
      heartbeatLease: () => {
        throw primary;
      },
      releaseLease: () => true,
    },
    { ownerId: "idle-heartbeat" },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        daemon.runEffect({
          stop: new AbortController().signal,
          cancel: async () => {},
          onDrainTimeout: () => {
            timedOut = true;
          },
        }),
      );
      yield* Effect.promise(() => entered.promise);
      yield* TestClock.adjust(3_000);
      const immediate = yield* Fiber.poll(fiber);
      yield* TestClock.adjust(250);
      const exit = yield* Fiber.await(fiber);
      expect(Option.isSome(immediate)).toBe(true);
      expect(timedOut).toBe(false);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(primary);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
});

test("a primary heartbeat failure survives a tick failure during drain", async () => {
  const primary = new Error("heartbeat failed");
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<never>();
  let released = false;
  const daemon = new SchedulerDaemon(
    {
      tick() {
        entered.resolve();
        return finish.promise;
      },
    },
    {
      acquireLease: () => true,
      heartbeatLease: () => {
        throw primary;
      },
      releaseLease: () => {
        released = true;
        return true;
      },
    },
    { ownerId: "owner-1" },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        daemon.runEffect({
          stop: new AbortController().signal,
          cancel: async () => {
            finish.reject(new Error("secondary tick failure"));
          },
        }),
      );
      yield* Effect.promise(() => entered.promise);
      yield* TestClock.adjust(3_000);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(primary);
      expect(released).toBe(true);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
});

test("preserves a tick failure during stop grace even when cancellation stays pending", async () => {
  const primary = new Error("tick failed during grace");
  const entered = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<never>();
  const stop = new AbortController();
  let released = false;
  const daemon = new SchedulerDaemon(
    {
      tick() {
        entered.resolve();
        return finish.promise;
      },
    },
    {
      acquireLease: () => true,
      heartbeatLease: () => true,
      releaseLease: () => {
        released = true;
        return true;
      },
    },
    { ownerId: "owner-1" },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        daemon.runEffect({
          stop: stop.signal,
          cancel: () => {
            cancelling.resolve();
            return new Promise(() => {});
          },
        }),
      );
      yield* Effect.promise(() => entered.promise);
      stop.abort();
      yield* Effect.promise(() => cancelling.promise);
      finish.reject(primary);
      yield* TestClock.adjust(250);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(primary);
      expect(released).toBe(true);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
});

test("Effect drain seals a stuck tick at the configured deadline", async () => {
  const entered = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  const stop = new AbortController();
  let tickSignal: AbortSignal | undefined;
  let released = false;
  let incomplete = 0;
  const daemon = new SchedulerDaemon(
    {
      async tick(_owner, signal) {
        tickSignal = signal;
        entered.resolve();
        return new Promise(() => {});
      },
    },
    {
      acquireLease: () => true,
      heartbeatLease: () => true,
      releaseLease: () => {
        released = true;
        return true;
      },
    },
    { ownerId: "test-owner" },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        daemon.runEffect({
          stop: stop.signal,
          cancel: () => {
            cancelling.resolve();
            return new Promise(() => {});
          },
          drainMs: 250,
          onDrainTimeout: () => {
            expect(tickSignal?.aborted).toBe(false);
            incomplete += 1;
          },
        }),
      );
      yield* Effect.promise(() => entered.promise);
      stop.abort();
      yield* Effect.promise(() => cancelling.promise);
      yield* TestClock.adjust(249);
      expect(tickSignal?.aborted).toBe(false);
      expect(released).toBe(false);
      yield* TestClock.adjust(1);
      yield* Fiber.join(fiber);
      expect(tickSignal?.aborted).toBe(true);
      expect(released).toBe(true);
      expect(incomplete).toBe(1);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
});

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
  const entered = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  const stop = new AbortController();
  let ticks = 0;
  const daemon = new SchedulerDaemon(
    {
      async tick() {
        calls.push("tick");
        ticks += 1;
        if (ticks === 1) entered.resolve();
        else second.resolve();
        return { kind: "idle" };
      },
    },
    {
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
    },
    { ownerId: "owner-1" },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        daemon.runEffect({
          stop: stop.signal,
          cancel: async () => {
            cancelling.resolve();
          },
        }),
      );
      yield* Effect.promise(() => entered.promise);
      yield* TestClock.adjust(999);
      expect(ticks).toBe(1);
      yield* TestClock.adjust(1);
      yield* Effect.promise(() => second.promise);
      stop.abort();
      yield* Effect.promise(() => cancelling.promise);
      yield* TestClock.adjust(1);
      const idleExit = yield* Fiber.poll(fiber);
      yield* TestClock.adjust(249);
      yield* Fiber.join(fiber);
      expect(Option.isSome(idleExit)).toBe(true);
      expect(calls).toEqual(["acquire", "tick", "tick", "release"]);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
});

test("heartbeats every three seconds with a ten-second lease", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<{
    kind: "task_claimed";
    taskId: string;
  }>();
  const stop = new AbortController();
  const leases: string[][] = [];
  const daemon = new SchedulerDaemon(
    {
      tick() {
        entered.resolve();
        return finish.promise;
      },
    },
    {
      acquireLease(...args) {
        leases.push(args);
        return true;
      },
      heartbeatLease(...args) {
        leases.push(args);
        return true;
      },
      releaseLease() {
        return true;
      },
    },
    { ownerId: "owner-1" },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-25T00:00:00.000Z"));
      const fiber = yield* Effect.fork(
        daemon.runEffect({
          stop: stop.signal,
          cancel: async () => {
            finish.resolve({ kind: "task_claimed", taskId: "T1" });
          },
        }),
      );
      yield* Effect.promise(() => entered.promise);
      yield* TestClock.adjust(2_999);
      expect(leases).toEqual([
        ["owner-1", "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:10.000Z"],
      ]);
      yield* TestClock.adjust(1);
      expect(leases[1]).toEqual([
        "owner-1",
        "2026-08-25T00:00:03.000Z",
        "2026-08-25T00:00:13.000Z",
      ]);
      yield* TestClock.adjust(3_000);
      expect(leases[2]).toEqual([
        "owner-1",
        "2026-08-25T00:00:06.000Z",
        "2026-08-25T00:00:16.000Z",
      ]);
      stop.abort();
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
});

test("heartbeats while a tick is pending and prevents lease takeover", async () => {
  const db = openDatabase(":memory:");
  const repo = new OrchestrationRepository(db);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<{
    kind: "task_claimed";
    taskId: string;
  }>();
  const stop = new AbortController();
  let ticks = 0;
  const daemon = new SchedulerDaemon(
    {
      tick() {
        ticks += 1;
        entered.resolve();
        return finish.promise;
      },
    },
    repo,
    { ownerId: "owner-1" },
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-08-25T00:00:00.000Z"));
        const fiber = yield* Effect.fork(
          daemon.runEffect({
            stop: stop.signal,
            cancel: async () => {
              finish.resolve({ kind: "task_claimed", taskId: "T1" });
            },
          }),
        );
        yield* Effect.promise(() => entered.promise);
        yield* TestClock.adjust(11_000);
        expect(
          repo.acquireLease(
            "owner-2",
            "2026-08-25T00:00:11.000Z",
            "2026-08-25T00:00:21.000Z",
          ),
        ).toBe(false);
        stop.abort();
        yield* Fiber.join(fiber);
        expect(ticks).toBe(1);
        expect(
          repo.acquireLease(
            "owner-2",
            "2026-08-25T00:00:11.000Z",
            "2026-08-25T00:00:21.000Z",
          ),
        ).toBe(true);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  } finally {
    db.close();
  }
});

test("surfaces lease loss during a pending tick without starting another tick", async () => {
  const db = openDatabase(":memory:");
  const repo = new OrchestrationRepository(db);
  const entered = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  let ticks = 0;
  const daemon = new SchedulerDaemon(
    {
      async tick() {
        ticks += 1;
        entered.resolve();
        return new Promise(() => {});
      },
    },
    repo,
    { ownerId: "owner-1" },
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-08-25T00:00:00.000Z"));
        const fiber = yield* Effect.fork(
          daemon.runEffect({
            stop: new AbortController().signal,
            cancel: async () => {
              cancelling.resolve();
            },
          }),
        );
        yield* Effect.promise(() => entered.promise);
        expect(
          repo.acquireLease(
            "owner-2",
            "2026-08-25T00:00:11.000Z",
            "2026-08-25T00:00:21.000Z",
          ),
        ).toBe(true);
        yield* TestClock.adjust(3_000);
        yield* Effect.promise(() => cancelling.promise);
        yield* TestClock.adjust(250);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toMatchObject({
            message: "Scheduler lease was lost",
          });
        expect(ticks).toBe(1);
        expect(repo.releaseLease("owner-1")).toBe(false);
        expect(repo.releaseLease("owner-2")).toBe(true);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  } finally {
    db.close();
  }
});

test("rejects a stale pending delivery after lease takeover without writes", async () => {
  const db = openDatabase(":memory:");
  const epoch = Date.parse("2026-08-25T00:00:00.000Z");
  let now = epoch;
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

  const entered = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<HarnessDelivery>();
  const harness: AgentHarness = {
    step() {
      entered.resolve();
      return delivery.promise;
    },
    async cancel() {},
  };
  const scheduler = new Scheduler(repo, harness);
  const daemon = new SchedulerDaemon(scheduler, repo, {
    ownerId: "owner-1",
  });
  const event = {
    type: "attempt.started" as const,
    eventId: "stale:started",
    attemptId: "attempt-1",
    sequence: 1,
    occurredAt: "2026-08-25T00:00:11.000Z",
    threadId: "thread-stale",
  };
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(epoch);
        const fiber = yield* Effect.fork(
          daemon.runEffect({
            stop: new AbortController().signal,
            cancel: async () => {},
          }),
        );
        yield* Effect.promise(() => entered.promise);
        now = epoch + 11_000;
        expect(
          repo.acquireLease(
            "owner-2",
            "2026-08-25T00:00:11.000Z",
            "2026-08-25T00:00:21.000Z",
          ),
        ).toBe(true);
        delivery.resolve({ kind: "event", nextCursor: "cursor-stale", event });

        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toMatchObject({
            message: "Scheduler lease was lost",
          });
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
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  } finally {
    repo.releaseLease("owner-2");
    db.close();
  }
});
