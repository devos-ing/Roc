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

export function migrate(db: Database): void {
  let version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  if (version > 2) throw new Error(`Database version ${version} is newer than supported version 2`);
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
  }
}
