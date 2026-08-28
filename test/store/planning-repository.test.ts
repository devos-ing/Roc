import { expect, test } from "bun:test";
import type { BacklogManifest } from "../../src/domain/schemas";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";

const spec = {
  problem: "No task store",
  desiredOutcome: "Persist tasks",
  scope: ["repository"],
  nonGoals: [],
  acceptanceCriteria: ["task can transition"],
  validation: ["bun test"],
  dependencies: [],
  risk: "medium" as const,
  contextCandidates: [],
  tokenCeiling: 20_000,
};

function createRepository() {
  const db = openDatabase(":memory:");
  const repo = new PlanningRepository(db, () => "2026-08-24T00:00:00.000Z");
  repo.createWeek({
    id: "2026-W35",
    goal: "Foundation",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: ["F1", "F2"],
  });
  return { db, repo };
}

function createTask(repo: PlanningRepository, id: string): void {
  repo.createTask({
    id,
    weekId: "2026-W35",
    title: `Repository ${id}`,
    spec,
    priority: id === "F1" ? 0 : 1,
    approvalRequired: false,
    approved: true,
  });
}

const firstBacklogTask = {
  id: "import-01",
  title: "Create the imported task",
  priority: 0,
  spec: { ...spec, tokenCeiling: 10_000 },
};

const secondBacklogTask = {
  id: "import-02",
  title: "Block on the imported task",
  priority: 1,
  spec: {
    ...spec,
    dependencies: ["import-01"],
    tokenCeiling: 15_000,
  },
};

const backlog: BacklogManifest = {
  weekId: "2026-W35",
  goal: "Import a reviewed backlog",
  tasks: [firstBacklogTask, secondBacklogTask],
};

function importRepository() {
  const db = openDatabase(":memory:");
  return {
    db,
    repo: new PlanningRepository(db, () => "2026-08-24T00:00:00.000Z"),
  };
}

function rowCount(db: ReturnType<typeof openDatabase>, table: string): number {
  const row = db
    .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
    .get();
  if (!row) throw new Error(`Missing count for ${table}`);
  return row.count;
}

test("imports a ready approved backlog with its blocking dependencies", () => {
  const { db, repo } = importRepository();
  try {
    expect(repo.importBacklog(backlog)).toEqual({
      created: 2,
      skipped: 0,
      total: 2,
    });
    expect(repo.listTasks()).toMatchObject([
      {
        id: "import-01",
        status: "ready",
        approvalRequired: true,
        approved: true,
      },
      {
        id: "import-02",
        status: "ready",
        approvalRequired: true,
        approved: true,
      },
    ]);
    expect(
      db
        .query<{ goal: string; token_budget: number }, [string]>(
          "SELECT goal, token_budget FROM weeks WHERE id = ?",
        )
        .get(backlog.weekId),
    ).toEqual({ goal: backlog.goal, token_budget: 25_000 });
    expect(
      db
        .query<
          { task_id: string; depends_on_task_id: string; kind: string },
          []
        >("SELECT task_id, depends_on_task_id, kind FROM task_deps")
        .get(),
    ).toEqual({
      task_id: "import-02",
      depends_on_task_id: "import-01",
      kind: "blocks",
    });
  } finally {
    db.close();
  }
});

test("replays an imported backlog without changing task progress", () => {
  const { db, repo } = importRepository();
  try {
    repo.importBacklog(backlog);
    repo.transitionTask("import-01", "claimed", "test:import-01:claimed");

    expect(repo.importBacklog(backlog)).toEqual({
      created: 0,
      skipped: 2,
      total: 2,
    });
    expect(repo.listTasks()).toMatchObject([
      { id: "import-01", status: "claimed" },
      { id: "import-02", status: "ready" },
    ]);
  } finally {
    db.close();
  }
});

test("rolls back a conflicting backlog before adding its week or other tasks", () => {
  const { db, repo } = importRepository();
  try {
    repo.createWeek({
      id: "2026-W34",
      goal: "Existing work",
      nonGoals: [],
      tokenBudget: 20_000,
      ticketIds: ["import-01"],
    });
    repo.createTask({
      id: "import-01",
      weekId: "2026-W34",
      title: "Conflicting task",
      spec,
      priority: 0,
      approvalRequired: true,
      approved: true,
    });

    expect(() => repo.importBacklog(backlog)).toThrow(
      "Task conflict: import-01",
    );
    expect(rowCount(db, "weeks")).toBe(1);
    expect(rowCount(db, "tasks")).toBe(1);
    expect(rowCount(db, "task_deps")).toBe(0);
    expect(rowCount(db, "events")).toBe(0);
  } finally {
    db.close();
  }
});

test("rejects an unresolved dependency without changing storage", () => {
  const { db, repo } = importRepository();
  try {
    const missingDependency = {
      ...backlog,
      tasks: [
        {
          ...firstBacklogTask,
          spec: { ...firstBacklogTask.spec, dependencies: ["absent-task"] },
        },
      ],
    };

    expect(() => repo.importBacklog(missingDependency)).toThrow(
      "Missing task dependency: absent-task",
    );
    expect(rowCount(db, "weeks")).toBe(0);
    expect(rowCount(db, "tasks")).toBe(0);
    expect(rowCount(db, "task_deps")).toBe(0);
    expect(rowCount(db, "events")).toBe(0);
  } finally {
    db.close();
  }
});

test("rejects unsafe and duplicate task identifiers before any write", () => {
  const { db, repo } = importRepository();
  try {
    expect(() =>
      repo.importBacklog({
        ...backlog,
        tasks: [{ ...firstBacklogTask, id: "../unsafe" }],
      }),
    ).toThrow("Unsafe task path component");
    expect(() =>
      repo.importBacklog({
        ...backlog,
        tasks: [firstBacklogTask, firstBacklogTask],
      }),
    ).toThrow("Duplicate task ID: import-01");
    expect(rowCount(db, "weeks")).toBe(0);
    expect(rowCount(db, "tasks")).toBe(0);
    expect(rowCount(db, "task_deps")).toBe(0);
    expect(rowCount(db, "events")).toBe(0);
  } finally {
    db.close();
  }
});

test("records the complete audit event for a valid transition", () => {
  const { db, repo } = createRepository();
  try {
    createTask(repo, "F1");
    repo.transitionTask("F1", "ready", "test:F1:ready");

    expect(repo.listTasks()).toMatchObject([
      { id: "F1", status: "ready", spec },
    ]);
    expect(
      db
        .query<
          {
            idempotency_key: string;
            task_id: string;
            type: string;
            payload_json: string;
            occurred_at: string;
          },
          []
        >(`
      SELECT idempotency_key, task_id, type, payload_json, occurred_at FROM events
    `)
        .get(),
    ).toEqual({
      idempotency_key: "test:F1:ready",
      task_id: "F1",
      type: "task.status_changed",
      payload_json: JSON.stringify({ from: "draft", to: "ready" }),
      occurred_at: "2026-08-24T00:00:00.000Z",
    });
    expect(() => repo.transitionTask("F1", "done", "test:F1:done")).toThrow(
      "Invalid task transition: ready -> done",
    );
  } finally {
    db.close();
  }
});

test("treats an identical transition replay as a successful no-op", () => {
  const { db, repo } = createRepository();
  try {
    createTask(repo, "F1");
    repo.transitionTask("F1", "ready", "test:F1:ready");

    expect(() =>
      repo.transitionTask("F1", "ready", "test:F1:ready"),
    ).not.toThrow();
    expect(repo.listTasks()).toMatchObject([{ id: "F1", status: "ready" }]);
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
        .get()?.count,
    ).toBe(1);
  } finally {
    db.close();
  }
});

test("keeps later task progress when replaying an earlier successful transition", () => {
  const { db, repo } = createRepository();
  try {
    createTask(repo, "F1");
    repo.transitionTask("F1", "ready", "test:F1:ready");
    repo.transitionTask("F1", "claimed", "test:F1:claimed");

    expect(() =>
      repo.transitionTask("F1", "ready", "test:F1:ready"),
    ).not.toThrow();
    expect(repo.listTasks()).toMatchObject([{ id: "F1", status: "claimed" }]);
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
        .get()?.count,
    ).toBe(2);
  } finally {
    db.close();
  }
});

test("rejects conflicting reuse of a transition idempotency key", () => {
  const { db, repo } = createRepository();
  try {
    createTask(repo, "F1");
    repo.transitionTask("F1", "ready", "test:F1:transition");

    expect(() =>
      repo.transitionTask("F1", "claimed", "test:F1:transition"),
    ).toThrow("Idempotency key conflict: test:F1:transition");
    expect(repo.listTasks()).toMatchObject([{ id: "F1", status: "ready" }]);
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
        .get()?.count,
    ).toBe(1);
  } finally {
    db.close();
  }
});

test("rolls back a second task transition when its idempotency key already exists", () => {
  const { db, repo } = createRepository();
  try {
    createTask(repo, "F1");
    createTask(repo, "F2");
    repo.transitionTask("F1", "ready", "test:ready");

    expect(() => repo.transitionTask("F2", "ready", "test:ready")).toThrow();
    expect(repo.listTasks()).toMatchObject([
      { id: "F1", status: "ready" },
      { id: "F2", status: "draft" },
    ]);
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
        .get()?.count,
    ).toBe(1);
  } finally {
    db.close();
  }
});

test("rejects a task whose specification violates the repository boundary schema", () => {
  const { db, repo } = createRepository();
  try {
    expect(() =>
      repo.createTask({
        id: "F1",
        weekId: "2026-W35",
        title: "Repository",
        priority: 0,
        approvalRequired: false,
        approved: true,
        spec: { ...spec, acceptanceCriteria: [] },
      }),
    ).toThrow();
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM tasks")
        .get()?.count,
    ).toBe(0);
  } finally {
    db.close();
  }
});

test("rejects a malformed task record read from storage", () => {
  const { db, repo } = createRepository();
  try {
    db.query(`
      INSERT INTO tasks(
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES(
        $id, $weekId, $title, $spec, 'draft', $priority, $risk, $tokenCeiling,
        $approvalRequired, $approved, $now, $now
      )
    `).run({
      id: "F1",
      weekId: "2026-W35",
      title: "Malformed",
      spec: "{}",
      priority: 0,
      risk: "medium",
      tokenCeiling: 20_000,
      approvalRequired: 0,
      approved: 1,
      now: "2026-08-24T00:00:00.000Z",
    });

    expect(() => repo.listTasks()).toThrow();
  } finally {
    db.close();
  }
});
