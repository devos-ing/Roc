import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { TaskPublisher } from "../../src/github/pr-publisher";
import type {
  AgentHarness,
  HarnessEvent,
  HarnessStepRequest,
} from "../../src/harness/contracts";
import { createFakeHarness } from "../../src/harness/fake";
import { SchedulerDaemon } from "../../src/scheduler/daemon";
import { Scheduler } from "../../src/scheduler/scheduler";
import {
  type TaskHookRunner,
  TaskHookService,
  type TaskHookWorkspaceProvider,
  taskHookConfigHash,
} from "../../src/scheduler/task-hooks";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

const scoutOutput = {
  kind: "scout" as const,
  summary: "Found the scheduler boundary",
  files: ["src/scheduler/scheduler.ts"],
  tests: ["bun test"],
  risks: [],
};

const implementOutput = {
  kind: "implement" as const,
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  validation: ["bun test"],
  risks: [],
  limitations: [],
};

const reviewOutput = {
  kind: "review" as const,
  decision: "accepted" as const,
  findings: [],
  remainingGaps: [],
};

const rejectedReviewOutput = {
  kind: "review" as const,
  decision: "rejected" as const,
  findings: ["validation failed"],
  remainingGaps: ["follow-up fixes validation"],
};

function fakePublisher(
  calls: Array<{ taskId: string; branch: string }> = [],
): TaskPublisher {
  return {
    baseBranch: "main",
    async publish(input) {
      calls.push({
        taskId: input.task.id,
        branch: input.publication.branch,
      });
      return {
        number: calls.length,
        url: `https://example.test/pull/${calls.length}`,
        state: "OPEN",
      };
    },
  };
}

const inheritedContext = {
  threadId: "thread-C",
  anchorId: "anchor-C",
  sourceTaskId: "C",
  gitCommit: "cccccccccccccccccccccccccccccccccccccccc",
  summaryArtifact: "artifacts/C-summary.md",
};

function roleDeliveries(
  key: string,
  attemptId: string,
  output: Extract<HarnessEvent, { type: "attempt.output" }>["output"],
  usage?: Pick<
    Extract<HarnessEvent, { type: "attempt.usage_delta" }>,
    | "inputTokens"
    | "cachedInputTokens"
    | "outputTokens"
    | "reasoningOutputTokens"
  >,
) {
  return [
    {
      nextCursor: "1",
      event: {
        type: "attempt.started" as const,
        eventId: `${key}:started`,
        attemptId,
        sequence: 1,
        occurredAt: "2026-08-25T00:00:02.000Z",
        threadId: `thread-${key}`,
      },
    },
    ...(usage === undefined
      ? []
      : [
          {
            nextCursor: "2",
            event: {
              type: "attempt.usage_delta" as const,
              eventId: `${key}:usage`,
              attemptId,
              sequence: 2,
              occurredAt: "2026-08-25T00:00:03.000Z",
              ...usage,
            },
          },
        ]),
    {
      nextCursor: usage === undefined ? "2" : "3",
      event: {
        type: "attempt.output" as const,
        eventId: `${key}:output`,
        attemptId,
        sequence: usage === undefined ? 2 : 3,
        occurredAt:
          usage === undefined
            ? "2026-08-25T00:00:03.000Z"
            : "2026-08-25T00:00:04.000Z",
        output,
      },
    },
    {
      nextCursor: usage === undefined ? "3" : "4",
      event: {
        type: "attempt.completed" as const,
        eventId: `${key}:completed`,
        attemptId,
        sequence: usage === undefined ? 3 : 4,
        occurredAt:
          usage === undefined
            ? "2026-08-25T00:00:04.000Z"
            : "2026-08-25T00:00:05.000Z",
      },
    },
  ];
}

function infraFailureDelivery(
  key: string,
  attemptId: string,
  code: string,
  retryable: boolean,
) {
  return [
    {
      nextCursor: "1",
      event: {
        type: "attempt.failed_infra" as const,
        eventId: `${key}:failed`,
        attemptId,
        sequence: 1,
        occurredAt: "2026-08-25T00:00:02.000Z",
        code,
        message: "Fake infrastructure failure",
        retryable,
      },
    },
  ];
}

function setupAcceptedTask(
  finalReviewOutput: Extract<
    Extract<HarnessEvent, { type: "attempt.output" }>["output"],
    { kind: "review" }
  > = reviewOutput,
  hooks?: {
    prehook?: { command: string; args: string[]; timeoutSeconds: number };
    posthook?: { command: string; args: string[]; timeoutSeconds: number };
    runner: TaskHookRunner;
    workspacePath?: string;
    workspace?: TaskHookWorkspaceProvider;
  },
) {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
  planning.createCycle({
    id: "2026-W34",
    goal: "Prior context",
    nonGoals: [],
    tokenBudget: 50_000,
    ticketIds: ["C"],
  });
  planning.createTask({
    id: "C",
    cycleId: "2026-W34",
    title: "Prior task C",
    spec: {
      problem: "Prior task context",
      desiredOutcome: "Provide an immutable context anchor",
      scope: ["context"],
      nonGoals: [],
      acceptanceCriteria: ["context can be inherited"],
      validation: ["bun test"],
      dependencies: [],
      risk: "medium",
      contextCandidates: [],
      tokenCeiling: 5_000,
    },
    priority: 0,
    approvalRequired: false,
    approved: true,
  });
  planning.createCycle({
    id: "2026-W35",
    goal: "Run roles",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: ["T1"],
  });
  planning.createTask({
    id: "T1",
    cycleId: "2026-W35",
    title: "Run roles",
    spec: {
      problem: "No role pipeline",
      desiredOutcome: "Complete all roles",
      scope: ["scheduler"],
      nonGoals: [],
      acceptanceCriteria: ["task reaches done"],
      validation: ["bun test"],
      dependencies: [],
      risk: "medium",
      contextCandidates: [inheritedContext],
      tokenCeiling: 10_000,
      ...(hooks?.prehook === undefined ? {} : { prehook: hooks.prehook }),
      ...(hooks?.posthook === undefined ? {} : { posthook: hooks.posthook }),
    },
    priority: 0,
    approvalRequired: false,
    approved: true,
  });
  planning.transitionTask("T1", "ready", "T1:ready");
  db.query(`
    INSERT INTO contexts(id, thread_id, anchor_id, source_task_id, git_commit, summary_artifact)
    VALUES('context-C', $threadId, $anchorId, $sourceTaskId, $gitCommit, $summaryArtifact)
  `).run(inheritedContext);
  db.query("UPDATE tasks SET context_id = 'context-C' WHERE id = 'T1'").run();

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
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "T1",
        role: "scout",
        retryIndex: 0,
        expect: { model: "luna", effort: "high", contextRef: inheritedContext },
        deliveries: roleDeliveries("scout", "attempt-1", scoutOutput, {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        }),
      },
      {
        taskId: "T1",
        role: "implement",
        retryIndex: 0,
        expect: {
          model: "terra",
          effort: "high",
          contextRef: inheritedContext,
        },
        deliveries: roleDeliveries("implement", "attempt-2", implementOutput, {
          inputTokens: 20,
          cachedInputTokens: 4,
          outputTokens: 8,
          reasoningOutputTokens: 2,
        }),
      },
      {
        taskId: "T1",
        role: "review",
        retryIndex: 0,
        expect: { model: "sol", effort: "high", contextRef: inheritedContext },
        deliveries: roleDeliveries("review", "attempt-3", finalReviewOutput, {
          inputTokens: 5,
          cachedInputTokens: 1,
          outputTokens: 2,
          reasoningOutputTokens: 1,
        }),
      },
    ],
  });
  const requests: HarnessStepRequest[] = [];
  const harness: AgentHarness = {
    async step(input) {
      requests.push(input);
      return fake.harness.step(input);
    },
    cancel: (attemptId) => fake.harness.cancel(attemptId),
  };
  const taskHooks =
    hooks === undefined
      ? undefined
      : new TaskHookService(
          repo,
          hooks.workspace ?? {
            async prepare() {
              return { path: hooks.workspacePath ?? "/workspace/T1" };
            },
          },
          hooks.runner,
        );
  const publicationCalls: Array<{ taskId: string; branch: string }> = [];
  const publisher = fakePublisher(publicationCalls);
  const scheduler = new Scheduler(
    repo,
    harness,
    () => {},
    taskHooks,
    publisher,
  );
  return {
    db,
    repo,
    scheduler,
    fake,
    requests,
    taskHooks,
    publisher,
    publicationCalls,
  };
}

/** Creates a deterministic hook runner that records each workspace invocation. */
function scriptedHookRunner(
  outcomes: boolean[],
  calls: Array<{ command: string; cwd: string }>,
): TaskHookRunner {
  return {
    async run(input) {
      calls.push({ command: input.hook.command, cwd: input.cwd });
      const succeeded = outcomes.shift();
      if (succeeded === undefined) throw new Error("Unexpected hook execution");
      return {
        succeeded,
        exitCode: succeeded ? 0 : 1,
        timedOut: false,
        stdout: "ok\u0000",
        stderr: succeeded ? "" : "failure\u001b[31m",
      };
    },
    async stop() {},
  };
}

test("sealed delivery does not touch a closed database", async () => {
  const { db, repo, fake } = setupAcceptedTask();
  repo.claimNext();
  repo.beginNextAttempt();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seal = new AbortController();
  const reason = new Error("Scheduler session sealed");
  const scheduler = new Scheduler(repo, {
    async step(request) {
      const delivery = await fake.harness.step(request);
      entered.resolve();
      await release.promise;
      return delivery;
    },
    cancel: (id) => fake.harness.cancel(id),
  });
  const pending = scheduler.tick(undefined, seal.signal);
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    seal.abort(reason);
    db.close();
    release.resolve();
    expect(await outcome).toBe(reason);
  } finally {
    release.resolve();
    await outcome;
    db.close();
  }
});

test("sealed workspace rejection does not touch a closed database", async () => {
  const prehook = { command: "prepare-task", args: [], timeoutSeconds: 1 };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seal = new AbortController();
  const reason = new Error("Scheduler session sealed");
  const { db, repo, scheduler } = setupAcceptedTask(reviewOutput, {
    prehook,
    runner: scriptedHookRunner([], []),
    workspace: {
      async prepare() {
        entered.resolve();
        await release.promise;
        throw new Error("workspace unavailable");
      },
    },
  });
  repo.trustTaskHook("T1", "prehook", taskHookConfigHash(prehook));
  repo.claimNext();
  const pending = scheduler.tick(undefined, seal.signal);
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    seal.abort(reason);
    db.close();
    release.resolve();
    expect(await outcome).toBe(reason);
  } finally {
    release.resolve();
    await outcome;
    db.close();
  }
});

test("sealed hook runner result does not touch a closed database", async () => {
  const prehook = { command: "prepare-task", args: [], timeoutSeconds: 1 };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seal = new AbortController();
  const reason = new Error("Scheduler session sealed");
  const runner: TaskHookRunner = {
    async run() {
      entered.resolve();
      await release.promise;
      return {
        succeeded: true,
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
      };
    },
    async stop() {},
  };
  const { db, repo, scheduler } = setupAcceptedTask(reviewOutput, {
    prehook,
    runner,
  });
  repo.trustTaskHook("T1", "prehook", taskHookConfigHash(prehook));
  repo.claimNext();
  const pending = scheduler.tick(undefined, seal.signal);
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    seal.abort(reason);
    db.close();
    release.resolve();
    expect(await outcome).toBe(reason);
  } finally {
    release.resolve();
    await outcome;
    db.close();
  }
});

test("sealed publication resolution does not touch a closed database", async () => {
  const { db, repo, scheduler, fake } = setupAcceptedTask();
  for (
    let ticks = 0;
    ticks < 20 && repo.listPublishingTasks().length === 0;
    ticks += 1
  )
    await scheduler.tick();
  expect(repo.listPublishingTasks()).toHaveLength(1);

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seal = new AbortController();
  const reason = new Error("Scheduler session sealed");
  const lateScheduler = new Scheduler(repo, fake.harness, () => {}, undefined, {
    baseBranch: "main",
    async publish() {
      entered.resolve();
      await release.promise;
      return {
        number: 1,
        url: "https://example.test/pull/1",
        state: "OPEN",
      };
    },
  });
  const pending = lateScheduler.tick(undefined, seal.signal);
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    seal.abort(reason);
    db.close();
    release.resolve();
    expect(await outcome).toBe(reason);
  } finally {
    release.resolve();
    await outcome;
    db.close();
  }
});

test("sealed publication rejection does not touch a closed database", async () => {
  const { db, repo, scheduler, fake } = setupAcceptedTask();
  for (
    let ticks = 0;
    ticks < 20 && repo.listPublishingTasks().length === 0;
    ticks += 1
  )
    await scheduler.tick();
  expect(repo.listPublishingTasks()).toHaveLength(1);

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seal = new AbortController();
  const reason = new Error("Scheduler session sealed");
  const lateScheduler = new Scheduler(repo, fake.harness, () => {}, undefined, {
    baseBranch: "main",
    async publish() {
      entered.resolve();
      await release.promise;
      throw new Error("publisher unavailable");
    },
  });
  const pending = lateScheduler.tick(undefined, seal.signal);
  const outcome = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    seal.abort(reason);
    db.close();
    release.resolve();
    expect(await outcome).toBe(reason);
  } finally {
    release.resolve();
    await outcome;
    db.close();
  }
});

test("Effect daemon completes the accepted Fake Harness flow", async () => {
  const { db, repo, scheduler, publisher } = setupAcceptedTask();
  const stop = new AbortController();
  const publish = publisher.publish.bind(publisher);
  publisher.publish = async (input) => {
    const receipt = await publish(input);
    stop.abort();
    return receipt;
  };
  const daemon = new SchedulerDaemon(scheduler, repo, {
    ownerId: "effect-vertical",
  });
  try {
    await Effect.runPromise(
      daemon.runEffect({ stop: stop.signal, async cancel() {} }),
    );
    const task = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM tasks WHERE id = ?",
      )
      .get("T1");
    expect(task?.status).toBe("done");
    const lease = db
      .query<{ owner_id: string }, []>(
        "SELECT owner_id FROM scheduler_lease WHERE lease_key = 'scheduler'",
      )
      .get();
    expect(lease).toBeNull();
  } finally {
    stop.abort();
    db.close();
  }
});

test("runs Scout, Implement, Review, and publication to done", async () => {
  const { db, repo, scheduler, fake, requests, publicationCalls } =
    setupAcceptedTask();
  try {
    await scheduler.runUntilIdle(40);
    expect(repo.inspectTask("T1")).toMatchObject({ status: "done" });
    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", model: "luna", effort: "high", status: "succeeded" },
      {
        role: "implement",
        model: "terra",
        effort: "high",
        status: "succeeded",
      },
      { role: "review", model: "sol", effort: "high", status: "succeeded" },
    ]);
    expect(repo.listReviews("T1")).toMatchObject([{ decision: "accepted" }]);
    expect(repo.getTaskPublication("T1")).toMatchObject({
      status: "published",
      branch: "agile/T1",
      pullRequestNumber: 1,
    });
    expect(publicationCalls).toEqual([{ taskId: "T1", branch: "agile/T1" }]);
    const reviewRequest = requests.find(
      (request) => request.attempt.role === "review",
    );
    expect(reviewRequest?.input).toEqual({
      role: "review",
      ticket: expect.objectContaining({ id: "T1" }),
      scout: scoutOutput,
      implementation: implementOutput,
    });
    expect(
      requests.every(
        (request) => request.attempt.contextRef?.sourceTaskId === "C",
      ),
    ).toBe(true);
    expect(JSON.stringify(reviewRequest)).not.toContain("thread-implement");
    expect(repo.inspect()).toMatchObject({
      cycles: [
        {
          id: "2026-W34",
          actual: {
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
        },
        {
          id: "2026-W35",
          actual: {
            inputTokens: 35,
            cachedInputTokens: 7,
            outputTokens: 14,
            reasoningOutputTokens: 4,
          },
        },
      ],
      tasks: [
        { id: "C", roles: [], attempts: [] },
        {
          id: "T1",
          actual: {
            inputTokens: 35,
            cachedInputTokens: 7,
            outputTokens: 14,
            reasoningOutputTokens: 4,
          },
          roles: [
            {
              role: "scout",
              actual: {
                inputTokens: 10,
                cachedInputTokens: 2,
                outputTokens: 4,
                reasoningOutputTokens: 1,
              },
            },
            {
              role: "implement",
              actual: {
                inputTokens: 20,
                cachedInputTokens: 4,
                outputTokens: 8,
                reasoningOutputTokens: 2,
              },
            },
            {
              role: "review",
              actual: {
                inputTokens: 5,
                cachedInputTokens: 1,
                outputTokens: 2,
                reasoningOutputTokens: 1,
              },
            },
          ],
          attempts: [
            {
              id: "attempt-1",
              inputTokens: 10,
              cachedInputTokens: 2,
              outputTokens: 4,
              reasoningOutputTokens: 1,
            },
            {
              id: "attempt-2",
              inputTokens: 20,
              cachedInputTokens: 4,
              outputTokens: 8,
              reasoningOutputTokens: 2,
            },
            {
              id: "attempt-3",
              inputTokens: 5,
              cachedInputTokens: 1,
              outputTokens: 2,
              reasoningOutputTokens: 1,
            },
          ],
        },
      ],
    });
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});

test("reconciles from the committed cursor after a post-commit crash", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "agile-agents-scheduler-crash-"),
  );
  const databasePath = join(directory, "scheduler.db");
  const db = openDatabase(databasePath);
  let reopened: ReturnType<typeof openDatabase> | undefined;
  try {
    const planning = new PlanningRepository(
      db,
      () => "2026-08-25T00:00:00.000Z",
    );
    planning.createCycle({
      id: "2026-W35",
      goal: "Reconcile",
      nonGoals: [],
      tokenBudget: 100_000,
      ticketIds: ["T1"],
    });
    planning.createTask({
      id: "T1",
      cycleId: "2026-W35",
      title: "Reconcile after a crash",
      spec: {
        problem: "A scheduler can crash after commit",
        desiredOutcome: "Resume from the durable cursor",
        scope: ["scheduler"],
        nonGoals: [],
        acceptanceCriteria: ["the event is not redelivered"],
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
      () => "2026-08-25T00:00:01.000Z",
      (kind) => {
        const count = (counters[kind] ?? 0) + 1;
        counters[kind] = count;
        return `${kind}-${count}`;
      },
    );
    const event = {
      type: "attempt.started" as const,
      eventId: "scout:started",
      attemptId: "attempt-1",
      sequence: 1,
      occurredAt: "2026-08-25T00:00:02.000Z",
      threadId: "thread-scout",
    };
    const scheduler = new Scheduler(
      repo,
      {
        async step() {
          return { kind: "event", nextCursor: "cursor-1", event };
        },
        async cancel() {},
      },
      (point) => {
        if (point === "after_delivery_commit")
          throw new Error(`crash:${point}`);
      },
    );

    expect(await scheduler.tick()).toEqual({
      kind: "task_claimed",
      taskId: "T1",
    });
    expect(await scheduler.tick()).toEqual({
      kind: "attempt_started",
      attemptId: "attempt-1",
    });
    await expect(scheduler.tick()).rejects.toThrow(
      "crash:after_delivery_commit",
    );
    db.close();

    reopened = openDatabase(databasePath);
    const resumedRepo = new OrchestrationRepository(reopened);
    const resumedRequests: HarnessStepRequest[] = [];
    const resumed = new Scheduler(resumedRepo, {
      async step(request) {
        resumedRequests.push(request);
        return { kind: "idle" };
      },
      async cancel() {},
    });

    expect(await resumed.tick()).toEqual({ kind: "idle" });
    expect(resumedRequests).toMatchObject([
      {
        mode: "reconcile",
        backendCursor: "cursor-1",
        attempt: { attemptId: "attempt-1" },
      },
    ]);
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
        .get(event.attemptId),
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

test("rejected Review creates one draft follow-up without rerunning the original task", async () => {
  const { db, repo, scheduler, fake } = setupAcceptedTask(rejectedReviewOutput);
  try {
    await scheduler.runUntilIdle(40);

    expect(repo.inspectTask("T1")).toMatchObject({ status: "rejected" });
    expect(repo.listReviews("T1")).toMatchObject([
      {
        decision: "rejected",
        findings: ["validation failed"],
      },
    ]);
    expect(repo.listTasksByRoot("T1")).toMatchObject([
      { id: "T1", status: "rejected" },
      {
        id: "task-1",
        status: "draft",
        parentTaskId: "T1",
        rootTaskId: "T1",
        approved: false,
      },
    ]);
    expect(repo.listAttempts("T1")).toHaveLength(3);
    expect(repo.listAttempts("task-1")).toEqual([]);
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});

test("caps retryable Scout infrastructure failures and upgrades only the final retry", async () => {
  const { db, repo } = setupAcceptedTask();
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "T1",
        role: "scout",
        retryIndex: 0,
        expect: { model: "luna", effort: "high", contextRef: inheritedContext },
        deliveries: infraFailureDelivery(
          "scout-0",
          "attempt-1",
          "backend_unavailable",
          true,
        ),
      },
      {
        taskId: "T1",
        role: "scout",
        retryIndex: 1,
        expect: { model: "luna", effort: "high", contextRef: inheritedContext },
        deliveries: infraFailureDelivery(
          "scout-1",
          "attempt-2",
          "backend_unavailable",
          true,
        ),
      },
      {
        taskId: "T1",
        role: "scout",
        retryIndex: 2,
        expect: {
          model: "terra",
          effort: "high",
          contextRef: inheritedContext,
        },
        deliveries: infraFailureDelivery(
          "scout-2",
          "attempt-3",
          "backend_unavailable",
          true,
        ),
      },
    ],
  });
  const scheduler = new Scheduler(
    repo,
    fake.harness,
    () => {},
    undefined,
    fakePublisher(),
  );
  try {
    await scheduler.runUntilIdle(12);

    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", retryIndex: 0, model: "luna", status: "failed_infra" },
      { role: "scout", retryIndex: 1, model: "luna", status: "failed_infra" },
      { role: "scout", retryIndex: 2, model: "terra", status: "failed_infra" },
    ]);
    expect(repo.inspectTask("T1")).toMatchObject({ status: "failed_infra" });
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});

test("retries only a failed Implement role and persists both routing rationales", async () => {
  const { db, repo } = setupAcceptedTask();
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "T1",
        role: "scout",
        retryIndex: 0,
        expect: { model: "luna", effort: "high", contextRef: inheritedContext },
        deliveries: roleDeliveries("scout", "attempt-1", scoutOutput),
      },
      {
        taskId: "T1",
        role: "implement",
        retryIndex: 0,
        expect: {
          model: "terra",
          effort: "high",
          contextRef: inheritedContext,
        },
        deliveries: infraFailureDelivery(
          "implement-0",
          "attempt-2",
          "backend_unavailable",
          true,
        ),
      },
      {
        taskId: "T1",
        role: "implement",
        retryIndex: 1,
        expect: {
          model: "terra",
          effort: "high",
          contextRef: inheritedContext,
        },
        deliveries: roleDeliveries("implement-1", "attempt-3", implementOutput),
      },
      {
        taskId: "T1",
        role: "review",
        retryIndex: 0,
        expect: { model: "sol", effort: "high", contextRef: inheritedContext },
        deliveries: roleDeliveries("review", "attempt-4", reviewOutput),
      },
    ],
  });
  const scheduler = new Scheduler(
    repo,
    fake.harness,
    () => {},
    undefined,
    fakePublisher(),
  );
  try {
    await scheduler.runUntilIdle(30);

    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", retryIndex: 0, model: "luna", status: "succeeded" },
      {
        role: "implement",
        retryIndex: 0,
        model: "terra",
        status: "failed_infra",
      },
      { role: "implement", retryIndex: 1, model: "terra", status: "succeeded" },
      { role: "review", retryIndex: 0, model: "sol", status: "succeeded" },
    ]);
    expect(
      repo.listAttempts("T1").filter((attempt) => attempt.role === "scout"),
    ).toHaveLength(1);
    expect(
      repo.inspect().tasks.find((task) => task.id === "T1")?.modelDecisions,
    ).toMatchObject([
      {
        id: "decision-1",
        role: "scout",
        model: "luna",
        rationale: ["scout baseline", "medium risk"],
      },
      {
        id: "decision-2",
        role: "implement",
        model: "terra",
        rationale: ["implement baseline", "medium risk"],
      },
      {
        id: "decision-3",
        role: "implement",
        model: "terra",
        rationale: ["implement retry 1", "model retained"],
      },
      {
        id: "decision-4",
        role: "review",
        model: "sol",
        rationale: ["review baseline", "medium risk"],
      },
    ]);
    expect(repo.inspectTask("T1")).toEqual({ id: "T1", status: "done" });
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});

test("retries a model-unavailable Scout with Terra immediately", async () => {
  const { db, repo } = setupAcceptedTask();
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "T1",
        role: "scout",
        retryIndex: 0,
        expect: { model: "luna", effort: "high", contextRef: inheritedContext },
        deliveries: infraFailureDelivery(
          "scout-0",
          "attempt-1",
          "model_unavailable",
          true,
        ),
      },
      {
        taskId: "T1",
        role: "scout",
        retryIndex: 1,
        expect: {
          model: "terra",
          effort: "high",
          contextRef: inheritedContext,
        },
        deliveries: infraFailureDelivery(
          "scout-1",
          "attempt-2",
          "backend_unavailable",
          false,
        ),
      },
    ],
  });
  const scheduler = new Scheduler(repo, fake.harness);
  try {
    await scheduler.runUntilIdle(8);

    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", retryIndex: 0, model: "luna", status: "failed_infra" },
      { role: "scout", retryIndex: 1, model: "terra", status: "failed_infra" },
    ]);
    expect(repo.inspectTask("T1")).toMatchObject({ status: "failed_infra" });
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});

test("terminalizes a non-retryable task failure and continues with the next task", async () => {
  const { db, repo } = setupAcceptedTask();
  const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
  planning.createTask({
    id: "T2",
    cycleId: "2026-W35",
    title: "Continue after T1",
    spec: {
      problem: "A prior task failed",
      desiredOutcome: "The next task still runs",
      scope: ["scheduler"],
      nonGoals: [],
      acceptanceCriteria: ["T2 reaches done"],
      validation: ["bun test"],
      dependencies: [],
      risk: "medium",
      contextCandidates: [],
      tokenCeiling: 10_000,
    },
    priority: 1,
    approvalRequired: false,
    approved: true,
  });
  planning.transitionTask("T2", "ready", "T2:ready");
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "T1",
        role: "scout",
        retryIndex: 0,
        expect: { model: "luna", effort: "high", contextRef: inheritedContext },
        deliveries: infraFailureDelivery(
          "scout-0",
          "attempt-1",
          "backend_unavailable",
          false,
        ),
      },
      {
        taskId: "T2",
        role: "scout",
        retryIndex: 0,
        expect: { model: "luna", effort: "high" },
        deliveries: roleDeliveries("T2-scout", "attempt-2", scoutOutput),
      },
      {
        taskId: "T2",
        role: "implement",
        retryIndex: 0,
        expect: { model: "terra", effort: "high" },
        deliveries: roleDeliveries(
          "T2-implement",
          "attempt-3",
          implementOutput,
        ),
      },
      {
        taskId: "T2",
        role: "review",
        retryIndex: 0,
        expect: { model: "sol", effort: "high" },
        deliveries: roleDeliveries("T2-review", "attempt-4", reviewOutput),
      },
    ],
  });
  const scheduler = new Scheduler(
    repo,
    fake.harness,
    () => {},
    undefined,
    fakePublisher(),
  );
  try {
    await scheduler.runUntilIdle(20);

    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", retryIndex: 0, model: "luna", status: "failed_infra" },
    ]);
    expect(repo.inspectTask("T1")).toMatchObject({ status: "failed_infra" });
    expect(repo.inspectTask("T2")).toMatchObject({ status: "done" });
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});

test("trusted prehook runs once in the task workspace before Scout and survives restart", async () => {
  const calls: Array<{ command: string; cwd: string }> = [];
  const prehook = { command: "prepare-task", args: [], timeoutSeconds: 1 };
  const { db, repo, scheduler, fake, requests, taskHooks } = setupAcceptedTask(
    reviewOutput,
    {
      prehook,
      runner: scriptedHookRunner([true], calls),
      workspacePath: "/isolated/T1",
    },
  );
  try {
    await scheduler.runUntilIdle(2);
    expect(calls).toEqual([]);
    expect(requests).toEqual([]);

    repo.trustTaskHook("T1", "prehook", taskHookConfigHash(prehook));
    await scheduler.runUntilIdle(40);

    expect(calls).toEqual([{ command: "prepare-task", cwd: "/isolated/T1" }]);
    expect(requests[0]?.attempt.role).toBe("scout");
    expect(repo.getTaskHook("T1", "prehook")).toMatchObject({
      status: "succeeded",
      attempts: 1,
      workspacePath: "/isolated/T1",
    });
    expect(repo.inspectTask("T1")).toMatchObject({ status: "done" });
    expect(() => fake.assertComplete()).not.toThrow();

    const restarted = new Scheduler(repo, fake.harness, () => {}, taskHooks);
    expect((await restarted.tick()).kind).toBe("idle");
    expect(calls).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("prehook retries three times, fails the task without Scout, then runs its posthook", async () => {
  const calls: Array<{ command: string; cwd: string }> = [];
  const prehook = { command: "fail-pre", args: [], timeoutSeconds: 1 };
  const posthook = { command: "finish-post", args: [], timeoutSeconds: 1 };
  const { db, repo, scheduler, requests } = setupAcceptedTask(reviewOutput, {
    prehook,
    posthook,
    runner: scriptedHookRunner([false, false, false, true], calls),
  });
  try {
    repo.trustTaskHook("T1", "prehook", taskHookConfigHash(prehook));
    repo.trustTaskHook("T1", "posthook", taskHookConfigHash(posthook));

    await scheduler.runUntilIdle(12);

    expect(repo.inspectTask("T1")).toMatchObject({ status: "failed_infra" });
    expect(requests).toEqual([]);
    expect(calls.map((call) => call.command)).toEqual([
      "fail-pre",
      "fail-pre",
      "fail-pre",
      "finish-post",
    ]);
    expect(repo.getTaskHook("T1", "prehook")).toMatchObject({
      status: "failed",
      attempts: 3,
    });
    expect(repo.getTaskHook("T1", "posthook")).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
  } finally {
    db.close();
  }
});

test("a task spec change invalidates prehook trust before it can spawn", async () => {
  const calls: Array<{ command: string; cwd: string }> = [];
  const original = { command: "prepare-original", args: [], timeoutSeconds: 1 };
  const replacement = {
    command: "prepare-replacement",
    args: [],
    timeoutSeconds: 1,
  };
  const { db, repo, scheduler, requests } = setupAcceptedTask(reviewOutput, {
    prehook: original,
    runner: scriptedHookRunner([true], calls),
  });
  try {
    repo.trustTaskHook("T1", "prehook", taskHookConfigHash(original));
    const task = repo.getTask("T1");
    if (task === undefined) throw new Error("Expected T1");
    db.query("UPDATE tasks SET spec_json = ? WHERE id = 'T1'").run(
      JSON.stringify({ ...task.spec, prehook: replacement }),
    );

    await scheduler.runUntilIdle(2);

    expect(calls).toEqual([]);
    expect(requests).toEqual([]);
    expect(repo.getTaskHook("T1", "prehook")).toMatchObject({
      configHash: taskHookConfigHash(original),
      trustedHash: taskHookConfigHash(original),
    });
  } finally {
    db.close();
  }
});

test("posthook failure returns an accepted task to replanning before publication", async () => {
  const calls: Array<{ command: string; cwd: string }> = [];
  const posthook = { command: "fail-post", args: [], timeoutSeconds: 1 };
  const { db, repo, scheduler } = setupAcceptedTask(reviewOutput, {
    posthook,
    runner: scriptedHookRunner([false, false, false], calls),
  });
  try {
    repo.trustTaskHook("T1", "posthook", taskHookConfigHash(posthook));

    await scheduler.runUntilIdle(40);

    expect(repo.inspectTask("T1")).toMatchObject({ status: "needs_replan" });
    expect(calls).toHaveLength(3);
    expect(
      db
        .query<{ commit_sha: string }, []>(`
          SELECT json_extract(payload_json, '$.output.commitSha') AS commit_sha
          FROM events
          WHERE task_id = 'T1' AND type = 'attempt.output'
            AND json_extract(payload_json, '$.output.kind') = 'implement'
        `)
        .get()?.commit_sha,
    ).toBe(implementOutput.commitSha);
    expect(repo.getTaskHook("T1", "posthook")).toMatchObject({
      status: "failed",
      attempts: 3,
    });
  } finally {
    db.close();
  }
});
