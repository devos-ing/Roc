import { expect, test } from "bun:test";
import type { BacklogManifest } from "../../src/domain/schemas";
import { createFakeHarness } from "../../src/harness/fake";
import { Scheduler } from "../../src/scheduler/scheduler";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

function setup() {
  const db = openDatabase(":memory:");
  const manifest: BacklogManifest = {
    cycleId: "2026-W37",
    goal: "Run independent work concurrently",
    tasks: ["A", "B", "C", "D"].map((id, priority) => ({
      id,
      title: id,
      priority,
      spec: {
        problem: "Independent work waits",
        desiredOutcome: "Tasks progress independently",
        scope: ["scheduler"],
        nonGoals: [],
        acceptanceCriteria: ["Finish safely"],
        validation: ["bun test"],
        dependencies: id === "C" ? ["A"] : [],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 1000,
      },
    })),
  };
  new PlanningRepository(db).importBacklog(manifest);
  const repo = new OrchestrationRepository(db);
  const fake = createFakeHarness({
    attempts: manifest.tasks.flatMap(({ id }) =>
      (["scout", "implement", "review"] as const).map((role) => ({
        taskId: id,
        role,
        retryIndex: 0,
        expect: {
          model: { scout: "luna", implement: "terra", review: "sol" }[role],
          effort: "high",
        },
        deliveries: [
          {
            nextCursor: "1",
            event: {
              type: "attempt.started",
              eventId: `${id}:${role}:start`,
              attemptId: "rebound",
              sequence: 1,
              occurredAt: "2026-09-10T00:00:00Z",
              threadId: `${id}-${role}`,
            },
          },
          {
            nextCursor: "2",
            event: {
              type: "attempt.output",
              eventId: `${id}:${role}:output`,
              attemptId: "rebound",
              sequence: 2,
              occurredAt: "2026-09-10T00:00:01Z",
              output:
                role === "scout"
                  ? {
                      kind: role,
                      summary: "Ready",
                      files: [],
                      tests: ["bun test"],
                      risks: [],
                    }
                  : role === "implement"
                    ? {
                        kind: role,
                        commitSha: "a".repeat(40),
                        validation: ["bun test"],
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
              eventId: `${id}:${role}:complete`,
              attemptId: "rebound",
              sequence: 3,
              occurredAt: "2026-09-10T00:00:02Z",
            },
          },
        ],
      })),
    ),
  });
  return { db, repo, fake };
}

test("two tasks overlap, the fast task publishes independently, and dependencies stay blocked", async () => {
  const { db, repo, fake } = setup();
  const release = Promise.withResolvers<void>();
  const published: string[] = [];
  const scheduler = new Scheduler(
    repo,
    {
      async step(request) {
        if (request.attempt.taskId === "A" && request.attempt.role === "scout")
          await release.promise;
        return fake.harness.step(request);
      },
      cancel: fake.harness.cancel,
    },
    () => {},
    undefined,
    {
      baseBranch: "main",
      async publish(input) {
        published.push(input.task.id);
        return {
          number: published.length,
          url: `https://example.test/pr/${published.length}`,
          state: "OPEN",
        };
      },
    },
    false,
    false,
    2,
  );
  let progress: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await scheduler.tick();
    await scheduler.tick();
    expect(repo.inspectTask("A")?.status).toBe("claimed");
    expect(repo.inspectTask("B")?.status).toBe("claimed");
    expect(repo.inspectTask("C")?.status).toBe("ready");
    expect(repo.claimNext(undefined, false, false, 2)).toBeUndefined();
    expect(repo.inspectTask("D")?.status).toBe("ready");
    progress = (async () => {
      for (let i = 0; i < 40 && repo.inspectTask("B")?.status !== "done"; i++)
        await scheduler.tick();
    })();
    await Promise.race([
      progress,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("B waited for blocked A")),
          1000,
        );
      }),
    ]);
    expect(published).toEqual(["B"]);
    expect(repo.inspectTask("A")?.status).toBe("scouting");
    expect(repo.inspectTask("C")?.status).toBe("ready");
    release.resolve();
    await scheduler.runUntilIdle(80);
    expect(new Set(published)).toEqual(new Set(["A", "B", "C", "D"]));
    expect(published.indexOf("C")).toBeGreaterThan(published.indexOf("A"));
    fake.assertComplete();
  } finally {
    clearTimeout(timer);
    release.resolve();
    await progress;
    db.close();
  }
});

test("restart reconciles every running cursor even when the concurrency limit is reduced", async () => {
  const { db, repo, fake } = setup();
  const first = new Scheduler(
    repo,
    fake.harness,
    () => {},
    undefined,
    undefined,
    false,
    false,
    2,
  );
  try {
    for (
      let i = 0;
      i < 8 &&
      repo
        .getRunningAttempts()
        .filter((attempt) => attempt.backendCursor !== undefined).length < 2;
      i++
    )
      await first.tick();
    await first.drain();
    const running = repo.getRunningAttempts();
    expect(running).toHaveLength(2);
    expect(
      running.every((attempt) => attempt.backendCursor !== undefined),
    ).toBe(true);
    const reconciled: string[] = [];
    const restarted = new Scheduler(
      repo,
      {
        async step(request) {
          if (request.mode === "reconcile")
            reconciled.push(request.attempt.attemptId);
          return fake.harness.step(request);
        },
        cancel: fake.harness.cancel,
      },
      () => {},
      undefined,
      {
        baseBranch: "main",
        async publish() {
          return { number: 1, url: "https://example.test/pr/1", state: "OPEN" };
        },
      },
      false,
      false,
      1,
    );
    await restarted.runUntilIdle(100);
    expect(new Set(reconciled)).toEqual(
      new Set(running.map((attempt) => attempt.descriptor.attemptId)),
    );
    for (const id of ["A", "B", "C", "D"]) {
      expect(repo.inspectTask(id)?.status).toBe("done");
      expect(repo.listAttempts(id)).toHaveLength(3);
    }
    fake.assertComplete();
  } finally {
    db.close();
  }
});

test("draining includes sibling work after another task has returned and seals late delivery", async () => {
  const { db, repo, fake } = setup();
  const release = Promise.withResolvers<void>();
  const seal = new AbortController();
  const reason = new Error("Scheduler session sealed");
  const scheduler = new Scheduler(
    repo,
    {
      async step(request) {
        if (request.attempt.taskId === "A") await release.promise;
        return fake.harness.step(request);
      },
      cancel: fake.harness.cancel,
    },
    () => {},
    undefined,
    undefined,
    false,
    false,
    2,
  );
  let drain: Promise<unknown> | undefined;
  try {
    for (
      let i = 0;
      i < 8 && repo.getRunningAttempt("B")?.backendCursor === undefined;
      i++
    )
      await scheduler.tick(undefined, seal.signal);
    expect(repo.getRunningAttempt("A")?.backendCursor).toBeUndefined();
    expect(repo.getRunningAttempt("B")?.backendCursor).toBeDefined();
    drain = scheduler.drain().catch((error: unknown) => error);
    seal.abort(reason);
    db.close();
    release.resolve();
    expect(await drain).toBe(reason);
  } finally {
    release.resolve();
    await drain;
    db.close();
  }
});
