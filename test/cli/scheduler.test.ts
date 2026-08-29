import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, runDaemon, schedulerSleep } from "../../src/cli/run";
import { defaultRuntime } from "../../src/cli/runtime";
import type { SchedulerRunInput } from "../../src/cli/types";
import { AgileError } from "../../src/runtime/errors";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";

/** Waits until one stored task reaches the expected scheduler status. */
async function waitForTaskStatus(
  databasePath: string,
  taskId: string,
  status: string,
): Promise<void> {
  const db = openDatabase(databasePath);
  const deadline = Date.now() + 2_000;
  try {
    while (Date.now() < deadline) {
      const actual = db
        .query<{ status: string }, [string]>(
          "SELECT status FROM tasks WHERE id = ?",
        )
        .get(taskId)?.status;
      if (actual === status) return;
      await Bun.sleep(5);
    }
    throw new Error(`Timed out waiting for ${taskId} to reach ${status}`);
  } finally {
    db.close();
  }
}

test("the internal fake runtime binds authored events to generated attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-runtime-"));
  const databasePath = join(root, "state.db");
  let running: Promise<void> | undefined;
  try {
    const db = openDatabase(databasePath);
    try {
      const planning = new PlanningRepository(
        db,
        () => "2026-08-25T00:00:00.000Z",
      );
      planning.createCycle({
        id: "2026-W35",
        goal: "Exercise the fake scheduler runtime",
        nonGoals: [],
        tokenBudget: 100_000,
        ticketIds: ["T1"],
      });
      planning.createTask({
        id: "T1",
        cycleId: "2026-W35",
        title: "Generated attempt binding",
        spec: {
          problem: "The script has an authored attempt ID",
          desiredOutcome: "The runtime-generated attempt receives the event",
          scope: ["scheduler runtime"],
          nonGoals: [],
          acceptanceCriteria: ["the durable event is applied"],
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

    running = defaultRuntime.runScheduler({
      backend: "fake",
      dbPath: databasePath,
      scenario: {
        attempts: [
          {
            taskId: "T1",
            role: "scout",
            retryIndex: 0,
            expect: { model: "luna", effort: "high" },
            deliveries: [
              {
                nextCursor: "1",
                event: {
                  type: "attempt.failed_infra",
                  eventId: "T1:scout:failed",
                  attemptId: "authored-attempt-id",
                  sequence: 1,
                  occurredAt: "2026-08-25T00:00:01.000Z",
                  code: "backend_unavailable",
                  message: "Stop after one delivery",
                  retryable: false,
                },
              },
            ],
          },
        ],
      },
    });
    await waitForTaskStatus(databasePath, "T1", "failed_infra");
    process.emit("SIGTERM");
    await running;

    const lifecycle = (await readFile(join(root, "agile.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { code: string; runId?: string });
    expect(lifecycle.map((record) => record.code)).toEqual([
      "SCHEDULER_RUN_STARTED",
      "SCHEDULER_RUN_STOPPED",
    ]);

    const inspected = openDatabase(databasePath);
    try {
      const attempt = inspected
        .query<{ id: string }, []>(
          "SELECT id FROM attempts WHERE task_id = 'T1'",
        )
        .get();
      const payload = inspected
        .query<{ payload_json: string }, []>(
          "SELECT payload_json FROM events WHERE idempotency_key = 'T1:scout:failed'",
        )
        .get();
      expect(attempt?.id).toStartWith("attempt-");
      expect(JSON.parse(payload?.payload_json ?? "null").attemptId).toBe(
        attempt?.id,
      );
    } finally {
      inspected.close();
    }
  } finally {
    process.emit("SIGTERM");
    await running?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("production sleep cancels heartbeat waits and preserves the idle delay", async () => {
  const stop = new AbortController();
  const heartbeat = schedulerSleep(3_000, stop.signal);
  stop.abort(new Error("tick finished"));
  await expect(heartbeat).rejects.toThrow("tick finished");

  const idleStartedAt = Date.now();
  await schedulerSleep(1_000);
  const idleElapsed = Date.now() - idleStartedAt;
  expect(idleElapsed).toBeGreaterThanOrEqual(900);
  expect(idleElapsed).toBeLessThan(2_000);
});

test("signal shutdown bounds cancellation and closes a blocked backend", async () => {
  let releaseDaemon: (() => void) | undefined;
  let released = false;
  let cancelCalled = false;
  let closeCalled = false;
  const running = runDaemon({
    daemon: {
      async run() {
        await new Promise<void>((resolve) => {
          releaseDaemon = () => {
            released = true;
            resolve();
          };
        });
      },
    },
    repo: {
      getRunningAttempt() {
        return { descriptor: { attemptId: "attempt-blocked" } } as never;
      },
    },
    harness: {
      async step() {
        throw new Error("not used");
      },
      async cancel() {
        cancelCalled = true;
        await new Promise(() => {});
      },
    },
    closeBackend: async () => {
      closeCalled = true;
      releaseDaemon?.();
    },
    shutdownTimeoutMs: 25,
    logger: { async write() {}, async error() {} },
    runId: "run-signal-test",
  });

  process.emit("SIGTERM");
  await running;

  expect(cancelCalled).toBe(true);
  expect(closeCalled).toBe(true);
  expect(released).toBe(true);
});

test("prints a stable project scheduler snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-inspect-"));
  const output: string[] = [];
  try {
    expect(
      await runCli(
        ["scheduler", "inspect"],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        { runScheduler: async () => {}, projectRoot: root },
      ),
    ).toBe(0);
    expect(JSON.parse(output[0] ?? "null")).toEqual({
      scheduler: {},
      cycles: [],
      tasks: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passes fixed project paths and the selected base to the Codex runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-codex-cli-"));
  const calls: unknown[] = [];
  const output: string[] = [];
  try {
    expect(
      await runCli(
        ["scheduler", "run", "--base", "origin/main"],
        { out: (text) => output.push(text), err: () => {} },
        {
          projectRoot: root,
          runScheduler: async (input) => {
            calls.push(input);
          },
        },
      ),
    ).toBe(0);
    expect(calls).toEqual([
      {
        backend: "codex",
        repoPath: root,
        baseRef: "origin/main",
        dbPath: join(root, ".agile", "runtime", "agile.db"),
      },
    ]);
    expect(output).toEqual(["Status: Starting", "Result: Stopped"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects internal scheduler flags before invoking the runtime", async () => {
  for (const option of ["--db", "--repo", "--fake-script"]) {
    const errors: string[] = [];
    let called = false;
    expect(
      await runCli(
        ["scheduler", "run", option, "value"],
        { out: () => {}, err: (text) => errors.push(text) },
        {
          runScheduler: async () => {
            called = true;
          },
        },
      ),
    ).toBe(2);
    expect(errors.join("\n")).toContain(`unknown option '${option}'`);
    expect(called).toBeFalse();
  }
});

test("rejects a --backend name outside the registry before invoking the runtime", async () => {
  for (const backend of ["nope", "toString", "constructor", "__proto__"]) {
    const errors: string[] = [];
    let called = false;
    expect(
      await runCli(
        ["scheduler", "run", "--backend", backend],
        { out: () => {}, err: (text) => errors.push(text) },
        {
          runScheduler: async () => {
            called = true;
          },
        },
      ),
    ).toBe(2);
    expect(errors.join("\n")).toContain(
      "scheduler run requires --backend fake|codex",
    );
    expect(called).toBeFalse();
  }
});

test("routes a registered --backend name into the scheduler run input", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-backend-"));
  const calls: SchedulerRunInput[] = [];
  try {
    expect(
      await runCli(
        ["scheduler", "run", "--backend", "codex"],
        { out: () => {}, err: () => {} },
        {
          projectRoot: root,
          runScheduler: async (input) => {
            calls.push(input);
          },
        },
      ),
    ).toBe(0);
    expect(calls).toEqual([
      {
        backend: "codex",
        repoPath: root,
        baseRef: "HEAD",
        dbPath: join(root, ".agile", "runtime", "agile.db"),
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("logs and renders one operational scheduler failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-error-"));
  const output: string[] = [];
  const errors: string[] = [];
  const logged: AgileError[] = [];
  const runtimeError = new AgileError({
    code: "CODEX_STARTUP_BLOCKED",
    category: "startup",
    retryable: false,
    component: "cli",
    message: "Codex could not start",
  });
  try {
    expect(
      await runCli(
        ["scheduler", "run"],
        { out: (text) => output.push(text), err: (text) => errors.push(text) },
        {
          projectRoot: root,
          runScheduler: async () => {
            throw runtimeError;
          },
          logError: async (error) => {
            logged.push(error);
          },
        },
      ),
    ).toBe(1);
    expect(output).toEqual(["Status: Starting"]);
    expect(errors).toEqual(["CODEX_STARTUP_BLOCKED: Codex could not start"]);
    expect(logged).toEqual([runtimeError]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
