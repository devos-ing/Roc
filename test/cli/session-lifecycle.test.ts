import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber, TestClock, TestContext } from "effect";
import {
  closeBackendEffect,
  runSession,
} from "../../src/cli/session-lifecycle";
import type { Logger, LogInput } from "../../src/runtime/logger";
import { openDatabase } from "../../src/store/database";

/** Records only the public cleanup diagnostics for each test. */
function recordingLogger(records: LogInput[]): Logger {
  return {
    async write(input) {
      records.push(input);
    },
    async error() {},
  };
}

test("successful close confirms quiescence without marking incomplete", async () => {
  let incomplete = 0;
  const warnings: LogInput[] = [];
  const confirmed = await Effect.runPromise(
    closeBackendEffect(
      async () => {},
      Exit.void,
      recordingLogger(warnings),
      "clean",
      () => {
        incomplete += 1;
      },
    ),
  );
  expect(confirmed).toBe(true);
  expect(incomplete).toBe(0);
  expect(warnings).toEqual([]);
});

test("session failure survives failed cleanup and removes signal listeners", async () => {
  const primary = new Error("primary");
  const warnings: LogInput[] = [];
  const logger = recordingLogger(warnings);
  const before = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ];
  let closes = 0;
  let incomplete = 0;
  await expect(
    runSession(() =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, (_resource, exit) =>
          closeBackendEffect(
            async () => {
              closes += 1;
              throw new Error("secondary secret");
            },
            exit,
            logger,
            "run-cleanup",
            () => {
              incomplete += 1;
            },
          ),
        );
        yield* Effect.fail(primary);
      }),
    ),
  ).rejects.toBe(primary);
  expect(closes).toBe(1);
  expect(incomplete).toBe(1);
  expect(warnings).toEqual([
    {
      level: "warn",
      code: "SCHEDULER_BACKEND_CLOSE_FAILED",
      category: "infra",
      component: "cli",
      retryable: false,
      runId: "run-cleanup",
      message: "Scheduler cleanup did not finish normally",
    },
  ]);
  expect([
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ]).toEqual(before);
});

test("close-only failure preserves the cleanup error and still closes the database", async () => {
  const failure = new Error("close-only secret");
  const warnings: LogInput[] = [];
  const order: string[] = [];
  const db = openDatabase(":memory:");
  await expect(
    runSession(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            db.close();
            order.push("database");
          }),
        );
        yield* Effect.acquireRelease(Effect.void, (_resource, exit) =>
          closeBackendEffect(
            async () => {
              db.query("SELECT 1").get();
              order.push("backend");
              throw failure;
            },
            exit,
            recordingLogger(warnings),
            "run-close-only",
          ),
        );
      }),
    ),
  ).rejects.toBe(failure);
  expect(order).toEqual(["backend", "database"]);
  expect(warnings.map((record) => record.code)).toEqual([
    "SCHEDULER_BACKEND_CLOSE_FAILED",
  ]);
  expect(() => db.query("SELECT 1").get()).toThrow();
});

test("a stuck backend close times out at 250ms before the database finalizer runs", async () => {
  const closing = Promise.withResolvers<void>();
  const warnings: LogInput[] = [];
  const db = openDatabase(":memory:");
  let dbClosed = false;
  let incomplete = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                db.close();
                dbClosed = true;
              }),
            );
            yield* Effect.acquireRelease(Effect.void, (_resource, exit) =>
              closeBackendEffect(
                () => {
                  db.query("SELECT 1").get();
                  closing.resolve();
                  return new Promise(() => {});
                },
                exit,
                recordingLogger(warnings),
                "run-timeout",
                () => {
                  incomplete += 1;
                },
              ),
            );
          }),
        ),
      );
      yield* Effect.promise(() => closing.promise);
      yield* TestClock.adjust(249);
      expect(dbClosed).toBe(false);
      expect(warnings).toEqual([]);
      yield* TestClock.adjust(1);
      yield* Fiber.join(fiber);
      expect(dbClosed).toBe(true);
      expect(incomplete).toBe(1);
      expect(warnings.map((record) => record.code)).toEqual([
        "SCHEDULER_BACKEND_CLOSE_TIMEOUT",
      ]);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
});

test("a stuck diagnostic is bounded and does not replace the primary failure", async () => {
  const primary = new Error("primary");
  const writing = Promise.withResolvers<void>();
  let finalized = false;
  let incomplete = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized = true;
              }),
            );
            yield* Effect.acquireRelease(Effect.void, (_resource, exit) =>
              closeBackendEffect(
                async () => {
                  throw new Error("secondary secret");
                },
                exit,
                {
                  write() {
                    expect(incomplete).toBe(true);
                    writing.resolve();
                    return new Promise(() => {});
                  },
                  async error() {},
                },
                "run-stuck-diagnostic",
                () => {
                  incomplete = true;
                },
              ),
            );
            yield* Effect.fail(primary);
          }),
        ),
      );
      yield* Effect.promise(() => writing.promise);
      yield* TestClock.adjust(99);
      expect(finalized).toBe(false);
      yield* TestClock.adjust(1);
      const exit = yield* Fiber.await(fiber);
      expect(finalized).toBe(true);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(primary);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
});
