import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runCli, schedulerSleep } from "../../src/cli/run";
import { AgileError } from "../../src/runtime/errors";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";

async function waitForTaskStatus(databasePath: string, taskId: string, status: string): Promise<void> {
  const db = openDatabase(databasePath);
  const deadline = Date.now() + 2_000;
  try {
    while (Date.now() < deadline) {
      const actual = db.query<{ status: string }, [string]>(
        "SELECT status FROM tasks WHERE id = ?",
      ).get(taskId)?.status;
      if (actual === status) return;
      await Bun.sleep(5);
    }
    throw new Error(`Timed out waiting for ${taskId} to reach ${status}`);
  } finally {
    db.close();
  }
}

test("runs a validated fake scenario through the scheduler runtime seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-cli-"));
  const scenarioPath = join(root, "scenario.json");
  const calls: unknown[] = [];
  try {
    await writeFile(scenarioPath, JSON.stringify({ attempts: [{
      taskId: "T1",
      role: "scout",
      retryIndex: 0,
      expect: { model: "luna", effort: "high" },
      deliveries: [{
        nextCursor: "1",
        event: {
          type: "attempt.completed",
          eventId: "T1:completed",
          attemptId: "A1",
          sequence: 1,
          occurredAt: "2026-08-25T00:00:00.000Z",
        },
      }],
    }] }));
    const output: string[] = [];
    const code = await runCli(
      ["scheduler", "run", "--backend", "fake", "--db", join(root, "state.db"), "--fake-script", scenarioPath],
      { out: (text) => output.push(text), err: (text) => output.push(text) },
      { runScheduler: async (input) => { calls.push(input); } },
    );
    expect(code).toBe(0);
    expect(calls).toEqual([{
      backend: "fake",
      dbPath: resolve(join(root, "state.db")),
      scenario: expect.any(Object),
    }]);
    expect(output).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default runtime binds authored events to generated attempts and stops promptly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-default-runtime-"));
  const databasePath = join(root, "state.db");
  const scenarioPath = join(root, "scenario.json");
  let running: Promise<number> | undefined;
  try {
    const db = openDatabase(databasePath);
    try {
      const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
      planning.createWeek({
        id: "2026-W35",
        goal: "Exercise the real scheduler runtime",
        nonGoals: [],
        tokenBudget: 100_000,
        ticketIds: ["T1"],
      });
      planning.createTask({
        id: "T1",
        weekId: "2026-W35",
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
    await writeFile(scenarioPath, JSON.stringify({ attempts: [{
      taskId: "T1",
      role: "scout",
      retryIndex: 0,
      expect: { model: "luna", effort: "high" },
      deliveries: [{
        nextCursor: "1",
        event: {
          type: "attempt.failed_infra",
          eventId: "T1:scout:failed",
          attemptId: "authored-attempt-id",
          sequence: 1,
          occurredAt: "2026-08-25T00:00:01.000Z",
          code: "backend_unavailable",
          message: "Stop after one real delivery",
          retryable: false,
        },
      }],
    }] }));

    const startedAt = Date.now();
    running = runCli(
      ["scheduler", "run", "--backend", "fake", "--db", databasePath, "--fake-script", scenarioPath],
      { out: () => {}, err: (text) => { throw new Error(text); } },
    );
    await waitForTaskStatus(databasePath, "T1", "failed_infra");
    process.emit("SIGTERM");
    expect(await running).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const lifecycle = (await readFile(join(root, "agile.log"), "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { code: string; runId?: string });
    expect(lifecycle.map((record) => record.code)).toEqual([
      "SCHEDULER_RUN_STARTED",
      "SCHEDULER_RUN_STOPPED",
    ]);
    expect(lifecycle[0]?.runId).toBeTruthy();
    expect(lifecycle[1]?.runId).toBe(lifecycle[0]?.runId);

    const inspected = openDatabase(databasePath);
    try {
      const attempt = inspected.query<{ id: string }, []>(
        "SELECT id FROM attempts WHERE task_id = 'T1'",
      ).get();
      const payload = inspected.query<{ payload_json: string }, []>(
        "SELECT payload_json FROM events WHERE idempotency_key = 'T1:scout:failed'",
      ).get();
      expect(attempt?.id).toStartWith("attempt-");
      expect(attempt?.id).not.toBe("authored-attempt-id");
      expect(JSON.parse(payload?.payload_json ?? "null").attemptId).toBe(attempt?.id);
    } finally {
      inspected.close();
    }
  } finally {
    process.emit("SIGTERM");
    await running?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("production sleep cancels heartbeat waits and preserves the one-second idle delay", async () => {
  const stop = new AbortController();
  const heartbeatStartedAt = Date.now();
  const heartbeat = schedulerSleep(3_000, stop.signal);
  stop.abort(new Error("tick finished"));
  await expect(heartbeat).rejects.toThrow("tick finished");
  expect(Date.now() - heartbeatStartedAt).toBeLessThan(250);

  const idleStartedAt = Date.now();
  await schedulerSleep(1_000);
  const idleElapsed = Date.now() - idleStartedAt;
  expect(idleElapsed).toBeGreaterThanOrEqual(900);
  expect(idleElapsed).toBeLessThan(2_000);
});

test("prints a stable JSON inspection snapshot", async () => {
  const output: string[] = [];
  const code = await runCli(["scheduler", "inspect", "--db", ":memory:"], {
    out: (text) => output.push(text),
    err: (text) => output.push(text),
  });
  expect(code).toBe(0);
  expect(JSON.parse(output[0] ?? "null")).toEqual({ scheduler: {}, weeks: [], tasks: [] });
});

test("returns configuration errors before opening a database", async () => {
  const output: string[] = [];
  expect(await runCli(["scheduler", "run"], {
    out: (text) => output.push(text),
    err: (text) => output.push(text),
  })).toBe(2);
  expect(output[0]).toContain("--backend fake|codex");
});

test("passes normalized Codex scheduler options to the runtime seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-codex-cli-"));
  const databasePath = join(root, "state.db");
  const calls: unknown[] = [];
  try {
    expect(await runCli([
      "scheduler", "run", "--backend", "codex", "--repo", root, "--db", databasePath,
    ], { out: () => {}, err: () => {} }, {
      runScheduler: async (input) => { calls.push(input); },
    })).toBe(0);
    expect(calls[0]).toEqual({
      backend: "codex",
      repoPath: resolve(root),
      baseRef: "HEAD",
      dbPath: resolve(databasePath),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires backend-specific scheduler options before invoking the runtime", async () => {
  const cases: Array<{ args: string[]; message: string }> = [
    { args: ["scheduler", "run", "--backend", "fake"], message: "--fake-script PATH" },
    { args: ["scheduler", "run", "--backend", "codex", "--repo", ".", "--fake-script", "scenario.json"], message: "does not accept --fake-script" },
    { args: ["scheduler", "run", "--backend", "codex"], message: "--repo PATH" },
  ];
  for (const entry of cases) {
    const errors: string[] = [];
    let called = false;
    expect(await runCli(entry.args, { out: () => {}, err: (text) => errors.push(text) }, {
      runScheduler: async () => { called = true; },
    })).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(entry.message);
    expect(called).toBeFalse();
  }
});

test("renders an operational AgileError once and asks the runtime to log it", async () => {
  const errors: string[] = [];
  const logged: AgileError[] = [];
  const runtimeError = new AgileError({
    code: "CODEX_STARTUP_BLOCKED",
    category: "startup",
    retryable: false,
    component: "cli",
    message: "Codex could not start",
  });
  expect(await runCli([
    "scheduler", "run", "--backend", "codex", "--repo", ".",
  ], { out: () => {}, err: (text) => errors.push(text) }, {
    runScheduler: async () => { throw runtimeError; },
    logError: async (error) => { logged.push(error); },
  })).toBe(1);
  expect(errors).toEqual(["CODEX_STARTUP_BLOCKED: Codex could not start"]);
  expect(logged).toEqual([runtimeError]);
});

test("returns configuration errors for invalid fake scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-cli-"));
  const invalidJson = join(root, "invalid.json");
  const invalidSchema = join(root, "invalid-schema.json");
  try {
    await writeFile(invalidJson, "{");
    await writeFile(invalidSchema, JSON.stringify({ attempts: [] }));
    for (const fakeScript of [invalidJson, invalidSchema]) {
      const output: string[] = [];
      expect(await runCli(["scheduler", "run", "--backend", "fake", "--db", join(root, "state.db"), "--fake-script", fakeScript], {
        out: (text) => output.push(text),
        err: (text) => output.push(text),
      })).toBe(2);
      expect(output).toHaveLength(1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns operational errors for an unreadable scheduler database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-cli-"));
  const scenarioPath = join(root, "scenario.json");
  const output: string[] = [];
  try {
    await writeFile(scenarioPath, JSON.stringify({ attempts: [{
      taskId: "T1",
      role: "scout",
      retryIndex: 0,
      expect: { model: "luna", effort: "high" },
      deliveries: [{
        nextCursor: "1",
        event: {
          type: "attempt.completed",
          eventId: "T1:completed",
          attemptId: "A1",
          sequence: 1,
          occurredAt: "2026-08-25T00:00:00.000Z",
        },
      }],
    }] }));
    expect(await runCli(["scheduler", "run", "--backend", "fake", "--db", "/dev/null/state.db", "--fake-script", scenarioPath], {
      out: (text) => output.push(text),
      err: (text) => output.push(text),
    })).toBe(1);
    expect(output).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
