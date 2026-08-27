import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/store/database";
import { migrate } from "../../src/store/migrations";

function createV2Database(model = "luna"): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE weeks (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL,
      week_id TEXT NOT NULL REFERENCES weeks(id)
    );
    CREATE TABLE usage (
      id TEXT PRIMARY KEY NOT NULL,
      week_id TEXT NOT NULL REFERENCES weeks(id),
      category TEXT NOT NULL
    );
    CREATE TABLE contexts (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      role TEXT NOT NULL CHECK(role IN ('scout', 'implement', 'review')),
      model TEXT NOT NULL,
      effort TEXT NOT NULL CHECK(effort IN ('medium', 'high', 'xhigh')),
      status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed_infra')),
      thread_id TEXT,
      retry_index INTEGER NOT NULL CHECK(retry_index BETWEEN 0 AND 2),
      git_commit TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      backend_cursor TEXT,
      UNIQUE(task_id, id)
    );
    CREATE TABLE model_decisions (
      id TEXT PRIMARY KEY NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      role TEXT NOT NULL CHECK(role IN ('scout', 'implement', 'review')),
      model TEXT NOT NULL,
      effort TEXT NOT NULL CHECK(effort IN ('medium', 'high', 'xhigh')),
      token_budget INTEGER NOT NULL CHECK(token_budget > 0),
      context_id TEXT REFERENCES contexts(id) DEFERRABLE INITIALLY DEFERRED,
      fallback_models_json TEXT NOT NULL,
      decided_by TEXT NOT NULL CHECK(decided_by IN ('rule', 'advisor-llm', 'fallback')),
      confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
      rationale_json TEXT NOT NULL,
      UNIQUE(task_id, id)
    );
    INSERT INTO weeks(id) VALUES('2026-W35');
    INSERT INTO tasks(id, week_id) VALUES('task-1', '2026-W35');
    INSERT INTO attempts(
      id, task_id, role, model, effort, status, retry_index, started_at
    ) VALUES('attempt-1', 'task-1', 'scout', '${model}', 'high', 'running', 0, 'now');
    PRAGMA user_version = 2;
  `);
  return db;
}

/** Creates the released version-3 tables affected by the Agile Cycle rename. */
function createV3CycleRenameDatabase(): Database {
  const db = new Database(":memory:", { strict: true });
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE weeks (
      id TEXT PRIMARY KEY NOT NULL,
      goal TEXT NOT NULL,
      token_budget INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL,
      week_id TEXT NOT NULL REFERENCES weeks(id),
      UNIQUE(week_id, id)
    );
    CREATE TABLE usage (
      id TEXT PRIMARY KEY NOT NULL,
      week_id TEXT NOT NULL REFERENCES weeks(id),
      task_id TEXT,
      category TEXT NOT NULL,
      FOREIGN KEY(week_id, task_id) REFERENCES tasks(week_id, id)
    );
    INSERT INTO weeks(id, goal, token_budget, status, created_at)
    VALUES('2026-W35', 'Ship safely', 1000, 'active', '2026-08-24T00:00:00Z');
    INSERT INTO tasks(id, week_id) VALUES('task-1', '2026-W35');
    INSERT INTO usage(id, week_id, task_id, category)
    VALUES('usage-1', '2026-W35', 'task-1', 'weekly_grilling');
    PRAGMA user_version = 3;
  `);
  return db;
}

test("migration creates every approved table", () => {
  const db = openDatabase(":memory:");
  const rows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all();
  const names = rows.map((row) => row.name);

  for (const name of [
    "attempts",
    "contexts",
    "events",
    "model_decisions",
    "reviews",
    "scheduler_lease",
    "task_deps",
    "tasks",
    "usage",
    "cycles",
  ]) {
    expect(names).toContain(name);
  }
  expect(
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()
      ?.user_version,
  ).toBe(4);
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(tasks)")
      .all()
      .map((row) => row.name),
  ).toContain("base_commit");
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(attempts)")
      .all()
      .map((row) => row.name),
  ).toEqual(
    expect.arrayContaining(["model_profile", "turn_id", "backend_cursor"]),
  );
  expect(
    db
      .query<{ name: string }, []>("PRAGMA table_info(model_decisions)")
      .all()
      .map((row) => row.name),
  ).toContain("model_profile");
  const taskIndexes = db
    .query<
      {
        seq: number;
        name: string;
        unique: number;
        origin: string;
        partial: number;
      },
      []
    >("PRAGMA index_list(tasks)")
    .all();
  expect(taskIndexes).toContainEqual({
    seq: expect.any(Number),
    name: "tasks_one_followup_per_review",
    unique: 1,
    origin: "c",
    partial: 1,
  });
  db.close();
});

test("v4 migration renames weeks to cycles without losing related data", () => {
  const db = createV3CycleRenameDatabase();
  try {
    migrate(db);

    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cycles'",
        )
        .get(),
    ).toEqual({ name: "cycles" });
    expect(
      db.query<{ cycle_id: string }, []>("SELECT cycle_id FROM tasks").get(),
    ).toEqual({ cycle_id: "2026-W35" });
    expect(
      db
        .query<{ cycle_id: string; category: string }, []>(
          "SELECT cycle_id, category FROM usage",
        )
        .get(),
    ).toEqual({ cycle_id: "2026-W35", category: "cycle_grilling" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get(),
    ).toEqual({ user_version: 4 });
  } finally {
    db.close();
  }
});

test("v3 migration rejects an unmappable legacy model profile", () => {
  const db = createV2Database("gpt-5.6-luna");
  try {
    expect(() => migrate(db)).toThrow(
      "Cannot map legacy model profile: gpt-5.6-luna",
    );
    expect(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(2);
    expect(
      db
        .query<{ name: string }, []>("PRAGMA table_info(tasks)")
        .all()
        .map((row) => row.name),
    ).not.toContain("base_commit");
  } finally {
    db.close();
  }
});

test("v3 migration backfills supported model profiles without losing runtime columns", () => {
  const db = createV2Database();
  try {
    db.exec(`
      UPDATE attempts SET backend_cursor = 'cursor-v2' WHERE id = 'attempt-1';
      INSERT INTO model_decisions(
        id, task_id, role, model, effort, token_budget, fallback_models_json,
        decided_by, confidence, rationale_json
      ) VALUES(
        'decision-1', 'task-1', 'implement', 'terra', 'high', 100, '[]',
        'rule', 1, '["legacy decision"]'
      );
    `);

    migrate(db);

    expect(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(4);
    expect(
      db
        .query<
          {
            model: string;
            model_profile: string;
            backend_cursor: string | null;
          },
          []
        >(`
      SELECT model, model_profile, backend_cursor FROM attempts WHERE id = 'attempt-1'
    `)
        .get(),
    ).toEqual({
      model: "luna",
      model_profile: "luna",
      backend_cursor: "cursor-v2",
    });
    expect(
      db
        .query<{ model: string; model_profile: string }, []>(`
      SELECT model, model_profile FROM model_decisions WHERE id = 'decision-1'
    `)
        .get(),
    ).toEqual({ model: "terra", model_profile: "terra" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("v3 migration rolls back atomically and restores foreign keys when validation fails", () => {
  const db = createV2Database();
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY,
        task_id TEXT,
        attempt_id TEXT,
        FOREIGN KEY(task_id, attempt_id) REFERENCES attempts(task_id, id)
      );
      INSERT INTO events(seq, task_id, attempt_id) VALUES(1, 'missing-task', 'missing-attempt');
      PRAGMA foreign_keys = ON;
    `);

    expect(() => migrate(db)).toThrow(
      "Foreign key check failed during migration 3",
    );
    expect(
      db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
        ?.foreign_keys,
    ).toBe(1);
    expect(
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
    ).toBe(2);
    expect(
      db
        .query<{ name: string }, []>("PRAGMA table_info(tasks)")
        .all()
        .map((row) => row.name),
    ).not.toContain("base_commit");
    expect(
      db
        .query<{ name: string }, []>("PRAGMA table_info(attempts)")
        .all()
        .map((row) => row.name),
    ).not.toContain("model_profile");
  } finally {
    db.close();
  }
});

test("entity tables reject null IDs", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO cycles (id, goal, token_budget, status, created_at)
      VALUES ('cycle-1', 'Ship foundation', 1000, 'active', '2026-08-24T00:00:00Z');
      INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES (
        'task-1', 'cycle-1', 'Foundation', '{}', 'draft', 0, 'low', 100,
        0, 0, '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      );
      INSERT INTO contexts (
        id, thread_id, anchor_id, source_task_id, git_commit
      ) VALUES ('context-1', 'thread-1', 'anchor-1', 'task-1', 'abc123');
      INSERT INTO attempts (
        id, task_id, role, model, model_profile, effort, status, retry_index, started_at
      ) VALUES ('attempt-1', 'task-1', 'scout', 'gpt-5', 'luna', 'high', 'running', 0, '2026-08-24T00:00:00Z');
    `);

    for (const sql of [
      "INSERT INTO cycles (id, goal, token_budget, status, created_at) VALUES (NULL, 'Goal', 1, 'active', 'now')",
      `INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES (NULL, 'cycle-1', 'Task', '{}', 'draft', 0, 'low', 1, 0, 0, 'now', 'now')`,
      "INSERT INTO contexts (id, thread_id, anchor_id, source_task_id, git_commit) VALUES (NULL, 'thread-2', 'anchor-2', 'task-1', 'def456')",
      "INSERT INTO attempts (id, task_id, role, model, model_profile, effort, status, retry_index, started_at) VALUES (NULL, 'task-1', 'scout', 'gpt-5', 'luna', 'high', 'running', 0, 'now')",
      "INSERT INTO reviews (id, task_id, attempt_id, decision, findings_json) VALUES (NULL, 'task-1', 'attempt-1', 'accepted', '[]')",
      "INSERT INTO model_decisions (id, task_id, role, model, model_profile, effort, token_budget, fallback_models_json, decided_by, confidence, rationale_json) VALUES (NULL, 'task-1', 'scout', 'gpt-5', 'luna', 'high', 1, '[]', 'rule', 1, '[]')",
      "INSERT INTO usage (id, cycle_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES (NULL, 'cycle-1', 'cycle_grilling', 0, 0, 0, 0)",
    ]) {
      expect(() => db.exec(sql)).toThrow();
    }
  } finally {
    db.close();
  }
});

test("lineage and context references reject nonexistent records", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO cycles (id, goal, token_budget, status, created_at)
      VALUES ('cycle-1', 'Ship foundation', 1000, 'active', '2026-08-24T00:00:00Z');
      INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES (
        'task-1', 'cycle-1', 'Foundation', '{}', 'draft', 0, 'low', 100,
        0, 0, '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      );
    `);

    const taskWithReference = (column: string, value: string) => `
      INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, ${column}, created_at, updated_at
      ) VALUES (
        'task-${column}', 'cycle-1', 'Follow-up', '{}', 'draft', 0, 'low', 100,
        0, 0, '${value}', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      )`;

    for (const sql of [
      taskWithReference("root_task_id", "missing-task"),
      taskWithReference("parent_task_id", "missing-task"),
      taskWithReference("discovered_from_review_id", "missing-review"),
      taskWithReference("context_id", "missing-context"),
      "INSERT INTO contexts (id, thread_id, anchor_id, source_task_id, git_commit) VALUES ('context-bad-source', 'thread', 'anchor', 'missing-task', 'abc123')",
      "INSERT INTO contexts (id, thread_id, anchor_id, source_task_id, parent_context_id, git_commit) VALUES ('context-bad-parent', 'thread', 'anchor', 'task-1', 'missing-context', 'abc123')",
      "INSERT INTO model_decisions (id, task_id, role, model, model_profile, effort, token_budget, context_id, fallback_models_json, decided_by, confidence, rationale_json) VALUES ('decision-bad-context', 'task-1', 'scout', 'gpt-5', 'luna', 'high', 1, 'missing-context', '[]', 'rule', 1, '[]')",
    ]) {
      expect(() => db.exec(sql)).toThrow();
    }

    expect(() =>
      db.exec(`
      INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES (
        'task-null-lineage', 'cycle-1', 'Independent', '{}', 'draft', 0, 'low', 100,
        0, 0, '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      );
      INSERT INTO model_decisions (
        id, task_id, role, model, model_profile, effort, token_budget, fallback_models_json,
        decided_by, confidence, rationale_json
      ) VALUES (
        'decision-null-context', 'task-1', 'scout', 'gpt-5', 'luna', 'high', 1, '[]',
        'rule', 1, '[]'
      );
    `),
    ).not.toThrow();
  } finally {
    db.close();
  }
});

test("persisted domain enums accept approved values and reject unknown values", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO cycles (id, goal, token_budget, status, created_at)
      VALUES ('cycle-1', 'Ship foundation', 1000, 'active', '2026-08-24T00:00:00Z');
      INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES (
        'task-1', 'cycle-1', 'Foundation', '{}', 'draft', 0, 'low', 100,
        0, 0, '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      );
    `);

    for (const status of [
      "running",
      "succeeded",
      "failed_infra",
      "blocked_policy",
    ]) {
      expect(() =>
        db.exec(`
        INSERT INTO attempts (
          id, task_id, role, model, model_profile, effort, status, retry_index, started_at
        ) VALUES (
          'attempt-${status}', 'task-1', 'scout', 'gpt-5', 'luna', 'high', '${status}', 0,
          '2026-08-24T00:00:00Z'
        )
      `),
      ).not.toThrow();
    }

    for (const sql of [
      `INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES ('task-bad-status', 'cycle-1', 'Bad', '{}', 'unknown', 0, 'low', 1, 0, 0, 'now', 'now')`,
      `INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES ('task-bad-risk', 'cycle-1', 'Bad', '{}', 'draft', 0, 'critical', 1, 0, 0, 'now', 'now')`,
      "INSERT INTO attempts (id, task_id, role, model, model_profile, effort, status, retry_index, started_at) VALUES ('attempt-bad-role', 'task-1', 'manager', 'gpt-5', 'luna', 'high', 'running', 0, 'now')",
      "INSERT INTO attempts (id, task_id, role, model, model_profile, effort, status, retry_index, started_at) VALUES ('attempt-bad-status', 'task-1', 'scout', 'gpt-5', 'luna', 'high', 'unknown', 0, 'now')",
      "INSERT INTO attempts (id, task_id, role, model, model_profile, effort, status, retry_index, started_at) VALUES ('attempt-low', 'task-1', 'scout', 'gpt-5', 'luna', 'low', 'running', 0, 'now')",
      "INSERT INTO attempts (id, task_id, role, model, model_profile, effort, status, retry_index, started_at) VALUES ('attempt-bad-profile', 'task-1', 'scout', 'gpt-5', 'nova', 'high', 'running', 0, 'now')",
      "INSERT INTO model_decisions (id, task_id, role, model, model_profile, effort, token_budget, fallback_models_json, decided_by, confidence, rationale_json) VALUES ('decision-bad-role', 'task-1', 'manager', 'gpt-5', 'luna', 'high', 1, '[]', 'rule', 1, '[]')",
      "INSERT INTO model_decisions (id, task_id, role, model, model_profile, effort, token_budget, fallback_models_json, decided_by, confidence, rationale_json) VALUES ('decision-bad-decider', 'task-1', 'scout', 'gpt-5', 'luna', 'high', 1, '[]', 'human', 1, '[]')",
      "INSERT INTO model_decisions (id, task_id, role, model, model_profile, effort, token_budget, fallback_models_json, decided_by, confidence, rationale_json) VALUES ('decision-low', 'task-1', 'scout', 'gpt-5', 'luna', 'low', 1, '[]', 'rule', 1, '[]')",
      "INSERT INTO model_decisions (id, task_id, role, model, model_profile, effort, token_budget, fallback_models_json, decided_by, confidence, rationale_json) VALUES ('decision-bad-profile', 'task-1', 'scout', 'gpt-5', 'nova', 'high', 1, '[]', 'rule', 1, '[]')",
    ]) {
      expect(() => db.exec(sql)).toThrow();
    }
  } finally {
    db.close();
  }
});

test("reviews and usage preserve task and cycle attribution", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO cycles (id, goal, token_budget, status, created_at) VALUES
        ('cycle-1', 'First cycle', 1000, 'active', '2026-08-24T00:00:00Z'),
        ('cycle-2', 'Second cycle', 1000, 'active', '2026-08-31T00:00:00Z');
      INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES
        ('task-1', 'cycle-1', 'First task', '{}', 'draft', 0, 'low', 100, 0, 0, 'now', 'now'),
        ('task-2', 'cycle-2', 'Second task', '{}', 'draft', 0, 'low', 100, 0, 0, 'now', 'now');
      INSERT INTO attempts (
        id, task_id, role, model, model_profile, effort, status, retry_index, started_at
      ) VALUES (
        'attempt-1', 'task-1', 'scout', 'gpt-5', 'luna', 'high', 'succeeded', 0, 'now'
      );
      INSERT INTO model_decisions (
        id, task_id, role, model, model_profile, effort, token_budget, fallback_models_json,
        decided_by, confidence, rationale_json
      ) VALUES (
        'decision-1', 'task-1', 'scout', 'gpt-5', 'luna', 'high', 10, '[]', 'rule', 1, '[]'
      );
    `);

    for (const sql of [
      "INSERT INTO reviews (id, task_id, attempt_id, decision, findings_json) VALUES ('review-wrong-task', 'task-2', 'attempt-1', 'accepted', '[]')",
      "INSERT INTO usage (id, cycle_id, task_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES ('usage-wrong-cycle', 'cycle-2', 'task-1', 'ticket_grilling', 0, 0, 0, 0)",
      "INSERT INTO usage (id, cycle_id, task_id, attempt_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES ('usage-wrong-attempt', 'cycle-2', 'task-2', 'attempt-1', 'scout', 0, 0, 0, 0)",
      "INSERT INTO usage (id, cycle_id, task_id, model_decision_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES ('usage-wrong-decision', 'cycle-2', 'task-2', 'decision-1', 'advisor', 0, 0, 0, 0)",
      "INSERT INTO usage (id, cycle_id, attempt_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES ('usage-attempt-without-task', 'cycle-1', 'attempt-1', 'scout', 0, 0, 0, 0)",
      "INSERT INTO usage (id, cycle_id, model_decision_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES ('usage-decision-without-task', 'cycle-1', 'decision-1', 'advisor', 0, 0, 0, 0)",
      "INSERT INTO usage (id, cycle_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, cost) VALUES ('usage-negative-cost', 'cycle-1', 'cycle_grilling', 0, 0, 0, 0, -0.01)",
    ]) {
      expect(() => db.exec(sql)).toThrow();
    }

    expect(() =>
      db.exec(`
      INSERT INTO reviews (id, task_id, attempt_id, decision, findings_json)
      VALUES ('review-valid', 'task-1', 'attempt-1', 'accepted', '[]');
      INSERT INTO usage (
        id, cycle_id, category, input_tokens, cached_input_tokens, output_tokens,
        reasoning_output_tokens
      ) VALUES ('usage-cycle', 'cycle-1', 'cycle_grilling', 0, 0, 0, 0);
      INSERT INTO usage (
        id, cycle_id, task_id, category, input_tokens, cached_input_tokens,
        output_tokens, reasoning_output_tokens, cost
      ) VALUES ('usage-task', 'cycle-1', 'task-1', 'ticket_grilling', 0, 0, 0, 0, 0);
      INSERT INTO usage (
        id, cycle_id, task_id, attempt_id, category, input_tokens,
        cached_input_tokens, output_tokens, reasoning_output_tokens
      ) VALUES ('usage-attempt', 'cycle-1', 'task-1', 'attempt-1', 'scout', 0, 0, 0, 0);
      INSERT INTO usage (
        id, cycle_id, task_id, model_decision_id, category, input_tokens,
        cached_input_tokens, output_tokens, reasoning_output_tokens
      ) VALUES ('usage-decision', 'cycle-1', 'task-1', 'decision-1', 'advisor', 0, 0, 0, 0);
    `),
    ).not.toThrow();
  } finally {
    db.close();
  }
});

test("events reject attempts attributed to a different or missing task", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO cycles (id, goal, token_budget, status, created_at)
      VALUES ('cycle-1', 'Ship foundation', 1000, 'active', 'now');
      INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES
        ('task-1', 'cycle-1', 'First', '{}', 'draft', 0, 'low', 100, 0, 0, 'now', 'now'),
        ('task-2', 'cycle-1', 'Second', '{}', 'draft', 1, 'low', 100, 0, 0, 'now', 'now');
      INSERT INTO attempts (
        id, task_id, role, model, model_profile, effort, status, retry_index, started_at
      ) VALUES ('attempt-1', 'task-1', 'scout', 'gpt-5', 'luna', 'high', 'running', 0, 'now');
    `);

    for (const sql of [
      "INSERT INTO events (idempotency_key, task_id, attempt_id, type, payload_json, occurred_at) VALUES ('event-wrong-task', 'task-2', 'attempt-1', 'attempt.started', '{}', 'now')",
      "INSERT INTO events (idempotency_key, attempt_id, type, payload_json, occurred_at) VALUES ('event-missing-task', 'attempt-1', 'attempt.started', '{}', 'now')",
    ]) {
      expect(() => db.exec(sql)).toThrow();
    }
  } finally {
    db.close();
  }
});

test("events permit global, task-only, and correctly attributed attempt events", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO cycles (id, goal, token_budget, status, created_at)
      VALUES ('cycle-1', 'Ship foundation', 1000, 'active', 'now');
      INSERT INTO tasks (
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES ('task-1', 'cycle-1', 'First', '{}', 'draft', 0, 'low', 100, 0, 0, 'now', 'now');
      INSERT INTO attempts (
        id, task_id, role, model, model_profile, effort, status, retry_index, started_at
      ) VALUES ('attempt-1', 'task-1', 'scout', 'gpt-5', 'luna', 'high', 'running', 0, 'now');
    `);

    expect(() =>
      db.exec(`
      INSERT INTO events (idempotency_key, type, payload_json, occurred_at)
      VALUES ('event-global', 'cycle.started', '{}', 'now');
      INSERT INTO events (idempotency_key, task_id, type, payload_json, occurred_at)
      VALUES ('event-task', 'task-1', 'task.created', '{}', 'now');
      INSERT INTO events (idempotency_key, task_id, attempt_id, type, payload_json, occurred_at)
      VALUES ('event-attempt', 'task-1', 'attempt-1', 'attempt.started', '{}', 'now');
    `),
    ).not.toThrow();
    expect(
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events")
        .get()?.count,
    ).toBe(3);
  } finally {
    db.close();
  }
});

test("database initialization closes its handle before rethrowing", () => {
  const directory = mkdtempSync(join(tmpdir(), "agile-agents-db-"));
  const path = join(directory, "future.sqlite");
  const future = new Database(path, { create: true });
  future.exec("PRAGMA user_version = 5");
  future.close();

  const close = spyOn(Database.prototype, "close");
  try {
    expect(() => openDatabase(path)).toThrow(
      "Database version 5 is newer than supported version 4",
    );
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file databases create parents and enable durable SQLite settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "agile-agents-db-"));
  const path = join(directory, "nested", "state.sqlite");
  try {
    expect(existsSync(path)).toBe(false);
    const db = openDatabase(path);
    try {
      expect(existsSync(path)).toBe(true);
      expect(
        db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
          ?.foreign_keys,
      ).toBe(1);
      expect(
        db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
          ?.journal_mode,
      ).toBe("wal");
    } finally {
      db.close();
    }

    const reopened = openDatabase(path);
    try {
      expect(
        reopened
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get()?.user_version,
      ).toBe(4);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database rejects a symlinked runtime directory without creating external files", () => {
  const root = mkdtempSync(join(tmpdir(), "agile-agents-db-symlink-"));
  const external = mkdtempSync(join(tmpdir(), "agile-agents-db-external-"));
  try {
    mkdirSync(join(root, ".agile"));
    writeFileSync(join(external, "sentinel.txt"), "unchanged\n");
    symlinkSync(external, join(root, ".agile", "runtime"), "dir");

    expect(() =>
      openDatabase(join(root, ".agile", "runtime", "state.sqlite")),
    ).toThrow(/symbolic link/i);
    expect(readdirSync(external)).toEqual(["sentinel.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("database rejects a symlinked ancestor even when the runtime directory already exists", () => {
  const root = mkdtempSync(join(tmpdir(), "agile-agents-db-ancestor-symlink-"));
  const external = mkdtempSync(
    join(tmpdir(), "agile-agents-db-ancestor-external-"),
  );
  try {
    mkdirSync(join(external, "runtime"));
    symlinkSync(external, join(root, ".agile"), "dir");

    expect(() =>
      openDatabase(join(root, ".agile", "runtime", "state.sqlite")),
    ).toThrow(/symbolic link/i);
    expect(readdirSync(join(external, "runtime"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("database rejects a symlinked database target without changing its referent", () => {
  const root = mkdtempSync(join(tmpdir(), "agile-agents-db-target-symlink-"));
  const runtime = join(root, ".agile", "runtime");
  const external = join(root, "external.sqlite");
  try {
    mkdirSync(runtime, { recursive: true });
    writeFileSync(external, "unchanged\n");
    symlinkSync(external, join(runtime, "state.sqlite"), "file");

    expect(() => openDatabase(join(runtime, "state.sqlite"))).toThrow(
      /symbolic link/i,
    );
    expect(readFileSync(external, "utf8")).toBe("unchanged\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deferred context references permit an atomic task and context cycle", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO cycles (id, goal, token_budget, status, created_at)
      VALUES ('cycle-1', 'Ship foundation', 1000, 'active', '2026-08-24T00:00:00Z');
    `);

    expect(() =>
      db.transaction(() => {
        db.exec(`
        INSERT INTO contexts (
          id, thread_id, anchor_id, source_task_id, git_commit
        ) VALUES (
          'context-1', 'thread-1', 'anchor-1', 'task-1', 'abc123'
        );
        INSERT INTO tasks (
          id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
          approval_required, approved, context_id, created_at, updated_at
        ) VALUES (
          'task-1', 'cycle-1', 'Foundation', '{}', 'draft', 0, 'low', 100,
          0, 0, 'context-1', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
        );
      `);
      })(),
    ).not.toThrow();
  } finally {
    db.close();
  }
});
