# Deterministic Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-daemon deterministic Scout/Implement/Review scheduler driven by a thin JSON Fake Harness, with rejection follow-ups, bounded infrastructure retries, restart reconciliation, and exact token accounting.

**Architecture:** Keep SQLite as the source of truth and add one provider-neutral `AgentHarness` boundary. `Scheduler.tick()` performs one durable action, while a small daemon owns a singleton lease and polls once per second. The Fake returns scripted normalized events; no real model, workflow engine, Git worktree, TUI, or token enforcement is added.

**Tech Stack:** Bun, TypeScript, Zod, `bun:sqlite`, `bun:test`, Node standard library

---

## File Map

| File | Responsibility |
|---|---|
| `src/harness/contracts.ts` | Strict normalized harness, event, output, and scenario schemas |
| `src/harness/fake.ts` | In-process cursor-driven scripted Fake Harness |
| `src/store/migrations.ts` | Migration v2: backend cursor, singleton lease, unique review successor |
| `src/store/orchestration-repository.ts` | Atomic scheduler transactions and inspection queries |
| `src/scheduler/model-routing.ts` | Minimal role baselines and retry escalation |
| `src/scheduler/scheduler.ts` | One durable action per `tick()` and test-only `runUntilIdle()` |
| `src/scheduler/daemon.ts` | Lease heartbeat, one-second polling, graceful shutdown |
| `src/cli/run.ts` | `scheduler run` and `scheduler inspect` command integration |
| `src/cli/help.ts` | CLI discovery text |
| `test/harness/fake.test.ts` | Scenario parsing, cursor replay, expectations, completeness |
| `test/store/orchestration-repository.test.ts` | Claim, role, retry, rejection, cursor, usage, lease transactions |
| `test/scheduler/scheduler.test.ts` | Happy path, rejection, retry, and reconciliation ticks |
| `test/scheduler/daemon.test.ts` | Lease takeover, polling, and signal stop behavior |
| `test/cli/scheduler.test.ts` | CLI run/inspect behavior |
| `test/integration/deterministic-orchestrator.test.ts` | Three-task release gate |

Do not add a claims table, message transcript table, generic event bus, dependency-injection container, workflow DSL, or external runtime dependency.

## Execution Model Routing

Use the Codex backend for every implementation worker. `low` is forbidden; `high` is the default. This routing spends Sol/xhigh only where transaction or recovery mistakes would be expensive:

| Ticket | Implementation model | Reasoning | Why |
|---|---|---|---|
| O1 | Terra | high | Small typed boundary with straightforward test feedback |
| O2 | Sol | xhigh | Migration and atomic-claim correctness |
| O3 | Sol | high | Cross-module state progression and evidence isolation |
| O4 | Terra | high | Bounded retry rules over the established state machine |
| O5 | Sol | xhigh | Idempotent multi-row rejection transaction |
| O6 | Sol | xhigh | Crash boundaries, cursor reconciliation, and lease safety |
| O7 | Terra | high | Deterministic aggregation and projection queries |
| O8 | Terra | high | Thin CLI wiring plus integration assembly |

Use Sol/xhigh for each ticket review and the final whole-branch review. Luna/high is appropriate only for optional read-only scouting; no implementation ticket depends on a separate Scout pass.

### Task 1: O1 — Harness Contracts and Scripted Fake

**Files:**
- Create: `src/harness/contracts.ts`
- Create: `src/harness/fake.ts`
- Create: `test/harness/fake.test.ts`

- [ ] **Step 1: Write the failing Fake Harness tests**

Create `test/harness/fake.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createFakeHarness } from "../../src/harness/fake";

const scenario = {
  attempts: [{
    taskId: "T1",
    role: "scout",
    retryIndex: 0,
    expect: { model: "luna", effort: "high" },
    deliveries: [
      {
        nextCursor: "1",
        event: {
          type: "attempt.started",
          eventId: "T1:scout:0:started",
          attemptId: "A1",
          sequence: 1,
          occurredAt: "2026-08-25T00:00:00.000Z",
          threadId: "thread-T1",
        },
      },
      {
        nextCursor: "2",
        event: {
          type: "attempt.usage_delta",
          eventId: "T1:scout:0:usage",
          attemptId: "A1",
          sequence: 2,
          occurredAt: "2026-08-25T00:00:01.000Z",
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
      },
      {
        nextCursor: "3",
        event: {
          type: "attempt.usage_delta",
          eventId: "T1:scout:0:usage",
          attemptId: "A1",
          sequence: 2,
          occurredAt: "2026-08-25T00:00:01.000Z",
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 1,
        },
      },
    ],
  }],
};

const ticket = {
  id: "T1",
  weekId: "2026-W35",
  title: "Test task",
  spec: {
    problem: "Need a scripted agent",
    desiredOutcome: "Receive deterministic events",
    scope: ["harness"],
    nonGoals: [],
    acceptanceCriteria: ["events follow the cursor"],
    validation: ["bun test"],
    dependencies: [],
    risk: "low" as const,
    contextCandidates: [],
    tokenCeiling: 1_000,
  },
  priority: 0,
  approvalRequired: false,
  approved: true,
  status: "scouting" as const,
};

const request = {
  mode: "dispatch" as const,
  attempt: {
    attemptId: "A1",
    taskId: "T1",
    role: "scout" as const,
    retryIndex: 0 as const,
    model: "luna",
    effort: "high" as const,
  },
  input: { role: "scout" as const, ticket },
};

test("delivers scripted events by persisted cursor, including duplicate event IDs", async () => {
  const fake = createFakeHarness(scenario);
  const first = await fake.harness.step(request);
  expect(first).toMatchObject({ kind: "event", nextCursor: "1", event: { type: "attempt.started" } });
  const second = await fake.harness.step({ ...request, backendCursor: "1" });
  expect(second).toMatchObject({ kind: "event", nextCursor: "2", event: { eventId: "T1:scout:0:usage" } });
  const duplicate = await fake.harness.step({ ...request, backendCursor: "2" });
  expect(duplicate).toMatchObject({ kind: "event", nextCursor: "3", event: { eventId: "T1:scout:0:usage" } });
  await expect(fake.harness.step({ ...request, backendCursor: "3" }))
    .rejects.toThrow("Unexpected extra fake call for T1:scout:0");
  expect(() => fake.assertComplete()).not.toThrow();
});

test("fails fast for a model mismatch, missing script, and unconsumed delivery", async () => {
  const mismatch = createFakeHarness(scenario);
  await expect(mismatch.harness.step({
    ...request,
    attempt: { ...request.attempt, model: "terra" },
  })).rejects.toThrow("Fake expectation failed for T1:scout:0: model terra !== luna");

  const missing = createFakeHarness(scenario);
  await expect(missing.harness.step({
    ...request,
    attempt: { ...request.attempt, taskId: "T2" },
  })).rejects.toThrow("Missing fake script for T2:scout:0");

  const incomplete = createFakeHarness(scenario);
  await incomplete.harness.step(request);
  expect(() => incomplete.assertComplete()).toThrow("Unconsumed fake deliveries for T1:scout:0");

  expect(() => createFakeHarness({
    attempts: [scenario.attempts[0], scenario.attempts[0]],
  })).toThrow("Duplicate fake script for T1:scout:0");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
rtk bun test test/harness/fake.test.ts
```

Expected: FAIL because `src/harness/fake.ts` does not exist.

- [ ] **Step 3: Add the strict normalized contracts**

Create `src/harness/contracts.ts` with these exported schemas and inferred types:

```ts
import { z } from "zod";
import { ContextRefSchema, StoredTaskSchema } from "../domain/schemas";

const NonEmpty = z.string().trim().min(1);
export const AgentRoleSchema = z.enum(["scout", "implement", "review"]);
export const RetryIndexSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export const ReasoningEffortSchema = z.enum(["medium", "high", "xhigh"]);

const EventBaseSchema = z.object({
  eventId: NonEmpty,
  attemptId: NonEmpty,
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime(),
});

export const ScoutOutputSchema = z.object({
  kind: z.literal("scout"),
  summary: NonEmpty,
  files: z.array(NonEmpty),
  tests: z.array(NonEmpty),
  risks: z.array(NonEmpty),
}).strict();

export const ImplementOutputSchema = z.object({
  kind: z.literal("implement"),
  commitSha: NonEmpty,
  validation: z.array(NonEmpty),
  risks: z.array(NonEmpty),
  limitations: z.array(NonEmpty),
}).strict();

export const ReviewOutputSchema = z.object({
  kind: z.literal("review"),
  decision: z.enum(["accepted", "rejected"]),
  findings: z.array(NonEmpty),
  remainingGaps: z.array(NonEmpty),
}).strict();

export const HarnessEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("attempt.started"),
    threadId: NonEmpty.optional(),
  }).strict(),
  EventBaseSchema.extend({
    type: z.literal("attempt.output"),
    output: z.discriminatedUnion("kind", [
      ScoutOutputSchema,
      ImplementOutputSchema,
      ReviewOutputSchema,
    ]),
  }).strict(),
  EventBaseSchema.extend({
    type: z.literal("attempt.usage_delta"),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  }).strict(),
  EventBaseSchema.extend({ type: z.literal("attempt.completed") }).strict(),
  EventBaseSchema.extend({
    type: z.literal("attempt.failed_infra"),
    code: NonEmpty,
    message: NonEmpty,
    retryable: z.boolean(),
  }).strict(),
]);

export const HarnessAttemptSchema = z.object({
  attemptId: NonEmpty,
  taskId: NonEmpty,
  role: AgentRoleSchema,
  retryIndex: RetryIndexSchema,
  model: NonEmpty,
  effort: ReasoningEffortSchema,
  contextRef: ContextRefSchema.optional(),
}).strict();

export const HarnessRoleInputSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("scout"), ticket: StoredTaskSchema }).strict(),
  z.object({
    role: z.literal("implement"),
    ticket: StoredTaskSchema,
    scout: ScoutOutputSchema,
  }).strict(),
  z.object({
    role: z.literal("review"),
    ticket: StoredTaskSchema,
    scout: ScoutOutputSchema,
    implementation: ImplementOutputSchema,
  }).strict(),
]);

export const HarnessStepRequestSchema = z.object({
  mode: z.enum(["dispatch", "reconcile"]),
  attempt: HarnessAttemptSchema,
  input: HarnessRoleInputSchema,
  backendCursor: NonEmpty.optional(),
}).strict();

export const HarnessDeliverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), nextCursor: NonEmpty, event: HarnessEventSchema }).strict(),
  z.object({ kind: z.literal("idle"), nextCursor: NonEmpty.optional() }).strict(),
  z.object({ kind: z.literal("closed"), nextCursor: NonEmpty.optional() }).strict(),
]);

export const FakeScenarioSchema = z.object({
  attempts: z.array(z.object({
    taskId: NonEmpty,
    role: AgentRoleSchema,
    retryIndex: RetryIndexSchema,
    expect: z.object({
      model: NonEmpty,
      effort: ReasoningEffortSchema,
      contextRef: ContextRefSchema.optional(),
    }).strict(),
    deliveries: z.array(z.object({
      nextCursor: NonEmpty,
      event: HarnessEventSchema,
    }).strict()).min(1),
  }).strict()).min(1),
}).strict().superRefine((scenario, context) => {
  const attemptKeys = new Set<string>();
  scenario.attempts.forEach((attempt, attemptIndex) => {
    const attemptKey = `${attempt.taskId}:${attempt.role}:${attempt.retryIndex}`;
    if (attemptKeys.has(attemptKey)) {
      context.addIssue({
        code: "custom",
        path: ["attempts", attemptIndex],
        message: `Duplicate fake script for ${attemptKey}`,
      });
    }
    attemptKeys.add(attemptKey);

    const cursors = new Set<string>();
    attempt.deliveries.forEach((delivery, deliveryIndex) => {
      if (cursors.has(delivery.nextCursor)) {
        context.addIssue({
          code: "custom",
          path: ["attempts", attemptIndex, "deliveries", deliveryIndex, "nextCursor"],
          message: `Duplicate fake cursor for ${attemptKey}: ${delivery.nextCursor}`,
        });
      }
      cursors.add(delivery.nextCursor);
    });
  });
});

export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export type HarnessStepRequest = z.infer<typeof HarnessStepRequestSchema>;
export type HarnessDelivery = z.infer<typeof HarnessDeliverySchema>;
export type FakeScenario = z.infer<typeof FakeScenarioSchema>;

export interface AgentHarness {
  step(input: HarnessStepRequest): Promise<HarnessDelivery>;
  cancel(attemptId: string): Promise<void>;
}
```

- [ ] **Step 4: Implement the cursor-driven Fake**

Create `src/harness/fake.ts`:

```ts
import {
  FakeScenarioSchema,
  HarnessStepRequestSchema,
  type AgentHarness,
  type FakeScenario,
  type HarnessDelivery,
  type HarnessStepRequest,
} from "./contracts";

function keyOf(input: Pick<HarnessStepRequest["attempt"], "taskId" | "role" | "retryIndex">): string {
  return `${input.taskId}:${input.role}:${input.retryIndex}`;
}

export function createFakeHarness(input: unknown): {
  harness: AgentHarness;
  assertComplete(): void;
} {
  const scenario: FakeScenario = FakeScenarioSchema.parse(input);
  const consumed = new Map<string, string>();

  const harness: AgentHarness = {
    async step(rawInput): Promise<HarnessDelivery> {
      const request = HarnessStepRequestSchema.parse(rawInput);
      const key = keyOf(request.attempt);
      const script = scenario.attempts.find((candidate) => keyOf(candidate) === key);
      if (!script) throw new Error(`Missing fake script for ${key}`);
      if (request.attempt.model !== script.expect.model) {
        throw new Error(`Fake expectation failed for ${key}: model ${request.attempt.model} !== ${script.expect.model}`);
      }
      if (request.attempt.effort !== script.expect.effort) {
        throw new Error(`Fake expectation failed for ${key}: effort ${request.attempt.effort} !== ${script.expect.effort}`);
      }
      if (JSON.stringify(request.attempt.contextRef) !== JSON.stringify(script.expect.contextRef)) {
        throw new Error(`Fake expectation failed for ${key}: contextRef mismatch`);
      }

      const cursorIndex = request.backendCursor === undefined
        ? -1
        : script.deliveries.findIndex((delivery) => delivery.nextCursor === request.backendCursor);
      if (request.backendCursor !== undefined && cursorIndex === -1) {
        throw new Error(`Unknown fake cursor for ${key}: ${request.backendCursor}`);
      }
      const index = cursorIndex + 1;
      const delivery = script.deliveries[index];
      if (!delivery) throw new Error(`Unexpected extra fake call for ${key}`);
      consumed.set(key, delivery.nextCursor);
      return { kind: "event", ...delivery };
    },
    async cancel(): Promise<void> {},
  };

  return {
    harness,
    assertComplete(): void {
      for (const script of scenario.attempts) {
        const key = keyOf(script);
        const finalCursor = script.deliveries.at(-1)?.nextCursor;
        if (consumed.get(key) !== finalCursor) {
          throw new Error(`Unconsumed fake deliveries for ${key}`);
        }
      }
    },
  };
}
```

- [ ] **Step 5: Run focused and full checks**

Run:

```bash
rtk bun test test/harness/fake.test.ts
rtk bun run check
```

Expected: focused tests pass; the complete typecheck and suite pass.

- [ ] **Step 6: Commit O1**

```bash
rtk git add src/harness/contracts.ts src/harness/fake.ts test/harness/fake.test.ts
rtk git commit -m "feat: add deterministic fake agent harness"
```

### Task 2: O2 — Migration v2, Dependency Readiness, and Atomic Claim

**Files:**
- Modify: `src/store/migrations.ts`
- Create: `src/store/orchestration-repository.ts`
- Modify: `test/store/database.test.ts`
- Create: `test/store/orchestration-repository.test.ts`

- [ ] **Step 1: Write failing migration and claim tests**

Add a migration test that expects schema version 2, `attempts.backend_cursor`, the singleton lease table, and the unique follow-up index. Create `test/store/orchestration-repository.test.ts` with this public behavior:

```ts
import { expect, test } from "bun:test";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

const ticketSpec = {
  problem: "Need deterministic scheduling",
  desiredOutcome: "One task is claimed",
  scope: ["scheduler"],
  nonGoals: [],
  acceptanceCriteria: ["only one task is claimed"],
  validation: ["bun test"],
  dependencies: [],
  risk: "medium" as const,
  contextCandidates: [],
  tokenCeiling: 10_000,
};

function setup() {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
  planning.createWeek({
    id: "2026-W35",
    goal: "Deterministic scheduler",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: ["T1", "T2"],
  });
  for (const [id, priority] of [["T1", 0], ["T2", 1]] as const) {
    planning.createTask({
      id,
      weekId: "2026-W35",
      title: id,
      spec: ticketSpec,
      priority,
      approvalRequired: false,
      approved: true,
    });
    planning.transitionTask(id, "ready", `${id}:ready`);
  }
  const repo = new OrchestrationRepository(
    db,
    () => "2026-08-25T00:00:01.000Z",
    (kind) => `${kind}-1`,
  );
  return { db, repo };
}

test("claims the first approved ready task once", () => {
  const { db, repo } = setup();
  try {
    expect(repo.claimNext()).toEqual({ taskId: "T1" });
    expect(repo.claimNext()).toBeUndefined();
    expect(db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get("T1")?.status).toBe("claimed");
    expect(db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get("T2")?.status).toBe("ready");
  } finally {
    db.close();
  }
});

test("skips a task with an unfinished dependency", () => {
  const { db, repo } = setup();
  try {
    db.exec("INSERT INTO task_deps(task_id, depends_on_task_id, kind) VALUES ('T1', 'T2', 'blocks')");
    expect(repo.claimNext()).toEqual({ taskId: "T2" });
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Run the tests and verify RED**

```bash
rtk bun test test/store/database.test.ts test/store/orchestration-repository.test.ts
```

Expected: FAIL because schema version 2 and `OrchestrationRepository` do not exist.

- [ ] **Step 3: Add migration v2 without rewriting migration v1**

Append this migration after `migration1` in `src/store/migrations.ts`:

```ts
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
```

Replace `migrate` with versioned, transactional increments:

```ts
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
```

Update database tests from expected version 1 to 2, add `scheduler_lease` to the expected tables, assert `PRAGMA table_info(attempts)` contains `backend_cursor`, and change the future-version fixture from 2 to 3 with the message `Database version 3 is newer than supported version 2`.

- [ ] **Step 4: Implement the atomic claim transaction**

Create `src/store/orchestration-repository.ts` with the constructor and claim API below. Use the conditional update count as the concurrency guard; do not add a claims table.

```ts
import type { Database } from "bun:sqlite";

export type IdFactory = (kind: "attempt" | "decision" | "event" | "review" | "task") => string;

export class OrchestrationRepository {
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: IdFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
  ) {}

  claimNext(): { taskId: string } | undefined {
    return this.db.transaction(() => {
      const row = this.db.query<{ id: string }, []>(`
        SELECT task.id
        FROM tasks AS task
        WHERE task.status = 'ready'
          AND task.approved = 1
          AND NOT EXISTS (
            SELECT 1 FROM tasks AS active
            WHERE active.status IN ('claimed', 'scouting', 'implementing', 'reviewing')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM task_deps AS dep
            JOIN tasks AS dependency ON dependency.id = dep.depends_on_task_id
            WHERE dep.task_id = task.id AND dependency.status <> 'done'
          )
        ORDER BY task.priority ASC, task.created_at ASC, task.id ASC
        LIMIT 1
      `).get();
      if (!row) return undefined;

      const changed = this.db.query(`
        UPDATE tasks SET status = 'claimed', updated_at = ?
        WHERE id = ? AND status = 'ready'
      `).run(this.now(), row.id).changes;
      if (changed !== 1) return undefined;

      this.db.query(`
        INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
        VALUES(?, ?, 'task.claimed', '{}', ?)
      `).run(this.id("event"), row.id, this.now());
      return { taskId: row.id };
    })();
  }
}
```

- [ ] **Step 5: Run focused and full checks**

```bash
rtk bun test test/store/database.test.ts test/store/orchestration-repository.test.ts
rtk bun run check
```

Expected: schema v2 and both claim cases pass; the full suite passes.

- [ ] **Step 6: Commit O2**

```bash
rtk git add src/store/migrations.ts src/store/orchestration-repository.ts test/store/database.test.ts test/store/orchestration-repository.test.ts
rtk git commit -m "feat: add atomic scheduler claims"
```

### Task 3: O3 — Happy-Path Role Pipeline and Structured Evidence

**Files:**
- Create: `src/scheduler/model-routing.ts`
- Create: `src/scheduler/scheduler.ts`
- Modify: `src/store/orchestration-repository.ts`
- Create: `test/scheduler/scheduler.test.ts`
- Modify: `test/store/orchestration-repository.test.ts`

- [ ] **Step 1: Write a failing Scout -> Implement -> Review test**

Create `test/scheduler/scheduler.test.ts`. Seed one approved ready task with `PlanningRepository`, inject IDs that increment per kind, and use a Fake scenario with these exact outputs:

```ts
import { expect, test } from "bun:test";
import type { AgentHarness, HarnessStepRequest } from "../../src/harness/contracts";
import { createFakeHarness } from "../../src/harness/fake";
import { Scheduler } from "../../src/scheduler/scheduler";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

const scoutOutput = {
  kind: "scout" as const,
  summary: "Found the scheduler boundary",
  files: ["src/scheduler/scheduler.ts"],
  tests: ["bun test"],
  risks: [],
};

const implementOutput = {
  kind: "implement" as const,
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  validation: ["bun test"],
  risks: [],
  limitations: [],
};

const reviewOutput = {
  kind: "review" as const,
  decision: "accepted" as const,
  findings: [],
  remainingGaps: [],
};

const inheritedContext = {
  threadId: "thread-C",
  anchorId: "anchor-C",
  sourceTaskId: "C",
  gitCommit: "cccccccccccccccccccccccccccccccccccccccc",
  summaryArtifact: "artifacts/C-summary.md",
};

function roleDeliveries(
  key: string,
  attemptId: string,
  output: typeof scoutOutput | typeof implementOutput | typeof reviewOutput,
) {
  return [
    {
      nextCursor: "1",
      event: {
        type: "attempt.started" as const,
        eventId: `${key}:started`,
        attemptId,
        sequence: 1,
        occurredAt: "2026-08-25T00:00:02.000Z",
        threadId: `thread-${key}`,
      },
    },
    {
      nextCursor: "2",
      event: {
        type: "attempt.output" as const,
        eventId: `${key}:output`,
        attemptId,
        sequence: 2,
        occurredAt: "2026-08-25T00:00:03.000Z",
        output,
      },
    },
    {
      nextCursor: "3",
      event: {
        type: "attempt.completed" as const,
        eventId: `${key}:completed`,
        attemptId,
        sequence: 3,
        occurredAt: "2026-08-25T00:00:04.000Z",
      },
    },
  ];
}
```

Build each role's deliveries with a test helper that returns `attempt.started`, `attempt.output`, and `attempt.completed` events with stable IDs and cursors `1`, `2`, and `3`. Use expected attempts `attempt-1`/Scout/Luna, `attempt-2`/Implement/Terra, and `attempt-3`/Review/Sol.

Define `setupAcceptedTask()` in the same test file with this exact construction sequence:

```ts
function setupAcceptedTask() {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
  planning.createWeek({
    id: "2026-W34", goal: "Prior context", nonGoals: [], tokenBudget: 50_000, ticketIds: ["C"],
  });
  planning.createTask({
    id: "C",
    weekId: "2026-W34",
    title: "Prior task C",
    spec: {
      problem: "Prior task context",
      desiredOutcome: "Provide an immutable context anchor",
      scope: ["context"],
      nonGoals: [],
      acceptanceCriteria: ["context can be inherited"],
      validation: ["bun test"],
      dependencies: [],
      risk: "medium",
      contextCandidates: [],
      tokenCeiling: 5_000,
    },
    priority: 0,
    approvalRequired: false,
    approved: true,
  });
  planning.createWeek({
    id: "2026-W35", goal: "Run roles", nonGoals: [], tokenBudget: 100_000, ticketIds: ["T1"],
  });
  planning.createTask({
    id: "T1",
    weekId: "2026-W35",
    title: "Run roles",
    spec: {
      problem: "No role pipeline",
      desiredOutcome: "Complete all roles",
      scope: ["scheduler"],
      nonGoals: [],
      acceptanceCriteria: ["task reaches done"],
      validation: ["bun test"],
      dependencies: [],
      risk: "medium",
      contextCandidates: [inheritedContext],
      tokenCeiling: 10_000,
    },
    priority: 0,
    approvalRequired: false,
    approved: true,
  });
  planning.transitionTask("T1", "ready", "T1:ready");
  db.query(`
    INSERT INTO contexts(id, thread_id, anchor_id, source_task_id, git_commit, summary_artifact)
    VALUES('context-C', $threadId, $anchorId, $sourceTaskId, $gitCommit, $summaryArtifact)
  `).run(inheritedContext);
  db.query("UPDATE tasks SET context_id = 'context-C' WHERE id = 'T1'").run();

  const counters: Record<string, number> = {};
  const repo = new OrchestrationRepository(
    db,
    () => "2026-08-25T00:00:01.000Z",
    (kind) => `${kind}-${counters[kind] = (counters[kind] ?? 0) + 1}`,
  );
  const fake = createFakeHarness({ attempts: [
    { taskId: "T1", role: "scout", retryIndex: 0, expect: { model: "luna", effort: "high", contextRef: inheritedContext }, deliveries: roleDeliveries("scout", "attempt-1", scoutOutput) },
    { taskId: "T1", role: "implement", retryIndex: 0, expect: { model: "terra", effort: "high", contextRef: inheritedContext }, deliveries: roleDeliveries("implement", "attempt-2", implementOutput) },
    { taskId: "T1", role: "review", retryIndex: 0, expect: { model: "sol", effort: "high", contextRef: inheritedContext }, deliveries: roleDeliveries("review", "attempt-3", reviewOutput) },
  ] });
  const requests: HarnessStepRequest[] = [];
  const harness: AgentHarness = {
    async step(input) {
      requests.push(input);
      return fake.harness.step(input);
    },
    cancel: (attemptId) => fake.harness.cancel(attemptId),
  };
  const scheduler = new Scheduler(repo, harness);
  return { db, repo, scheduler, fake, requests };
}
```

The test body must assert the complete observable contract:

```ts
test("runs Scout, Implement, and isolated Review to done", async () => {
  const { db, repo, scheduler, fake, requests } = setupAcceptedTask();
  try {
    await scheduler.runUntilIdle(40);
    expect(repo.inspectTask("T1")).toMatchObject({ status: "done" });
    expect(repo.listAttempts("T1")).toMatchObject([
      { role: "scout", model: "luna", effort: "high", status: "succeeded" },
      { role: "implement", model: "terra", effort: "high", status: "succeeded" },
      { role: "review", model: "sol", effort: "high", status: "succeeded" },
    ]);
    expect(repo.listReviews("T1")).toMatchObject([{ decision: "accepted" }]);
    const reviewRequest = requests.find((request) => request.attempt.role === "review");
    expect(reviewRequest?.input).toEqual({
      role: "review",
      ticket: expect.objectContaining({ id: "T1" }),
      scout: scoutOutput,
      implementation: implementOutput,
    });
    expect(requests.every((request) => request.attempt.contextRef?.sourceTaskId === "C")).toBe(true);
    expect(JSON.stringify(reviewRequest)).not.toContain("thread-implement");
    expect(() => fake.assertComplete()).not.toThrow();
  } finally {
    db.close();
  }
});
```

Wrap the Fake in the test to push every `HarnessStepRequest` into `requests` before delegating to `fake.harness.step`.

- [ ] **Step 2: Run the test and verify RED**

```bash
rtk bun test test/scheduler/scheduler.test.ts
```

Expected: FAIL because Scheduler role progression methods do not exist.

- [ ] **Step 3: Add the baseline model route**

Create `src/scheduler/model-routing.ts`:

```ts
import type { z } from "zod";
import { AgentRoleSchema, ReasoningEffortSchema } from "../harness/contracts";

export type Route = {
  model: "luna" | "terra" | "sol";
  effort: z.infer<typeof ReasoningEffortSchema>;
  fallbacks: Array<"luna" | "terra" | "sol">;
  rationale: string[];
};

export function baselineRoute(role: z.infer<typeof AgentRoleSchema>, risk: "low" | "medium" | "high"): Route {
  const model = role === "scout" ? "luna" : role === "implement" ? "terra" : "sol";
  const effort = risk === "high" ? "xhigh" : "high";
  const fallbacks: Route["fallbacks"] = model === "luna" ? ["terra", "sol"] : model === "terra" ? ["sol"] : [];
  return { model, effort, fallbacks, rationale: [`${role} baseline`, `${risk} risk`] };
}
```

- [ ] **Step 4: Add the repository role APIs**

Extend `OrchestrationRepository` with these public types and methods:

```ts
import type { z } from "zod";
import {
  HarnessEventSchema,
  HarnessRoleInputSchema,
  type HarnessEvent,
  type HarnessStepRequest,
} from "../harness/contracts";

export type RunningAttempt = {
  descriptor: HarnessStepRequest["attempt"];
  input: z.infer<typeof HarnessRoleInputSchema>;
  backendCursor?: string;
};

getRunningAttempt(): RunningAttempt | undefined;
beginNextAttempt(): { attemptId: string; taskId: string; role: "scout" | "implement" | "review" } | undefined;
applyHarnessEvent(attemptId: string, nextCursor: string, rawEvent: HarnessEvent): void;
inspectTask(taskId: string): { id: string; status: string } | undefined;
listAttempts(taskId: string): Array<{ role: string; model: string; effort: string; status: string }>;
listReviews(taskId: string): Array<{ decision: string; findings: string[] }>;
```

Implement `beginNextAttempt()` as one transaction:

1. Select the single task in `claimed|scouting|implementing|reviewing` with no running attempt.
2. Map `claimed -> scout`, `scouting -> implement`, and `implementing -> review`. A `reviewing` task has no next role.
3. For Implement require a succeeded Scout attempt; for Review require a succeeded Implement attempt.
4. Parse the stored ticket with `StoredTaskSchema` and parse prior role output from the latest matching `attempt.output` event.
5. Call `baselineRoute(role, risk)`.
6. Insert one `model_decisions` row with `decided_by='rule'`, confidence `1`, the task's informational token ceiling, selected `tasks.context_id`, fallbacks, and rationale.
7. Insert one running attempt with `retry_index=0`.
8. Move `claimed -> scouting`, `scouting -> implementing`, or `implementing -> reviewing` using `assertTransition`.
9. Append `task.status_changed` and `attempt.created` events.

`getRunningAttempt()` selects the one running attempt, joins its task, optional `tasks.context_id -> contexts` row, and prior Scout/Implement outputs, then returns the role-specific Harness input. Parse the joined row with `ContextRefSchema` and pass the same immutable reference to every role. It must never put an Implement thread ID or conversation into Review input.

`applyHarnessEvent()` starts with this exact idempotency rule inside one transaction:

```ts
const event = HarnessEventSchema.parse(rawEvent);
if (event.attemptId !== attemptId) {
  throw new Error(`Harness event attempt mismatch: ${event.attemptId} !== ${attemptId}`);
}
const attempt = this.db.query<{ task_id: string; role: string; status: string }, [string]>(
  "SELECT task_id, role, status FROM attempts WHERE id = ?",
).get(attemptId);
if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
const duplicate = this.db.query<{ attempt_id: string | null; payload_json: string }, [string]>(
  "SELECT attempt_id, payload_json FROM events WHERE idempotency_key = ?",
).get(event.eventId);
if (duplicate) {
  if (duplicate.attempt_id !== attemptId || duplicate.payload_json !== JSON.stringify(event)) {
    throw new Error(`Harness event idempotency conflict: ${event.eventId}`);
  }
  this.db.query("UPDATE attempts SET backend_cursor = ? WHERE id = ?").run(nextCursor, attemptId);
  return;
}
if (attempt.status !== "running") throw new Error(`Attempt is not running: ${attemptId}`);
const lastSequence = this.db.query<{ sequence: number | null }, [string]>(`
  SELECT MAX(CAST(json_extract(payload_json, '$.sequence') AS INTEGER)) AS sequence
  FROM events WHERE attempt_id = ?
`).get(attemptId)?.sequence;
if (lastSequence !== null && lastSequence !== undefined && event.sequence <= lastSequence) {
  throw new Error(`Non-monotonic harness event sequence for ${attemptId}: ${event.sequence} <= ${lastSequence}`);
}
```

For a new event, insert it into `events` using `eventId`, task ID, attempt ID, type, exact JSON payload, and `occurredAt`, then:

- `attempt.started`: update `attempts.thread_id` when supplied.
- `attempt.output`: require `output.kind` to match the attempt role, retain the structured payload in `events`, and when kind is Implement also update `attempts.git_commit`.
- `attempt.completed`: require a prior matching `attempt.output`, mark the attempt `succeeded`, set `ended_at`, and for an accepted Review insert one `reviews` row and move `reviewing -> done`.
- `attempt.usage_delta` and `attempt.failed_infra`: throw explicit `Unsupported harness event in happy-path repository: <type>` until Tasks 4 and 7 add those branches.

Always update `attempts.backend_cursor = nextCursor` before committing a new supported event.

- [ ] **Step 5: Implement one-action Scheduler ticks**

Create `src/scheduler/scheduler.ts`:

```ts
import type { AgentHarness, HarnessStepRequest } from "../harness/contracts";
import type { OrchestrationRepository } from "../store/orchestration-repository";

export type TickResult =
  | { kind: "delivery"; attemptId: string; eventId: string }
  | { kind: "attempt_started"; attemptId: string }
  | { kind: "task_claimed"; taskId: string }
  | { kind: "idle" };

export class Scheduler {
  private readonly reconcile = new Set<string>();

  constructor(
    private readonly repo: OrchestrationRepository,
    private readonly harness: AgentHarness,
  ) {
    const active = repo.getRunningAttempt();
    if (active) this.reconcile.add(active.descriptor.attemptId);
  }

  async tick(): Promise<TickResult> {
    const running = this.repo.getRunningAttempt();
    if (running) {
      const attemptId = running.descriptor.attemptId;
      const request: HarnessStepRequest = {
        mode: this.reconcile.delete(attemptId) ? "reconcile" : "dispatch",
        attempt: running.descriptor,
        input: running.input,
        backendCursor: running.backendCursor,
      };
      const delivery = await this.harness.step(request);
      if (delivery.kind === "idle") return { kind: "idle" };
      if (delivery.kind === "closed") throw new Error(`Harness closed before attempt completion: ${attemptId}`);
      this.repo.applyHarnessEvent(attemptId, delivery.nextCursor, delivery.event);
      return { kind: "delivery", attemptId, eventId: delivery.event.eventId };
    }

    const started = this.repo.beginNextAttempt();
    if (started) return { kind: "attempt_started", attemptId: started.attemptId };
    const claimed = this.repo.claimNext();
    if (claimed) return { kind: "task_claimed", taskId: claimed.taskId };
    return { kind: "idle" };
  }

  async runUntilIdle(maxTicks: number): Promise<void> {
    for (let tick = 0; tick < maxTicks; tick += 1) {
      if ((await this.tick()).kind === "idle") return;
    }
    throw new Error(`Scheduler exceeded ${maxTicks} ticks`);
  }
}
```

- [ ] **Step 6: Run focused and full checks**

```bash
rtk bun test test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts
rtk bun run check
```

Expected: the task reaches `done`, all three attempts succeed with baseline models, Review input contains evidence but no Implement conversation, and all tests pass.

- [ ] **Step 7: Commit O3**

```bash
rtk git add src/scheduler/model-routing.ts src/scheduler/scheduler.ts src/store/orchestration-repository.ts test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts
rtk git commit -m "feat: run deterministic role pipeline"
```

### Task 4: O4 — Infrastructure Retry Cap and Minimal Model Escalation

**Files:**
- Modify: `src/scheduler/model-routing.ts`
- Modify: `src/store/orchestration-repository.ts`
- Modify: `test/store/orchestration-repository.test.ts`
- Modify: `test/scheduler/scheduler.test.ts`

- [ ] **Step 1: Write failing retry tests**

Add a Scout scenario whose attempts fail with `attempt.failed_infra` at retry indexes 0, 1, and 2. Assert:

```ts
expect(repo.listAttempts("T1")).toMatchObject([
  { role: "scout", retryIndex: 0, model: "luna", status: "failed_infra" },
  { role: "scout", retryIndex: 1, model: "luna", status: "failed_infra" },
  { role: "scout", retryIndex: 2, model: "terra", status: "failed_infra" },
]);
expect(repo.inspectTask("T1")).toMatchObject({ status: "failed_infra" });
```

Add a second test where retry 0 fails with code `model_unavailable` and retry 1 immediately uses Terra. Add a third test where `retryable=false` terminalizes the task after retry 0.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
rtk bun test test/scheduler/scheduler.test.ts --test-name-pattern "infra|unavailable|non-retryable"
```

Expected: FAIL because `attempt.failed_infra` is unsupported.

- [ ] **Step 3: Extend the routing function**

Add this export to `src/scheduler/model-routing.ts`:

```ts
export function retryRoute(
  role: "scout" | "implement" | "review",
  risk: "low" | "medium" | "high",
  retryIndex: 1 | 2,
  priorModel: "luna" | "terra" | "sol",
  priorErrorCode: string,
): Route {
  const shouldUpgrade = retryIndex === 2 || priorErrorCode === "model_unavailable";
  const model = shouldUpgrade
    ? priorModel === "luna" ? "terra" : "sol"
    : priorModel;
  const baseline = baselineRoute(role, risk);
  return {
    model,
    effort: baseline.effort,
    fallbacks: model === "luna" ? ["terra", "sol"] : model === "terra" ? ["sol"] : [],
    rationale: [`${role} retry ${retryIndex}`, shouldUpgrade ? "model upgraded" : "model retained"],
  };
}
```

- [ ] **Step 4: Persist failures and start the correct retry**

Extend `applyHarnessEvent()` for `attempt.failed_infra`:

1. mark the running attempt `failed_infra`, set `ended_at`, and persist the event/cursor;
2. if `retryable=false` or `retry_index=2`, transition the task to `failed_infra` and move all nonterminal dependents to `needs_replan` in the same transaction;
3. otherwise leave the task in its current phase so the next tick can create a retry of the same role.

Extend `beginNextAttempt()` so a phase with a latest failed attempt starts the same role with `retry_index + 1`. Query the latest failure event code, call `retryRoute`, and persist a new model decision. Do not rerun successful earlier roles.

Use this exact dependent update predicate:

```sql
UPDATE tasks
SET status = 'needs_replan', updated_at = $now
WHERE id IN (SELECT task_id FROM task_deps WHERE depends_on_task_id = $failedTaskId)
  AND status IN ('draft', 'ready');
```

Append one `task.needs_replan` event for each changed dependent so inspection explains the block.

- [ ] **Step 5: Run focused and full checks**

```bash
rtk bun test test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts
rtk bun run check
```

Expected: only the failed role retries; models are Luna, Luna, Terra; exhaustion and nonretryable failure terminalize the task; all tests pass.

- [ ] **Step 6: Commit O4**

```bash
rtk git add src/scheduler/model-routing.ts src/store/orchestration-repository.ts test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts
rtk git commit -m "feat: cap infrastructure retries"
```

### Task 5: O5 — No-Loop Review Rejection Transaction

**Files:**
- Modify: `src/store/orchestration-repository.ts`
- Modify: `test/store/orchestration-repository.test.ts`
- Modify: `test/scheduler/scheduler.test.ts`

- [ ] **Step 1: Write the failing rejection transaction test**

Drive a Review attempt through a rejected `attempt.output` followed by `attempt.completed`, then assert:

```ts
expect(repo.inspectTask("T1")).toMatchObject({ status: "rejected" });
expect(repo.listReviews("T1")).toMatchObject([{
  decision: "rejected",
  findings: ["validation failed"],
}]);
expect(repo.listTasksByRoot("T1")).toMatchObject([
  { id: "T1", status: "rejected" },
  {
    id: "task-1",
    status: "draft",
    parentTaskId: "T1",
    rootTaskId: "T1",
    approved: false,
  },
]);
```

Replay the same completed event and assert there are still exactly two lineage tasks and one review. Add a dependent task and assert it moves to `needs_replan` rather than being rewired to the follow-up.

- [ ] **Step 2: Run the rejection tests and verify RED**

```bash
rtk bun test test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts --test-name-pattern "rejected|follow-up"
```

Expected: FAIL because only accepted Review is supported.

- [ ] **Step 3: Implement the rejection branch in the existing event transaction**

When a Review `attempt.completed` event is new, load and strictly parse the latest Review output. For `decision='rejected'`, perform these statements before committing the event cursor:

```sql
INSERT INTO reviews(id, task_id, attempt_id, decision, findings_json)
VALUES($reviewId, $taskId, $attemptId, 'rejected', $findingsJson);

UPDATE attempts
SET status = 'succeeded', ended_at = $endedAt
WHERE id = $attemptId AND status = 'running';

UPDATE tasks
SET status = 'rejected', updated_at = $endedAt
WHERE id = $taskId AND status = 'reviewing';
```

Parse the original `spec_json` with `TicketSpecSchema`. Create the follow-up spec as:

```ts
const followUpSpec = TicketSpecSchema.parse({
  ...originalSpec,
  problem: `${originalSpec.problem}\n\nReview findings:\n${review.findings.map((finding) => `- ${finding}`).join("\n")}`,
  acceptanceCriteria: [...new Set([
    ...originalSpec.acceptanceCriteria,
    ...review.remainingGaps,
  ])],
});
```

Insert one task using a generated task ID, original week/title/priority/token ceiling/context, `status='draft'`, `approved=0`, `approval_required=1`, `root_task_id = original.root_task_id ?? original.id`, `parent_task_id = original.id`, and `discovered_from_review_id = reviewId`.

Then move `draft|ready` dependents to `needs_replan`, append `task.rejected`, `task.follow_up_created`, and dependent events, and update the backend cursor. The unique partial index on `discovered_from_review_id` is the final duplicate guard.

For an already-seen `attempt.completed` event, only advance the cursor and return; do not generate new IDs or rerun the transaction.

- [ ] **Step 4: Add lineage inspection used by the test**

Add:

```ts
listTasksByRoot(rootTaskId: string): Array<{
  id: string;
  status: string;
  parentTaskId?: string;
  rootTaskId?: string;
  approved: boolean;
}>;
```

The query must include the root task itself plus `root_task_id = ?`, ordered by `created_at, id`, and Zod-parse all returned status/boolean fields.

- [ ] **Step 5: Run focused and full checks**

```bash
rtk bun test test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts
rtk bun run check
```

Expected: rejection creates exactly one draft follow-up, the original is terminal, dependents need replanning, replay is a no-op, and all tests pass.

- [ ] **Step 6: Commit O5**

```bash
rtk git add src/store/orchestration-repository.ts test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts
rtk git commit -m "feat: create review rejection follow-ups"
```

### Task 6: O6 — Cursor Reconciliation and Singleton Daemon Lease

**Files:**
- Modify: `src/store/orchestration-repository.ts`
- Modify: `src/scheduler/scheduler.ts`
- Create: `src/scheduler/daemon.ts`
- Modify: `test/store/orchestration-repository.test.ts`
- Modify: `test/scheduler/scheduler.test.ts`
- Create: `test/scheduler/daemon.test.ts`

- [ ] **Step 1: Write failing cursor and lease tests**

Add two reconciliation tests:

1. Run the same reopen-and-replay assertion once with `after_event_insert` and once with `before_cursor_update`; each thrown fault stays inside the event transaction, and after reopening the file database the event is applied exactly once.
2. Throw after the event transaction commits; construct a new Scheduler and assert its first request uses `mode='reconcile'`, starts from the persisted cursor, and does not redeliver the committed event.

Use an `attempt.started` event so the test is independent of token accounting. Assert one event row, the expected thread ID, and the final cursor.

Create `test/scheduler/daemon.test.ts` with a fake clock and no real sleeps:

```ts
import { expect, test } from "bun:test";
import { openDatabase } from "../../src/store/database";
import { SchedulerDaemon } from "../../src/scheduler/daemon";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";

test("allows one lease owner and takeover only after expiry", () => {
  const db = openDatabase(":memory:");
  const repo = new OrchestrationRepository(db);
  try {
    expect(repo.acquireLease("owner-1", "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:10.000Z")).toBe(true);
    expect(repo.acquireLease("owner-2", "2026-08-25T00:00:05.000Z", "2026-08-25T00:00:15.000Z")).toBe(false);
    expect(repo.heartbeatLease("owner-1", "2026-08-25T00:00:11.000Z", "2026-08-25T00:00:21.000Z")).toBe(false);
    expect(repo.acquireLease("owner-2", "2026-08-25T00:00:11.000Z", "2026-08-25T00:00:21.000Z")).toBe(true);
    expect(repo.releaseLease("owner-1")).toBe(false);
    expect(repo.releaseLease("owner-2")).toBe(true);
  } finally {
    db.close();
  }
});

test("polls after idle and releases its lease on stop", async () => {
  const calls: string[] = [];
  let stop = false;
  const scheduler = { async tick() { calls.push("tick"); return { kind: "idle" as const }; } };
  const lease = {
    acquireLease() { calls.push("acquire"); return true; },
    heartbeatLease() { calls.push("heartbeat"); return true; },
    releaseLease() { calls.push("release"); return true; },
  };
  const daemon = new SchedulerDaemon(scheduler, lease, {
    ownerId: "owner-1",
    now: () => new Date("2026-08-25T00:00:00.000Z"),
    sleep: async (milliseconds) => { expect(milliseconds).toBe(1_000); stop = true; },
  });
  await daemon.run(() => stop);
  expect(calls).toEqual(["acquire", "tick", "release"]);
});
```

- [ ] **Step 2: Run the tests and verify RED**

```bash
rtk bun test test/scheduler/scheduler.test.ts test/scheduler/daemon.test.ts --test-name-pattern "reconcile|lease|polls"
```

Expected: FAIL because fault hooks and lease APIs do not exist.

- [ ] **Step 3: Add exact fault seams around the existing transaction**

Add optional fault hooks without creating a framework:

```ts
export type RepositoryFaultPoint = "after_event_insert" | "before_cursor_update";
export type SchedulerFaultPoint = "after_delivery_commit";
```

Extend `OrchestrationRepository` constructor with a fourth optional argument:

```ts
private readonly fault: (point: RepositoryFaultPoint) => void = () => {},
```

Call `fault("after_event_insert")` immediately after inserting a new normalized event and `fault("before_cursor_update")` immediately before updating `attempts.backend_cursor`. Both calls must remain inside the same SQLite transaction so a thrown test fault rolls everything back.

Extend Scheduler's constructor with `fault: (point: SchedulerFaultPoint) => void = () => {}` and call `fault("after_delivery_commit")` immediately after `applyHarnessEvent()` returns. This simulates process death after durable commit.

- [ ] **Step 4: Add lease transactions to the repository**

Add these methods:

```ts
acquireLease(ownerId: string, now: string, expiresAt: string): boolean {
  return this.db.transaction(() => {
    this.db.query(`
      INSERT INTO scheduler_lease(lease_key, owner_id, heartbeat_at, expires_at)
      VALUES('scheduler', ?, ?, ?)
      ON CONFLICT(lease_key) DO UPDATE SET
        owner_id = excluded.owner_id,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at
      WHERE scheduler_lease.owner_id = excluded.owner_id
         OR scheduler_lease.expires_at <= excluded.heartbeat_at
    `).run(ownerId, now, expiresAt);
    return this.db.query<{ owner_id: string }, []>(
      "SELECT owner_id FROM scheduler_lease WHERE lease_key = 'scheduler'",
    ).get()?.owner_id === ownerId;
  })();
}

heartbeatLease(ownerId: string, now: string, expiresAt: string): boolean {
  return this.db.query(`
    UPDATE scheduler_lease SET heartbeat_at = ?, expires_at = ?
    WHERE lease_key = 'scheduler' AND owner_id = ? AND expires_at > ?
  `).run(now, expiresAt, ownerId, now).changes === 1;
}

releaseLease(ownerId: string): boolean {
  return this.db.query(
    "DELETE FROM scheduler_lease WHERE lease_key = 'scheduler' AND owner_id = ?",
  ).run(ownerId).changes === 1;
}
```

The daemon is the only production caller of `Scheduler.tick()`. Tests may call `tick()` directly.

- [ ] **Step 5: Implement the daemon loop**

Create `src/scheduler/daemon.ts`:

```ts
import type { Scheduler, TickResult } from "./scheduler";

export type LeaseStore = {
  acquireLease(ownerId: string, now: string, expiresAt: string): boolean;
  heartbeatLease(ownerId: string, now: string, expiresAt: string): boolean;
  releaseLease(ownerId: string): boolean;
};

type Runtime = {
  ownerId: string;
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
};

export class SchedulerDaemon {
  constructor(
    private readonly scheduler: Pick<Scheduler, "tick">,
    private readonly leases: LeaseStore,
    private readonly runtime: Runtime,
  ) {}

  async run(shouldStop: () => boolean): Promise<void> {
    const leaseTimes = () => {
      const now = this.runtime.now();
      return {
        now: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10_000).toISOString(),
      };
    };
    let times = leaseTimes();
    if (!this.leases.acquireLease(this.runtime.ownerId, times.now, times.expiresAt)) {
      throw new Error("Scheduler lease is already held");
    }
    let nextHeartbeat = this.runtime.now().getTime() + 3_000;
    try {
      while (!shouldStop()) {
        const result: TickResult = await this.scheduler.tick();
        const now = this.runtime.now();
        if (now.getTime() >= nextHeartbeat) {
          times = leaseTimes();
          if (!this.leases.heartbeatLease(this.runtime.ownerId, times.now, times.expiresAt)) {
            throw new Error("Scheduler lease was lost");
          }
          nextHeartbeat = now.getTime() + 3_000;
        }
        if (result.kind === "idle") await this.runtime.sleep(1_000);
      }
    } finally {
      this.leases.releaseLease(this.runtime.ownerId);
    }
  }
}
```

- [ ] **Step 6: Run focused and full checks**

```bash
rtk bun test test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts test/scheduler/daemon.test.ts
rtk bun run check
```

Expected: both pre-commit and post-commit crash scenarios reconcile without duplicates; one lease owner and expiry takeover work; daemon stops cleanly; all tests pass.

- [ ] **Step 7: Commit O6**

```bash
rtk git add src/store/orchestration-repository.ts src/scheduler/scheduler.ts src/scheduler/daemon.ts test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts test/scheduler/daemon.test.ts
rtk git commit -m "feat: reconcile scheduler restarts"
```

### Task 7: O7 — Token Delta Ledger and Inspection Snapshot

**Files:**
- Modify: `src/store/orchestration-repository.ts`
- Modify: `test/store/orchestration-repository.test.ts`
- Modify: `test/scheduler/scheduler.test.ts`

- [ ] **Step 1: Write failing token-delta and inspection tests**

In `test/store/orchestration-repository.test.ts`, add a fresh `setupInspect()` that creates only week `2026-W35` and medium-risk task `T1`, transitions it to ready, injects per-kind incrementing IDs, then calls `claimNext()` and `beginNextAttempt()`. This produces `decision-1` and running `attempt-1` without inheriting the earlier two-task claim fixture.

Apply `attempt.started` under cursor `1`. Deliver the same `attempt.usage_delta` event twice under cursors `2` and `3`, then deliver a different delta under cursor `4`. Assert the first delta is counted once and the second is added:

```ts
expect(repo.inspect()).toEqual({
  scheduler: { activeTaskId: "T1", activeAttemptId: "attempt-1" },
  weeks: [{
    id: "2026-W35",
    tokenTarget: 100_000,
    actual: {
      inputTokens: 15,
      cachedInputTokens: 3,
      outputTokens: 6,
      reasoningOutputTokens: 2,
    },
  }],
  tasks: [{
    id: "T1",
    status: "scouting",
    priority: 0,
    tokenTarget: 10_000,
    actual: {
      inputTokens: 15,
      cachedInputTokens: 3,
      outputTokens: 6,
      reasoningOutputTokens: 2,
    },
    modelDecisions: [{
      id: "decision-1",
      role: "scout",
      model: "luna",
      effort: "high",
      tokenTarget: 10_000,
      fallbackModels: ["terra", "sol"],
      decidedBy: "rule",
      confidence: 1,
      rationale: ["scout baseline", "medium risk"],
    }],
    roles: [{
      role: "scout",
      actual: {
        inputTokens: 15,
        cachedInputTokens: 3,
        outputTokens: 6,
        reasoningOutputTokens: 2,
      },
    }],
    attempts: [{
      id: "attempt-1",
      role: "scout",
      model: "luna",
      effort: "high",
      status: "running",
      retryIndex: 0,
      inputTokens: 15,
      cachedInputTokens: 3,
      outputTokens: 6,
      reasoningOutputTokens: 2,
    }],
  }],
});
```

Use deltas `(10,2,4,1)` and `(5,1,2,1)`. Do not assert cost because the Fake does not price models.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
rtk bun test test/store/orchestration-repository.test.ts --test-name-pattern "token delta|inspect"
```

Expected: FAIL because usage events are unsupported and `inspect()` does not exist.

- [ ] **Step 3: Record usage in the existing event transaction**

Handle `attempt.usage_delta` in `applyHarnessEvent()` after the duplicate check:

```sql
INSERT INTO usage(
  id, week_id, task_id, attempt_id, category,
  input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
)
SELECT
  $eventId, task.week_id, task.id, attempt.id, attempt.role,
  $inputTokens, $cachedInputTokens, $outputTokens, $reasoningOutputTokens
FROM attempts AS attempt
JOIN tasks AS task ON task.id = attempt.task_id
WHERE attempt.id = $attemptId;
```

Require exactly one inserted row. Then update the backend cursor in the same transaction. The already-existing event ID returns through the duplicate branch, advances only the cursor, and never inserts usage again.

- [ ] **Step 4: Add one deterministic inspection query surface**

Export exact snapshot types from `src/store/orchestration-repository.ts` and add `inspect(): InspectionSnapshot`. Use SQL `SUM(...)` with `COALESCE(..., 0)` grouped by week, task, role, and attempt. Order weeks by ID, tasks by `priority, id`, roles by Scout/Implement/Review pipeline order, and attempts by `started_at, id`.

The returned shape must be exactly the shape asserted in Step 1. Each task also carries optional `contextRef` parsed from its selected `tasks.context_id -> contexts` row and its ordered `modelDecisions` projection. Populate each decision from `model_decisions`, parse its JSON arrays, and order decisions by `CASE role WHEN 'scout' THEN 0 WHEN 'implement' THEN 1 ELSE 2 END, id`. Validate task status, role, effort, retry index, decision fields, context references, and all nonnegative token fields with Zod before returning. `scheduler.activeTaskId` and `activeAttemptId` come from current nonterminal state and the running attempt; omit each property when absent.

Do not add budget reservation, remaining-budget calculations, dispatch checks, or cost estimation.

- [ ] **Step 5: Run focused and full checks**

```bash
rtk bun test test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts
rtk bun run check
```

Expected: duplicate deltas count once, totals match at every scope, inspection ordering is stable, and the full suite passes.

- [ ] **Step 6: Commit O7**

```bash
rtk git add src/store/orchestration-repository.ts test/store/orchestration-repository.test.ts test/scheduler/scheduler.test.ts
rtk git commit -m "feat: account for attempt token usage"
```

### Task 8: O8 — Scheduler CLI, Daemon Wiring, and Three-Task Gate

**Files:**
- Modify: `src/cli/run.ts`
- Modify: `src/cli/help.ts`
- Create: `test/cli/scheduler.test.ts`
- Create: `test/integration/deterministic-orchestrator.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `test/cli/scheduler.test.ts` with an injectable scheduler runner so the CLI test never starts an endless real daemon:

```ts
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../../src/cli/run";

test("runs a validated fake scenario through the scheduler runtime seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-cli-"));
  const scenarioPath = join(root, "scenario.json");
  const calls: unknown[] = [];
  try {
    await writeFile(scenarioPath, JSON.stringify({ attempts: [{
      taskId: "T1",
      role: "scout",
      retryIndex: 0,
      expect: { model: "luna", effort: "high" },
      deliveries: [{
        nextCursor: "1",
        event: {
          type: "attempt.completed",
          eventId: "T1:completed",
          attemptId: "A1",
          sequence: 1,
          occurredAt: "2026-08-25T00:00:00.000Z",
        },
      }],
    }] }));
    const output: string[] = [];
    const code = await runCli(
      ["scheduler", "run", "--db", join(root, "state.db"), "--fake-script", scenarioPath],
      { out: (text) => output.push(text), err: (text) => output.push(text) },
      { runScheduler: async (input) => { calls.push(input.scenario); } },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(output).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prints a stable JSON inspection snapshot", async () => {
  const output: string[] = [];
  const code = await runCli(["scheduler", "inspect", "--db", ":memory:"], {
    out: (text) => output.push(text),
    err: (text) => output.push(text),
  });
  expect(code).toBe(0);
  expect(JSON.parse(output[0] ?? "null")).toEqual({ scheduler: {}, weeks: [], tasks: [] });
});
```

Add error tests for missing `--fake-script`, invalid JSON, invalid scenario schema, and operational database failure. Expected exit codes: configuration/usage `2`, operational failure `1`.

- [ ] **Step 2: Run CLI tests and verify RED**

```bash
rtk bun test test/cli/scheduler.test.ts
```

Expected: FAIL because scheduler commands and runtime seam do not exist.

- [ ] **Step 3: Extend CLI parsing and help**

Add one option to `parseCliArgs`:

```ts
options: {
  db: { type: "string" },
  "fake-script": { type: "string" },
},
```

Replace help text with:

```ts
export const helpText = `agile - local agent development orchestrator

Usage:
  agile init [--db PATH]
  agile task list [--db PATH]
  agile scheduler run --fake-script PATH [--db PATH]
  agile scheduler inspect [--db PATH]
  agile help
`;
```

- [ ] **Step 4: Add the smallest runtime seam and command wiring**

Extend `runCli` with a third optional dependency:

```ts
type SchedulerRunInput = { dbPath: string; scenario: unknown };
type CliRuntime = { runScheduler(input: SchedulerRunInput): Promise<void> };

const defaultRuntime: CliRuntime = {
  async runScheduler({ dbPath, scenario }) {
    const db = openDatabase(dbPath);
    const stop = new AbortController();
    const onSignal = () => stop.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      const fake = createFakeHarness(scenario);
      const repo = new OrchestrationRepository(db);
      const scheduler = new Scheduler(repo, fake.harness);
      const daemon = new SchedulerDaemon(scheduler, repo, {
        ownerId: `scheduler-${crypto.randomUUID()}`,
        now: () => new Date(),
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      });
      await daemon.run(() => stop.signal.aborted);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      db.close();
    }
  },
};
```

Use `runtime: CliRuntime = defaultRuntime` as the third `runCli` parameter.

Before command dispatch, preserve SQLite's in-memory sentinel instead of resolving it as a filesystem path:

```ts
const requestedDb = parsed.values.db ?? ".agile/runtime/agile.db";
const dbPath = requestedDb === ":memory:" ? ":memory:" : resolve(requestedDb);
```

For `scheduler run`, require the fake-script path, read it with `await Bun.file(resolve(path)).json()`, validate by calling `FakeScenarioSchema.parse` before opening the database, then invoke `runtime.runScheduler`. Report parse/schema errors through `io.err` and return 2.

For `scheduler inspect`, open the database, call `new OrchestrationRepository(db).inspect()`, output `JSON.stringify(snapshot, null, 2)`, close in `finally`, and return 0. Preserve existing exit-code behavior for database failures.

- [ ] **Step 5: Write the three-task release-gate integration test**

Create `test/integration/deterministic-orchestrator.test.ts`. Use a temporary file database, deterministic IDs/clock, and one JSON-equivalent scenario containing:

- T1 Scout/Implement success and Review rejection with finding `validation failed` and remaining gap `fix validation`.
- T2 Scout events where a Scheduler fault throws after the first committed event; reopen the same database and continue with a new Scheduler.
- T2 Implement/Review accepted.
- T3 Scout/Implement/Review accepted.
- Two identical usage deltas `(10,2,4,1)` per task. Each task therefore totals `(20,4,8,2)`, and all three tasks total `(60,12,24,6)` as literal assertions.

Seed all three tasks as approved and ready. Run ticks through T1 rejection, assert its follow-up is draft, inject the T2 crash, close and reopen the DB, then continue until idle. Assert:

```ts
expect(snapshot.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
  { id: "T1", status: "rejected" },
  { id: "T1-follow-up", status: "draft" },
  { id: "T2", status: "done" },
  { id: "T3", status: "done" },
]);
expect(snapshot.weeks[0]?.actual).toEqual({
  inputTokens: 60,
  cachedInputTokens: 12,
  outputTokens: 24,
  reasoningOutputTokens: 6,
});
expect(db.query<{ count: number }, []>(
  "SELECT COUNT(*) AS count FROM tasks WHERE discovered_from_review_id IS NOT NULL",
).get()?.count).toBe(1);
expect(db.query<{ count: number }, []>(
  "SELECT COUNT(*) AS count FROM events GROUP BY idempotency_key HAVING COUNT(*) > 1",
).all()).toEqual([]);
expect(() => fake.assertComplete()).not.toThrow();
```

Use deterministic task ID generation that returns `T1-follow-up` for the first generated task ID. Do not create Git worktrees or call any real model.

- [ ] **Step 6: Run the release gate and all checks**

```bash
rtk bun test test/integration/deterministic-orchestrator.test.ts
rtk bun run typecheck
rtk bun test
rtk bun run check
```

Expected: integration test passes; typecheck passes; every test passes with zero failures.

- [ ] **Step 7: Smoke-test CLI inspection**

```bash
rtk bun src/cli/main.ts init --db /tmp/agile-orchestrator-slice2.db
rtk bun src/cli/main.ts scheduler inspect --db /tmp/agile-orchestrator-slice2.db
```

Expected: first command prints the initialized path; second prints valid JSON with empty `weeks` and `tasks` arrays and an empty `scheduler` object.

- [ ] **Step 8: Commit O8**

```bash
rtk git add src/cli/run.ts src/cli/help.ts test/cli/scheduler.test.ts test/integration/deterministic-orchestrator.test.ts
rtk git commit -m "feat: add deterministic scheduler CLI"
```

## Final Verification

Run from a clean worktree:

```bash
rtk bun install --frozen-lockfile
rtk bun run typecheck
rtk bun test
rtk bun run check
rtk git diff --check main...HEAD
rtk git status --short
```

Expected:

- typecheck exits zero;
- all focused and integration tests pass;
- no whitespace errors;
- worktree is clean;
- at least the eight planned task commits exist after the plan/spec baseline, plus any review-fix commits.

Then request one whole-branch Sol/xhigh review against [`docs/superpowers/specs/2026-08-25-deterministic-orchestrator-design.md`](../specs/2026-08-25-deterministic-orchestrator-design.md) before merge.
