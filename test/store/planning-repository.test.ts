import { expect, test } from "bun:test";
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
    id: "2026-W35", goal: "Foundation", nonGoals: [], tokenBudget: 100_000, ticketIds: ["F1", "F2"],
  });
  return { db, repo };
}

function createTask(repo: PlanningRepository, id: string): void {
  repo.createTask({
    id, weekId: "2026-W35", title: `Repository ${id}`, spec,
    priority: id === "F1" ? 0 : 1, approvalRequired: false, approved: true,
  });
}

test("records the complete audit event for a valid transition", () => {
  const { db, repo } = createRepository();
  try {
    createTask(repo, "F1");
    repo.transitionTask("F1", "ready", "test:F1:ready");

    expect(repo.listTasks()).toMatchObject([{ id: "F1", status: "ready", spec }]);
    expect(db.query<{
      idempotency_key: string;
      task_id: string;
      type: string;
      payload_json: string;
      occurred_at: string;
    }, []>(`
      SELECT idempotency_key, task_id, type, payload_json, occurred_at FROM events
    `).get()).toEqual({
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

    expect(() => repo.transitionTask("F1", "ready", "test:F1:ready")).not.toThrow();
    expect(repo.listTasks()).toMatchObject([{ id: "F1", status: "ready" }]);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(1);
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

    expect(() => repo.transitionTask("F1", "ready", "test:F1:ready")).not.toThrow();
    expect(repo.listTasks()).toMatchObject([{ id: "F1", status: "claimed" }]);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(2);
  } finally {
    db.close();
  }
});

test("rejects conflicting reuse of a transition idempotency key", () => {
  const { db, repo } = createRepository();
  try {
    createTask(repo, "F1");
    repo.transitionTask("F1", "ready", "test:F1:transition");

    expect(() => repo.transitionTask("F1", "claimed", "test:F1:transition")).toThrow(
      "Idempotency key conflict: test:F1:transition",
    );
    expect(repo.listTasks()).toMatchObject([{ id: "F1", status: "ready" }]);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(1);
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
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(1);
  } finally {
    db.close();
  }
});

test("rejects a task whose specification violates the repository boundary schema", () => {
  const { db, repo } = createRepository();
  try {
    expect(() => repo.createTask({
      id: "F1", weekId: "2026-W35", title: "Repository", priority: 0,
      approvalRequired: false, approved: true,
      spec: { ...spec, acceptanceCriteria: [] },
    })).toThrow();
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM tasks").get()?.count).toBe(0);
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
