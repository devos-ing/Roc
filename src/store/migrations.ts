import type { Database } from "bun:sqlite";

const migration1 = `
CREATE TABLE weeks (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  token_budget INTEGER NOT NULL CHECK(token_budget > 0),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES weeks(id),
  title TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  spec_path TEXT,
  spec_hash TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK(priority >= 0),
  risk TEXT NOT NULL,
  token_ceiling INTEGER NOT NULL CHECK(token_ceiling > 0),
  approval_required INTEGER NOT NULL CHECK(approval_required IN (0, 1)),
  approved INTEGER NOT NULL CHECK(approved IN (0, 1)),
  root_task_id TEXT,
  parent_task_id TEXT,
  discovered_from_review_id TEXT,
  context_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  PRIMARY KEY(task_id, depends_on_task_id, kind)
);
CREATE TABLE contexts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  anchor_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL,
  parent_context_id TEXT,
  git_commit TEXT NOT NULL,
  summary_artifact TEXT
);
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL CHECK(effort IN ('medium', 'high', 'xhigh')),
  status TEXT NOT NULL,
  thread_id TEXT,
  retry_index INTEGER NOT NULL CHECK(retry_index BETWEEN 0 AND 2),
  git_commit TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  decision TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected')),
  findings_json TEXT NOT NULL
);
CREATE TABLE model_decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL CHECK(effort IN ('medium', 'high', 'xhigh')),
  token_budget INTEGER NOT NULL CHECK(token_budget > 0),
  context_id TEXT,
  fallback_models_json TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  rationale_json TEXT NOT NULL
);
CREATE TABLE usage (
  id TEXT PRIMARY KEY,
  week_id TEXT NOT NULL REFERENCES weeks(id),
  task_id TEXT REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  model_decision_id TEXT REFERENCES model_decisions(id),
  category TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK(cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  reasoning_output_tokens INTEGER NOT NULL CHECK(reasoning_output_tokens >= 0),
  cost REAL
);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  task_id TEXT REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
`;

export function migrate(db: Database): void {
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  if (version > 1) throw new Error(`Database version ${version} is newer than supported version 1`);
  if (version === 0) {
    db.transaction(() => {
      db.exec(migration1);
      db.exec("PRAGMA user_version = 1");
    })();
  }
}
