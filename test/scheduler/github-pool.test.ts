import { expect, test } from "bun:test";
import type { HarnessStepRequest } from "../../src/harness/contracts";
import { createFakeHarness } from "../../src/harness/fake";
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
          effort: "high",
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
function fixture(scopes: string[][], concurrency: 1 | 2 = 2) {
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
  const pool = new GitHubTaskPool({
    store: remote.store,
    branches,
    concurrency,
    advisor: createStaticModelAdvisor(),
    harness: {
      async step(request: HarnessStepRequest) {
        const index = ids.indexOf(request.attempt.taskId);
        attempts.set(request.attempt.attemptId, request.attempt.taskId);
        if (request.attempt.role === "scout" && !request.backendCursor) {
          started.push(request.attempt.taskId);
          entered[index]?.release();
          await release[index]?.promise;
          if (request.attempt.taskId === failedTask)
            throw Error("Private backend diagnostic");
        }
        return fake.harness.step(request);
      },
      async cancel(attemptId) {
        const id = attempts.get(attemptId);
        if (id) {
          cancelled.push(id);
          release[ids.indexOf(id)]?.release();
        }
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
    fail(id: string) {
      failedTask = id;
    },
  };
}

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
