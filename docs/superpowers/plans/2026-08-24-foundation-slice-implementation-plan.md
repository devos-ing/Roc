# Foundation Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested Bun CLI foundation that validates weekly/task contracts, persists them in SQLite, enforces task-state transitions, and renders versionable Markdown artifacts.

**Architecture:** Domain schemas and transitions remain pure. `store/` owns all `bun:sqlite` writes, `artifacts/` owns deterministic Markdown output, and `cli/` composes those boundaries. This slice does not start Codex, schedule agents, or implement the TUI.

**Tech Stack:** Bun, TypeScript, Zod 4, `bun:sqlite`, `node:util.parseArgs`, Bun Test.

---

## File map

```text
package.json                         project metadata and scripts
tsconfig.json                        strict TypeScript configuration
src/cli/main.ts                      executable entry point
src/cli/help.ts                      static CLI help
src/cli/run.ts                       parsed CLI commands and I/O boundary
src/domain/schemas.ts                Zod contracts and inferred types
src/domain/transitions.ts            pure task-state rules
src/store/database.ts                database construction and pragmas
src/store/migrations.ts              versioned SQLite schema
src/store/planning-repository.ts     week/task persistence and events
src/artifacts/writer.ts              deterministic Markdown artifacts
test/cli/help.test.ts                help contract
test/cli/run.test.ts                 CLI vertical-slice tests
test/domain/schemas.test.ts          schema invariants
test/domain/transitions.test.ts      state-machine invariants
test/store/database.test.ts          migration contract
test/store/planning-repository.test.ts repository transactions
test/artifacts/writer.test.ts        artifact output and hashing
```

### Task 1: F1 — Project scaffold and CLI help

**Execution profile:** Scout Luna + high; Implement Luna + high; Review Sol + high.

**Why:** The output is fully specified and isolated from domain behavior.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/cli/help.ts`
- Create: `src/cli/main.ts`
- Create: `test/cli/help.test.ts`

- [ ] **Step 1: Write the failing help test**

```ts
import { expect, test } from "bun:test";
import { helpText } from "../../src/cli/help";

test("help lists the foundation commands", () => {
  expect(helpText).toContain("agile init");
  expect(helpText).toContain("agile task list");
  expect(helpText).not.toContain("--low");
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `bun test test/cli/help.test.ts`

Expected: FAIL because `src/cli/help.ts` does not exist.

- [ ] **Step 3: Add Bun/TypeScript configuration and the minimal CLI**

`package.json`:

```json
{
  "name": "agile-agents",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "agile": "./src/cli/main.ts" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "check": "bun run typecheck && bun test"
  },
  "dependencies": { "zod": "^4.0.0" },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "latest"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "types": ["bun"]
  },
  "include": ["src", "test"]
}
```

`src/cli/help.ts`:

```ts
export const helpText = `agile - local agent development orchestrator

Usage:
  agile init [--db PATH]
  agile task list [--db PATH]
  agile help
`;
```

`src/cli/main.ts`:

```ts
#!/usr/bin/env bun
import { helpText } from "./help";

if (import.meta.main) {
  process.stdout.write(helpText);
}
```

Run: `bun install`

Expected: dependencies install and `bun.lock` is created.

- [ ] **Step 4: Verify the scaffold**

Run: `bun test test/cli/help.test.ts`

Expected: 1 pass, 0 fail.

Run: `bun run typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock tsconfig.json src/cli/help.ts src/cli/main.ts test/cli/help.test.ts
git commit -m "chore: scaffold Bun CLI"
```

### Task 2: F2 — Domain and Zod contracts

**Execution profile:** Scout Luna + high; Implement Terra + high; Review Sol + high.

**Why:** These schemas become contracts for every later subsystem, but the implementation is bounded TypeScript.

**Files:**
- Create: `src/domain/schemas.ts`
- Create: `test/domain/schemas.test.ts`

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  ModelDecisionSchema,
  TicketSpecSchema,
  WeeklyPlanSchema,
} from "../../src/domain/schemas";

const ticket = {
  problem: "Tasks can be claimed twice",
  desiredOutcome: "Exactly one worker owns a task",
  scope: ["atomic claim"],
  nonGoals: ["distributed scheduling"],
  acceptanceCriteria: ["two claim attempts yield one owner"],
  validation: ["bun test test/store/claim.test.ts"],
  dependencies: [],
  risk: "high",
  contextCandidates: [],
  tokenCeiling: 60_000,
};

describe("domain schemas", () => {
  test("accepts a complete ticket", () => {
    expect(TicketSpecSchema.parse(ticket)).toEqual(ticket);
  });

  test("rejects an empty acceptance list", () => {
    expect(() => TicketSpecSchema.parse({ ...ticket, acceptanceCriteria: [] })).toThrow();
  });

  test("rejects low reasoning effort", () => {
    expect(() => ModelDecisionSchema.parse({
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
      tokenBudget: 20_000,
      fallbackModels: [],
      decidedBy: "rule",
      confidence: 1,
      rationale: ["bounded task"],
    })).toThrow();
  });

  test("accepts an ISO week plan", () => {
    expect(WeeklyPlanSchema.parse({
      id: "2026-W35",
      goal: "Ship the foundation slice",
      nonGoals: ["Codex integration"],
      tokenBudget: 500_000,
      ticketIds: ["F1"],
    }).id).toBe("2026-W35");
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing module failure**

Run: `bun test test/domain/schemas.test.ts`

Expected: FAIL because `src/domain/schemas.ts` does not exist.

- [ ] **Step 3: Implement the complete foundation contracts**

```ts
import { z } from "zod";

const NonEmpty = z.string().trim().min(1);

export const TaskStatusSchema = z.enum([
  "draft",
  "needs_input",
  "needs_replan",
  "ready",
  "claimed",
  "scouting",
  "implementing",
  "reviewing",
  "done",
  "rejected",
  "failed_infra",
]);

export const ContextRefSchema = z.object({
  threadId: NonEmpty,
  anchorId: NonEmpty,
  sourceTaskId: NonEmpty,
  gitCommit: NonEmpty,
  summaryArtifact: NonEmpty.optional(),
}).strict();

export const TicketSpecSchema = z.object({
  problem: NonEmpty,
  desiredOutcome: NonEmpty,
  scope: z.array(NonEmpty).min(1),
  nonGoals: z.array(NonEmpty),
  acceptanceCriteria: z.array(NonEmpty).min(1),
  validation: z.array(NonEmpty).min(1),
  dependencies: z.array(NonEmpty),
  risk: z.enum(["low", "medium", "high"]),
  contextCandidates: z.array(ContextRefSchema),
  tokenCeiling: z.number().int().positive(),
}).strict();

export const WeeklyPlanSchema = z.object({
  id: z.string().regex(/^\d{4}-W\d{2}$/),
  goal: NonEmpty,
  nonGoals: z.array(NonEmpty),
  tokenBudget: z.number().int().positive(),
  ticketIds: z.array(NonEmpty),
}).strict();

export const TaskCreateSchema = z.object({
  id: NonEmpty,
  weekId: WeeklyPlanSchema.shape.id,
  title: NonEmpty,
  spec: TicketSpecSchema,
  priority: z.number().int().min(0),
  approvalRequired: z.boolean(),
  approved: z.boolean(),
}).strict();

export const StoredTaskSchema = TaskCreateSchema.extend({
  status: TaskStatusSchema,
  specPath: NonEmpty.optional(),
  specHash: NonEmpty.optional(),
}).strict();

export const ModelDecisionSchema = z.object({
  model: NonEmpty,
  reasoningEffort: z.enum(["medium", "high", "xhigh"]),
  tokenBudget: z.number().int().positive(),
  contextRef: ContextRefSchema.optional(),
  fallbackModels: z.array(NonEmpty),
  decidedBy: z.enum(["rule", "advisor-llm", "fallback"]),
  confidence: z.number().min(0).max(1),
  rationale: z.array(NonEmpty).min(1),
}).strict();

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TicketSpec = z.infer<typeof TicketSpecSchema>;
export type WeeklyPlan = z.infer<typeof WeeklyPlanSchema>;
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type StoredTask = z.infer<typeof StoredTaskSchema>;
export type ModelDecision = z.infer<typeof ModelDecisionSchema>;
```

- [ ] **Step 4: Verify schemas and type checking**

Run: `bun test test/domain/schemas.test.ts`

Expected: 4 pass, 0 fail.

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain/schemas.ts test/domain/schemas.test.ts
git commit -m "feat: define orchestration domain contracts"
```

### Task 3: F3 — Task-state transition function

**Execution profile:** Scout Luna + high; Implement Sol + xhigh; Review Sol + xhigh.

**Why:** Terminal states, allowed recovery states, and the no-loop invariant are product-critical.

**Files:**
- Create: `src/domain/transitions.ts`
- Create: `test/domain/transitions.test.ts`

- [ ] **Step 1: Write failing transition tests**

```ts
import { describe, expect, test } from "bun:test";
import { assertTransition, canTransition, isTerminal } from "../../src/domain/transitions";

describe("task transitions", () => {
  test("allows the happy path", () => {
    expect(canTransition("draft", "ready")).toBe(true);
    expect(canTransition("ready", "claimed")).toBe(true);
    expect(canTransition("reviewing", "done")).toBe(true);
  });

  test("permits ready tasks to return for input or replanning", () => {
    expect(canTransition("ready", "needs_input")).toBe(true);
    expect(canTransition("ready", "needs_replan")).toBe(true);
  });

  test("never reopens terminal tasks", () => {
    for (const status of ["done", "rejected", "failed_infra"] as const) {
      expect(isTerminal(status)).toBe(true);
      expect(canTransition(status, "ready")).toBe(false);
    }
  });

  test("throws a descriptive error for an invalid transition", () => {
    expect(() => assertTransition("rejected", "ready")).toThrow(
      "Invalid task transition: rejected -> ready",
    );
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing module failure**

Run: `bun test test/domain/transitions.test.ts`

Expected: FAIL because `src/domain/transitions.ts` does not exist.

- [ ] **Step 3: Implement the explicit transition graph**

```ts
import type { TaskStatus } from "./schemas";

const allowed: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["needs_input", "needs_replan", "ready"],
  needs_input: ["draft"],
  needs_replan: ["draft"],
  ready: ["needs_input", "needs_replan", "claimed"],
  claimed: ["scouting", "failed_infra"],
  scouting: ["implementing", "failed_infra"],
  implementing: ["reviewing", "failed_infra"],
  reviewing: ["done", "rejected", "failed_infra"],
  done: [],
  rejected: [],
  failed_infra: [],
};

const terminal = new Set<TaskStatus>(["done", "rejected", "failed_infra"]);

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return allowed[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return terminal.has(status);
}
```

- [ ] **Step 4: Verify the state machine**

Run: `bun test test/domain/transitions.test.ts`

Expected: 4 pass, 0 fail.

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/domain/transitions.ts test/domain/transitions.test.ts
git commit -m "feat: enforce task state transitions"
```

### Task 4: F4 — SQLite migration

**Execution profile:** Scout Luna + high; Implement Sol + xhigh; Review Sol + xhigh.

**Why:** Later concurrency, lineage, and usage guarantees depend on a durable schema with correct keys.

**Files:**
- Create: `src/store/migrations.ts`
- Create: `src/store/database.ts`
- Create: `test/store/database.test.ts`

- [ ] **Step 1: Write the failing migration test**

```ts
import { expect, test } from "bun:test";
import { openDatabase } from "../../src/store/database";

test("migration creates every approved table", () => {
  const db = openDatabase(":memory:");
  const rows = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all();
  const names = rows.map((row) => row.name);

  for (const name of [
    "attempts", "contexts", "events", "model_decisions", "reviews",
    "task_deps", "tasks", "usage", "weeks",
  ]) {
    expect(names).toContain(name);
  }
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
  db.close();
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `bun test test/store/database.test.ts`

Expected: FAIL because `src/store/database.ts` does not exist.

- [ ] **Step 3: Implement migration version 1**

`src/store/migrations.ts`:

```ts
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
```

`src/store/database.ts`:

```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrations";

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}
```

- [ ] **Step 4: Verify migration and all earlier tests**

Run: `bun test test/store/database.test.ts`

Expected: 1 pass, 0 fail.

Run: `bun run check`

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/store/migrations.ts src/store/database.ts test/store/database.test.ts
git commit -m "feat: add orchestration database schema"
```

### Task 5: F5 — Planning repository and audit events

**Execution profile:** Scout Luna + high; Implement Terra + high; Review Sol + high.

**Why:** The transition rules already exist; this task applies them in one local transaction.

**Files:**
- Create: `src/store/planning-repository.ts`
- Create: `test/store/planning-repository.test.ts`

- [ ] **Step 1: Write the failing repository test**

```ts
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

test("creates a week and task and audits a valid transition", () => {
  const db = openDatabase(":memory:");
  const repo = new PlanningRepository(db, () => "2026-08-24T00:00:00.000Z");
  repo.createWeek({
    id: "2026-W35", goal: "Foundation", nonGoals: [], tokenBudget: 100_000, ticketIds: ["F1"],
  });
  repo.createTask({
    id: "F1", weekId: "2026-W35", title: "Repository", spec,
    priority: 0, approvalRequired: false, approved: true,
  });
  repo.transitionTask("F1", "ready", "test:F1:ready");

  expect(repo.listTasks()).toMatchObject([{ id: "F1", status: "ready", spec }]);
  expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(1);
  expect(() => repo.transitionTask("F1", "done", "test:F1:done")).toThrow(
    "Invalid task transition: ready -> done",
  );
  db.close();
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `bun test test/store/planning-repository.test.ts`

Expected: FAIL because `src/store/planning-repository.ts` does not exist.

- [ ] **Step 3: Implement the repository**

```ts
import type { Database } from "bun:sqlite";
import {
  StoredTaskSchema,
  TaskCreateSchema,
  WeeklyPlanSchema,
  type StoredTask,
  type TaskCreate,
  type TaskStatus,
  type WeeklyPlan,
} from "../domain/schemas";
import { assertTransition } from "../domain/transitions";

type TaskRow = {
  id: string;
  week_id: string;
  title: string;
  spec_json: string;
  spec_path: string | null;
  spec_hash: string | null;
  status: TaskStatus;
  priority: number;
  approval_required: number;
  approved: number;
};

export class PlanningRepository {
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createWeek(input: WeeklyPlan): void {
    const plan = WeeklyPlanSchema.parse(input);
    this.db.query(`
      INSERT INTO weeks(id, goal, token_budget, status, created_at)
      VALUES($id, $goal, $tokenBudget, 'draft', $now)
    `).run({ $id: plan.id, $goal: plan.goal, $tokenBudget: plan.tokenBudget, $now: this.now() });
  }

  createTask(input: TaskCreate): void {
    const task = TaskCreateSchema.parse(input);
    const now = this.now();
    this.db.query(`
      INSERT INTO tasks(
        id, week_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES(
        $id, $weekId, $title, $spec, 'draft', $priority, $risk, $tokenCeiling,
        $approvalRequired, $approved, $now, $now
      )
    `).run({
      $id: task.id,
      $weekId: task.weekId,
      $title: task.title,
      $spec: JSON.stringify(task.spec),
      $priority: task.priority,
      $risk: task.spec.risk,
      $tokenCeiling: task.spec.tokenCeiling,
      $approvalRequired: Number(task.approvalRequired),
      $approved: Number(task.approved),
      $now: now,
    });
  }

  listTasks(): StoredTask[] {
    const rows = this.db.query<TaskRow, []>(`
      SELECT id, week_id, title, spec_json, spec_path, spec_hash, status,
             priority, approval_required, approved
      FROM tasks ORDER BY priority, id
    `).all();
    return rows.map((row) => StoredTaskSchema.parse({
      id: row.id,
      weekId: row.week_id,
      title: row.title,
      spec: JSON.parse(row.spec_json),
      status: row.status,
      priority: row.priority,
      approvalRequired: Boolean(row.approval_required),
      approved: Boolean(row.approved),
      specPath: row.spec_path ?? undefined,
      specHash: row.spec_hash ?? undefined,
    }));
  }

  transitionTask(id: string, to: TaskStatus, idempotencyKey: string): void {
    this.db.transaction(() => {
      const row = this.db.query<{ status: TaskStatus }, [string]>(
        "SELECT status FROM tasks WHERE id = ?",
      ).get(id);
      if (!row) throw new Error(`Task not found: ${id}`);
      assertTransition(row.status, to);
      const now = this.now();
      this.db.query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(to, now, id);
      this.db.query(`
        INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
        VALUES(?, ?, 'task.status_changed', ?, ?)
      `).run(idempotencyKey, id, JSON.stringify({ from: row.status, to }), now);
    })();
  }
}
```

- [ ] **Step 4: Verify repository behavior**

Run: `bun test test/store/planning-repository.test.ts`

Expected: 1 pass, 0 fail.

Run: `bun run check`

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/store/planning-repository.ts test/store/planning-repository.test.ts
git commit -m "feat: persist plans and audited task transitions"
```

### Task 6: F6 — Markdown artifact writer

**Execution profile:** Scout Luna + high; Implement Luna + high; Review Sol + high.

**Why:** Rendering is deterministic and has no scheduler or database side effects.

**Files:**
- Create: `src/artifacts/writer.ts`
- Create: `test/artifacts/writer.test.ts`

- [ ] **Step 1: Write the failing artifact test**

```ts
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTicketArtifact } from "../../src/artifacts/writer";

test("writes deterministic ticket Markdown and returns its SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-artifact-"));
  try {
    const result = await writeTicketArtifact(root, {
      id: "F6",
      weekId: "2026-W35",
      title: "Artifact writer",
      priority: 0,
      approvalRequired: false,
      approved: true,
      spec: {
        problem: "No readable ticket", desiredOutcome: "Markdown ticket",
        scope: ["render"], nonGoals: [], acceptanceCriteria: ["stable output"],
        validation: ["bun test"], dependencies: [], risk: "low",
        contextCandidates: [], tokenCeiling: 10_000,
      },
    });
    expect(result.path.endsWith(".agile/tickets/F6.md")).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(result.path, "utf8")).toContain("# F6 — Artifact writer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `bun test test/artifacts/writer.test.ts`

Expected: FAIL because `src/artifacts/writer.ts` does not exist.

- [ ] **Step 3: Implement deterministic rendering and hashing**

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TaskCreateSchema, type TaskCreate } from "../domain/schemas";

export function renderTicketArtifact(input: TaskCreate): string {
  const task = TaskCreateSchema.parse(input);
  const bullets = (values: string[]) => values.length ? values.map((v) => `- ${v}`).join("\n") : "- None";
  return [
    `# ${task.id} — ${task.title}`,
    "",
    `Week: ${task.weekId}`,
    `Risk: ${task.spec.risk}`,
    `Token ceiling: ${task.spec.tokenCeiling}`,
    "",
    "## Problem",
    "",
    task.spec.problem,
    "",
    "## Desired outcome",
    "",
    task.spec.desiredOutcome,
    "",
    "## Scope",
    "",
    bullets(task.spec.scope),
    "",
    "## Non-goals",
    "",
    bullets(task.spec.nonGoals),
    "",
    "## Acceptance criteria",
    "",
    bullets(task.spec.acceptanceCriteria),
    "",
    "## Validation",
    "",
    bullets(task.spec.validation),
    "",
  ].join("\n");
}

export async function writeTicketArtifact(
  projectRoot: string,
  input: TaskCreate,
): Promise<{ path: string; sha256: string }> {
  const directory = join(projectRoot, ".agile", "tickets");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${input.id}.md`);
  const content = renderTicketArtifact(input);
  await Bun.write(path, content);
  const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  return { path, sha256 };
}
```

- [ ] **Step 4: Verify artifact output**

Run: `bun test test/artifacts/writer.test.ts`

Expected: 1 pass, 0 fail.

Run: `bun run check`

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/artifacts/writer.ts test/artifacts/writer.test.ts
git commit -m "feat: render versionable ticket artifacts"
```

### Task 7: F7 — CLI init/list vertical slice

**Execution profile:** Scout Luna + high; Implement Terra + high; Review Sol + high.

**Why:** This task composes already-tested boundaries and establishes the CLI testing seam used by later slices.

**Files:**
- Create: `src/cli/run.ts`
- Modify: `src/cli/main.ts`
- Create: `test/cli/run.test.ts`

- [ ] **Step 1: Write the failing CLI integration test**

```ts
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../../src/cli/run";

test("init creates a database and task list reads it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const output: string[] = [];
  const io = { out: (text: string) => output.push(text), err: (text: string) => output.push(text) };
  try {
    expect(await runCli(["init", "--db", dbPath], io)).toBe(0);
    expect(await runCli(["task", "list", "--db", dbPath], io)).toBe(0);
    expect(output).toEqual([`Initialized ${dbPath}`, "No tasks."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `bun test test/cli/run.test.ts`

Expected: FAIL because `src/cli/run.ts` does not exist.

- [ ] **Step 3: Implement command parsing and update the entry point**

`src/cli/run.ts`:

```ts
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { helpText } from "./help";
import { openDatabase } from "../store/database";
import { PlanningRepository } from "../store/planning-repository";

export type CliIo = { out(text: string): void; err(text: string): void };

function parseCliArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { db: { type: "string" } },
  });
}

export async function runCli(args: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const [command, subcommand] = parsed.positionals;
  if (!command || command === "help") {
    io.out(helpText.trimEnd());
    return 0;
  }

  const dbPath = resolve(parsed.values.db ?? ".agile/runtime/agile.db");
  if (command === "init") {
    const db = openDatabase(dbPath);
    db.close();
    io.out(`Initialized ${dbPath}`);
    return 0;
  }

  if (command === "task" && subcommand === "list") {
    const db = openDatabase(dbPath);
    const tasks = new PlanningRepository(db).listTasks();
    db.close();
    io.out(tasks.length ? tasks.map((task) => `${task.id}\t${task.status}\t${task.title}`).join("\n") : "No tasks.");
    return 0;
  }

  io.err(`Unknown command: ${parsed.positionals.join(" ")}`);
  return 2;
}
```

`src/cli/main.ts`:

```ts
#!/usr/bin/env bun
import { runCli } from "./run";

if (import.meta.main) {
  const code = await runCli(Bun.argv.slice(2), {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  });
  process.exitCode = code;
}
```

- [ ] **Step 4: Verify the complete foundation slice**

Run: `bun test test/cli/run.test.ts`

Expected: 1 pass, 0 fail.

Run: `bun run check`

Expected: every foundation test passes and typecheck exits 0.

Run: `bun src/cli/main.ts init --db /tmp/agile-foundation.db`

Expected: prints `Initialized /tmp/agile-foundation.db`.

Run: `bun src/cli/main.ts task list --db /tmp/agile-foundation.db`

Expected: prints `No tasks.`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts src/cli/run.ts test/cli/run.test.ts
git commit -m "feat: add foundation CLI vertical slice"
```

## Slice completion gate

Run these commands from a clean worktree:

```bash
bun run typecheck
bun test
bun src/cli/main.ts init --db /tmp/agile-foundation.db
bun src/cli/main.ts task list --db /tmp/agile-foundation.db
git status --short
```

Expected:

- TypeScript exits 0.
- All tests pass with zero failures.
- CLI initialization and listing exit 0.
- Listing prints `No tasks.`.
- Git status is clean.
