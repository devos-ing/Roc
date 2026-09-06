import { expect, test } from "bun:test";
import type { BacklogManifest } from "../../src/domain/schemas";
import {
  GitHubRemoteTaskSource,
  type RemoteIssue,
  RemoteSchedulerSource,
} from "../../src/github/remote-source";
import {
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";
import { RemoteTaskRepository } from "../../src/store/remote-task-repository";

const manifest: BacklogManifest = {
  cycleId: "2026-09-06-P7D",
  goal: "Execute on the worker",
  tasks: [
    {
      id: "A",
      title: "Foundation",
      priority: 1,
      spec: {
        problem: "Missing base",
        desiredOutcome: "Base exists",
        scope: ["base"],
        nonGoals: [],
        acceptanceCriteria: ["base passes"],
        validation: ["bun test"],
        dependencies: [],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 100,
      },
    },
    {
      id: "B",
      title: "Dependent",
      priority: 2,
      spec: {
        problem: "Missing dependent work",
        desiredOutcome: "Dependent exists",
        scope: ["dependent"],
        nonGoals: [],
        acceptanceCriteria: ["dependent passes"],
        validation: ["bun test"],
        dependencies: ["A"],
        risk: "high",
        contextCandidates: [],
        tokenCeiling: 200,
      },
    },
  ],
};

/** Creates a ready managed Issue with an exact trusted approval. */
function issueFor(
  source: BacklogManifest,
  taskId: string,
  number: number,
): RemoteIssue {
  const envelope = remoteTaskEnvelope(source, taskId);
  return {
    number,
    title: envelope.task.title,
    body: renderRemoteTaskBody(envelope),
    url: `https://example.test/issues/${number}`,
    state: "OPEN",
    labels: [{ name: "roc:task" }, { name: "roc:ready" }],
    comments: [
      {
        body: renderRemoteTaskApproval(envelope),
        author: { login: "trusted" },
        databaseId: number + 100,
      },
    ],
  };
}

test("admits a complete approved plan once and preserves its dependency graph", async () => {
  const db = openDatabase(":memory:");
  const issues = [issueFor(manifest, "B", 12), issueFor(manifest, "A", 11)];
  const source = new GitHubRemoteTaskSource(
    "owner/repo",
    new Set(["trusted"]),
    new PlanningRepository(db, () => "2026-09-06T00:00:00.000Z"),
    new RemoteTaskRepository(db, () => "2026-09-06T00:00:00.000Z"),
    async () => issues,
  );

  expect(await source.poll()).toMatchObject({
    imported: 2,
    tracked: 2,
    errors: [],
  });
  expect(await source.poll()).toMatchObject({
    imported: 0,
    tracked: 2,
    errors: [],
  });
  expect(new PlanningRepository(db).listTasks()).toMatchObject([
    { id: "A", cycleId: manifest.cycleId, status: "ready" },
    { id: "B", cycleId: manifest.cycleId, status: "ready" },
  ]);
  expect(
    db
      .query<{ depends_on_task_id: string }, []>(
        "SELECT depends_on_task_id FROM task_deps WHERE task_id = 'B'",
      )
      .get(),
  ).toEqual({ depends_on_task_id: "A" });
  db.close();
});

test("isolates an invalid plan and pauses a tracked task after approval withdrawal", async () => {
  const db = openDatabase(":memory:");
  const firstTask = manifest.tasks[0];
  if (firstTask === undefined)
    throw new Error("test manifest has no first task");
  const oneTask: BacklogManifest = { ...manifest, tasks: [firstTask] };
  const good = issueFor(oneTask, "A", 21);
  good.comments.unshift({
    body: "<!-- roc:approval {malformed} -->",
    author: { login: "trusted" },
    databaseId: 120,
  });
  const invalidManifest: BacklogManifest = {
    ...oneTask,
    cycleId: "2026-09-07-P7D",
    tasks: [{ ...firstTask, id: "INVALID" }],
  };
  const invalid = issueFor(invalidManifest, "INVALID", 22);
  invalid.comments = [];
  let issues = [good, invalid];
  const planning = new PlanningRepository(db);
  const remote = new RemoteTaskRepository(db);
  const source = new GitHubRemoteTaskSource(
    "owner/repo",
    new Set(["trusted"]),
    planning,
    remote,
    async () => issues,
  );

  const first = await source.poll();
  expect(first.imported).toBe(1);
  expect(first.errors.join("\n")).toContain("lacks trusted approval");
  await source.poll();
  expect(planning.listTasks()).toMatchObject([{ id: "A", status: "ready" }]);
  const malformedApproval = good.comments[0];
  if (malformedApproval === undefined)
    throw new Error("missing malformed approval");
  good.comments = [malformedApproval];
  issues = [good, invalid];
  await source.poll();
  expect(planning.listTasks()).toMatchObject([
    { id: "A", status: "needs_replan" },
  ]);
  db.close();
});

test("rejects a second plan whose existing cycle has a different goal", async () => {
  const db = openDatabase(":memory:");
  const first = manifest.tasks[0];
  if (first === undefined) throw new Error("test manifest has no first task");
  const firstPlan: BacklogManifest = { ...manifest, tasks: [first] };
  const secondPlan: BacklogManifest = {
    ...manifest,
    goal: "A conflicting cycle goal",
    tasks: [{ ...first, id: "C" }],
  };
  const remote = new RemoteTaskRepository(db);
  const source = new GitHubRemoteTaskSource(
    "owner/repo",
    new Set(["trusted"]),
    new PlanningRepository(db),
    remote,
    async () => [issueFor(firstPlan, "A", 41), issueFor(secondPlan, "C", 42)],
  );

  const result = await source.poll();

  expect(result.imported).toBe(1);
  expect(result.errors.join("\n")).toContain(
    "Existing cycle goal conflicts with remote plan",
  );
  expect(remote.list().map((task) => task.taskId)).toEqual(["A"]);
  db.close();
});

test("network failure pauses idle advancement while allowing an active role to finish", async () => {
  let running: unknown;
  let now = 0;
  let offline = true;
  const source = new RemoteSchedulerSource(
    {
      poll: async () => {
        if (offline) throw new Error("offline");
        return { imported: 0, tracked: 0, errors: [] };
      },
    },
    { getRunningAttempt: () => running },
    () => now,
  );
  expect(await source.beforeTick()).toBeFalse();
  now = 1_000;
  running = { attemptId: "active" };
  expect(await source.beforeTick()).toBeTrue();
  now = 2_000;
  running = undefined;
  expect(await source.beforeTick()).toBeFalse();
  offline = false;
  now = 6_000;
  expect(await source.beforeTick()).toBeTrue();
});

test("a local ID conflict leaves the whole remote plan unimported", async () => {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db);
  const firstTask = manifest.tasks[0];
  if (firstTask === undefined)
    throw new Error("test manifest has no first task");
  planning.importBacklog({ ...manifest, tasks: [firstTask] });
  const remote = new RemoteTaskRepository(db);
  const source = new GitHubRemoteTaskSource(
    "owner/repo",
    new Set(["trusted"]),
    planning,
    remote,
    async () => [issueFor(manifest, "A", 31), issueFor(manifest, "B", 32)],
  );

  const result = await source.poll();
  expect(result.errors.join("\n")).toContain(
    "Local task ID is already in use: A",
  );
  expect(planning.listTasks().map((task) => task.id)).toEqual(["A"]);
  expect(remote.list()).toEqual([]);
  db.close();
});
