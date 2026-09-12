import { expect, spyOn, test } from "bun:test";
import type { HarnessStepRequest } from "../../src/harness/contracts";
import { createFakeHarness } from "../../src/harness/fake";
import { AgileError } from "../../src/runtime/errors";
import { GitHubTaskPool } from "../../src/scheduler/github-pool";
import { createStaticModelAdvisor } from "../../src/scheduler/model-routing";
import type { TaskBranchManager } from "../../src/workspace/task-branch";
import { barrier, memoryPlan } from "../helpers/github-plan";

const base = "a".repeat(40);
const time = "2026-09-09T00:00:00Z";
const branches: TaskBranchManager = {
  async prepare(taskId) {
    return {
      taskId,
      path: `/fixture/${taskId}`,
      branch: `agile/${taskId}`,
      baseCommit: base,
    };
  },
  async refresh() {
    throw Error("Unexpected base refresh");
  },
  async restoreChanges() {},
  async commitChanges() {
    return base;
  },
  async assertCommit() {},
  async assertReviewReady() {},
  async status() {
    return "";
  },
};

/** Scripts a full accepted flow with usage isolated by Issue and role. */
function scripts(ids: string[]) {
  return {
    attempts: ids.flatMap((taskId) =>
      (["scout", "implement", "review"] as const).map((role) => ({
        taskId,
        role,
        retryIndex: 0,
        expect: {
          model:
            role === "scout" ? "luna" : role === "implement" ? "terra" : "sol",
          effort: role === "implement" ? "medium" : "high",
        },
        deliveries: [
          {
            nextCursor: "1",
            event: {
              type: "attempt.usage_delta",
              eventId: `${taskId}-${role}-usage`,
              attemptId: "fixture",
              sequence: 1,
              occurredAt: time,
              inputTokens: Number(taskId.slice(6)),
              cachedInputTokens: 0,
              outputTokens: 1,
              reasoningOutputTokens: 0,
            },
          },
          {
            nextCursor: "2",
            event: {
              type: "attempt.output",
              eventId: `${taskId}-${role}-output`,
              attemptId: "fixture",
              sequence: 2,
              occurredAt: time,
              output:
                role === "scout"
                  ? {
                      kind: role,
                      summary: "Inspect file",
                      files: ["file.ts"],
                      tests: [],
                      risks: [],
                    }
                  : role === "implement"
                    ? {
                        kind: role,
                        commitSha: base,
                        validation: ["fixture"],
                        risks: [],
                        limitations: [],
                      }
                    : {
                        kind: role,
                        decision: "accepted",
                        findings: [],
                        remainingGaps: [],
                      },
            },
          },
          {
            nextCursor: "3",
            event: {
              type: "attempt.completed",
              eventId: `${taskId}-${role}-done`,
              attemptId: "fixture",
              sequence: 3,
              occurredAt: time,
            },
          },
        ],
      })),
    ),
  };
}

/** Connects task gates to the real pool and runner using deterministic Fake Harness deliveries. */
function fixture(scopes: string[][], concurrency = 2) {
  const remote = memoryPlan(scopes);
  const ids = scopes.map((_, index) => `issue-${41 + index}`);
  const fake = createFakeHarness(scripts(ids));
  const entered = ids.map(() => barrier());
  const release = ids.map(() => barrier());
  const completed = ids.map(() => barrier());
  const started: string[] = [];
  const cancelled: string[] = [];
  const attempts = new Map<string, string>();
  let failedTask: string | undefined;
  let failure: Error = Error("Private backend diagnostic");
  const errors: AgileError[] = [];
  const diagnostics: string[] = [];
  let cleanupFails = false;
  const pool = new GitHubTaskPool({
    store: remote.store,
    branches,
    concurrency,
    async logError(error) {
      errors.push(error);
    },
    diagnostic(message) {
      diagnostics.push(message);
    },
    advisor: createStaticModelAdvisor(),
    harness: {
      async step(request: HarnessStepRequest) {
        const index = ids.indexOf(request.attempt.taskId);
        attempts.set(request.attempt.attemptId, request.attempt.taskId);
        if (request.attempt.role === "scout" && !request.backendCursor) {
          started.push(request.attempt.taskId);
          entered[index]?.release();
          await release[index]?.promise;
          if (request.attempt.taskId === failedTask) throw failure;
        }
        return fake.harness.step(request);
      },
      async cancel(attemptId) {
        const id = attempts.get(attemptId);
        if (id) {
          cancelled.push(id);
          release[ids.indexOf(id)]?.release();
        }
        if (cleanupFails) throw Error("Private cleanup cause");
      },
    },
    publisher: {
      baseBranch: "main",
      async publish(input) {
        completed[ids.indexOf(input.task.id)]?.release();
        return {
          number: Number(input.task.id.slice(6)),
          url: `https://github.com/acme/test/pull/${input.task.id.slice(6)}`,
          state: "OPEN",
        };
      },
    },
    command: {
      async run(input) {
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            input.command[0] === "gh"
              ? JSON.stringify({
                  state: "OPEN",
                  baseRefName: "main",
                  headRefName: `agile/issue-${input.command[3]}`,
                  headRefOid: base,
                  mergeCommit: null,
                })
              : base,
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  return {
    ...remote,
    pool,
    fake,
    entered,
    release,
    completed,
    started,
    cancelled,
    errors,
    diagnostics,
    failCleanup() {
      cleanupFails = true;
    },
    fail(id: string, error = failure) {
      failedTask = id;
      failure = error;
    },
  };
}

test("eight task slots stay bounded and refill while unrelated Issues remain blocked", async () => {
  const f = fixture(
    Array.from({ length: 9 }, (_, index) => [`file-${index}.ts`]),
    8,
  );
  const stop = new AbortController();
  const run = f.pool.run(stop.signal).catch((error) => {
    if (!stop.signal.aborted) throw error;
  });
  try {
    await Promise.all(f.entered.slice(0, 8).map((gate) => gate.promise));
    expect(f.started).toHaveLength(8);
    expect(f.started).not.toContain("issue-49");
    f.release[7]?.release();
    await f.entered[8]?.promise;
    expect(f.started).toHaveLength(9);
    expect((await f.store.get(41)).execution?.phase).toBe("scouting");
    expect((await f.store.get(48)).execution?.phase).toBe("awaiting_merge");
  } finally {
    stop.abort();
    for (const gate of f.release) gate.release();
    await f.pool.cancel();
    await run;
  }
});

test("a worker that finishes during a remote read is excluded from that stale admission snapshot", async () => {
  const f = fixture([["a.ts"], ["b.ts"]]);
  const reading = barrier();
  const releaseRead = barrier();
  const read = f.api.read;
  let pause = false;
  f.api.read = async () => {
    const snapshot = await read();
    if (pause) {
      pause = false;
      reading.release();
      await releaseRead.promise;
    }
    return snapshot;
  };
  const stop = new AbortController();
  const run = f.pool.run(stop.signal).catch((error) => {
    if (!stop.signal.aborted) throw error;
  });
  try {
    await Promise.all([f.entered[0]?.promise, f.entered[1]?.promise]);
    pause = true;
    f.release[1]?.release();
    await reading.promise;
    f.release[0]?.release();
    await f.completed[0]?.promise;
    await f.pool.cancel("issue-41");
    releaseRead.release();
    // A fresh following read proves the stale admission round has fully finished.
    const fresh = barrier();
    f.api.read = async () => {
      const value = await read();
      fresh.release();
      return value;
    };
    await fresh.promise;
    expect(f.started).toEqual(["issue-41", "issue-42"]);
    expect((await f.store.get(41)).execution?.attempts).toHaveLength(3);
  } finally {
    releaseRead.release();
    stop.abort();
    await f.pool.cancel();
    await run;
  }
});

test("worker failures retain a safe code, phase and attempt identity without exposing the cause", async () => {
  const f = fixture([["a.ts"]]);
  f.fail(
    "issue-41",
    new AgileError({
      code: "GITHUB_READ_FAILED",
      category: "infra",
      component: "github-state",
      retryable: true,
      message:
        "GitHub task read failed; check connection and repository access",
      cause: Error("Authorization: secret-token"),
    }),
  );
  const run = f.pool.run(new AbortController().signal, true);
  await f.entered[0]?.promise;
  f.release[0]?.release();
  await run;
  const record = (await f.store.get(41)).execution;
  expect(f.errors).toHaveLength(1);
  expect(f.errors[0]).toMatchObject({
    code: "GITHUB_READ_FAILED",
    taskId: "issue-41",
    attemptId: record?.attempts[0]?.descriptor.attemptId,
  });
  expect(record?.failure).toContain("GITHUB_READ_FAILED");
  expect(record?.failure).toContain("scouting");
  expect(record?.failure).not.toContain("secret-token");
  expect(record?.phase).toBe("needs_replan");
});

test("cleanup failure retains the original diagnostic and attributed ownership failure", async () => {
  const f = fixture([["a.ts"]]);
  f.fail("issue-41");
  f.failCleanup();
  const run = f.pool
    .run(new AbortController().signal, true)
    .catch((error: unknown) => error);
  await f.entered[0]?.promise;
  f.release[0]?.release();
  expect(await run).toMatchObject({
    code: "TASK_CLEANUP_UNCONFIRMED",
    taskId: "issue-41",
  });
  expect(f.errors.map((error) => error.code)).toEqual([
    "TASK_EXECUTION_FAILED",
    "TASK_CLEANUP_UNCONFIRMED",
  ]);
  expect(
    f.errors.every(
      (error) => error.attemptId && error.message.includes("scouting"),
    ),
  ).toBe(true);
  expect(f.errors.map((error) => error.message).join(" ")).not.toContain(
    "Private",
  );
});

test("two slots overlap and refill while a slow Issue stays active without duplicate dispatch or mixed usage", async () => {
  const f = fixture([["a.ts"], ["b.ts"], ["c.ts"]]);
  const stop = new AbortController();
  const run = f.pool.run(stop.signal).catch((error) => {
    if (!stop.signal.aborted) throw error;
  });
  try {
    await Promise.all([f.entered[0]?.promise, f.entered[1]?.promise]);
    expect(f.started).toEqual(["issue-41", "issue-42"]);
    f.release[1]?.release();
    await f.entered[2]?.promise;
    expect(f.started).toEqual(["issue-41", "issue-42", "issue-43"]);
    expect((await f.store.get(41)).execution?.phase).toBe("scouting");
    expect((await f.store.get(42)).execution?.phase).toBe("awaiting_merge");
    f.release[2]?.release();
    await f.completed[2]?.promise;
    f.release[0]?.release();
    await f.completed[0]?.promise;
    f.fake.assertComplete();
    for (const issue of [41, 42, 43]) {
      const task = await f.store.get(issue);
      expect(
        task.execution?.attempts.every(
          (attempt) =>
            attempt.descriptor.taskId === `issue-${issue}` &&
            attempt.usage.inputTokens === issue,
        ),
      ).toBe(true);
    }
  } finally {
    stop.abort();
    await f.pool.cancel();
    await run;
  }
});

test("overlapping scopes and concurrency one serialize execution", async () => {
  for (const [scopes, concurrency] of [
    [["src/auth/"], ["src/auth/user.ts"]],
    [["a.ts"], ["b.ts"]],
  ].map((scopes, index) => [scopes, index === 0 ? 2 : 1] as const)) {
    const f = fixture(scopes, concurrency);
    const stop = new AbortController();
    const run = f.pool.run(stop.signal).catch((error) => {
      if (!stop.signal.aborted) throw error;
    });
    try {
      await f.entered[0]?.promise;
      expect(f.started).toEqual(["issue-41"]);
      f.release[0]?.release();
      await f.entered[1]?.promise;
      expect((await f.store.get(41)).execution?.phase).toBe("awaiting_merge");
      f.release[1]?.release();
      await f.completed[1]?.promise;
    } finally {
      stop.abort();
      await f.pool.cancel();
      await run;
    }
  }
});

test("cancellation and task-local exceptions preserve sibling execution and persist attention", async () => {
  for (const cancel of [true, false]) {
    const f = fixture([["a.ts"], ["b.ts"]]);
    if (!cancel) f.fail("issue-41");
    const stop = new AbortController();
    const run = f.pool.run(stop.signal).catch((error) => {
      if (!stop.signal.aborted) throw error;
    });
    try {
      await Promise.all([f.entered[0]?.promise, f.entered[1]?.promise]);
      if (cancel) {
        const cancelling = f.pool.cancel("issue-41");
        f.release[0]?.release();
        await cancelling;
      } else f.release[0]?.release();
      f.release[1]?.release();
      await f.completed[1]?.promise;
      expect(f.cancelled).not.toContain("issue-42");
      const failed = await f.store.get(41);
      expect(failed.execution?.phase).toBe("needs_replan");
      expect(failed.execution?.failure).not.toContain(
        "Private backend diagnostic",
      );
    } finally {
      stop.abort();
      await f.pool.cancel();
      await run;
    }
  }
});

for (const mode of [
  "complete",
  "omit-active",
  "omit-sibling",
  "changed-sibling",
  "read-failure",
  "withdraw-approval",
  "closed",
] as const) {
  test(`authority confirmation during continuous polling: ${mode}`, async () => {
    const f = fixture(
      ["omit-sibling", "changed-sibling"].includes(mode)
        ? [["a.ts"], ["b.ts"]]
        : [["a.ts"]],
      1,
    );
    const issue = f.issues[0];
    const entered = f.entered[0];
    if (!issue || !entered) throw Error("Missing first worker fixture");
    const stop = new AbortController();
    const setTimer = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(
      Object.assign(
        (...[handler, delay, ...args]: Parameters<typeof setTimeout>) =>
          setTimer(handler, delay === 30_000 ? 2 : delay, ...args),
        { __promisify__: setTimer.__promisify__ },
      ) as typeof setTimeout,
    );
    const apiRead = f.api.read;
    const apiGet = f.api.get;
    let failRead = false;
    let loopFailure: unknown;
    f.api.get = async (...args) => {
      if (failRead) {
        failRead = false;
        throw Error("private transport detail");
      }
      return apiGet(...args);
    };
    let injected = false;
    f.api.read = async () => {
      const snapshot = await apiRead();
      if (injected || f.started.length === 0) return snapshot;
      injected = true;
      setTimer(() => f.release[0]?.release(), 5);
      if (mode === "read-failure") {
        failRead = true;
        return [];
      }
      if (mode === "omit-active") return [];
      if (mode === "omit-sibling")
        return snapshot.filter((issue) => issue.number === 41);
      if (mode === "changed-sibling") {
        const sibling = f.issues[1];
        if (!sibling) throw Error("Missing plan sibling");
        sibling.body = sibling.body.replaceAll(
          "Wrong answer",
          "Changed requirement",
        );
        return apiRead();
      }
      if (mode === "withdraw-approval") {
        issue.comments = issue.comments.filter(
          (comment) => comment.author?.login !== "owner",
        );
        return apiRead();
      }
      if (mode === "closed") {
        issue.state = "CLOSED";
        return apiRead();
      }
      return snapshot;
    };
    const run = f.pool.run(stop.signal).catch(async (error) => {
      if (!stop.signal.aborted) {
        if (mode !== "read-failure") throw error;
        loopFailure = error;
        await f.pool.cancel().catch(() => undefined);
      }
    });
    try {
      await entered.promise;
      let task = await f.store.get(41);
      for (let i = 0; i < 100; i++) {
        await Bun.sleep(2);
        task = await f.store.get(41);
        if (
          task.task.status === "awaiting_merge" ||
          (f.cancelled.length > 0 && task.execution?.phase === "needs_replan")
        )
          break;
      }
      const shouldCancel =
        mode === "withdraw-approval" ||
        mode === "closed" ||
        mode === "changed-sibling" ||
        mode === "read-failure";
      expect(f.cancelled.length > 0).toBe(shouldCancel);
      if (!shouldCancel) expect(task.task.status).toBe("awaiting_merge");
      else
        expect(task.execution?.failure).toContain(
          mode === "closed"
            ? "Issue is closed"
            : mode === "read-failure"
              ? "GITHUB_AUTHORITY_UNCONFIRMED"
              : mode === "changed-sibling"
                ? "Remote plan is incomplete"
                : "Trusted approval is missing or withdrawn",
        );
    } finally {
      stop.abort();
      for (const gate of f.release) gate.release();
      await f.pool.cancel().catch((error) => {
        if (mode !== "read-failure") throw error;
      });
      await run;
      timer.mockRestore();
      if (mode === "read-failure")
        expect(loopFailure).toMatchObject({
          code: "GITHUB_AUTHORITY_UNCONFIRMED",
          taskId: "issue-41",
        });
    }
  });
}

/** Builds the sanitized transient read failure raised by the remote reader. */
function transientReadFailure(): AgileError {
  return new AgileError({
    code: "GITHUB_READ_FAILED",
    category: "infra",
    component: "github-state",
    retryable: true,
    message:
      "GitHub task read failed (Issue list; HTTP 502); check connection, authentication and repository access",
  });
}

/** Compresses scheduler-scale waits to two milliseconds while recording each requested delay. */
function compressPollingTimers(): { delays: number[]; restore: () => void } {
  const setTimer = globalThis.setTimeout;
  const delays: number[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      (...[handler, delay, ...args]: Parameters<typeof setTimeout>) => {
        const wait = delay ?? 0;
        if (wait >= 30_000) {
          delays.push(wait);
          return setTimer(handler, 2, ...args);
        }
        return setTimer(handler, delay, ...args);
      },
      { __promisify__: setTimer.__promisify__ },
    ) as typeof setTimeout,
  );
  return { delays, restore: () => timer.mockRestore() };
}

/** Waits briefly in real time for an asynchronous scheduler condition to hold. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(2);
  expect(condition()).toBe(true);
}

/** Extracts the consecutive-failure counts from the daemon's poll warnings. */
function failureCounts(messages: string[]): string[] {
  return messages
    .map((message) => /consecutive failures: (\d+)/u.exec(message)?.[1])
    .filter((count): count is string => count !== undefined);
}

test("a retryable read failure during polling warns, backs off and keeps the run loop alive", async () => {
  const f = fixture([["a.ts"]]);
  const timers = compressPollingTimers();
  const apiRead = f.api.read;
  let injected = false;
  f.api.read = async () => {
    if (f.started.length > 0 && !injected) {
      injected = true;
      throw transientReadFailure();
    }
    return apiRead();
  };
  const stop = new AbortController();
  let settled = false;
  const run = f.pool.run(stop.signal).catch((error) => {
    if (!stop.signal.aborted) throw error;
  });
  const finished = run.finally(() => {
    settled = true;
  });
  try {
    await f.entered[0]?.promise;
    await until(() => failureCounts(f.diagnostics).length === 1);
    expect(f.diagnostics[0]).toContain("GITHUB_READ_FAILED");
    expect(f.diagnostics[0]).toContain("consecutive failures: 1");
    expect(f.diagnostics[0]).toContain("retrying in 30s");
    expect(timers.delays).toContain(30_000);
    expect(settled).toBe(false);
    f.release[0]?.release();
    await f.completed[0]?.promise;
    expect(settled).toBe(false);
    let task = await f.store.get(41);
    for (let i = 0; i < 100 && task.task.status !== "awaiting_merge"; i++) {
      await Bun.sleep(2);
      task = await f.store.get(41);
    }
    expect(task.task.status).toBe("awaiting_merge");
  } finally {
    stop.abort();
    for (const gate of f.release) gate.release();
    await f.pool.cancel().catch(() => undefined);
    await finished;
    timers.restore();
    expect(settled).toBe(true);
    expect(failureCounts(f.diagnostics)).toEqual(["1"]);
  }
});

test("backoff for consecutive retryable read failures doubles to a five-minute cap and resets after success", async () => {
  const f = fixture([["a.ts"]]);
  const timers = compressPollingTimers();
  const failOnCall = new Set([1, 2, 3, 4, 5, 6]);
  let calls = 0;
  f.api.read = async () => {
    calls++;
    if (failOnCall.has(calls)) throw transientReadFailure();
    return [];
  };
  const stop = new AbortController();
  const run = f.pool.run(stop.signal).catch((error) => {
    if (!stop.signal.aborted) throw error;
  });
  try {
    await until(() => failureCounts(f.diagnostics).length >= 6);
    expect(timers.delays.slice(0, 6)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
    expect(failureCounts(f.diagnostics)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    expect(f.diagnostics[5]).toContain("retrying in 300s");
    await until(() => timers.delays.length >= 7);
    failOnCall.add(calls + 1);
    await until(() => failureCounts(f.diagnostics).length >= 7);
    expect(failureCounts(f.diagnostics)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "1",
    ]);
  } finally {
    stop.abort();
    for (const gate of f.release) gate.release();
    await f.pool.cancel().catch(() => undefined);
    await run;
    timers.restore();
  }
});

test("a non-retryable read failure such as a 401 still terminates the run loop", async () => {
  const f = fixture([["a.ts"]]);
  f.api.read = async () => {
    throw new AgileError({
      code: "GITHUB_READ_FORBIDDEN",
      category: "infra",
      component: "github-state",
      retryable: false,
      message:
        "GitHub GraphQL task read failed (permission); check connection and repository access",
    });
  };
  const run = f.pool
    .run(new AbortController().signal)
    .catch((error: unknown) => error);
  expect(await run).toMatchObject({
    code: "GITHUB_READ_FORBIDDEN",
    retryable: false,
  });
  await f.pool.cancel().catch(() => undefined);
});
