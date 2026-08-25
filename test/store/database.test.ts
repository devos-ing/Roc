import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/store/database";

test("migration creates every approved table", () => {
  const db = openDatabase(":memory:");
  const rows = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all();
  const names = rows.map((row) => row.name);

  for (const name of [
    "attempts", "contexts", "events", "model_decisions", "reviews",
    "scheduler_lease", "task_deps", "tasks", "usage", "weeks",
  ]) {
    expect(names).toContain(name);
  }
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
  const attemptColumns = db.query<{ name: string }, []>("PRAGMA table_info(attempts)").all();
  expect(attemptColumns.map((column) => column.name)).toContain("backend_cursor");
  const taskIndexes = db.query<{
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }, []>(
    "PRAGMA index_list(tasks)",
  ).all();
  expect(taskIndexes).toContainEqual({
    seq: expect.any(Number),
    name: "tasks_one_followup_per_review",
    unique: 1,
    origin: "c",
    partial: 1,
  });
  db.close();
});

test("entity tables reject null IDs", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO weeks (id, goal, token_budget, status, created_at)
      VALUES ('week-1', 'Ship foundation', 1000, 'active', '2026-08-24T00:00:00Z');
      INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES (
        'task-1', 'week-1', 'Foundation', '{}', 'draft', 0, 'low', 100,
        0, 0, '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      );
      INSERT INTO contexts (
        id, thread_id, anchor_id, source_task_id, git_commit
      ) VALUES ('context-1', 'thread-1', 'anchor-1', 'task-1', 'abc123');
      INSERT INTO attempts (
        id, task_id, role, model, effort, status, retry_index, started_at
      ) VALUES ('attempt-1', 'task-1', 'scout', 'gpt-5', 'high', 'running', 0, '2026-08-24T00:00:00Z');
    `);

    for (const sql of [
      "INSERT INTO weeks (id, goal, token_budget, status, created_at) VALUES (NULL, 'Goal', 1, 'active', 'now')",
      `INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES (NULL, 'week-1', 'Task', '{}', 'draft', 0, 'low', 1, 0, 0, 'now', 'now')`,
      "INSERT INTO contexts (id, thread_id, anchor_id, source_task_id, git_commit) VALUES (NULL, 'thread-2', 'anchor-2', 'task-1', 'def456')",
      "INSERT INTO attempts (id, task_id, role, model, effort, status, retry_index, started_at) VALUES (NULL, 'task-1', 'scout', 'gpt-5', 'high', 'running', 0, 'now')",
      "INSERT INTO reviews (id, task_id, attempt_id, decision, findings_json) VALUES (NULL, 'task-1', 'attempt-1', 'accepted', '[]')",
      "INSERT INTO model_decisions (id, task_id, role, model, effort, token_budget, fallback_models_json, decided_by, confidence, rationale_json) VALUES (NULL, 'task-1', 'scout', 'gpt-5', 'high', 1, '[]', 'rule', 1, '[]')",
      "INSERT INTO usage (id, week_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES (NULL, 'week-1', 'weekly_grilling', 0, 0, 0, 0)",
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
      INSERT INTO weeks (id, goal, token_budget, status, created_at)
      VALUES ('week-1', 'Ship foundation', 1000, 'active', '2026-08-24T00:00:00Z');
      INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES (
        'task-1', 'week-1', 'Foundation', '{}', 'draft', 0, 'low', 100,
        0, 0, '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      );
    `);

    const taskWithReference = (column: string, value: string) => `
      INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, ${column}, created_at, updated_at
      ) VALUES (
        'task-${column}', 'week-1', 'Follow-up', '{}', 'draft', 0, 'low', 100,
        0, 0, '${value}', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      )`;

    for (const sql of [
      taskWithReference("root_task_id", "missing-task"),
      taskWithReference("parent_task_id", "missing-task"),
      taskWithReference("discovered_from_review_id", "missing-review"),
      taskWithReference("context_id", "missing-context"),
      "INSERT INTO contexts (id, thread_id, anchor_id, source_task_id, git_commit) VALUES ('context-bad-source', 'thread', 'anchor', 'missing-task', 'abc123')",
      "INSERT INTO contexts (id, thread_id, anchor_id, source_task_id, parent_context_id, git_commit) VALUES ('context-bad-parent', 'thread', 'anchor', 'task-1', 'missing-context', 'abc123')",
      "INSERT INTO model_decisions (id, task_id, role, model, effort, token_budget, context_id, fallback_models_json, decided_by, confidence, rationale_json) VALUES ('decision-bad-context', 'task-1', 'scout', 'gpt-5', 'high', 1, 'missing-context', '[]', 'rule', 1, '[]')",
    ]) {
      expect(() => db.exec(sql)).toThrow();
    }

    expect(() => db.exec(`
      INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES (
        'task-null-lineage', 'week-1', 'Independent', '{}', 'draft', 0, 'low', 100,
        0, 0, '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      );
      INSERT INTO model_decisions (
        id, task_id, role, model, effort, token_budget, fallback_models_json,
        decided_by, confidence, rationale_json
      ) VALUES (
        'decision-null-context', 'task-1', 'scout', 'gpt-5', 'high', 1, '[]',
        'rule', 1, '[]'
      );
    `)).not.toThrow();
  } finally {
    db.close();
  }
});

test("persisted domain enums accept approved values and reject unknown values", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO weeks (id, goal, token_budget, status, created_at)
      VALUES ('week-1', 'Ship foundation', 1000, 'active', '2026-08-24T00:00:00Z');
      INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES (
        'task-1', 'week-1', 'Foundation', '{}', 'draft', 0, 'low', 100,
        0, 0, '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
      );
    `);

    for (const status of ["running", "succeeded", "failed_infra"]) {
      expect(() => db.exec(`
        INSERT INTO attempts (
          id, task_id, role, model, effort, status, retry_index, started_at
        ) VALUES (
          'attempt-${status}', 'task-1', 'scout', 'gpt-5', 'high', '${status}', 0,
          '2026-08-24T00:00:00Z'
        )
      `)).not.toThrow();
    }

    for (const sql of [
      `INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES ('task-bad-status', 'week-1', 'Bad', '{}', 'unknown', 0, 'low', 1, 0, 0, 'now', 'now')`,
      `INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES ('task-bad-risk', 'week-1', 'Bad', '{}', 'draft', 0, 'critical', 1, 0, 0, 'now', 'now')`,
      "INSERT INTO attempts (id, task_id, role, model, effort, status, retry_index, started_at) VALUES ('attempt-bad-role', 'task-1', 'manager', 'gpt-5', 'high', 'running', 0, 'now')",
      "INSERT INTO attempts (id, task_id, role, model, effort, status, retry_index, started_at) VALUES ('attempt-bad-status', 'task-1', 'scout', 'gpt-5', 'high', 'unknown', 0, 'now')",
      "INSERT INTO attempts (id, task_id, role, model, effort, status, retry_index, started_at) VALUES ('attempt-low', 'task-1', 'scout', 'gpt-5', 'low', 'running', 0, 'now')",
      "INSERT INTO model_decisions (id, task_id, role, model, effort, token_budget, fallback_models_json, decided_by, confidence, rationale_json) VALUES ('decision-bad-role', 'task-1', 'manager', 'gpt-5', 'high', 1, '[]', 'rule', 1, '[]')",
      "INSERT INTO model_decisions (id, task_id, role, model, effort, token_budget, fallback_models_json, decided_by, confidence, rationale_json) VALUES ('decision-bad-decider', 'task-1', 'scout', 'gpt-5', 'high', 1, '[]', 'human', 1, '[]')",
      "INSERT INTO model_decisions (id, task_id, role, model, effort, token_budget, fallback_models_json, decided_by, confidence, rationale_json) VALUES ('decision-low', 'task-1', 'scout', 'gpt-5', 'low', 1, '[]', 'rule', 1, '[]')",
    ]) {
      expect(() => db.exec(sql)).toThrow();
    }
  } finally {
    db.close();
  }
});

test("reviews and usage preserve task and week attribution", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO weeks (id, goal, token_budget, status, created_at) VALUES
        ('week-1', 'First week', 1000, 'active', '2026-08-24T00:00:00Z'),
        ('week-2', 'Second week', 1000, 'active', '2026-08-31T00:00:00Z');
      INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES
        ('task-1', 'week-1', 'First task', '{}', 'draft', 0, 'low', 100, 0, 0, 'now', 'now'),
        ('task-2', 'week-2', 'Second task', '{}', 'draft', 0, 'low', 100, 0, 0, 'now', 'now');
      INSERT INTO attempts (
        id, task_id, role, model, effort, status, retry_index, started_at
      ) VALUES (
        'attempt-1', 'task-1', 'scout', 'gpt-5', 'high', 'succeeded', 0, 'now'
      );
      INSERT INTO model_decisions (
        id, task_id, role, model, effort, token_budget, fallback_models_json,
        decided_by, confidence, rationale_json
      ) VALUES (
        'decision-1', 'task-1', 'scout', 'gpt-5', 'high', 10, '[]', 'rule', 1, '[]'
      );
    `);

    for (const sql of [
      "INSERT INTO reviews (id, task_id, attempt_id, decision, findings_json) VALUES ('review-wrong-task', 'task-2', 'attempt-1', 'accepted', '[]')",
      "INSERT INTO usage (id, week_id, task_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES ('usage-wrong-week', 'week-2', 'task-1', 'ticket_grilling', 0, 0, 0, 0)",
      "INSERT INTO usage (id, week_id, task_id, attempt_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES ('usage-wrong-attempt', 'week-2', 'task-2', 'attempt-1', 'scout', 0, 0, 0, 0)",
      "INSERT INTO usage (id, week_id, task_id, model_decision_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES ('usage-wrong-decision', 'week-2', 'task-2', 'decision-1', 'advisor', 0, 0, 0, 0)",
      "INSERT INTO usage (id, week_id, attempt_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES ('usage-attempt-without-task', 'week-1', 'attempt-1', 'scout', 0, 0, 0, 0)",
      "INSERT INTO usage (id, week_id, model_decision_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens) VALUES ('usage-decision-without-task', 'week-1', 'decision-1', 'advisor', 0, 0, 0, 0)",
      "INSERT INTO usage (id, week_id, category, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, cost) VALUES ('usage-negative-cost', 'week-1', 'weekly_grilling', 0, 0, 0, 0, -0.01)",
    ]) {
      expect(() => db.exec(sql)).toThrow();
    }

    expect(() => db.exec(`
      INSERT INTO reviews (id, task_id, attempt_id, decision, findings_json)
      VALUES ('review-valid', 'task-1', 'attempt-1', 'accepted', '[]');
      INSERT INTO usage (
        id, week_id, category, input_tokens, cached_input_tokens, output_tokens,
        reasoning_output_tokens
      ) VALUES ('usage-week', 'week-1', 'weekly_grilling', 0, 0, 0, 0);
      INSERT INTO usage (
        id, week_id, task_id, category, input_tokens, cached_input_tokens,
        output_tokens, reasoning_output_tokens, cost
      ) VALUES ('usage-task', 'week-1', 'task-1', 'ticket_grilling', 0, 0, 0, 0, 0);
      INSERT INTO usage (
        id, week_id, task_id, attempt_id, category, input_tokens,
        cached_input_tokens, output_tokens, reasoning_output_tokens
      ) VALUES ('usage-attempt', 'week-1', 'task-1', 'attempt-1', 'scout', 0, 0, 0, 0);
      INSERT INTO usage (
        id, week_id, task_id, model_decision_id, category, input_tokens,
        cached_input_tokens, output_tokens, reasoning_output_tokens
      ) VALUES ('usage-decision', 'week-1', 'task-1', 'decision-1', 'advisor', 0, 0, 0, 0);
    `)).not.toThrow();
  } finally {
    db.close();
  }
});

test("events reject attempts attributed to a different or missing task", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO weeks (id, goal, token_budget, status, created_at)
      VALUES ('week-1', 'Ship foundation', 1000, 'active', 'now');
      INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES
        ('task-1', 'week-1', 'First', '{}', 'draft', 0, 'low', 100, 0, 0, 'now', 'now'),
        ('task-2', 'week-1', 'Second', '{}', 'draft', 1, 'low', 100, 0, 0, 'now', 'now');
      INSERT INTO attempts (
        id, task_id, role, model, effort, status, retry_index, started_at
      ) VALUES ('attempt-1', 'task-1', 'scout', 'gpt-5', 'high', 'running', 0, 'now');
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
      INSERT INTO weeks (id, goal, token_budget, status, created_at)
      VALUES ('week-1', 'Ship foundation', 1000, 'active', 'now');
      INSERT INTO tasks (
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES ('task-1', 'week-1', 'First', '{}', 'draft', 0, 'low', 100, 0, 0, 'now', 'now');
      INSERT INTO attempts (
        id, task_id, role, model, effort, status, retry_index, started_at
      ) VALUES ('attempt-1', 'task-1', 'scout', 'gpt-5', 'high', 'running', 0, 'now');
    `);

    expect(() => db.exec(`
      INSERT INTO events (idempotency_key, type, payload_json, occurred_at)
      VALUES ('event-global', 'week.started', '{}', 'now');
      INSERT INTO events (idempotency_key, task_id, type, payload_json, occurred_at)
      VALUES ('event-task', 'task-1', 'task.created', '{}', 'now');
      INSERT INTO events (idempotency_key, task_id, attempt_id, type, payload_json, occurred_at)
      VALUES ('event-attempt', 'task-1', 'attempt-1', 'attempt.started', '{}', 'now');
    `)).not.toThrow();
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(3);
  } finally {
    db.close();
  }
});

test("database initialization closes its handle before rethrowing", () => {
  const directory = mkdtempSync(join(tmpdir(), "agile-agents-db-"));
  const path = join(directory, "future.sqlite");
  const future = new Database(path, { create: true });
  future.exec("PRAGMA user_version = 3");
  future.close();

  const close = spyOn(Database.prototype, "close");
  try {
    expect(() => openDatabase(path)).toThrow(
      "Database version 3 is newer than supported version 2",
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
      expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    } finally {
      db.close();
    }

    const reopened = openDatabase(path);
    try {
      expect(reopened.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deferred context references permit an atomic task and context cycle", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`
      INSERT INTO weeks (id, goal, token_budget, status, created_at)
      VALUES ('week-1', 'Ship foundation', 1000, 'active', '2026-08-24T00:00:00Z');
    `);

    expect(() => db.transaction(() => {
      db.exec(`
        INSERT INTO contexts (
          id, thread_id, anchor_id, source_task_id, git_commit
        ) VALUES (
          'context-1', 'thread-1', 'anchor-1', 'task-1', 'abc123'
        );
        INSERT INTO tasks (
          id, week_id, title, spec_json, status, priority, risk, token_ceiling,
          approval_required, approved, context_id, created_at, updated_at
        ) VALUES (
          'task-1', 'week-1', 'Foundation', '{}', 'draft', 0, 'low', 100,
          0, 0, 'context-1', '2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z'
        );
      `);
    })()).not.toThrow();
  } finally {
    db.close();
  }
});
