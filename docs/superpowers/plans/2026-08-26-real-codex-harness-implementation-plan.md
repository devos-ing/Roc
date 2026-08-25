# Real Codex Harness — Slice 3A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production Codex app-server backend that runs one accepted ticket through isolated Scout, Implement, and detached Review while preserving the deterministic Fake Harness and Scheduler invariants.

**Architecture:** Keep `Scheduler` provider-neutral behind the existing `AgentHarness` contract. Add one stdio `CodexClient`, a deterministic catalog-backed Model Advisor, task-scoped Git worktrees, and a `CodexHarness` that normalizes only load-bearing app-server events into SQLite. Use one typed `AgileError` plus a tiny JSONL logger; token usage is recorded but never enforced.

**Tech Stack:** Bun, TypeScript, Zod 4, `bun:sqlite`, Codex app-server JSON-RPC/JSONL, Git worktrees, Bun Test.

---

## Execution rules

- Implement with TDD and commit after every task.
- Prefix every shell command with `rtk`.
- Never use reasoning effort `low`; implementation defaults to `high`.
- Keep existing Fake Harness behavior and its full suite green after every task.
- Follow [AGENTS.md](../../../AGENTS.md): test the core vertical flow and load-bearing safety boundaries, not exhaustive protocol variants.
- Do not add Pi, a workflow framework, a dependency-injection container, a logging package, token enforcement, TUI, Grilling, or automatic Git merge/delete behavior.
- Run the opt-in real Codex smoke only in Task 8; earlier tasks remain offline.

## Model routing for implementation

| Task | Implement | Independent review | Reason |
|---|---|---|---|
| C1 Error and logging boundary | Terra + high | Sol + high | Small isolated runtime utility |
| C2 Persistence and policy-block contracts | Sol + xhigh | Sol + xhigh | SQLite rebuild and transactional state invariant |
| C3 Catalog-backed Model Advisor | Terra + high | Sol + high | Pure deterministic policy with repository seam |
| C4 Task worktree isolation | Sol + xhigh | Sol + xhigh | Filesystem and Git safety boundary |
| C5 Codex JSON-RPC client | Sol + xhigh | Sol + xhigh | External protocol, process lifecycle, correlation |
| C6 Scout/Implement CodexHarness | Sol + xhigh | Sol + xhigh | Event identity, usage deltas, structured output |
| C7 Detached Review, policy, recovery | Sol + xhigh | Sol + xhigh | Review isolation and no-partial-state guarantees |
| C8 CLI and real acceptance | Sol + high | Sol + xhigh | Cross-module integration and live backend gate |

## File map

| File | Responsibility |
|---|---|
| `src/runtime/errors.ts` | One typed runtime error and safe normalization |
| `src/runtime/logger.ts` | Zod-validated stderr + JSONL logging |
| `src/codex/protocol.ts` | Small forward-compatible Zod subset of app-server v2 |
| `src/codex/client.ts` | Bun child process, JSONL framing, request correlation, inbound queue |
| `src/codex/prompts.ts` | Role prompts and JSON Schema conversion |
| `src/codex/harness.ts` | `AgentHarness` implementation and normalized delivery cursor |
| `src/workspace/task-worktree.ts` | Validate, create, reuse, inspect, and verify task worktrees |
| `src/domain/task-path.ts` | Shared safe task path component validation |
| `src/scheduler/model-routing.ts` | Deterministic profile policy plus catalog resolution |
| `src/store/migrations.ts` | Migration v3 and legacy profile backfill |
| `src/store/orchestration-repository.ts` | Persist profiles/turn/base, policy block, inspection, Advisor seam |
| `src/cli/run.ts` | Backend selection and runtime composition |

### Task 1 (C1): Typed errors and structured local logging

**Files:**
- Create: `src/runtime/errors.ts`
- Create: `src/runtime/logger.ts`
- Create: `test/runtime/errors-and-logging.test.ts`

- [ ] **Step 1: Write the failing error/logging test**

```ts
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgileError, normalizeError } from "../../src/runtime/errors";
import { createJsonlLogger } from "../../src/runtime/logger";

test("normalizes unknown failures and logs only safe AgileError fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-error-log-"));
  const path = join(root, "agile.log");
  const stderr: string[] = [];
  try {
    const cause = new Error("secret-token-must-not-leak");
    const error = new AgileError({
      code: "CODEX_STREAM_DISCONNECTED",
      category: "infra",
      retryable: true,
      component: "codex-client",
      message: "Codex stream disconnected",
      runId: "run-1",
      taskId: "T1",
      attemptId: "A1",
      cause,
    });
    const logger = createJsonlLogger({
      path,
      err: (line) => stderr.push(line),
      now: () => "2026-08-26T00:00:00.000Z",
    });

    await logger.write({
      level: "info",
      code: "SCHEDULER_RUN_STARTED",
      category: "domain",
      component: "cli",
      retryable: false,
      message: "Scheduler run started",
      runId: "run-1",
    });
    await logger.error(error);

    expect(stderr).toEqual(["CODEX_STREAM_DISCONNECTED: Codex stream disconnected"]);
    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      level: "info",
      code: "SCHEDULER_RUN_STARTED",
      runId: "run-1",
    });
    expect(lines[1]).toEqual({
      timestamp: "2026-08-26T00:00:00.000Z",
      level: "error",
      code: "CODEX_STREAM_DISCONNECTED",
      category: "infra",
      component: "codex-client",
      retryable: true,
      message: "Codex stream disconnected",
      runId: "run-1",
      taskId: "T1",
      attemptId: "A1",
    });
    expect(text).not.toContain("secret-token-must-not-leak");
    expect(normalizeError(cause, {
      code: "UNEXPECTED_RUNTIME_FAILURE",
      category: "infra",
      retryable: false,
      component: "runtime",
      message: "Unexpected runtime failure",
    })).toBeInstanceOf(AgileError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `rtk bun test test/runtime/errors-and-logging.test.ts`

Expected: FAIL because `src/runtime/errors.ts` and `src/runtime/logger.ts` do not exist.

- [ ] **Step 3: Implement the single typed error**

Create `src/runtime/errors.ts` with this public surface and no subclasses:

```ts
import { z } from "zod";

export const ErrorCategorySchema = z.enum(["startup", "protocol", "infra", "policy", "domain"]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export type AgileErrorInput = {
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  component: string;
  message: string;
  runId?: string;
  taskId?: string;
  attemptId?: string;
  threadId?: string;
  requestId?: string;
  cause?: unknown;
};

export class AgileError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly component: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly threadId?: string;
  readonly requestId?: string;

  constructor(input: AgileErrorInput) {
    super(input.message, { cause: input.cause });
    this.name = "AgileError";
    this.code = z.string().trim().min(1).parse(input.code);
    this.category = ErrorCategorySchema.parse(input.category);
    this.retryable = input.retryable;
    this.component = z.string().trim().min(1).parse(input.component);
    this.runId = input.runId;
    this.taskId = input.taskId;
    this.attemptId = input.attemptId;
    this.threadId = input.threadId;
    this.requestId = input.requestId;
  }
}

export function normalizeError(error: unknown, fallback: Omit<AgileErrorInput, "cause">): AgileError {
  return error instanceof AgileError ? error : new AgileError({ ...fallback, cause: error });
}
```

- [ ] **Step 4: Implement the tiny JSONL logger**

Create `src/runtime/logger.ts`. The logger serializes only the explicit record and never serializes `error.cause` or arbitrary details.

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { ErrorCategorySchema, type AgileError } from "./errors";

export const LogRecordSchema = z.object({
  timestamp: z.string().datetime(),
  level: z.enum(["debug", "info", "warn", "error"]),
  code: z.string().trim().min(1),
  category: ErrorCategorySchema,
  component: z.string().trim().min(1),
  retryable: z.boolean(),
  message: z.string().trim().min(1),
  runId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  attemptId: z.string().trim().min(1).optional(),
  threadId: z.string().trim().min(1).optional(),
  requestId: z.string().trim().min(1).optional(),
}).strict();

export type LogInput = Omit<z.infer<typeof LogRecordSchema>, "timestamp">;
export type Logger = {
  write(input: LogInput): Promise<void>;
  error(error: AgileError): Promise<void>;
};

export function createJsonlLogger(input: {
  path: string;
  err(line: string): void;
  now?: () => string;
}): Logger {
  const now = input.now ?? (() => new Date().toISOString());
  const write = async (recordInput: LogInput): Promise<void> => {
    const record = LogRecordSchema.parse({ timestamp: now(), ...recordInput });
    await mkdir(dirname(input.path), { recursive: true });
    await appendFile(input.path, `${JSON.stringify(record)}\n`, "utf8");
  };
  return {
    write,
    async error(error) {
      await write({
        level: "error",
        code: error.code,
        category: error.category,
        component: error.component,
        retryable: error.retryable,
        message: error.message,
        ...(error.runId === undefined ? {} : { runId: error.runId }),
        ...(error.taskId === undefined ? {} : { taskId: error.taskId }),
        ...(error.attemptId === undefined ? {} : { attemptId: error.attemptId }),
        ...(error.threadId === undefined ? {} : { threadId: error.threadId }),
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      });
      input.err(`${error.code}: ${error.message}`);
    },
  };
}
```

- [ ] **Step 5: Verify GREEN and the full suite**

Run: `rtk bun test test/runtime/errors-and-logging.test.ts`

Expected: 1 pass, 0 fail.

Run: `rtk bun run check`

Expected: typecheck succeeds and all tests pass.

- [ ] **Step 6: Commit C1**

```bash
rtk git add src/runtime/errors.ts src/runtime/logger.ts test/runtime/errors-and-logging.test.ts
rtk git commit -m "feat: add typed runtime error logging"
```

### Task 2 (C2): Migration v3, runtime metadata, and policy-block transition

**Files:**
- Modify: `src/domain/schemas.ts`
- Modify: `src/domain/transitions.ts`
- Modify: `src/harness/contracts.ts`
- Modify: `src/store/migrations.ts`
- Modify: `src/store/orchestration-repository.ts`
- Modify: `test/domain/schemas.test.ts`
- Modify: `test/domain/transitions.test.ts`
- Modify: `test/store/database.test.ts`
- Modify: `test/store/orchestration-repository.test.ts`
- Modify: `test/cli/run.test.ts`

- [ ] **Step 1: Add failing migration and contract assertions**

Add focused assertions that a fresh database is version 3 and that these columns exist:

```ts
expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(3);
expect(db.query<{ name: string }, []>("PRAGMA table_info(tasks)").all().map((row) => row.name))
  .toContain("base_commit");
expect(db.query<{ name: string }, []>("PRAGMA table_info(attempts)").all().map((row) => row.name))
  .toEqual(expect.arrayContaining(["model_profile", "turn_id", "backend_cursor"]));
expect(db.query<{ name: string }, []>("PRAGMA table_info(model_decisions)").all().map((row) => row.name))
  .toContain("model_profile");
```

Extend `test/domain/schemas.test.ts` to accept all three model profiles and reject an unknown profile. Extend the database enum fixture to accept `blocked_policy`, and add an unmappable v2 model migration failure. Update the future-version fixture from 3 to 4 and its expected supported version from 2 to 3.

- [ ] **Step 2: Add the failing policy-block repository test**

Use the existing `startScout()` helper, then apply:

```ts
repo.applyHarnessEvent(attemptId, "1", {
  type: "attempt.blocked_policy",
  eventId: "scout:policy-blocked",
  attemptId,
  sequence: 1,
  occurredAt: "2026-08-26T00:00:02.000Z",
  code: "approval_required",
  message: "Approval requests are disabled",
});

expect(repo.inspectTask("T1")).toEqual({ id: "T1", status: "needs_replan" });
expect(db.query<{ status: string }, [string]>(
  "SELECT status FROM attempts WHERE id = ?",
).get(attemptId)?.status).toBe("blocked_policy");
expect(db.query<{ count: number }, []>(
  "SELECT COUNT(*) AS count FROM events WHERE idempotency_key = 'scout:policy-blocked'",
).get()?.count).toBe(1);
```

Also assert active task states can transition to `needs_replan` and terminal states still cannot reopen.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `rtk bun test test/domain/schemas.test.ts test/store/database.test.ts test/store/orchestration-repository.test.ts test/domain/transitions.test.ts test/cli/run.test.ts`

Expected: FAIL on version 3, missing columns/status/event, and active → `needs_replan` transitions.

- [ ] **Step 4: Extend domain and Harness schemas**

In `src/domain/schemas.ts`, add and export:

```ts
export const ModelProfileSchema = z.enum(["luna", "terra", "sol"]);
```

Add `modelProfile: ModelProfileSchema` to `ModelDecisionSchema`. Import this domain schema into `src/harness/contracts.ts`, extend `HarnessAttemptSchema` with `modelProfile: ModelProfileSchema`, and extend `attempt.started` with optional `turnId` and `baseCommit`. Add `attempt.blocked_policy` exactly as specified in the design. Keep Fake events valid by leaving the new started fields optional.

Update `src/domain/transitions.ts` so `claimed`, `scouting`, `implementing`, and `reviewing` allow `needs_replan` while `done`, `rejected`, and `failed_infra` remain terminal.

- [ ] **Step 5: Implement migration v3 atomically**

In `src/store/migrations.ts`:

1. Reject version > 3.
2. Before disabling foreign keys, query v2 `attempts` and `model_decisions` for any model outside `luna | terra | sol`; throw `Cannot map legacy model profile: <model>` when found.
3. Outside the DDL transaction, save the current foreign-key setting and set `PRAGMA foreign_keys = OFF`.
4. In one `db.transaction`, add `tasks.base_commit`; create `attempts_v3` with all existing columns plus `model_profile`, `turn_id`, the v2 `backend_cursor`, and status check including `blocked_policy`; copy rows with `model_profile = model`; drop old `attempts`; rename.
5. In the same transaction, rebuild `model_decisions` with `model_profile = model`, run `PRAGMA foreign_key_check`, throw if it returns any row, then set `user_version = 3`.
6. Restore the prior foreign-key setting in `finally`, including when the transaction rolls back.

The new attempts table definition must retain both `PRIMARY KEY(id)` and `UNIQUE(task_id, id)` so existing composite foreign keys remain valid.

- [ ] **Step 6: Persist and inspect the new metadata**

Update repository row types and queries so:

- new Slice 2 attempts write `model_profile = route.model` until C3 introduces actual IDs;
- model decisions write the same profile;
- `attempt.started` writes `thread_id`, `turn_id`, and the task's first `base_commit`;
- a conflicting later base commit throws before cursor advancement;
- `attempt.blocked_policy` atomically marks the attempt, transitions the task to `needs_replan`, and adds a `task.needs_replan` audit event;
- `inspect()` includes `modelProfile`, `threadId`, `turnId`, and `gitCommit` on attempts and `modelProfile` on decisions.

Use these inspection shapes:

```ts
const InspectionAttemptSchema = z.object({
  id: NonEmpty,
  role: AgentRoleSchema,
  modelProfile: ModelProfileSchema,
  model: NonEmpty,
  effort: ReasoningEffortSchema,
  status: z.enum(["running", "succeeded", "failed_infra", "blocked_policy"]),
  retryIndex: RetryIndexSchema,
  threadId: NonEmpty.optional(),
  turnId: NonEmpty.optional(),
  gitCommit: NonEmpty.optional(),
  ...TokenTotalsSchema.shape,
}).strict();
```

- [ ] **Step 7: Verify focused and full GREEN**

Run: `rtk bun test test/domain/schemas.test.ts test/store/database.test.ts test/store/orchestration-repository.test.ts test/domain/transitions.test.ts test/cli/run.test.ts`

Expected: all focused tests pass.

Run: `rtk bun run check`

Expected: typecheck succeeds and all tests pass.

- [ ] **Step 8: Commit C2**

```bash
rtk git add src/domain/schemas.ts src/domain/transitions.ts src/harness/contracts.ts src/store/migrations.ts src/store/orchestration-repository.ts test/domain/schemas.test.ts test/domain/transitions.test.ts test/store/database.test.ts test/store/orchestration-repository.test.ts test/cli/run.test.ts
rtk git commit -m "feat: persist real harness attempt metadata"
```

### Task 3 (C3): Catalog-backed deterministic Model Advisor

**Files:**
- Modify: `src/scheduler/model-routing.ts`
- Modify: `src/store/orchestration-repository.ts`
- Create: `test/scheduler/model-routing.test.ts`
- Modify: `test/scheduler/scheduler.test.ts`

- [ ] **Step 1: Write failing Advisor policy tests**

```ts
import { expect, test } from "bun:test";
import { createModelAdvisor } from "../../src/scheduler/model-routing";

const catalog = [
  { id: "gpt-5.6-luna", supportedReasoningEfforts: ["high"] },
  { id: "gpt-5.6-terra", supportedReasoningEfforts: ["high", "xhigh"] },
  { id: "gpt-5.6-sol", supportedReasoningEfforts: ["high", "xhigh"] },
];

test("resolves profiles to actual models without ever selecting low", () => {
  const advisor = createModelAdvisor(catalog);
  expect(advisor.decide({ role: "scout", risk: "medium", retryIndex: 0 })).toMatchObject({
    profile: "luna",
    model: "gpt-5.6-luna",
    effort: "high",
    fallbacks: ["gpt-5.6-terra", "gpt-5.6-sol"],
  });
  expect(advisor.decide({ role: "scout", risk: "high", retryIndex: 0 })).toMatchObject({
    profile: "terra",
    model: "gpt-5.6-terra",
    effort: "xhigh",
  });
  expect(advisor.decide({
    role: "implement",
    risk: "medium",
    retryIndex: 2,
    priorProfile: "terra",
    priorErrorCode: "backend_unavailable",
  })).toMatchObject({ profile: "sol", model: "gpt-5.6-sol", effort: "high" });
});

test("returns undefined when no model supports the required effort", () => {
  const advisor = createModelAdvisor([
    { id: "gpt-5.6-luna", supportedReasoningEfforts: ["low", "medium"] },
  ]);
  expect(advisor.decide({ role: "scout", risk: "medium", retryIndex: 0 })).toBeUndefined();
});
```

- [ ] **Step 2: Run the Advisor test and verify RED**

Run: `rtk bun test test/scheduler/model-routing.test.ts`

Expected: FAIL because `createModelAdvisor` and actual model routing do not exist.

- [ ] **Step 3: Implement the pure Advisor API**

Refactor `src/scheduler/model-routing.ts` around these types:

```ts
export type CatalogModel = {
  id: string;
  supportedReasoningEfforts: string[];
};

export type AdvisorInput = {
  role: "scout" | "implement" | "review";
  risk: "low" | "medium" | "high";
  retryIndex: 0 | 1 | 2;
  priorProfile?: "luna" | "terra" | "sol";
  priorErrorCode?: string;
};

export type Route = {
  profile: "luna" | "terra" | "sol";
  model: string;
  effort: "high" | "xhigh";
  fallbacks: string[];
  rationale: string[];
};

export type ModelAdvisor = { decide(input: AdvisorInput): Route | undefined };
```

`createModelAdvisor(catalog, mapping?)` must preserve server order, honor an exact configured mapping first, filter by exact required effort, use Luna → Terra → Sol fallback, retain retry 1, upgrade retry 2, and upgrade immediately for `model_unavailable`. Add `createStaticModelAdvisor()` mapping profile IDs to themselves so all existing Fake tests remain deterministic.

- [ ] **Step 4: Inject the Advisor into attempt creation**

Add a final optional constructor parameter to avoid changing existing test call sites:

```ts
constructor(
  db: Database,
  now: () => string = () => new Date().toISOString(),
  id: IdFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
  fault: (point: RepositoryFaultPoint) => void = () => {},
  advisor: ModelAdvisor = createStaticModelAdvisor(),
) {}
```

Query `latestAttempt.model_profile` for retries. Persist `route.profile` separately from `route.model`. If `advisor.decide()` returns undefined, atomically transition the active task to `needs_replan`, append one event with `{ reason: "no_compatible_model", role, effort }`, consume no attempt/decision IDs, and return `undefined` so the same Scheduler tick may claim the next ready task.

- [ ] **Step 5: Add the repository routing regression**

Create a repository with `createModelAdvisor(catalog)`, start Scout, and assert inspection contains:

```ts
{
  modelDecisions: [{
    modelProfile: "luna",
    model: "gpt-5.6-luna",
    effort: "high",
    fallbackModels: ["gpt-5.6-terra", "gpt-5.6-sol"],
  }],
  attempts: [{ modelProfile: "luna", model: "gpt-5.6-luna", effort: "high" }],
}
```

Add one no-compatible-model test proving `needs_replan` and zero attempts/decisions.

- [ ] **Step 6: Verify GREEN and full compatibility**

Run: `rtk bun test test/scheduler/model-routing.test.ts test/scheduler/scheduler.test.ts test/store/orchestration-repository.test.ts`

Expected: all focused tests pass, including existing retry rationale tests.

Run: `rtk bun run check`

Expected: typecheck succeeds and all tests pass.

- [ ] **Step 7: Commit C3**

```bash
rtk git add src/scheduler/model-routing.ts src/store/orchestration-repository.ts test/scheduler/model-routing.test.ts test/scheduler/scheduler.test.ts test/store/orchestration-repository.test.ts
rtk git commit -m "feat: resolve model profiles from codex catalog"
```

### Task 4 (C4): Task-scoped Git worktree isolation

**Files:**
- Create: `src/domain/task-path.ts`
- Modify: `src/artifacts/writer.ts`
- Create: `src/workspace/task-worktree.ts`
- Modify: `.gitignore`
- Create: `test/workspace/task-worktree.test.ts`
- Modify: `test/artifacts/writer.test.ts`

- [ ] **Step 1: Write the core worktree test with a real disposable Git repository**

The test initializes a repository, configures local commit identity, writes one file, commits it, and calls `createTaskWorktreeManager(root, "HEAD")`.

```ts
const first = await manager.prepare("T1");
expect(first.path).toBe(join(root, ".agile", "worktrees", "T1"));
expect(first.branch).toBe("agile/T1");
expect(first.baseCommit).toMatch(/^[0-9a-f]{40}$/);
expect(await manager.status("T1")).toBe("");

await Bun.write(join(first.path, "answer.txt"), "42\n");
await git(["add", "answer.txt"], first.path);
await git(["commit", "-m", "feat: answer"], first.path);
const commit = (await git(["rev-parse", "HEAD"], first.path)).stdout.trim();
await expect(manager.assertCommit("T1", commit)).resolves.toBeUndefined();
await expect(manager.prepare("../escape")).rejects.toThrow("Unsafe task path component");
```

Add a symlinked `.agile/worktrees` test proving no external directory is changed.

- [ ] **Step 2: Run the worktree test and verify RED**

Run: `rtk bun test test/workspace/task-worktree.test.ts`

Expected: FAIL because the path validator and worktree manager do not exist.

- [ ] **Step 3: Extract shared task path validation**

Create `src/domain/task-path.ts`:

```ts
import { z } from "zod";

export const SafeTaskPathComponentSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Unsafe task path component");

export function safeTaskPathComponent(value: string): string {
  return SafeTaskPathComponentSchema.parse(value);
}
```

Use it in `src/artifacts/writer.ts` in place of the private duplicate regex. Preserve the existing artifact error wording by catching the Zod failure and throwing `Unsafe artifact task ID: <id>`.

- [ ] **Step 4: Implement the worktree manager**

Export this surface from `src/workspace/task-worktree.ts`:

```ts
export type TaskWorkspace = {
  taskId: string;
  path: string;
  branch: string;
  baseCommit: string;
};

export type TaskWorktreeManager = {
  prepare(taskId: string): Promise<TaskWorkspace>;
  assertCommit(taskId: string, commitSha: string): Promise<void>;
  status(taskId: string): Promise<string>;
};

export async function createTaskWorktreeManager(
  repoPath: string,
  baseRef: string,
): Promise<TaskWorktreeManager>;
```

Implementation requirements:

- canonicalize `repoPath` and require `git rev-parse --show-toplevel` to equal it;
- resolve `baseRef` once to a full commit SHA;
- create and validate real `.agile` and `.agile/worktrees` directories without following symlinks;
- run Git with `Bun.spawn(["git", ...args], { cwd })` and argument arrays only;
- create with `git worktree add -b agile/<taskId> <path> <baseSha>`;
- when path/branch already exists, reuse only if `git worktree list --porcelain`, branch, and merge-base all match;
- `assertCommit` requires a 40-character SHA, verifies `git cat-file -e <sha>^{commit}`, and requires the commit to be reachable from `agile/<taskId>`;
- never remove or force-reset a worktree.

- [ ] **Step 5: Ignore task worktrees and keep artifact tests green**

Add exactly:

```gitignore
.agile/worktrees/
```

Run: `rtk bun test test/workspace/task-worktree.test.ts test/artifacts/writer.test.ts`

Expected: worktree isolation tests and all existing artifact safety tests pass.

- [ ] **Step 6: Run full verification**

Run: `rtk bun run check`

Expected: typecheck succeeds and all tests pass.

- [ ] **Step 7: Commit C4**

```bash
rtk git add .gitignore src/domain/task-path.ts src/artifacts/writer.ts src/workspace/task-worktree.ts test/workspace/task-worktree.test.ts test/artifacts/writer.test.ts
rtk git commit -m "feat: isolate tasks in git worktrees"
```

### Task 5 (C5): Minimal Codex app-server JSON-RPC client

**Files:**
- Create: `src/codex/protocol.ts`
- Create: `src/codex/client.ts`
- Create: `test/fixtures/scripted-app-server.ts`
- Create: `test/codex/client.test.ts`

- [ ] **Step 1: Write one scripted-process client test**

The fixture reads JSONL stdin. It responds to `initialize` and `model/list`, emits one `warning` notification, responds to a test-only `fixture/exit`, and exits. The test asserts:

```ts
import { join } from "node:path";

const fixturePath = join(import.meta.dir, "..", "fixtures", "scripted-app-server.ts");
const client = await CodexClient.start({
  command: [process.execPath, fixturePath],
  clientInfo: { name: "agile_agents_test", title: "Agile Agents Test", version: "0.1.0" },
});
const models = ModelListResponseSchema.parse(await client.request("model/list", {
  limit: 100,
  includeHidden: false,
}));
expect(models.data[0]).toMatchObject({
  id: "gpt-5.6-terra",
  supportedReasoningEfforts: [{ reasoningEffort: "high" }],
});
expect(await client.nextServerMessage()).toMatchObject({ method: "warning" });
await client.request("fixture/exit", {});
await expect(client.request("model/list", {})).rejects.toMatchObject({
  code: "CODEX_APP_SERVER_EXITED",
  category: "infra",
});
```

- [ ] **Step 2: Run the client test and verify RED**

Run: `rtk bun test test/codex/client.test.ts`

Expected: FAIL because the protocol and client modules do not exist.

- [ ] **Step 3: Define the small forward-compatible protocol subset**

In `src/codex/protocol.ts`, define generic response, notification, and server-request envelopes with `.passthrough()`. Export strict required-field schemas for:

```ts
export const ModelListResponseSchema = z.object({
  data: z.array(z.object({
    id: NonEmpty,
    hidden: z.boolean(),
    supportedReasoningEfforts: z.array(z.object({
      reasoningEffort: NonEmpty,
    }).passthrough()),
  }).passthrough()),
  nextCursor: NonEmpty.nullable(),
}).passthrough();

export const ServerMessageSchema = z.union([
  z.object({ method: NonEmpty, id: RpcIdSchema, params: z.unknown() }).passthrough(),
  z.object({ method: NonEmpty, params: z.unknown() }).passthrough(),
]);
```

The client must not vendor generated Codex types or accept a runtime dependency beyond Zod.

- [ ] **Step 4: Implement JSONL framing, correlation, and inbound queue**

Export this API from `src/codex/client.ts`:

```ts
export type CodexClientApi = {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, code: number, message: string): void;
  nextServerMessage(): Promise<z.infer<typeof ServerMessageSchema>>;
  close(): Promise<void>;
};

export class CodexClient implements CodexClientApi {
  static async start(input?: {
    command?: string[];
    clientInfo?: { name: string; title: string; version: string };
  }): Promise<CodexClient>;
}
```

Required behavior:

- default command is `["codex", "app-server", "--stdio"]`;
- start stdout/stderr/exited watchers before sending `initialize`;
- split arbitrary byte chunks into newline-delimited JSON without assuming chunk boundaries;
- resolve only the matching pending request ID;
- queue notifications and server requests in arrival order;
- turn JSON parse failures, RPC errors, write failures, and process exit into safe `AgileError` instances;
- do not include raw lines or stderr in safe error messages;
- after initialize response, send `initialized` exactly once;
- `close()` rejects pending requests, closes stdin, waits at most two seconds, then kills the child if needed.

- [ ] **Step 5: Implement the scripted fixture**

`test/fixtures/scripted-app-server.ts` must assert initialize occurs first, echo matching request IDs, send this model record, and never call a model:

```ts
{
  id: "gpt-5.6-terra",
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "default" }],
}
```

Use a small buffered stdin loop; write responses with `process.stdout.write(`${JSON.stringify(message)}\n`)`.

- [ ] **Step 6: Verify the focused test**

Run: `rtk bun test test/codex/client.test.ts`

Expected: scripted initialize/model/notification/exit test passes without network or Codex authentication.

- [ ] **Step 7: Run full verification**

Run: `rtk bun run check`

Expected: typecheck succeeds and all tests pass.

- [ ] **Step 8: Commit C5**

```bash
rtk git add src/codex/protocol.ts src/codex/client.ts test/fixtures/scripted-app-server.ts test/codex/client.test.ts
rtk git commit -m "feat: add codex app server client"
```

### Task 6 (C6): Scout and Implement CodexHarness with normalized usage

**Files:**
- Create: `src/codex/prompts.ts`
- Create: `src/codex/harness.ts`
- Modify: `src/codex/protocol.ts`
- Modify: `src/harness/contracts.ts`
- Create: `test/codex/harness.test.ts`

- [ ] **Step 1: Write a recorded Scout/Implement Harness test**

Inside the test file, use a tiny in-memory `CodexClientApi` script, not a product Fake Harness. Record the exact request sequence and feed only these app-server shapes:

- `thread/start` response with thread ID;
- `turn/start` response with turn ID;
- `thread/tokenUsage/updated` cumulative totals;
- `item/completed` with final `agentMessage.text` JSON;
- `turn/completed` with status `completed`.

Assert Scout deliveries are:

```ts
[
  { type: "attempt.started", threadId: "thread-scout", turnId: "turn-scout" },
  { type: "attempt.usage_delta", inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 1 },
  { type: "attempt.output", output: { kind: "scout" } },
  { type: "attempt.completed" },
]
```

For Implement, create a real commit in the Task C4 disposable worktree and assert the output commit is accepted. Replay the same cumulative usage and assert no second usage delta is emitted.

- [ ] **Step 2: Run the Harness test and verify RED**

Run: `rtk bun test test/codex/harness.test.ts`

Expected: FAIL because prompts, protocol notification schemas, cursor, and Harness do not exist.

- [ ] **Step 3: Add exact role prompts and JSON Schemas**

In `src/codex/prompts.ts`, export:

```ts
export function scoutPrompt(input: Extract<HarnessStepRequest["input"], { role: "scout" }>): string;
export function implementPrompt(input: Extract<HarnessStepRequest["input"], { role: "implement" }>): string;
export const ScoutOutputJsonSchema = z.toJSONSchema(ScoutOutputSchema);
export const ImplementOutputJsonSchema = z.toJSONSchema(ImplementOutputSchema);
```

Scout instructions explicitly forbid writes. Implement instructions require the ticket validations, one commit, and JSON matching the existing output schema. Serialize the validated ticket and Scout capsule with `JSON.stringify(value, null, 2)`; do not interpolate shell commands.

- [ ] **Step 4: Add the protocol notification subset**

Add required-field Zod schemas for:

- thread/start and turn/start responses;
- `thread/tokenUsage/updated` with `tokenUsage.total.{inputTokens,cachedInputTokens,outputTokens,reasoningOutputTokens}`;
- `item/completed` agent messages;
- `turn/completed` status and safe error classification.

All external schemas remain `.passthrough()` to tolerate additive fields.

- [ ] **Step 5: Implement the versioned cursor and event identity**

Inside `src/codex/harness.ts`, define:

```ts
const BackendCursorSchema = z.object({
  version: z.literal(1),
  nextSequence: z.number().int().positive(),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  }).strict(),
}).strict();
```

Serialize it as compact JSON in `nextCursor`. Build stable IDs from attempt ID plus turn/item/status identity; for usage include a SHA-256 hash of canonical cumulative totals. Increment the sequence only when returning a normalized event.

- [ ] **Step 6: Implement Scout/Implement dispatch and delivery**

Export:

```ts
export function createCodexHarness(input: {
  client: CodexClientApi;
  worktrees: TaskWorktreeManager;
  now?: () => string;
}): AgentHarness;
```

On first dispatch:

1. prepare/reuse the task worktree;
2. call `thread/start` with actual model ID, cwd, `approvalPolicy: "never"`, role sandbox, and service name `agile_agents`;
3. call `turn/start` with model, effort, network-disabled sandbox policy, prompt, and output schema;
4. return `attempt.started` with thread ID, turn ID, and base commit.

On subsequent steps, consume inbound messages until one produces a normalized delivery. Convert cumulative usage to a positive delta from the cursor. Parse final agent message JSON through the role Zod schema. For Implement, call `worktrees.assertCommit()` before emitting output. Emit completion only after a valid output was delivered.

`cancel(attemptId)` calls `turn/interrupt` for the active thread/turn and is a no-op only when the attempt is already terminal.

- [ ] **Step 7: Verify focused and full GREEN**

Run: `rtk bun test test/codex/harness.test.ts test/harness/fake.test.ts test/scheduler/scheduler.test.ts`

Expected: recorded Scout/Implement flow passes and Fake behavior remains unchanged.

Run: `rtk bun run check`

Expected: typecheck succeeds and all tests pass.

- [ ] **Step 8: Commit C6**

```bash
rtk git add src/codex/prompts.ts src/codex/harness.ts src/codex/protocol.ts src/harness/contracts.ts test/codex/harness.test.ts
rtk git commit -m "feat: run scout and implement through codex"
```

### Task 7 (C7): Detached Review, approval blocking, and minimal reconciliation

**Files:**
- Modify: `src/codex/prompts.ts`
- Modify: `src/codex/harness.ts`
- Modify: `src/codex/protocol.ts`
- Modify: `test/codex/harness.test.ts`
- Modify: `test/store/orchestration-repository.test.ts`

- [ ] **Step 1: Extend the recorded test through detached Review**

Feed a Review script that expects:

1. a fresh `thread/start` using Sol, read-only sandbox, and no normal turn;
2. `review/start` with `delivery: "detached"` and custom instructions naming the exact Implement commit;
3. a response whose `reviewThreadId` differs from the anchor and Implement threads;
4. `item/completed` containing `exitedReviewMode.review` with strict Review JSON;
5. `turn/completed` status `completed`.

Assert Review receives no Implement thread ID/history, worktree status is identical before/after, and output is `accepted`.

- [ ] **Step 2: Add the approval-block recorded test**

Feed `item/commandExecution/requestApproval` during Implement and assert:

```ts
expect(script.responses).toContainEqual({ id: 91, result: { decision: "decline" } });
expect(script.requests).toContainEqual({
  method: "turn/interrupt",
  params: { threadId: "thread-implement", turnId: "turn-implement" },
});
expect(delivery.event).toMatchObject({
  type: "attempt.blocked_policy",
  code: "approval_required",
  attemptId: "attempt-implement",
});
```

Apply the delivery through the real repository and assert task `needs_replan`, attempt `blocked_policy`, no retry attempt, and the next ready task remains claimable.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `rtk bun test test/codex/harness.test.ts test/store/orchestration-repository.test.ts`

Expected: FAIL because Review, approval responses, and reconciliation are not implemented.

- [ ] **Step 4: Add Review and approval protocol schemas**

Add required-field schemas for review/start response, `exitedReviewMode`, thread/read, and the modern server requests used by this slice. Respond as follows:

| Method | Response |
|---|---|
| `item/commandExecution/requestApproval` | `{ decision: "decline" }` |
| `item/fileChange/requestApproval` | `{ decision: "decline" }` |
| `item/permissions/requestApproval` | `{ permissions: {}, scope: "turn" }` |
| `item/tool/requestUserInput` | `{ answers: {} }` |
| `mcpServer/elicitation/request` | `{ action: "decline", content: null, _meta: null }` |

An unknown server request receives JSON-RPC error `-32601` and still blocks/interrupts the active attempt; no unknown request is silently accepted.

- [ ] **Step 5: Implement fresh detached Review**

Add `reviewPrompt()` returning instructions that name the exact commit and demand JSON matching `ReviewOutputSchema`. For Review dispatch:

- snapshot `worktrees.status(taskId)`;
- start a new empty read-only anchor thread with the Review model;
- call `review/start` on the anchor with `delivery: "detached"` and `{ type: "custom", instructions }`;
- use `reviewThreadId` and returned turn ID for `attempt.started`;
- parse `exitedReviewMode.review` as JSON and Zod;
- compare worktree status before output; if changed, emit retryable `review_mutated_workspace` instead of output.

- [ ] **Step 6: Implement policy block and minimal reconcile**

When any server request arrives for the active turn, respond with the denial above, call `turn/interrupt`, and return one stable `attempt.blocked_policy` event. Never return a retryable infra event for this case.

For `mode: "reconcile"`, call `thread/resume` then `thread/read` with `includeTurns: true`:

- reconstruct valid terminal output/completion items with the same stable IDs;
- map failed/interrupted turns to retryable `attempt.failed_infra`;
- when completion cannot be proven, emit retryable code `orphaned_turn`;
- never infer Implement success from Git commit alone.

- [ ] **Step 7: Verify the complete recorded core flow**

Run: `rtk bun test test/codex/harness.test.ts test/store/orchestration-repository.test.ts test/integration/deterministic-orchestrator.test.ts`

Expected: recorded Scout → Implement → detached Review passes, approval block reaches `needs_replan`, and the existing Fake no-loop gate remains green.

Run: `rtk bun run check`

Expected: typecheck succeeds and all tests pass.

- [ ] **Step 8: Commit C7**

```bash
rtk git add src/codex/prompts.ts src/codex/harness.ts src/codex/protocol.ts test/codex/harness.test.ts test/store/orchestration-repository.test.ts
rtk git commit -m "feat: add isolated codex review and recovery"
```

### Task 8 (C8): CLI backend composition and opt-in real Codex smoke

**Files:**
- Modify: `src/cli/help.ts`
- Modify: `src/cli/run.ts`
- Modify: `test/cli/help.test.ts`
- Modify: `test/cli/scheduler.test.ts`
- Create: `test/integration/real-codex.test.ts`

- [ ] **Step 1: Write failing backend-selection CLI tests**

Add tests for:

```ts
expect(await runCli(["scheduler", "run"], io, runtime)).toBe(2);
expect(errors[0]).toContain("--backend fake|codex");

expect(await runCli([
  "scheduler", "run", "--backend", "codex", "--repo", root, "--db", databasePath,
], io, runtime)).toBe(0);
expect(calls[0]).toEqual({
  backend: "codex",
  repoPath: resolve(root),
  baseRef: "HEAD",
  dbPath: resolve(databasePath),
});
```

Also prove Fake requires `--fake-script`, Codex rejects `--fake-script`, Codex requires `--repo`, and operational errors are rendered once with the AgileError code.

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `rtk bun test test/cli/help.test.ts test/cli/scheduler.test.ts`

Expected: FAIL because backend/repo/base parsing and Codex composition do not exist.

- [ ] **Step 3: Refactor the CLI runtime input into a discriminated union**

Use:

```ts
type SchedulerRunInput =
  | { backend: "fake"; dbPath: string; scenario: unknown }
  | { backend: "codex"; dbPath: string; repoPath: string; baseRef: string };

type CliRuntime = {
  runScheduler(input: SchedulerRunInput): Promise<void>;
  logError?(error: AgileError, input: { dbPath: string; repoPath?: string }): Promise<void>;
};
```

Add `backend`, `repo`, and `base` parse options. Require explicit backend. Keep configuration failures at exit 2 and runtime failures at exit 1.

- [ ] **Step 4: Compose the real backend in startup-safe order**

For Codex input:

1. create the worktree manager and resolve base;
2. start `CodexClient` and initialize;
3. call `model/list` through `ModelListResponseSchema`;
4. map entries to `CatalogModel` and create the Advisor;
5. open SQLite;
6. create `OrchestrationRepository(db, now, id, fault, advisor)`;
7. create `CodexHarness`, Scheduler, and Daemon;
8. on signal, interrupt the active turn, stop the daemon, close client, and close SQLite in nested `finally` blocks.

For Fake input, preserve the existing runtime behavior and static Advisor. Build `.agile/runtime/agile.log` under the Codex repository; for Fake/custom DB use `join(dirname(dbPath), "agile.log")`. Normalize and log runtime errors without serializing raw app-server errors.

Generate one `runId` with `crypto.randomUUID()` and reuse it as the daemon owner ID. Immediately before running the daemon, write a safe `SCHEDULER_RUN_STARTED` info record; after orderly shutdown, write `SCHEDULER_RUN_STOPPED`. Both records include the same `runId`, and normalized runtime errors receive it too. These lifecycle records make successful runs observable without logging prompts, environment variables, raw protocol messages, or model output.

- [ ] **Step 5: Update help text**

```text
agile scheduler run --backend fake --fake-script PATH [--db PATH]
agile scheduler run --backend codex --repo PATH [--base REF] [--db PATH]
agile scheduler inspect [--db PATH]
```

- [ ] **Step 6: Write the opt-in real smoke**

In `test/integration/real-codex.test.ts`, skip unless `process.env.AGILE_REAL_CODEX === "1"`. Create a disposable Git repository with a committed `answer.ts` returning `0` and a Bun test expecting `42`. Seed one approved ready task whose acceptance is to change the function to `42`, pass the test, and commit exactly once. Before startup, set `process.env.AGILE_TEST_SECRET = "AGILE_SECRET_SENTINEL_DO_NOT_LOG"`; restore its prior value (or delete it) in `finally`.

Run the real CLI runtime, poll SQLite until `done`, send SIGTERM, then assert:

- exactly three succeeded attempts in Scout/Implement/Review order;
- profiles Luna/Terra/Sol and actual model IDs from the catalog;
- every effort is high or xhigh;
- distinct Scout, Implement, and Review thread IDs plus non-empty turn IDs;
- one verified Implement commit in `.agile/worktrees/T1`;
- accepted review and nonzero total usage;
- Review left the worktree clean;
- the JSONL log contains `SCHEDULER_RUN_STARTED` and `SCHEDULER_RUN_STOPPED` with the same non-empty `runId`;
- the JSONL log does not contain sentinel `AGILE_SECRET_SENTINEL_DO_NOT_LOG`.

Use a 10-minute test timeout. In `finally`, stop the runtime, close databases, run `git worktree remove` from the disposable main repository, and remove only the disposable root.

- [ ] **Step 7: Run offline release gates first**

Run: `rtk bun run typecheck`

Expected: exit 0.

Run: `rtk bun test`

Expected: all offline tests pass; the real Codex test reports skipped when the environment variable is absent.

- [ ] **Step 8: Run the explicit real gate**

Run: `rtk env AGILE_REAL_CODEX=1 bun test test/integration/real-codex.test.ts`

Expected: 1 pass, 0 fail; one real accepted ticket reaches `done`. If local Codex authentication or all compatible profiles are unavailable, report the exact startup blocker and do not weaken effort, sandbox, or approval policy to make the test pass.

- [ ] **Step 9: Run final verification and commit C8**

Run: `rtk bun run check`

Expected: typecheck succeeds and all offline tests pass.

Run: `rtk git diff --check`

Expected: no output.

```bash
rtk git add src/cli/help.ts src/cli/run.ts test/cli/help.test.ts test/cli/scheduler.test.ts test/integration/real-codex.test.ts
rtk git commit -m "feat: run scheduler with real codex"
```

## Slice completion gate

Run from a clean branch after all eight task reviews are resolved:

```bash
rtk bun install --frozen-lockfile
rtk bun run typecheck
rtk bun test
rtk env AGILE_REAL_CODEX=1 bun test test/integration/real-codex.test.ts
rtk git diff --check main...HEAD
rtk git status --short
```

Required result:

- all offline tests pass;
- the opt-in real test completes one accepted ticket;
- Fake and Codex remain separate `AgentHarness` implementations;
- no selected effort is `low`;
- Review has no Implement conversation and does not modify the worktree;
- approval requests produce `needs_replan`, never a blocked daemon or retry loop;
- task/role/model/thread/turn/commit/usage are visible through `scheduler inspect`;
- the worktree is clean.
