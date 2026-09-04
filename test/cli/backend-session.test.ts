import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendFactory, BackendRuntime } from "../../src/agents/types";
import { runBackendSession } from "../../src/cli/runtime";
import type { RealSchedulerRunInput } from "../../src/cli/types";
import type {
  HarnessDelivery,
  HarnessStepRequest,
} from "../../src/harness/contracts";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";
import { git } from "../helpers/git";

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agile-backend-session-"));
  await git(["init"], root);
  await git(["config", "user.name", "Agile Tests"], root);
  await git(["config", "user.email", "agile@example.test"], root);
  await writeFile(join(root, "README.md"), "seed\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: seed"], root);
  return realpath(root);
}

/** Seeds one approved, ready task so the daemon dispatches a real attempt. */
async function seedReadyTask(dbPath: string): Promise<void> {
  const db = openDatabase(dbPath);
  try {
    const planning = new PlanningRepository(
      db,
      () => "2026-08-29T00:00:00.000Z",
    );
    planning.createCycle({
      id: "2026-W35",
      goal: "Exercise the backend session boundary",
      nonGoals: [],
      tokenBudget: 100_000,
      ticketIds: ["T1"],
    });
    planning.createTask({
      id: "T1",
      cycleId: "2026-W35",
      title: "Backend session boundary",
      spec: {
        problem: "The daemon must drive the factory-provided harness",
        desiredOutcome: "The harness step receives the dispatched attempt",
        scope: ["cli runtime"],
        nonGoals: [],
        acceptanceCriteria: ["the harness observes the attempt"],
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
  } finally {
    db.close();
  }
}

/** A catalog whose single model routes every role at medium risk. */
const compatibleCatalog = [
  { id: "fake-terra", supportedReasoningEfforts: ["high", "xhigh"] },
];

/**
 * Records harness step requests and close bookkeeping without touching real
 * agents. `close` mirrors an idempotent BackendRuntime close: every caller
 * advances `closeCalls`, but the underlying cleanup runs exactly once.
 */
function fakeBackend(catalog: typeof compatibleCatalog): {
  factory: BackendFactory;
  closed: () => boolean;
  branchSeen: () => boolean;
  closeCounts: () => { closeCalls: number; cleanupCalls: number };
  stepRequests: () => HarnessStepRequest[];
  firstStep: Promise<void>;
} {
  let closeCalls = 0;
  let cleanupCalls = 0;
  let closePromise: Promise<void> | undefined;
  let sawBranches = false;
  const requests: HarnessStepRequest[] = [];
  const firstStep = Promise.withResolvers<void>();
  const factory: BackendFactory = async ({ branches }) => {
    sawBranches = branches !== undefined;
    const runtime: BackendRuntime = {
      catalog,
      harness: {
        async step(request) {
          requests.push(request);
          firstStep.resolve();
          return { kind: "idle" };
        },
        async cancel() {},
      },
      close: () => {
        closeCalls += 1;
        closePromise ??= Promise.resolve().then(() => {
          cleanupCalls += 1;
        });
        return closePromise;
      },
    };
    return runtime;
  };
  return {
    factory,
    closed: () => cleanupCalls > 0,
    branchSeen: () => sawBranches,
    closeCounts: () => ({ closeCalls, cleanupCalls }),
    stepRequests: () => requests,
    firstStep: firstStep.promise,
  };
}

function sessionInput(repoPath: string, dbPath: string): RealSchedulerRunInput {
  return { backend: "codex", dbPath, repoPath, baseRef: "HEAD" };
}

test("runBackendSession dispatches a ready task through the factory harness and closes it exactly once", async () => {
  const root = await createRepository();
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const before = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ];
  await seedReadyTask(dbPath);
  const { factory, closed, branchSeen, closeCounts, stepRequests, firstStep } =
    fakeBackend(compatibleCatalog);
  try {
    const running = runBackendSession(
      factory,
      sessionInput(root, dbPath),
      "run-session-startup",
    );
    await firstStep;
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await running;

    expect(branchSeen()).toBe(true);
    const [request] = stepRequests();
    expect(request).toBeDefined();
    expect(request?.attempt.taskId).toBe("T1");
    expect(request?.attempt.role).toBe("scout");
    // The advisor picked the model from the catalog the factory returned.
    expect(request?.attempt.model).toBe("fake-terra");
    expect(stepRequests()).toHaveLength(1);
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(before);
    expect(closeCounts().closeCalls).toBe(1);
    expect(closeCounts().cleanupCalls).toBe(1);
    expect(closed()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.agile-checkout`, { recursive: true, force: true });
  }
});

test("runBackendSession closes the backend when no catalog model is compatible", async () => {
  const root = await createRepository();
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const { factory, closed } = fakeBackend([]);
  try {
    await expect(
      runBackendSession(
        factory,
        sessionInput(root, dbPath),
        "run-session-catalog",
      ),
    ).rejects.toMatchObject({ code: "BACKEND_MODEL_CATALOG_INCOMPATIBLE" });
    expect(closed()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.agile-checkout`, { recursive: true, force: true });
  }
});

test("runBackendSession rejects GitHub preflight before starting the backend", async () => {
  const root = await createRepository();
  let started = false;
  const factory: BackendFactory = async () => {
    started = true;
    throw new Error("Backend should not start");
  };
  try {
    await expect(
      runBackendSession(
        factory,
        sessionInput(root, join(root, "state.db")),
        "run-preflight",
        {
          preflight: {
            async assertReady() {
              throw new Error("gh auth login is required");
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "GITHUB_PREFLIGHT_FAILED" });
    expect(started).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.agile-checkout`, { recursive: true, force: true });
  }
});

test("runBackendSession closes the backend when the scheduler database cannot open", async () => {
  const root = await createRepository();
  // A directory cannot back a SQLite database file.
  const dbPath = join(root, "unwritable.db");
  await mkdir(dbPath);
  const { factory, closed } = fakeBackend(compatibleCatalog);
  try {
    await expect(
      runBackendSession(
        factory,
        sessionInput(root, dbPath),
        "run-session-database",
      ),
    ).rejects.toMatchObject({ code: "SCHEDULER_DATABASE_OPEN_FAILED" });
    expect(closed()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.agile-checkout`, { recursive: true, force: true });
  }
});

for (const late of [false, true]) {
  test(
    late
      ? "runBackendSession bounds stuck cancellation and seals late delivery before closing SQLite"
      : "runBackendSession commits delivery during grace and safely records cancellation failure",
    async () => {
      const root = await createRepository();
      const dbPath = join(root, ".agile", "runtime", "agile.db");
      await seedReadyTask(dbPath);
      const entered = Promise.withResolvers<HarnessStepRequest>();
      const finish = Promise.withResolvers<HarnessDelivery>();
      const cancelling = Promise.withResolvers<void>();
      const closing = Promise.withResolvers<void>();
      const returned = Promise.withResolvers<void>();
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => {
        unhandled.push(error);
      };
      process.on("unhandledRejection", onUnhandled);
      const before = [
        process.listenerCount("SIGINT"),
        process.listenerCount("SIGTERM"),
      ];
      let cancelCalls = 0;
      let closeCalls = 0;
      let stepCalls = 0;
      let delivery: HarnessDelivery = { kind: "idle" };
      const factory: BackendFactory = async () => ({
        catalog: compatibleCatalog,
        harness: {
          async step(request) {
            stepCalls += 1;
            entered.resolve(request);
            try {
              return await finish.promise;
            } finally {
              returned.resolve();
            }
          },
          cancel() {
            cancelCalls += 1;
            cancelling.resolve();
            if (late) return new Promise(() => {});
            finish.resolve(delivery);
            throw new Error("cancellation secret-token");
          },
        },
        async close() {
          closeCalls += 1;
          closing.resolve();
        },
      });
      let running: Promise<void> | undefined;
      try {
        running = runBackendSession(
          factory,
          sessionInput(root, dbPath),
          "run-drain",
        );
        const request = await entered.promise;
        delivery = {
          kind: "event",
          nextCursor: "cursor-drain",
          event: {
            type: "attempt.started",
            eventId: "drain:started",
            attemptId: request.attempt.attemptId,
            sequence: 1,
            occurredAt: new Date().toISOString(),
            threadId: "thread-drain",
          },
        };
        process.emit("SIGINT");
        process.emit("SIGTERM");
        await cancelling.promise;
        await closing.promise;
        await running;
        expect(cancelCalls).toBe(1);
        expect(closeCalls).toBe(1);
        expect(stepCalls).toBe(1);
        expect([
          process.listenerCount("SIGINT"),
          process.listenerCount("SIGTERM"),
        ]).toEqual(before);
        if (late) {
          finish.resolve(delivery);
          await returned.promise;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const inspected = openDatabase(dbPath);
        try {
          expect(
            inspected.query("SELECT owner_id FROM scheduler_lease").all(),
          ).toEqual([]);
          expect(
            inspected
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM events WHERE idempotency_key = 'drain:started'",
              )
              .get()?.count,
          ).toBe(late ? 0 : 1);
          expect(
            inspected
              .query<{ backend_cursor: string | null }, [string]>(
                "SELECT backend_cursor FROM attempts WHERE id = ?",
              )
              .get(request.attempt.attemptId)?.backend_cursor,
          ).toBe(late ? null : "cursor-drain");
        } finally {
          inspected.close();
        }
        if (!late) {
          const log = await readFile(
            join(root, ".agile", "runtime", "agile.log"),
            "utf8",
          );
          expect(log).toContain("SCHEDULER_CANCELLATION_FAILED");
          expect(log).not.toContain("secret-token");
        }
        expect(unhandled).toEqual([]);
      } finally {
        finish.resolve(delivery);
        process.emit("SIGTERM");
        await running?.catch(() => {});
        process.off("unhandledRejection", onUnhandled);
        await rm(root, { recursive: true, force: true });
        await rm(`${root}.agile-checkout`, { recursive: true, force: true });
      }
    },
  );
}

test("a signal during backend startup closes the acquired backend without opening SQLite", async () => {
  const root = await createRepository();
  const entered = Promise.withResolvers<void>();
  const started = Promise.withResolvers<BackendRuntime>();
  const before = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
  ];
  let closes = 0;
  // Opening this path would fail, so successful shutdown proves startup did not continue.
  const dbPath = join(root, "directory.db");
  await mkdir(dbPath);
  const factory: BackendFactory = () => {
    entered.resolve();
    return started.promise;
  };
  try {
    const running = runBackendSession(
      factory,
      sessionInput(root, dbPath),
      "run-startup-stop",
    );
    await entered.promise;
    process.emit("SIGINT");
    process.emit("SIGTERM");
    started.resolve({
      catalog: compatibleCatalog,
      harness: {
        async step() {
          throw new Error("must not dispatch");
        },
        async cancel() {},
      },
      async close() {
        closes += 1;
      },
    });
    await running;
    expect(closes).toBe(1);
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.agile-checkout`, { recursive: true, force: true });
  }
});
