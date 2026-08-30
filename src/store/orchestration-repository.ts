import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  ContextRefSchema,
  ModelProfileSchema,
  StoredTaskSchema,
  TaskHookPhaseSchema,
  TaskStatusSchema,
  TicketSpecSchema,
} from "../domain/schemas";
import { assertTransition } from "../domain/transitions";
import {
  AgentRoleSchema,
  HarnessAttemptSchema,
  type HarnessEvent,
  HarnessEventSchema,
  HarnessRoleInputSchema,
  type HarnessStepRequest,
  type ImplementOutput,
  ReasoningEffortSchema,
  RetryIndexSchema,
} from "../harness/contracts";
import {
  createStaticModelAdvisor,
  type ModelAdvisor,
  type Route,
} from "../scheduler/model-routing";

export type IdFactory = (
  kind: "attempt" | "decision" | "event" | "review" | "task",
) => string;
export type RepositoryFaultPoint =
  | "after_event_insert"
  | "before_cursor_update";

export type RunningAttempt = {
  descriptor: HarnessStepRequest["attempt"];
  input: z.infer<typeof HarnessRoleInputSchema>;
  backendCursor?: string;
};

export type TaskHookRecord = {
  taskId: string;
  phase: "prehook" | "posthook";
  configHash: string;
  trustedHash?: string;
  status: "pending" | "running" | "succeeded" | "failed";
  attempts: number;
  workspacePath?: string;
};

export type HookAttemptStart =
  | { kind: "untrusted" }
  | { kind: "succeeded" }
  | { kind: "exhausted" }
  | { kind: "started"; attempt: number };

export type TaskPublicationRecord = {
  taskId: string;
  branch: string;
  baseBranch: string;
  commitSha: string;
  status: "pending" | "published" | "failed";
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestState?: "OPEN" | "MERGED";
  failureMessage?: string;
};

export type PublishingTask = {
  task: z.infer<typeof StoredTaskSchema>;
  implementation: ImplementOutput;
  publication?: TaskPublicationRecord;
};

const NonEmpty = z.string().trim().min(1);
const CycleIdSchema = NonEmpty;
const TokenTotalsSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  })
  .strict();
const CategoryTokenUsageSchema = z
  .object({
    category: NonEmpty,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
const CycleCategoryUsageSchema = z
  .object({
    cycleId: CycleIdSchema,
    categories: z.array(CategoryTokenUsageSchema),
  })
  .strict();
const InspectionModelDecisionSchema = z
  .object({
    id: NonEmpty,
    role: AgentRoleSchema,
    modelProfile: ModelProfileSchema,
    model: NonEmpty,
    effort: z.enum(["medium", "high", "xhigh"]),
    tokenTarget: z.number().int().positive(),
    fallbackModels: z.array(NonEmpty),
    decidedBy: z.enum(["rule", "advisor-llm", "fallback"]),
    confidence: z.number().min(0).max(1),
    rationale: z.array(NonEmpty).min(1),
  })
  .strict();
const InspectionRoleSchema = z
  .object({
    role: AgentRoleSchema,
    actual: TokenTotalsSchema,
  })
  .strict();
const InspectionAttemptSchema = z
  .object({
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
  })
  .strict();
const InspectionTaskSchema = z
  .object({
    id: NonEmpty,
    status: TaskStatusSchema,
    priority: z.number().int().nonnegative(),
    tokenTarget: z.number().int().positive(),
    actual: TokenTotalsSchema,
    contextRef: ContextRefSchema.optional(),
    modelDecisions: z.array(InspectionModelDecisionSchema),
    roles: z.array(InspectionRoleSchema),
    attempts: z.array(InspectionAttemptSchema),
  })
  .strict();
const InspectionSchedulerSchema = z
  .object({
    activeTaskId: NonEmpty.optional(),
    activeAttemptId: NonEmpty.optional(),
  })
  .strict();
const InspectionCycleSchema = z
  .object({
    id: CycleIdSchema,
    tokenTarget: z.number().int().positive(),
    actual: TokenTotalsSchema,
  })
  .strict();
const InspectionSnapshotSchema = z
  .object({
    scheduler: InspectionSchedulerSchema,
    cycles: z.array(InspectionCycleSchema),
    tasks: z.array(InspectionTaskSchema),
  })
  .strict();

export type TokenTotals = z.infer<typeof TokenTotalsSchema>;
export type CategoryTokenUsage = z.infer<typeof CategoryTokenUsageSchema>;
export type CycleCategoryUsage = z.infer<typeof CycleCategoryUsageSchema>;
export type InspectionModelDecision = z.infer<
  typeof InspectionModelDecisionSchema
>;
export type InspectionRole = z.infer<typeof InspectionRoleSchema>;
export type InspectionAttempt = z.infer<typeof InspectionAttemptSchema>;
export type InspectionTask = z.infer<typeof InspectionTaskSchema>;
export type InspectionScheduler = z.infer<typeof InspectionSchedulerSchema>;
export type InspectionCycle = z.infer<typeof InspectionCycleSchema>;
export type InspectionSnapshot = z.infer<typeof InspectionSnapshotSchema>;

type TaskRow = {
  id: string;
  cycle_id: string;
  title: string;
  spec_json: string;
  spec_path: string | null;
  spec_hash: string | null;
  base_commit: string | null;
  status: string;
  priority: number;
  approval_required: number;
  approved: number;
  context_id: string | null;
};

type RunningAttemptRow = TaskRow & {
  attempt_id: string;
  role: string;
  model_profile: string;
  model: string;
  effort: string;
  retry_index: number;
  backend_cursor: string | null;
  context_thread_id: string | null;
  context_anchor_id: string | null;
  context_source_task_id: string | null;
  context_git_commit: string | null;
  context_summary_artifact: string | null;
};

type TaskHookRow = {
  task_id: string;
  phase: string;
  config_hash: string;
  trusted_hash: string | null;
  status: string;
  attempts: number;
  workspace_path: string | null;
};

type TaskPublicationRow = {
  task_id: string;
  branch: string;
  base_branch: string;
  commit_sha: string;
  status: string;
  pull_request_number: number | null;
  pull_request_url: string | null;
  pull_request_state: string | null;
  failure_message: string | null;
};

/** Converts a database task row into its validated stored-task representation. */
function storedTask(row: TaskRow) {
  return StoredTaskSchema.parse({
    id: row.id,
    cycleId: row.cycle_id,
    title: row.title,
    spec: JSON.parse(row.spec_json),
    status: row.status,
    priority: row.priority,
    approvalRequired: Boolean(row.approval_required),
    approved: Boolean(row.approved),
    specPath: row.spec_path ?? undefined,
    specHash: row.spec_hash ?? undefined,
    baseCommit: row.base_commit ?? undefined,
  });
}

/** Converts one persisted hook row into the scheduler's validated hook receipt. */
function taskHookRecord(row: TaskHookRow): TaskHookRecord {
  return {
    taskId: row.task_id,
    phase: TaskHookPhaseSchema.parse(row.phase),
    configHash: row.config_hash,
    trustedHash: row.trusted_hash ?? undefined,
    status: z
      .enum(["pending", "running", "succeeded", "failed"])
      .parse(row.status),
    attempts: z.number().int().min(0).max(3).parse(row.attempts),
    workspacePath: row.workspace_path ?? undefined,
  };
}

/** Converts one persisted publication row into the scheduler's durable publication receipt. */
function taskPublicationRecord(row: TaskPublicationRow): TaskPublicationRecord {
  return {
    taskId: row.task_id,
    branch: NonEmpty.parse(row.branch),
    baseBranch: NonEmpty.parse(row.base_branch),
    commitSha: NonEmpty.parse(row.commit_sha),
    status: z.enum(["pending", "published", "failed"]).parse(row.status),
    pullRequestNumber:
      row.pull_request_number === null
        ? undefined
        : z.number().int().positive().parse(row.pull_request_number),
    pullRequestUrl:
      row.pull_request_url === null
        ? undefined
        : NonEmpty.parse(row.pull_request_url),
    pullRequestState:
      row.pull_request_state === null
        ? undefined
        : z.enum(["OPEN", "MERGED"]).parse(row.pull_request_state),
    failureMessage:
      row.failure_message === null
        ? undefined
        : NonEmpty.parse(row.failure_message),
  };
}

export class OrchestrationRepository {
  /** Creates an orchestration repository with injectable time, IDs, faults, and routing. */
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: IdFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
    private readonly fault: (point: RepositoryFaultPoint) => void = () => {},
    private readonly advisor: ModelAdvisor = createStaticModelAdvisor(),
  ) {}

  /** Atomically claims the next approved dependency-ready task under the scheduler lease. */
  claimNext(leaseOwnerId?: string): { taskId: string } | undefined {
    return this.db.transaction(() => {
      this.assertLeaseOwner(leaseOwnerId);
      const row = this.db
        .query<{ id: string }, []>(`
        SELECT task.id
        FROM tasks AS task
        WHERE task.status = 'ready'
          AND task.approved = 1
          AND NOT EXISTS (
            SELECT 1 FROM tasks AS active
            WHERE active.status IN ('claimed', 'scouting', 'implementing', 'reviewing', 'publishing')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM task_deps AS dep
            JOIN tasks AS dependency ON dependency.id = dep.depends_on_task_id
            WHERE dep.task_id = task.id AND dependency.status <> 'done'
          )
        ORDER BY task.priority ASC, task.created_at ASC, task.id ASC
        LIMIT 1
      `)
        .get();
      if (!row) return undefined;

      const changed = this.db
        .query(`
        UPDATE tasks SET status = 'claimed', updated_at = ?
        WHERE id = ? AND status = 'ready'
      `)
        .run(this.now(), row.id).changes;
      if (changed !== 1) return undefined;

      this.db
        .query(`
        INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
        VALUES(?, ?, 'task.claimed', '{}', ?)
      `)
        .run(this.id("event"), row.id, this.now());
      return { taskId: row.id };
    })();
  }

  /** Returns the single claimed task that must finish its prehook before Scout can start. */
  getClaimedTask(): z.infer<typeof StoredTaskSchema> | undefined {
    const row = this.db
      .query<TaskRow, []>(`
        SELECT id, cycle_id, title, spec_json, spec_path, spec_hash, base_commit, status,
               priority, approval_required, approved, context_id
        FROM tasks
        WHERE status = 'claimed'
        ORDER BY priority ASC, created_at ASC, id ASC
        LIMIT 1
      `)
      .get();
    return row === null ? undefined : storedTask(row);
  }

  /** Returns one validated stored task by identity for task-scoped lifecycle operations. */
  getTask(taskId: string): z.infer<typeof StoredTaskSchema> | undefined {
    const row = this.db
      .query<TaskRow, [string]>(`
        SELECT id, cycle_id, title, spec_json, spec_path, spec_hash, base_commit, status,
               priority, approval_required, approved, context_id
        FROM tasks WHERE id = ?
      `)
      .get(taskId);
    return row === null ? undefined : storedTask(row);
  }

  /** Returns terminal tasks in deterministic order so their posthooks can be settled. */
  listTerminalTasks(): z.infer<typeof StoredTaskSchema>[] {
    return this.db
      .query<TaskRow, []>(`
        SELECT id, cycle_id, title, spec_json, spec_path, spec_hash, base_commit, status,
               priority, approval_required, approved, context_id
        FROM tasks
        WHERE status IN ('done', 'rejected', 'failed_infra')
        ORDER BY updated_at ASC, id ASC
      `)
      .all()
      .map(storedTask);
  }

  /** Returns tasks whose posthooks must settle before a publishing task can reach its final state. */
  listPosthookTasks(): z.infer<typeof StoredTaskSchema>[] {
    return this.db
      .query<TaskRow, []>(`
        SELECT id, cycle_id, title, spec_json, spec_path, spec_hash, base_commit, status,
               priority, approval_required, approved, context_id
        FROM tasks
        WHERE status IN ('publishing', 'done', 'rejected', 'failed_infra')
        ORDER BY updated_at ASC, id ASC
      `)
      .all()
      .map(storedTask);
  }

  /** Returns pending accepted tasks with their durable Implement output and publication state. */
  listPublishingTasks(): PublishingTask[] {
    return this.db
      .query<TaskRow, []>(`
        SELECT id, cycle_id, title, spec_json, spec_path, spec_hash, base_commit, status,
               priority, approval_required, approved, context_id
        FROM tasks
        WHERE status = 'publishing'
        ORDER BY updated_at ASC, id ASC
      `)
      .all()
      .map((row) => {
        const task = storedTask(row);
        return {
          task,
          implementation: this.implementationOutput(task.id),
          publication: this.getTaskPublication(task.id),
        };
      });
  }

  /** Returns the durable publication receipt for one task when publication has begun. */
  getTaskPublication(taskId: string): TaskPublicationRecord | undefined {
    const row = this.db
      .query<TaskPublicationRow, [string]>(`
        SELECT task_id, branch, base_branch, commit_sha, status, pull_request_number,
               pull_request_url, pull_request_state, failure_message
        FROM task_publications WHERE task_id = ?
      `)
      .get(taskId);
    return row === null ? undefined : taskPublicationRecord(row);
  }

  /** Creates or resumes a durable publication receipt before any remote publication side effect. */
  beginPublication(input: {
    taskId: string;
    branch: string;
    baseBranch: string;
    commitSha: string;
    leaseOwnerId?: string;
  }): TaskPublicationRecord {
    return this.db.transaction(() => {
      this.assertLeaseOwner(input.leaseOwnerId);
      const task = this.getTask(input.taskId);
      if (task === undefined)
        throw new Error(`Task not found: ${input.taskId}`);
      if (task.status !== "publishing") {
        throw new Error(`Task is not publishing: ${input.taskId}`);
      }
      const implementation = this.implementationOutput(input.taskId);
      if (implementation.commitSha !== input.commitSha) {
        throw new Error(
          `Publication commit does not match the Implement output: ${input.taskId}`,
        );
      }
      const existing = this.getTaskPublication(input.taskId);
      if (
        existing !== undefined &&
        existing.branch === input.branch &&
        existing.baseBranch === input.baseBranch &&
        existing.commitSha === input.commitSha
      ) {
        return existing;
      }
      if (existing?.status === "published") {
        throw new Error(
          `Published task cannot start a new publication: ${input.taskId}`,
        );
      }
      const now = this.now();
      this.db
        .query(`
          INSERT INTO task_publications(
            task_id, branch, base_branch, commit_sha, status, pull_request_number,
            pull_request_url, pull_request_state, failure_message, created_at, updated_at
          ) VALUES(?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            branch = excluded.branch,
            base_branch = excluded.base_branch,
            commit_sha = excluded.commit_sha,
            status = 'pending',
            pull_request_number = NULL,
            pull_request_url = NULL,
            pull_request_state = NULL,
            failure_message = NULL,
            updated_at = excluded.updated_at
        `)
        .run(
          input.taskId,
          NonEmpty.parse(input.branch),
          NonEmpty.parse(input.baseBranch),
          NonEmpty.parse(input.commitSha),
          now,
          now,
        );
      this.db
        .query(`
          INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
          VALUES(?, ?, 'task.publication_started', ?, ?)
        `)
        .run(
          this.id("event"),
          input.taskId,
          JSON.stringify({
            branch: input.branch,
            baseBranch: input.baseBranch,
            commitSha: input.commitSha,
          }),
          now,
        );
      const publication = this.getTaskPublication(input.taskId);
      if (publication === undefined)
        throw new Error(`Publication was not created: ${input.taskId}`);
      return publication;
    })();
  }

  /** Records a reconciled pull request and atomically completes its publishing task. */
  completePublication(input: {
    taskId: string;
    pullRequest: { number: number; url: string; state: "OPEN" | "MERGED" };
    leaseOwnerId?: string;
  }): void {
    this.db.transaction(() => {
      this.assertLeaseOwner(input.leaseOwnerId);
      const task = this.getTask(input.taskId);
      if (task === undefined)
        throw new Error(`Task not found: ${input.taskId}`);
      if (task.status !== "publishing") {
        throw new Error(`Task is not publishing: ${input.taskId}`);
      }
      const publication = this.getTaskPublication(input.taskId);
      if (publication === undefined)
        throw new Error(`Publication was not started: ${input.taskId}`);
      const now = this.now();
      this.db
        .query(`
          UPDATE task_publications
          SET status = 'published', pull_request_number = ?, pull_request_url = ?,
              pull_request_state = ?, failure_message = NULL, updated_at = ?
          WHERE task_id = ?
        `)
        .run(
          z.number().int().positive().parse(input.pullRequest.number),
          NonEmpty.parse(input.pullRequest.url),
          input.pullRequest.state,
          now,
          input.taskId,
        );
      assertTransition(task.status, "done");
      this.db
        .query("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
        .run(now, input.taskId);
      this.db
        .query(`
          INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
          VALUES(?, ?, 'task.status_changed', ?, ?)
        `)
        .run(
          this.id("event"),
          input.taskId,
          JSON.stringify({ from: task.status, to: "done", publication }),
          now,
        );
    })();
  }

  /** Records a publishing-stage failure and returns the accepted task to replanning without changing its commit. */
  failPublishing(
    taskId: string,
    failureMessage: string,
    leaseOwnerId?: string,
  ): void {
    this.db.transaction(() => {
      this.assertLeaseOwner(leaseOwnerId);
      const task = this.getTask(taskId);
      if (task === undefined) throw new Error(`Task not found: ${taskId}`);
      if (task.status !== "publishing") return;
      const now = this.now();
      this.db
        .query(`
          UPDATE task_publications
          SET status = 'failed', failure_message = ?, updated_at = ?
          WHERE task_id = ?
        `)
        .run(NonEmpty.parse(failureMessage), now, taskId);
      assertTransition(task.status, "needs_replan");
      this.db
        .query(
          "UPDATE tasks SET status = 'needs_replan', updated_at = ? WHERE id = ?",
        )
        .run(now, taskId);
      this.db
        .query(`
          INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
          VALUES(?, ?, 'task.needs_replan', ?, ?)
        `)
        .run(
          this.id("event"),
          taskId,
          JSON.stringify({ from: task.status, failure: failureMessage }),
          now,
        );
    })();
  }

  /** Returns the durable receipt for one task hook when one has been trusted or executed. */
  getTaskHook(
    taskId: string,
    phase: "prehook" | "posthook",
  ): TaskHookRecord | undefined {
    const row = this.db
      .query<TaskHookRow, [string, string]>(`
        SELECT task_id, phase, config_hash, trusted_hash, status, attempts, workspace_path
        FROM task_hooks WHERE task_id = ? AND phase = ?
      `)
      .get(taskId, phase);
    return row === null ? undefined : taskHookRecord(row);
  }

  /** Trusts the exact current hash for a configured task hook and resets its execution receipt. */
  trustTaskHook(
    taskId: string,
    phase: "prehook" | "posthook",
    configHash: string,
  ): void {
    const task = this.getTask(taskId);
    if (task === undefined) throw new Error(`Task not found: ${taskId}`);
    if (task.spec[phase] === undefined)
      throw new Error(`Task ${taskId} has no ${phase}`);
    this.db
      .query(`
        INSERT INTO task_hooks(
          task_id, phase, config_hash, trusted_hash, status, attempts, timed_out
        ) VALUES(?, ?, ?, ?, 'pending', 0, 0)
        ON CONFLICT(task_id, phase) DO UPDATE SET
          config_hash = excluded.config_hash,
          trusted_hash = excluded.trusted_hash,
          status = 'pending',
          attempts = 0,
          workspace_path = NULL,
          started_at = NULL,
          ended_at = NULL,
          exit_code = NULL,
          signal = NULL,
          timed_out = 0,
          stdout = NULL,
          stderr = NULL
      `)
      .run(taskId, phase, configHash, configHash);
  }

  /** Atomically reserves one of three attempts only for a matching trusted hook configuration. */
  beginTaskHook(
    taskId: string,
    phase: "prehook" | "posthook",
    configHash: string,
    workspacePath: string,
    leaseOwnerId?: string,
  ): HookAttemptStart {
    return this.db.transaction((): HookAttemptStart => {
      this.assertLeaseOwner(leaseOwnerId);
      const current = this.getTaskHook(taskId, phase);
      if (
        current === undefined ||
        current.configHash !== configHash ||
        current.trustedHash !== configHash
      )
        return { kind: "untrusted" };
      if (current.status === "succeeded") return { kind: "succeeded" };
      if (current.attempts >= 3) return { kind: "exhausted" };
      const attempt = current.attempts + 1;
      this.db
        .query(`
          UPDATE task_hooks
          SET status = 'running', attempts = ?, workspace_path = ?, started_at = ?,
              ended_at = NULL, exit_code = NULL, signal = NULL, timed_out = 0,
              stdout = NULL, stderr = NULL
          WHERE task_id = ? AND phase = ? AND config_hash = ? AND trusted_hash = ?
        `)
        .run(
          attempt,
          workspacePath,
          this.now(),
          taskId,
          phase,
          configHash,
          configHash,
        );
      return { kind: "started", attempt };
    })();
  }

  /** Persists a bounded hook result and makes its success receipt durable before later ticks. */
  finishTaskHook(input: {
    taskId: string;
    phase: "prehook" | "posthook";
    succeeded: boolean;
    exitCode?: number;
    signal?: string;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    leaseOwnerId?: string;
  }): void {
    this.db.transaction(() => {
      this.assertLeaseOwner(input.leaseOwnerId);
      const changed = this.db
        .query(`
          UPDATE task_hooks
          SET status = ?, ended_at = ?, exit_code = ?, signal = ?, timed_out = ?,
              stdout = ?, stderr = ?
          WHERE task_id = ? AND phase = ? AND status = 'running'
        `)
        .run(
          input.succeeded ? "succeeded" : "failed",
          this.now(),
          input.exitCode ?? null,
          input.signal ?? null,
          Number(input.timedOut),
          input.stdout,
          input.stderr,
          input.taskId,
          input.phase,
        ).changes;
      if (changed !== 1)
        throw new Error(
          `Task hook is not running: ${input.taskId}:${input.phase}`,
        );
    })();
  }

  /** Moves a claimed task to infrastructure failure after its prehook exhausts all retries. */
  failClaimedTaskHook(taskId: string, leaseOwnerId?: string): void {
    this.db.transaction(() => {
      this.assertLeaseOwner(leaseOwnerId);
      const status = this.db
        .query<{ status: string }, [string]>(
          "SELECT status FROM tasks WHERE id = ?",
        )
        .get(taskId)?.status;
      if (status === undefined) throw new Error(`Task not found: ${taskId}`);
      const from = TaskStatusSchema.parse(status);
      if (from !== "claimed") return;
      assertTransition(from, "failed_infra");
      const now = this.now();
      this.db
        .query(
          "UPDATE tasks SET status = 'failed_infra', updated_at = ? WHERE id = ?",
        )
        .run(now, taskId);
      this.db
        .query(`
          INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
          VALUES(?, ?, 'task.status_changed', ?, ?)
        `)
        .run(
          this.id("event"),
          taskId,
          JSON.stringify({ from, to: "failed_infra" }),
          now,
        );
      const dependents = this.db
        .query<{ id: string }, [string]>(`
          SELECT id FROM tasks
          WHERE id IN (SELECT task_id FROM task_deps WHERE depends_on_task_id = ?)
            AND status IN ('draft', 'ready')
        `)
        .all(taskId);
      this.db
        .query(`
          UPDATE tasks SET status = 'needs_replan', updated_at = ?
          WHERE id IN (SELECT task_id FROM task_deps WHERE depends_on_task_id = ?)
            AND status IN ('draft', 'ready')
        `)
        .run(now, taskId);
      for (const dependent of dependents) {
        this.db
          .query(`
            INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
            VALUES(?, ?, 'task.needs_replan', ?, ?)
          `)
          .run(
            this.id("event"),
            dependent.id,
            JSON.stringify({ failedTaskId: taskId }),
            now,
          );
      }
    })();
  }

  /** Reconstructs the earliest running attempt and its validated role input. */
  getRunningAttempt(): RunningAttempt | undefined {
    const row = this.db
      .query<RunningAttemptRow, []>(`
      SELECT
        attempt.id AS attempt_id,
        attempt.role,
        attempt.model_profile,
        attempt.model,
        attempt.effort,
        attempt.retry_index,
        attempt.backend_cursor,
        task.id,
        task.cycle_id,
        task.title,
        task.spec_json,
        task.spec_path,
        task.spec_hash,
        task.base_commit,
        task.status,
        task.priority,
        task.approval_required,
        task.approved,
        task.context_id,
        context.thread_id AS context_thread_id,
        context.anchor_id AS context_anchor_id,
        context.source_task_id AS context_source_task_id,
        context.git_commit AS context_git_commit,
        context.summary_artifact AS context_summary_artifact
      FROM attempts AS attempt
      JOIN tasks AS task ON task.id = attempt.task_id
      LEFT JOIN contexts AS context ON context.id = task.context_id
      WHERE attempt.status = 'running'
      ORDER BY attempt.started_at ASC, attempt.id ASC
      LIMIT 1
    `)
      .get();
    if (!row) return undefined;

    const ticket = storedTask(row);
    const role = AgentRoleSchema.parse(row.role);
    const contextRef =
      row.context_id === null
        ? undefined
        : ContextRefSchema.parse({
            threadId: row.context_thread_id,
            anchorId: row.context_anchor_id,
            sourceTaskId: row.context_source_task_id,
            gitCommit: row.context_git_commit,
            summaryArtifact: row.context_summary_artifact ?? undefined,
          });
    const descriptor = HarnessAttemptSchema.parse({
      attemptId: row.attempt_id,
      taskId: row.id,
      role,
      retryIndex: row.retry_index,
      modelProfile: row.model_profile,
      model: row.model,
      effort: row.effort,
      contextRef,
    });

    let input: z.infer<typeof HarnessRoleInputSchema>;
    if (role === "scout") {
      input = HarnessRoleInputSchema.parse({ role, ticket });
    } else if (role === "implement") {
      input = HarnessRoleInputSchema.parse({
        role,
        ticket,
        scout: this.latestRoleOutput(row.id, "scout"),
      });
    } else {
      input = HarnessRoleInputSchema.parse({
        role,
        ticket,
        scout: this.latestRoleOutput(row.id, "scout"),
        implementation: this.latestRoleOutput(row.id, "implement"),
      });
    }

    return {
      descriptor,
      input,
      backendCursor: row.backend_cursor ?? undefined,
    };
  }

  /** Atomically selects, routes, and starts the next role attempt for an active task. */
  beginNextAttempt(leaseOwnerId?: string):
    | {
        attemptId: string;
        taskId: string;
        role: "scout" | "implement" | "review";
      }
    | undefined {
    return this.db.transaction(() => {
      this.assertLeaseOwner(leaseOwnerId);
      const row = this.db
        .query<TaskRow, []>(`
        SELECT id, cycle_id, title, spec_json, spec_path, spec_hash, base_commit, status,
               priority, approval_required, approved, context_id
        FROM tasks AS task
        WHERE task.status IN ('claimed', 'scouting', 'implementing', 'reviewing')
          AND NOT EXISTS (
            SELECT 1 FROM attempts AS attempt
            WHERE attempt.task_id = task.id AND attempt.status = 'running'
          )
        ORDER BY task.priority ASC, task.created_at ASC, task.id ASC
        LIMIT 1
      `)
        .get();
      if (!row) return undefined;

      const ticket = storedTask(row);
      const from = TaskStatusSchema.parse(row.status);
      const latestAttempt =
        this.db
          .query<
            {
              id: string;
              role: string;
              model_profile: string;
              status: string;
              retry_index: number;
            },
            [string]
          >(`
        SELECT id, role, model_profile, status, retry_index FROM attempts
        WHERE task_id = ?
        ORDER BY rowid DESC
        LIMIT 1
      `)
          .get(row.id) ?? undefined;
      const role: "scout" | "implement" | "review" =
        latestAttempt?.status === "failed_infra"
          ? AgentRoleSchema.parse(latestAttempt.role)
          : from === "claimed"
            ? "scout"
            : from === "scouting"
              ? "implement"
              : "review";
      const to =
        role === "scout"
          ? "scouting"
          : role === "implement"
            ? "implementing"
            : "reviewing";
      if (role === "implement") this.latestRoleOutput(row.id, "scout");
      if (role === "review") this.latestRoleOutput(row.id, "implement");

      let retryIndex: 0 | 1 | 2;
      let routeInput: Parameters<ModelAdvisor["decide"]>[0];
      if (latestAttempt?.status === "failed_infra") {
        const failure = this.db
          .query<{ error_code: string }, [string]>(`
          SELECT json_extract(payload_json, '$.code') AS error_code
          FROM events
          WHERE attempt_id = ? AND type = 'attempt.failed_infra'
          ORDER BY seq DESC
          LIMIT 1
        `)
          .get(latestAttempt.id);
        if (!failure)
          throw new Error(
            `Missing infrastructure failure event for ${latestAttempt.id}`,
          );
        const nextRetryIndex =
          latestAttempt.retry_index === 0
            ? 1
            : latestAttempt.retry_index === 1
              ? 2
              : undefined;
        if (nextRetryIndex === undefined)
          throw new Error(
            `Cannot retry exhausted ${role} attempt for task ${row.id}`,
          );
        retryIndex = nextRetryIndex;
        routeInput = {
          role,
          risk: ticket.spec.risk,
          retryIndex,
          priorProfile: ModelProfileSchema.parse(latestAttempt.model_profile),
          priorErrorCode: failure.error_code,
        };
      } else {
        retryIndex = 0;
        routeInput = { role, risk: ticket.spec.risk, retryIndex };
      }
      const route: Route | undefined = this.advisor.decide(routeInput);
      if (route === undefined) {
        assertTransition(from, "needs_replan");
        const now = this.now();
        this.db
          .query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
          .run("needs_replan", now, row.id);
        this.db
          .query(`
          INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
          VALUES(?, ?, 'task.needs_replan', ?, ?)
        `)
          .run(
            this.id("event"),
            row.id,
            JSON.stringify({
              reason: "no_compatible_model",
              role,
              effort: ticket.spec.risk === "high" ? "xhigh" : "high",
            }),
            now,
          );
        return undefined;
      }
      const decisionId = this.id("decision");
      const attemptId = this.id("attempt");
      const now = this.now();
      this.db
        .query(`
        INSERT INTO model_decisions(
          id, task_id, role, model, model_profile, effort, token_budget, context_id,
          fallback_models_json, decided_by, confidence, rationale_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'rule', 1, ?)
      `)
        .run(
          decisionId,
          row.id,
          role,
          route.model,
          route.profile,
          route.effort,
          ticket.spec.tokenCeiling,
          row.context_id,
          JSON.stringify(route.fallbacks),
          JSON.stringify(route.rationale),
        );
      this.db
        .query(`
        INSERT INTO attempts(
          id, task_id, role, model, model_profile, effort, status, retry_index, started_at
        ) VALUES(?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `)
        .run(
          attemptId,
          row.id,
          role,
          route.model,
          route.profile,
          route.effort,
          retryIndex,
          now,
        );

      if (from !== to) {
        assertTransition(from, to);
        this.db
          .query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
          .run(to, now, row.id);
        this.db
          .query(`
          INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
          VALUES(?, ?, 'task.status_changed', ?, ?)
        `)
          .run(this.id("event"), row.id, JSON.stringify({ from, to }), now);
      }
      this.db
        .query(`
        INSERT INTO events(idempotency_key, task_id, attempt_id, type, payload_json, occurred_at)
        VALUES(?, ?, ?, 'attempt.created', ?, ?)
      `)
        .run(
          this.id("event"),
          row.id,
          attemptId,
          JSON.stringify({
            role,
            modelProfile: route.profile,
            model: route.model,
            effort: route.effort,
            retryIndex,
            decisionId,
          }),
          now,
        );
      return { attemptId, taskId: row.id, role };
    })();
  }

  /** Atomically applies one ordered idempotent harness event and advances its cursor. */
  applyHarnessEvent(
    attemptId: string,
    nextCursor: string,
    rawEvent: HarnessEvent,
    leaseOwnerId?: string,
  ): void {
    this.db.transaction(() => {
      this.assertLeaseOwner(leaseOwnerId);
      const event = HarnessEventSchema.parse(rawEvent);
      if (event.attemptId !== attemptId) {
        throw new Error(
          `Harness event attempt mismatch: ${event.attemptId} !== ${attemptId}`,
        );
      }
      const attempt = this.db
        .query<
          {
            task_id: string;
            role: string;
            status: string;
            retry_index: number;
          },
          [string]
        >(
          "SELECT task_id, role, status, retry_index FROM attempts WHERE id = ?",
        )
        .get(attemptId);
      if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
      const duplicate = this.db
        .query<{ attempt_id: string | null; payload_json: string }, [string]>(
          "SELECT attempt_id, payload_json FROM events WHERE idempotency_key = ?",
        )
        .get(event.eventId);
      if (duplicate) {
        if (
          duplicate.attempt_id !== attemptId ||
          duplicate.payload_json !== JSON.stringify(event)
        ) {
          throw new Error(
            `Harness event idempotency conflict: ${event.eventId}`,
          );
        }
        this.fault("before_cursor_update");
        this.db
          .query("UPDATE attempts SET backend_cursor = ? WHERE id = ?")
          .run(nextCursor, attemptId);
        return;
      }
      if (attempt.status !== "running")
        throw new Error(`Attempt is not running: ${attemptId}`);
      const lastSequence = this.db
        .query<{ sequence: number | null }, [string]>(`
        SELECT MAX(CAST(json_extract(payload_json, '$.sequence') AS INTEGER)) AS sequence
        FROM events WHERE attempt_id = ?
      `)
        .get(attemptId)?.sequence;
      if (
        lastSequence !== null &&
        lastSequence !== undefined &&
        event.sequence <= lastSequence
      ) {
        throw new Error(
          `Non-monotonic harness event sequence for ${attemptId}: ${event.sequence} <= ${lastSequence}`,
        );
      }

      this.db
        .query(`
        INSERT INTO events(idempotency_key, task_id, attempt_id, type, payload_json, occurred_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `)
        .run(
          event.eventId,
          attempt.task_id,
          attemptId,
          event.type,
          JSON.stringify(event),
          event.occurredAt,
        );
      this.fault("after_event_insert");

      if (event.type === "attempt.started") {
        if (event.threadId !== undefined) {
          this.db
            .query("UPDATE attempts SET thread_id = ? WHERE id = ?")
            .run(event.threadId, attemptId);
        }
        if (event.turnId !== undefined) {
          this.db
            .query("UPDATE attempts SET turn_id = ? WHERE id = ?")
            .run(event.turnId, attemptId);
        }
        if (event.baseCommit !== undefined) {
          const baseCommit = this.db
            .query<{ base_commit: string | null }, [string]>(
              "SELECT base_commit FROM tasks WHERE id = ?",
            )
            .get(attempt.task_id)?.base_commit;
          if (baseCommit === undefined)
            throw new Error(`Task not found: ${attempt.task_id}`);
          if (baseCommit !== null && baseCommit !== event.baseCommit) {
            throw new Error(
              `Conflicting base commit for task ${attempt.task_id}: ${event.baseCommit} !== ${baseCommit}`,
            );
          }
          if (baseCommit === null) {
            this.db
              .query(
                "UPDATE tasks SET base_commit = ? WHERE id = ? AND base_commit IS NULL",
              )
              .run(event.baseCommit, attempt.task_id);
          }
        }
      } else if (event.type === "attempt.output") {
        if (event.output.kind !== attempt.role) {
          throw new Error(
            `Harness output role mismatch: ${event.output.kind} !== ${attempt.role}`,
          );
        }
        if (event.output.kind === "implement") {
          this.db
            .query("UPDATE attempts SET git_commit = ? WHERE id = ?")
            .run(event.output.commitSha, attemptId);
        }
      } else if (event.type === "attempt.usage_delta") {
        const inserted = this.db
          .query(`
          INSERT INTO usage(
            id, cycle_id, task_id, attempt_id, category,
            input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
          )
          SELECT
            $eventId, task.cycle_id, task.id, attempt.id, attempt.role,
            $inputTokens, $cachedInputTokens, $outputTokens, $reasoningOutputTokens
          FROM attempts AS attempt
          JOIN tasks AS task ON task.id = attempt.task_id
          WHERE attempt.id = $attemptId
        `)
          .run({
            eventId: event.eventId,
            attemptId,
            inputTokens: event.inputTokens,
            cachedInputTokens: event.cachedInputTokens,
            outputTokens: event.outputTokens,
            reasoningOutputTokens: event.reasoningOutputTokens,
          }).changes;
        if (inserted !== 1)
          throw new Error(`Unable to record usage for attempt: ${attemptId}`);
      } else if (event.type === "attempt.completed") {
        const outputRow = this.db
          .query<{ payload_json: string }, [string, string]>(`
          SELECT payload_json FROM events
          WHERE attempt_id = ?
            AND type = 'attempt.output'
            AND json_extract(payload_json, '$.output.kind') = ?
          ORDER BY seq DESC LIMIT 1
        `)
          .get(attemptId, attempt.role);
        if (!outputRow)
          throw new Error(
            `Attempt completed without ${attempt.role} output: ${attemptId}`,
          );
        const outputEvent = HarnessEventSchema.parse(
          JSON.parse(outputRow.payload_json),
        );

        if (
          attempt.role === "review" &&
          outputEvent.type === "attempt.output" &&
          outputEvent.output.kind === "review" &&
          outputEvent.output.decision === "accepted"
        ) {
          this.db
            .query(`
            UPDATE attempts SET status = 'succeeded', ended_at = ? WHERE id = ? AND status = 'running'
          `)
            .run(event.occurredAt, attemptId);
          this.db
            .query(`
            INSERT INTO reviews(id, task_id, attempt_id, decision, findings_json)
            VALUES(?, ?, ?, ?, ?)
          `)
            .run(
              this.id("review"),
              attempt.task_id,
              attemptId,
              outputEvent.output.decision,
              JSON.stringify(outputEvent.output.findings),
            );
          const status = this.db
            .query<{ status: string }, [string]>(
              "SELECT status FROM tasks WHERE id = ?",
            )
            .get(attempt.task_id)?.status;
          if (status === undefined)
            throw new Error(`Task not found: ${attempt.task_id}`);
          const from = TaskStatusSchema.parse(status);
          assertTransition(from, "publishing");
          this.db
            .query(
              "UPDATE tasks SET status = 'publishing', updated_at = ? WHERE id = ?",
            )
            .run(event.occurredAt, attempt.task_id);
          this.db
            .query(`
            INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
            VALUES(?, ?, 'task.status_changed', ?, ?)
          `)
            .run(
              this.id("event"),
              attempt.task_id,
              JSON.stringify({ from, to: "publishing" }),
              event.occurredAt,
            );
        } else if (
          attempt.role === "review" &&
          outputEvent.type === "attempt.output" &&
          outputEvent.output.kind === "review" &&
          outputEvent.output.decision === "rejected"
        ) {
          const review = outputEvent.output;
          const original = this.db
            .query<
              {
                id: string;
                cycle_id: string;
                title: string;
                spec_json: string;
                status: string;
                priority: number;
                token_ceiling: number;
                root_task_id: string | null;
                context_id: string | null;
              },
              [string]
            >(`
            SELECT id, cycle_id, title, spec_json, status, priority, token_ceiling,
                   root_task_id, context_id
            FROM tasks WHERE id = ?
          `)
            .get(attempt.task_id);
          if (!original) throw new Error(`Task not found: ${attempt.task_id}`);
          const from = TaskStatusSchema.parse(original.status);
          assertTransition(from, "rejected");
          const originalSpec = TicketSpecSchema.parse(
            JSON.parse(original.spec_json),
          );
          const followUpSpec = TicketSpecSchema.parse({
            ...originalSpec,
            problem: `${originalSpec.problem}\n\nReview findings:\n${review.findings.map((finding) => `- ${finding}`).join("\n")}`,
            acceptanceCriteria: [
              ...new Set([
                ...originalSpec.acceptanceCriteria,
                ...review.remainingGaps,
              ]),
            ],
          });
          const reviewId = this.id("review");
          const followUpTaskId = this.id("task");
          const rootTaskId = original.root_task_id ?? original.id;
          const implementCommit = this.db
            .query<{ git_commit: string }, [string]>(`
            SELECT git_commit FROM attempts
            WHERE task_id = ? AND role = 'implement' AND status = 'succeeded'
              AND git_commit IS NOT NULL
            ORDER BY rowid DESC
            LIMIT 1
          `)
            .get(attempt.task_id)?.git_commit;
          if (implementCommit === undefined) {
            throw new Error(
              `Rejected task has no successful Implement commit: ${attempt.task_id}`,
            );
          }

          this.db
            .query(`
            INSERT INTO reviews(id, task_id, attempt_id, decision, findings_json)
            VALUES($reviewId, $taskId, $attemptId, 'rejected', $findingsJson)
          `)
            .run({
              reviewId,
              taskId: attempt.task_id,
              attemptId,
              findingsJson: JSON.stringify(review.findings),
            });
          this.db
            .query(`
            UPDATE attempts
            SET status = 'succeeded', ended_at = $endedAt
            WHERE id = $attemptId AND status = 'running'
          `)
            .run({ endedAt: event.occurredAt, attemptId });
          this.db
            .query(`
            UPDATE tasks
            SET status = 'rejected', updated_at = $endedAt
            WHERE id = $taskId AND status = 'reviewing'
          `)
            .run({ endedAt: event.occurredAt, taskId: attempt.task_id });
          this.db
            .query(`
            INSERT INTO tasks(
              id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
              approval_required, approved, root_task_id, parent_task_id,
              discovered_from_review_id, context_id, base_commit, created_at, updated_at
            ) VALUES(
              $id, $cycleId, $title, $specJson, 'draft', $priority, $risk, $tokenCeiling,
              1, 0, $rootTaskId, $parentTaskId, $reviewId, $contextId, $baseCommit, $now, $now
            )
          `)
            .run({
              id: followUpTaskId,
              cycleId: original.cycle_id,
              title: original.title,
              specJson: JSON.stringify(followUpSpec),
              priority: original.priority,
              risk: followUpSpec.risk,
              tokenCeiling: original.token_ceiling,
              rootTaskId,
              parentTaskId: original.id,
              reviewId,
              contextId: original.context_id,
              baseCommit: implementCommit,
              now: event.occurredAt,
            });

          const dependents = this.db
            .query<{ id: string }, [string]>(`
            SELECT id FROM tasks
            WHERE id IN (SELECT task_id FROM task_deps WHERE depends_on_task_id = ?)
              AND status IN ('draft', 'ready')
            ORDER BY created_at, id
          `)
            .all(attempt.task_id);
          this.db
            .query(`
            UPDATE tasks
            SET status = 'needs_replan', updated_at = $now
            WHERE id IN (SELECT task_id FROM task_deps WHERE depends_on_task_id = $rejectedTaskId)
              AND status IN ('draft', 'ready')
          `)
            .run({ now: event.occurredAt, rejectedTaskId: attempt.task_id });

          this.db
            .query(`
            INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
            VALUES(?, ?, 'task.rejected', ?, ?)
          `)
            .run(
              this.id("event"),
              attempt.task_id,
              JSON.stringify({ reviewId, from, to: "rejected" }),
              event.occurredAt,
            );
          this.db
            .query(`
            INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
            VALUES(?, ?, 'task.follow_up_created', ?, ?)
          `)
            .run(
              this.id("event"),
              followUpTaskId,
              JSON.stringify({
                reviewId,
                parentTaskId: original.id,
                rootTaskId,
                baseCommit: implementCommit,
              }),
              event.occurredAt,
            );
          for (const dependent of dependents) {
            this.db
              .query(`
              INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
              VALUES(?, ?, 'task.needs_replan', ?, ?)
            `)
              .run(
                this.id("event"),
                dependent.id,
                JSON.stringify({ rejectedTaskId: attempt.task_id }),
                event.occurredAt,
              );
          }
        } else {
          this.db
            .query(`
            UPDATE attempts SET status = 'succeeded', ended_at = ? WHERE id = ? AND status = 'running'
          `)
            .run(event.occurredAt, attemptId);
        }
      } else if (event.type === "attempt.failed_infra") {
        this.db
          .query(`
          UPDATE attempts SET status = 'failed_infra', ended_at = ? WHERE id = ?
        `)
          .run(event.occurredAt, attemptId);

        if (!event.retryable || attempt.retry_index === 2) {
          const status = this.db
            .query<{ status: string }, [string]>(
              "SELECT status FROM tasks WHERE id = ?",
            )
            .get(attempt.task_id)?.status;
          if (status === undefined)
            throw new Error(`Task not found: ${attempt.task_id}`);
          const from = TaskStatusSchema.parse(status);
          assertTransition(from, "failed_infra");
          this.db
            .query(
              "UPDATE tasks SET status = 'failed_infra', updated_at = ? WHERE id = ?",
            )
            .run(event.occurredAt, attempt.task_id);
          this.db
            .query(`
            INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
            VALUES(?, ?, 'task.status_changed', ?, ?)
          `)
            .run(
              this.id("event"),
              attempt.task_id,
              JSON.stringify({ from, to: "failed_infra" }),
              event.occurredAt,
            );

          const dependents = this.db
            .query<{ id: string }, [string]>(`
            SELECT id FROM tasks
            WHERE id IN (SELECT task_id FROM task_deps WHERE depends_on_task_id = ?)
              AND status IN ('draft', 'ready')
          `)
            .all(attempt.task_id);
          this.db
            .query(`
            UPDATE tasks
            SET status = 'needs_replan', updated_at = $now
            WHERE id IN (SELECT task_id FROM task_deps WHERE depends_on_task_id = $failedTaskId)
              AND status IN ('draft', 'ready')
          `)
            .run({ now: event.occurredAt, failedTaskId: attempt.task_id });
          for (const dependent of dependents) {
            this.db
              .query(`
              INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
              VALUES(?, ?, 'task.needs_replan', ?, ?)
            `)
              .run(
                this.id("event"),
                dependent.id,
                JSON.stringify({ failedTaskId: attempt.task_id }),
                event.occurredAt,
              );
          }
        }
      } else if (event.type === "attempt.blocked_policy") {
        this.db
          .query(`
          UPDATE attempts SET status = 'blocked_policy', ended_at = ? WHERE id = ?
        `)
          .run(event.occurredAt, attemptId);
        const status = this.db
          .query<{ status: string }, [string]>(
            "SELECT status FROM tasks WHERE id = ?",
          )
          .get(attempt.task_id)?.status;
        if (status === undefined)
          throw new Error(`Task not found: ${attempt.task_id}`);
        const from = TaskStatusSchema.parse(status);
        assertTransition(from, "needs_replan");
        this.db
          .query(
            "UPDATE tasks SET status = 'needs_replan', updated_at = ? WHERE id = ?",
          )
          .run(event.occurredAt, attempt.task_id);
        this.db
          .query(`
          INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
          VALUES(?, ?, 'task.needs_replan', ?, ?)
        `)
          .run(
            this.id("event"),
            attempt.task_id,
            JSON.stringify({
              attemptId,
              code: event.code,
              message: event.message,
            }),
            event.occurredAt,
          );
      } else {
        throw new Error("Unsupported harness event in happy-path repository");
      }

      this.fault("before_cursor_update");
      this.db
        .query("UPDATE attempts SET backend_cursor = ? WHERE id = ?")
        .run(nextCursor, attemptId);
    })();
  }

  /** Verifies that an optional scheduler lease owner still holds an unexpired lease. */
  private assertLeaseOwner(leaseOwnerId?: string): void {
    if (leaseOwnerId === undefined) return;
    const lease = this.db
      .query<{ owned: number }, [string, string]>(`
      SELECT 1 AS owned FROM scheduler_lease
      WHERE lease_key = 'scheduler' AND owner_id = ? AND expires_at > ?
    `)
      .get(leaseOwnerId, this.now());
    if (!lease) throw new Error("Scheduler lease was lost");
  }

  /** Acquires or renews the scheduler lease when it is available to the owner. */
  acquireLease(ownerId: string, now: string, expiresAt: string): boolean {
    return this.db.transaction(() => {
      this.db
        .query(`
        INSERT INTO scheduler_lease(lease_key, owner_id, heartbeat_at, expires_at)
        VALUES('scheduler', ?, ?, ?)
        ON CONFLICT(lease_key) DO UPDATE SET
          owner_id = excluded.owner_id,
          heartbeat_at = excluded.heartbeat_at,
          expires_at = excluded.expires_at
        WHERE scheduler_lease.owner_id = excluded.owner_id
           OR scheduler_lease.expires_at <= excluded.heartbeat_at
      `)
        .run(ownerId, now, expiresAt);
      return (
        this.db
          .query<{ owner_id: string }, []>(
            "SELECT owner_id FROM scheduler_lease WHERE lease_key = 'scheduler'",
          )
          .get()?.owner_id === ownerId
      );
    })();
  }

  /** Extends an unexpired scheduler lease held by the specified owner. */
  heartbeatLease(ownerId: string, now: string, expiresAt: string): boolean {
    return (
      this.db
        .query(`
      UPDATE scheduler_lease SET heartbeat_at = ?, expires_at = ?
      WHERE lease_key = 'scheduler' AND owner_id = ? AND expires_at > ?
    `)
        .run(now, expiresAt, ownerId, now).changes === 1
    );
  }

  /** Releases the scheduler lease when it belongs to the specified owner. */
  releaseLease(ownerId: string): boolean {
    return (
      this.db
        .query(
          "DELETE FROM scheduler_lease WHERE lease_key = 'scheduler' AND owner_id = ?",
        )
        .run(ownerId).changes === 1
    );
  }

  /** Returns the minimal identity and status snapshot for one task. */
  inspectTask(taskId: string): { id: string; status: string } | undefined {
    return (
      this.db
        .query<{ id: string; status: string }, [string]>(
          "SELECT id, status FROM tasks WHERE id = ?",
        )
        .get(taskId) ?? undefined
    );
  }

  /** Aggregates a cycle's persisted token usage by normalized category. */
  getCycleCategoryUsage(cycleId: string): CycleCategoryUsage | undefined {
    const id = CycleIdSchema.parse(cycleId);
    const cycle = this.db
      .query<{ id: string }, [string]>("SELECT id FROM cycles WHERE id = ?")
      .get(id);
    if (!cycle) return undefined;

    const categories = this.db
      .query<
        {
          category: string;
          input_tokens: number;
          output_tokens: number;
        },
        [string]
      >(`
      SELECT
        category,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM usage
      WHERE cycle_id = ?
      GROUP BY category
      ORDER BY category ASC
    `)
      .all(id)
      .map((row) =>
        CategoryTokenUsageSchema.parse({
          category: row.category,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
        }),
      );

    return CycleCategoryUsageSchema.parse({ cycleId: cycle.id, categories });
  }

  /** Builds a validated scheduler, cycle, task, decision, attempt, and usage snapshot. */
  inspect(): InspectionSnapshot {
    const cycles = this.db
      .query<
        {
          id: string;
          token_target: number;
          input_tokens: number;
          cached_input_tokens: number;
          output_tokens: number;
          reasoning_output_tokens: number;
        },
        []
      >(`
      SELECT
        cycle.id,
        cycle.token_budget AS token_target,
        COALESCE(SUM(usage.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(usage.cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(usage.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(usage.reasoning_output_tokens), 0) AS reasoning_output_tokens
      FROM cycles AS cycle
      LEFT JOIN usage ON usage.cycle_id = cycle.id
      GROUP BY cycle.id, cycle.token_budget
      ORDER BY cycle.id ASC
    `)
      .all()
      .map((row) => ({
        id: row.id,
        tokenTarget: row.token_target,
        actual: tokenTotals(row),
      }));
    const tasks = this.db
      .query<
        {
          id: string;
          status: string;
          priority: number;
          token_target: number;
          context_id: string | null;
          context_thread_id: string | null;
          context_anchor_id: string | null;
          context_source_task_id: string | null;
          context_git_commit: string | null;
          context_summary_artifact: string | null;
          input_tokens: number;
          cached_input_tokens: number;
          output_tokens: number;
          reasoning_output_tokens: number;
        },
        []
      >(`
      SELECT
        task.id,
        task.status,
        task.priority,
        task.token_ceiling AS token_target,
        task.context_id,
        context.thread_id AS context_thread_id,
        context.anchor_id AS context_anchor_id,
        context.source_task_id AS context_source_task_id,
        context.git_commit AS context_git_commit,
        context.summary_artifact AS context_summary_artifact,
        COALESCE(SUM(usage.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(usage.cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(usage.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(usage.reasoning_output_tokens), 0) AS reasoning_output_tokens
      FROM tasks AS task
      LEFT JOIN contexts AS context ON context.id = task.context_id
      LEFT JOIN usage ON usage.task_id = task.id
      GROUP BY task.id
      ORDER BY task.priority ASC, task.id ASC
    `)
      .all();
    const roleRows = this.db
      .query<
        {
          task_id: string;
          role: string;
          input_tokens: number;
          cached_input_tokens: number;
          output_tokens: number;
          reasoning_output_tokens: number;
        },
        []
      >(`
      SELECT
        attempt.task_id,
        attempt.role,
        COALESCE(SUM(usage.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(usage.cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(usage.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(usage.reasoning_output_tokens), 0) AS reasoning_output_tokens
      FROM attempts AS attempt
      LEFT JOIN usage ON usage.attempt_id = attempt.id
      GROUP BY attempt.task_id, attempt.role
      ORDER BY attempt.task_id ASC,
        CASE attempt.role WHEN 'scout' THEN 0 WHEN 'implement' THEN 1 ELSE 2 END ASC,
        attempt.role ASC
    `)
      .all();
    const attempts = this.db
      .query<
        {
          id: string;
          task_id: string;
          role: string;
          model_profile: string;
          model: string;
          effort: string;
          status: string;
          retry_index: number;
          thread_id: string | null;
          turn_id: string | null;
          git_commit: string | null;
          input_tokens: number;
          cached_input_tokens: number;
          output_tokens: number;
          reasoning_output_tokens: number;
        },
        []
      >(`
      SELECT
        attempt.id,
        attempt.task_id,
        attempt.role,
        attempt.model_profile,
        attempt.model,
        attempt.effort,
        attempt.status,
        attempt.retry_index,
        attempt.thread_id,
        attempt.turn_id,
        attempt.git_commit,
        COALESCE(SUM(usage.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(usage.cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(usage.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(usage.reasoning_output_tokens), 0) AS reasoning_output_tokens
      FROM attempts AS attempt
      LEFT JOIN usage ON usage.attempt_id = attempt.id
      GROUP BY attempt.id
      ORDER BY attempt.started_at ASC, attempt.id ASC
    `)
      .all();
    const decisions = this.db
      .query<
        {
          id: string;
          task_id: string;
          role: string;
          model_profile: string;
          model: string;
          effort: string;
          token_target: number;
          fallback_models_json: string;
          decided_by: string;
          confidence: number;
          rationale_json: string;
        },
        []
      >(`
      SELECT
        id, task_id, role, model_profile, model, effort, token_budget AS token_target,
        fallback_models_json, decided_by, confidence, rationale_json
      FROM model_decisions
      ORDER BY task_id ASC,
        CASE role WHEN 'scout' THEN 0 WHEN 'implement' THEN 1 ELSE 2 END ASC,
        id ASC
    `)
      .all();
    const activeTask = this.db
      .query<{ id: string }, []>(`
      SELECT id FROM tasks
      WHERE status IN ('claimed', 'scouting', 'implementing', 'reviewing')
      ORDER BY priority ASC, created_at ASC, id ASC
      LIMIT 1
    `)
      .get();
    const activeAttempt = this.db
      .query<{ id: string }, []>(`
      SELECT id FROM attempts
      WHERE status = 'running'
      ORDER BY started_at ASC, id ASC
      LIMIT 1
    `)
      .get();

    const rolesByTask = new Map<string, InspectionRole[]>();
    for (const row of roleRows) {
      const roles = rolesByTask.get(row.task_id) ?? [];
      roles.push(
        InspectionRoleSchema.parse({
          role: row.role,
          actual: tokenTotals(row),
        }),
      );
      rolesByTask.set(row.task_id, roles);
    }
    const attemptsByTask = new Map<string, InspectionAttempt[]>();
    for (const row of attempts) {
      const taskAttempts = attemptsByTask.get(row.task_id) ?? [];
      taskAttempts.push(
        InspectionAttemptSchema.parse({
          id: row.id,
          role: row.role,
          modelProfile: row.model_profile,
          model: row.model,
          effort: row.effort,
          status: row.status,
          retryIndex: row.retry_index,
          ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
          ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
          ...(row.git_commit === null ? {} : { gitCommit: row.git_commit }),
          ...tokenTotals(row),
        }),
      );
      attemptsByTask.set(row.task_id, taskAttempts);
    }
    const decisionsByTask = new Map<string, InspectionModelDecision[]>();
    for (const row of decisions) {
      const taskDecisions = decisionsByTask.get(row.task_id) ?? [];
      taskDecisions.push(
        InspectionModelDecisionSchema.parse({
          id: row.id,
          role: row.role,
          modelProfile: row.model_profile,
          model: row.model,
          effort: row.effort,
          tokenTarget: row.token_target,
          fallbackModels: JSON.parse(row.fallback_models_json),
          decidedBy: row.decided_by,
          confidence: row.confidence,
          rationale: JSON.parse(row.rationale_json),
        }),
      );
      decisionsByTask.set(row.task_id, taskDecisions);
    }

    return InspectionSnapshotSchema.parse({
      scheduler: {
        ...(activeTask == null ? {} : { activeTaskId: activeTask.id }),
        ...(activeAttempt == null ? {} : { activeAttemptId: activeAttempt.id }),
      },
      cycles,
      tasks: tasks.map((row) =>
        InspectionTaskSchema.parse({
          id: row.id,
          status: row.status,
          priority: row.priority,
          tokenTarget: row.token_target,
          actual: tokenTotals(row),
          ...(row.context_id === null
            ? {}
            : {
                contextRef: ContextRefSchema.parse({
                  threadId: row.context_thread_id,
                  anchorId: row.context_anchor_id,
                  sourceTaskId: row.context_source_task_id,
                  gitCommit: row.context_git_commit,
                  summaryArtifact: row.context_summary_artifact ?? undefined,
                }),
              }),
          modelDecisions: decisionsByTask.get(row.id) ?? [],
          roles: rolesByTask.get(row.id) ?? [],
          attempts: attemptsByTask.get(row.id) ?? [],
        }),
      ),
    });
  }

  /** Lists a root task and its descendants in deterministic creation order. */
  listTasksByRoot(rootTaskId: string): Array<{
    id: string;
    status: string;
    parentTaskId?: string;
    rootTaskId?: string;
    approved: boolean;
  }> {
    const parsedRootTaskId = StoredTaskSchema.shape.id.parse(rootTaskId);
    const rows = this.db
      .query<
        {
          id: string;
          status: string;
          parent_task_id: string | null;
          root_task_id: string | null;
          approved: number;
        },
        [string, string]
      >(`
      SELECT id, status, parent_task_id, root_task_id, approved
      FROM tasks
      WHERE id = ? OR root_task_id = ?
      ORDER BY created_at, id
    `)
      .all(parsedRootTaskId, parsedRootTaskId);
    return rows.map((row) => ({
      id: StoredTaskSchema.shape.id.parse(row.id),
      status: TaskStatusSchema.parse(row.status),
      ...(row.parent_task_id === null
        ? {}
        : {
            parentTaskId: StoredTaskSchema.shape.id.parse(row.parent_task_id),
          }),
      ...(row.root_task_id === null
        ? {}
        : { rootTaskId: StoredTaskSchema.shape.id.parse(row.root_task_id) }),
      approved: StoredTaskSchema.shape.approved.parse(Boolean(row.approved)),
    }));
  }

  /** Lists a task's attempts in deterministic start order. */
  listAttempts(taskId: string): Array<{
    role: string;
    model: string;
    effort: string;
    status: string;
    retryIndex: number;
  }> {
    return this.db
      .query<
        {
          role: string;
          model: string;
          effort: string;
          status: string;
          retryIndex: number;
        },
        [string]
      >(`
      SELECT role, model, effort, status, retry_index AS retryIndex FROM attempts
      WHERE task_id = ? ORDER BY started_at ASC, id ASC
    `)
      .all(taskId);
  }

  /** Lists a task's persisted review decisions and findings. */
  listReviews(taskId: string): Array<{ decision: string; findings: string[] }> {
    return this.db
      .query<{ decision: string; findings_json: string }, [string]>(`
      SELECT decision, findings_json FROM reviews WHERE task_id = ? ORDER BY rowid ASC
    `)
      .all(taskId)
      .map((row) => ({
        decision: row.decision,
        findings: JSON.parse(row.findings_json),
      }));
  }

  /** Returns the latest validated successful output for a prerequisite role. */
  private latestRoleOutput(taskId: string, role: "scout" | "implement") {
    const row = this.db
      .query<{ payload_json: string }, [string, string]>(`
      SELECT event.payload_json
      FROM events AS event
      JOIN attempts AS attempt ON attempt.id = event.attempt_id
      WHERE event.task_id = ?
        AND attempt.role = ?
        AND attempt.status = 'succeeded'
        AND event.type = 'attempt.output'
      ORDER BY event.seq DESC
      LIMIT 1
    `)
      .get(taskId, role);
    if (!row)
      throw new Error(`Missing succeeded ${role} output for task ${taskId}`);
    const event = HarnessEventSchema.parse(JSON.parse(row.payload_json));
    if (event.type !== "attempt.output" || event.output.kind !== role) {
      throw new Error(`Invalid ${role} output for task ${taskId}`);
    }
    return event.output;
  }

  /** Returns the latest successful Implement output that supplies a task's publishable commit. */
  private implementationOutput(taskId: string): ImplementOutput {
    const output = this.latestRoleOutput(taskId, "implement");
    if (output.kind !== "implement") {
      throw new Error(`Invalid Implement output for task ${taskId}`);
    }
    return output;
  }
}

/** Converts database token columns into a validated token-total value. */
function tokenTotals(row: {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}): TokenTotals {
  return TokenTotalsSchema.parse({
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
  });
}
