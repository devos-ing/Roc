import type { Database } from "bun:sqlite";

const migration1 = `
CREATE TABLE weeks (
  id TEXT PRIMARY KEY NOT NULL,
  goal TEXT NOT NULL,
  token_budget INTEGER NOT NULL CHECK(token_budget > 0),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  week_id TEXT NOT NULL REFERENCES weeks(id),
  title TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_path TEXT,
  spec_hash TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'draft', 'needs_input', 'needs_replan', 'ready', 'claimed', 'scouting',
    'implementing', 'reviewing', 'done', 'rejected', 'failed_infra'
  )),
  priority INTEGER NOT NULL CHECK(priority >= 0),
  risk TEXT NOT NULL CHECK(risk IN ('low', 'medium', 'high')),
  token_ceiling INTEGER NOT NULL CHECK(token_ceiling > 0),
  approval_required INTEGER NOT NULL CHECK(approval_required IN (0, 1)),
  approved INTEGER NOT NULL CHECK(approved IN (0, 1)),
  root_task_id TEXT REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  parent_task_id TEXT REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  discovered_from_review_id TEXT REFERENCES reviews(id) DEFERRABLE INITIALLY DEFERRED,
  context_id TEXT REFERENCES contexts(id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(week_id, id)
);
CREATE TABLE task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  PRIMARY KEY(task_id, depends_on_task_id, kind)
);
CREATE TABLE contexts (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL,
  anchor_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  parent_context_id TEXT REFERENCES contexts(id) DEFERRABLE INITIALLY DEFERRED,
  git_commit TEXT NOT NULL,
  summary_artifact TEXT
);
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
  UNIQUE(task_id, id)
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected')),
  findings_json TEXT NOT NULL,
  FOREIGN KEY(task_id, attempt_id) REFERENCES attempts(task_id, id)
    DEFERRABLE INITIALLY DEFERRED
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
CREATE TABLE usage (
  id TEXT PRIMARY KEY NOT NULL,
  week_id TEXT NOT NULL REFERENCES weeks(id),
  task_id TEXT REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  model_decision_id TEXT REFERENCES model_decisions(id),
  category TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK(cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  reasoning_output_tokens INTEGER NOT NULL CHECK(reasoning_output_tokens >= 0),
  cost REAL CHECK(cost IS NULL OR cost >= 0),
  CHECK(attempt_id IS NULL OR task_id IS NOT NULL),
  CHECK(model_decision_id IS NULL OR task_id IS NOT NULL),
  FOREIGN KEY(week_id, task_id) REFERENCES tasks(week_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(task_id, attempt_id) REFERENCES attempts(task_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(task_id, model_decision_id) REFERENCES model_decisions(task_id, id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_id TEXT REFERENCES tasks(id),
  attempt_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  CHECK(attempt_id IS NULL OR task_id IS NOT NULL),
  FOREIGN KEY(task_id, attempt_id) REFERENCES attempts(task_id, id)
    DEFERRABLE INITIALLY DEFERRED
);
`;

const migration2 = `
ALTER TABLE attempts ADD COLUMN backend_cursor TEXT;
CREATE TABLE scheduler_lease (
  lease_key TEXT PRIMARY KEY NOT NULL CHECK(lease_key = 'scheduler'),
  owner_id TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tasks_one_followup_per_review
  ON tasks(discovered_from_review_id)
  WHERE discovered_from_review_id IS NOT NULL;
`;

const migration3 = `
ALTER TABLE tasks ADD COLUMN base_commit TEXT;

CREATE TABLE attempts_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL CHECK(role IN ('scout', 'implement', 'review')),
  model TEXT NOT NULL,
  model_profile TEXT NOT NULL CHECK(model_profile IN ('luna', 'terra', 'sol')),
  effort TEXT NOT NULL CHECK(effort IN ('medium', 'high', 'xhigh')),
  status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed_infra', 'blocked_policy')),
  thread_id TEXT,
  turn_id TEXT,
  retry_index INTEGER NOT NULL CHECK(retry_index BETWEEN 0 AND 2),
  git_commit TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  backend_cursor TEXT,
  UNIQUE(task_id, id)
);
INSERT INTO attempts_v3(
  id, task_id, role, model, model_profile, effort, status, thread_id, turn_id,
  retry_index, git_commit, started_at, ended_at, backend_cursor
)
SELECT
  id, task_id, role, model, model, effort, status, thread_id, NULL,
  retry_index, git_commit, started_at, ended_at, backend_cursor
FROM attempts;
DROP TABLE attempts;
ALTER TABLE attempts_v3 RENAME TO attempts;

CREATE TABLE model_decisions_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL CHECK(role IN ('scout', 'implement', 'review')),
  model TEXT NOT NULL,
  model_profile TEXT NOT NULL CHECK(model_profile IN ('luna', 'terra', 'sol')),
  effort TEXT NOT NULL CHECK(effort IN ('medium', 'high', 'xhigh')),
  token_budget INTEGER NOT NULL CHECK(token_budget > 0),
  context_id TEXT REFERENCES contexts(id) DEFERRABLE INITIALLY DEFERRED,
  fallback_models_json TEXT NOT NULL,
  decided_by TEXT NOT NULL CHECK(decided_by IN ('rule', 'advisor-llm', 'fallback')),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  rationale_json TEXT NOT NULL,
  UNIQUE(task_id, id)
);
INSERT INTO model_decisions_v3(
  id, task_id, role, model, model_profile, effort, token_budget, context_id,
  fallback_models_json, decided_by, confidence, rationale_json
)
SELECT
  id, task_id, role, model, model, effort, token_budget, context_id,
  fallback_models_json, decided_by, confidence, rationale_json
FROM model_decisions;
DROP TABLE model_decisions;
ALTER TABLE model_decisions_v3 RENAME TO model_decisions;
`;

const migration4 = `
ALTER TABLE weeks RENAME TO cycles;
ALTER TABLE tasks RENAME COLUMN week_id TO cycle_id;
ALTER TABLE usage RENAME COLUMN week_id TO cycle_id;
UPDATE usage SET category = 'cycle_grilling' WHERE category = 'weekly_grilling';
`;

const migration5 = `
CREATE TABLE task_hooks (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  phase TEXT NOT NULL CHECK(phase IN ('prehook', 'posthook')),
  config_hash TEXT NOT NULL,
  trusted_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),
  workspace_path TEXT,
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  signal TEXT,
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK(timed_out IN (0, 1)),
  stdout TEXT,
  stderr TEXT,
  PRIMARY KEY(task_id, phase)
);
`;

const migration6 = `
CREATE TABLE tasks_v6 (
  id TEXT PRIMARY KEY NOT NULL,
  cycle_id TEXT NOT NULL REFERENCES cycles(id),
  title TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_path TEXT,
  spec_hash TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'draft', 'needs_input', 'needs_replan', 'ready', 'claimed', 'scouting',
    'implementing', 'reviewing', 'publishing', 'done', 'rejected', 'failed_infra'
  )),
  priority INTEGER NOT NULL CHECK(priority >= 0),
  risk TEXT NOT NULL CHECK(risk IN ('low', 'medium', 'high')),
  token_ceiling INTEGER NOT NULL CHECK(token_ceiling > 0),
  approval_required INTEGER NOT NULL CHECK(approval_required IN (0, 1)),
  approved INTEGER NOT NULL CHECK(approved IN (0, 1)),
  root_task_id TEXT REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  parent_task_id TEXT REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  discovered_from_review_id TEXT REFERENCES reviews(id) DEFERRABLE INITIALLY DEFERRED,
  context_id TEXT REFERENCES contexts(id) DEFERRABLE INITIALLY DEFERRED,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  base_commit TEXT,
  UNIQUE(cycle_id, id)
);
INSERT INTO tasks_v6(
  id, cycle_id, title, spec_json, spec_path, spec_hash, status, priority, risk,
  token_ceiling, approval_required, approved, root_task_id, parent_task_id,
  discovered_from_review_id, context_id, created_at, updated_at, base_commit
)
SELECT
  id, cycle_id, title, spec_json, spec_path, spec_hash, status, priority, risk,
  token_ceiling, approval_required, approved, root_task_id, parent_task_id,
  discovered_from_review_id, context_id, created_at, updated_at, base_commit
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v6 RENAME TO tasks;
CREATE UNIQUE INDEX tasks_one_followup_per_review
  ON tasks(discovered_from_review_id)
  WHERE discovered_from_review_id IS NOT NULL;

CREATE TABLE task_publications (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'published', 'failed')),
  pull_request_number INTEGER,
  pull_request_url TEXT,
  pull_request_state TEXT CHECK(pull_request_state IN ('OPEN', 'MERGED')),
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Migrates a database transactionally through every supported schema version. */
export function migrate(db: Database): void {
  let version =
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()
      ?.user_version ?? 0;
  if (version > 6)
    throw new Error(
      `Database version ${version} is newer than supported version 6`,
    );
  if (version === 0) {
    db.transaction(() => {
      db.exec(migration1);
      db.exec("PRAGMA user_version = 1");
    })();
    version = 1;
  }
  if (version === 1) {
    db.transaction(() => {
      db.exec(migration2);
      db.exec("PRAGMA user_version = 2");
    })();
    version = 2;
  }
  if (version === 2) {
    const legacy = db
      .query<{ model: string }, []>(`
      SELECT model
      FROM (
        SELECT model, 0 AS source FROM attempts
        UNION ALL
        SELECT model, 1 AS source FROM model_decisions
      )
      WHERE model NOT IN ('luna', 'terra', 'sol')
      ORDER BY source, model
      LIMIT 1
    `)
      .get();
    if (legacy)
      throw new Error(`Cannot map legacy model profile: ${legacy.model}`);

    const foreignKeys =
      db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
        ?.foreign_keys ?? 0;
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(migration3);
        const violation = db
          .query<
            {
              table: string;
              rowid: number | null;
              parent: string;
              fkid: number;
            },
            []
          >("PRAGMA foreign_key_check")
          .get();
        if (violation) {
          throw new Error(
            `Foreign key check failed during migration 3: ${violation.table} row ${violation.rowid ?? "unknown"}`,
          );
        }
        db.exec("PRAGMA user_version = 3");
      })();
    } finally {
      db.exec(
        foreignKeys === 0
          ? "PRAGMA foreign_keys = OFF"
          : "PRAGMA foreign_keys = ON",
      );
    }
    version = 3;
  }
  if (version === 3) {
    db.transaction(() => {
      db.exec(migration4);
      const violation = db
        .query<
          {
            table: string;
            rowid: number | null;
            parent: string;
            fkid: number;
          },
          []
        >("PRAGMA foreign_key_check")
        .get();
      if (violation) {
        throw new Error(
          `Foreign key check failed during migration 4: ${violation.table} row ${violation.rowid ?? "unknown"}`,
        );
      }
      db.exec("PRAGMA user_version = 4");
    })();
    version = 4;
  }
  if (version === 4) {
    db.transaction(() => {
      db.exec(migration5);
      db.exec("PRAGMA user_version = 5");
    })();
    version = 5;
  }
  if (version === 5) {
    const foreignKeys =
      db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
        ?.foreign_keys ?? 0;
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(migration6);
        const violation = db
          .query<
            {
              table: string;
              rowid: number | null;
              parent: string;
              fkid: number;
            },
            []
          >("PRAGMA foreign_key_check")
          .get();
        if (violation) {
          throw new Error(
            `Foreign key check failed during migration 6: ${violation.table} row ${violation.rowid ?? "unknown"}`,
          );
        }
        db.exec("PRAGMA user_version = 6");
      })();
    } finally {
      db.exec(
        foreignKeys === 0
          ? "PRAGMA foreign_keys = OFF"
          : "PRAGMA foreign_keys = ON",
      );
    }
  }
}
