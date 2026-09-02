import type { Database } from "bun:sqlite";
import {
  type AgileCyclePlan,
  AgileCyclePlanSchema,
  type BacklogManifest,
  BacklogManifestSchema,
  type StoredTask,
  StoredTaskSchema,
  type TaskCreate,
  TaskCreateSchema,
  type TaskStatus,
  TaskStatusSchema,
} from "../domain/schemas";
import { safeTaskPathComponent } from "../domain/task-path";
import { assertTransition, canTransition } from "../domain/transitions";

type TaskRow = {
  id: string;
  cycle_id: string;
  title: string;
  spec_json: string;
  spec_path: string | null;
  spec_hash: string | null;
  base_commit: string | null;
  status: TaskStatus;
  priority: number;
  approval_required: number;
  approved: number;
  retirement_reason: string | null;
  replacement_task_id: string | null;
  retired_at: string | null;
};

type StatusChangedEventRow = {
  task_id: string | null;
  type: string;
  payload_json: string;
};

type RetirementEventRow = {
  task_id: string | null;
  type: string;
  payload_json: string;
  occurred_at: string;
};

type RetirementTaskRow = {
  id: string;
  status: string;
  approved: number;
  retirement_reason: string | null;
  replacement_task_id: string | null;
  retired_at: string | null;
};

type RetirementEventPayload = {
  from: TaskStatus;
  reason: string;
  replacementTaskId?: string;
  retiredAt: string;
};

type ImportedTaskRow = {
  id: string;
  cycle_id: string;
  title: string;
  spec_json: string;
  priority: number;
  approval_required: number;
  approved: number;
};

export type BacklogImportResult = {
  created: number;
  skipped: number;
  total: number;
};

export type TaskRetirementInput = {
  taskId: string;
  reason: string;
  replacementTaskId?: string;
};

export type TaskRetirementResult = {
  taskId: string;
  replacementTaskId?: string;
  retiredAt: string;
};

/** Compares the immutable input fields of an imported task. */
function isSameImportedTask(existing: TaskCreate, task: TaskCreate): boolean {
  return (
    existing.cycleId === task.cycleId &&
    existing.title === task.title &&
    existing.priority === task.priority &&
    existing.approvalRequired === task.approvalRequired &&
    existing.approved === task.approved &&
    JSON.stringify(existing.spec) === JSON.stringify(task.spec)
  );
}

/** Parses a strict task-status change payload or returns undefined when invalid. */
function parseStatusChangePayload(
  payloadJson: string,
): { from: TaskStatus; to: TaskStatus } | undefined {
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return undefined;
    const keys = Object.keys(payload);
    if (keys.length !== 2 || !keys.includes("from") || !keys.includes("to"))
      return undefined;
    const values = payload as Record<string, unknown>;
    return {
      from: TaskStatusSchema.parse(values.from),
      to: TaskStatusSchema.parse(values.to),
    };
  } catch {
    return undefined;
  }
}

/** Parses the fields needed to verify a retirement event replay. */
function parseRetirementEventPayload(
  payloadJson: string,
): RetirementEventPayload | undefined {
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return undefined;
    const values = payload as Partial<RetirementEventPayload>;
    if (
      typeof values.reason !== "string" ||
      values.reason.trim().length === 0 ||
      typeof values.retiredAt !== "string" ||
      values.retiredAt.trim().length === 0 ||
      (values.replacementTaskId !== undefined &&
        typeof values.replacementTaskId !== "string")
    ) {
      return undefined;
    }
    return {
      from: TaskStatusSchema.parse(values.from),
      reason: values.reason.trim(),
      ...(values.replacementTaskId === undefined
        ? {}
        : {
            replacementTaskId: TaskCreateSchema.shape.id.parse(
              values.replacementTaskId,
            ),
          }),
      retiredAt: values.retiredAt.trim(),
    };
  } catch {
    return undefined;
  }
}

/** Returns whether a task status is actively executing and unsafe to retire around. */
function isActiveTaskStatus(status: TaskStatus): boolean {
  return [
    "claimed",
    "scouting",
    "implementing",
    "reviewing",
    "publishing",
  ].includes(status);
}

/** Returns whether an unapproved generated child may be retired with its source. */
function isRetirableGeneratedChild(row: RetirementTaskRow): boolean {
  const status = TaskStatusSchema.parse(row.status);
  return (
    row.approved === 0 &&
    (status === "draft" ||
      status === "needs_input" ||
      status === "needs_replan")
  );
}

export class PlanningRepository {
  /** Creates a planning repository with an injectable clock. */
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Validates and persists a new Agile Cycle plan in draft status. */
  createCycle(input: AgileCyclePlan): void {
    const plan = AgileCyclePlanSchema.parse(input);
    this.db
      .query(`
      INSERT INTO cycles(id, goal, token_budget, status, created_at)
      VALUES($id, $goal, $tokenBudget, 'draft', $now)
    `)
      .run({
        id: plan.id,
        goal: plan.goal,
        tokenBudget: plan.tokenBudget,
        now: this.now(),
      });
  }

  /** Validates and persists a new task in draft status. */
  createTask(input: TaskCreate): void {
    const task = TaskCreateSchema.parse(input);
    const now = this.now();
    this.db
      .query(`
      INSERT INTO tasks(
        id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
        approval_required, approved, created_at, updated_at
      ) VALUES(
        $id, $cycleId, $title, $spec, 'draft', $priority, $risk, $tokenCeiling,
        $approvalRequired, $approved, $now, $now
      )
    `)
      .run({
        id: task.id,
        cycleId: task.cycleId,
        title: task.title,
        spec: JSON.stringify(task.spec),
        priority: task.priority,
        risk: task.spec.risk,
        tokenCeiling: task.spec.tokenCeiling,
        approvalRequired: Number(task.approvalRequired),
        approved: Number(task.approved),
        now,
      });
  }

  /** Returns existing task identifiers without parsing their stored specifications. */
  findExistingTaskIds(ids: string[]): Set<string> {
    const taskIds = ids.map((id) => TaskCreateSchema.shape.id.parse(id));
    const query = this.db.query<{ id: string }, [string]>(
      "SELECT id FROM tasks WHERE id = ?",
    );
    const existing = new Set<string>();
    for (const taskId of taskIds) {
      if (query.get(taskId)) existing.add(taskId);
    }
    return existing;
  }

  /** Atomically imports approved backlog tasks and their blocking dependencies. */
  importBacklog(input: BacklogManifest): BacklogImportResult {
    const manifest = BacklogManifestSchema.parse(input);
    for (const task of manifest.tasks) safeTaskPathComponent(task.id);
    const tasks = manifest.tasks.map((task) =>
      TaskCreateSchema.parse({
        ...task,
        cycleId: manifest.cycleId,
        approvalRequired: true,
        approved: true,
      }),
    );
    const tokenBudget = tasks.reduce(
      (total, task) => total + task.spec.tokenCeiling,
      0,
    );

    return this.db.transaction(() => {
      const referencedIds = [
        ...new Set(
          tasks.flatMap((task) => [task.id, ...task.spec.dependencies]),
        ),
      ];
      const placeholders = referencedIds.map(() => "?").join(", ");
      const rows = this.db
        .query<ImportedTaskRow, string[]>(`
          SELECT id, cycle_id, title, spec_json, priority, approval_required, approved
          FROM tasks WHERE id IN (${placeholders})
        `)
        .all(...referencedIds);
      const existingById = new Map(rows.map((row) => [row.id, row]));
      const batchIds = new Set(tasks.map((task) => task.id));

      for (const task of tasks) {
        for (const dependency of task.spec.dependencies) {
          if (!batchIds.has(dependency) && !existingById.has(dependency)) {
            throw new Error(`Missing task dependency: ${dependency}`);
          }
        }
        const existing = existingById.get(task.id);
        if (!existing) continue;
        const existingTask = TaskCreateSchema.parse({
          id: existing.id,
          cycleId: existing.cycle_id,
          title: existing.title,
          spec: JSON.parse(existing.spec_json),
          priority: existing.priority,
          approvalRequired: Boolean(existing.approval_required),
          approved: Boolean(existing.approved),
        });
        if (!isSameImportedTask(existingTask, task)) {
          throw new Error(`Task conflict: ${task.id}`);
        }
      }

      const cycle = this.db
        .query<{ id: string }, [string]>("SELECT id FROM cycles WHERE id = ?")
        .get(manifest.cycleId);
      if (!cycle) {
        this.createCycle({
          id: manifest.cycleId,
          goal: manifest.goal,
          nonGoals: [],
          tokenBudget,
          ticketIds: tasks.map((task) => task.id),
        });
      }

      const created = tasks.filter((task) => !existingById.has(task.id));
      for (const task of created) this.createTask(task);
      for (const task of created) {
        for (const dependency of task.spec.dependencies) {
          this.db
            .query(
              "INSERT INTO task_deps(task_id, depends_on_task_id, kind) VALUES(?, ?, 'blocks')",
            )
            .run(task.id, dependency);
        }
      }
      for (const task of created) {
        this.transitionTask(task.id, "ready", `task-import:${task.id}:ready`);
      }
      return {
        created: created.length,
        skipped: tasks.length - created.length,
        total: tasks.length,
      };
    })();
  }

  /** Lists stored tasks in deterministic priority and identifier order. */
  listTasks(): StoredTask[] {
    const rows = this.db
      .query<TaskRow, []>(`
      SELECT id, cycle_id, title, spec_json, spec_path, spec_hash, base_commit, status,
             priority, approval_required, approved, retirement_reason,
             replacement_task_id, retired_at
      FROM tasks ORDER BY priority, id
    `)
      .all();
    return rows.map((row) =>
      StoredTaskSchema.parse({
        id: row.id,
        cycleId: row.cycle_id,
        title: row.title,
        spec: JSON.parse(row.spec_json),
        status: row.status,
        priority: row.priority,
        approvalRequired: Boolean(row.approval_required),
        approved: Boolean(row.approved),
        retirementReason: row.retirement_reason,
        replacementTaskId: row.replacement_task_id,
        retiredAt: row.retired_at,
        specPath: row.spec_path ?? undefined,
        specHash: row.spec_hash ?? undefined,
        baseCommit: row.base_commit ?? undefined,
      }),
    );
  }

  /** Applies an idempotent validated task-status transition and records its event. */
  transitionTask(id: string, to: TaskStatus, idempotencyKey: string): void {
    const taskId = TaskCreateSchema.shape.id.parse(id);
    const target = TaskStatusSchema.parse(to);
    const eventKey = TaskCreateSchema.shape.id.parse(idempotencyKey);

    this.db.transaction(() => {
      const row = this.db
        .query<{ status: string }, [string]>(
          "SELECT status FROM tasks WHERE id = ?",
        )
        .get(taskId);
      if (!row) throw new Error(`Task not found: ${taskId}`);
      const from = TaskStatusSchema.parse(row.status);

      const existingEvent = this.db
        .query<StatusChangedEventRow, [string]>(`
        SELECT task_id, type, payload_json
        FROM events WHERE idempotency_key = ?
      `)
        .get(eventKey);
      if (existingEvent) {
        const payload = parseStatusChangePayload(existingEvent.payload_json);
        if (
          existingEvent.task_id === taskId &&
          existingEvent.type === "task.status_changed" &&
          payload?.to === target &&
          canTransition(payload.from, payload.to)
        ) {
          return;
        }
        throw new Error(`Idempotency key conflict: ${eventKey}`);
      }

      assertTransition(from, target);
      const now = this.now();
      this.db
        .query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(target, now, taskId);
      this.db
        .query(`
        INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
        VALUES(?, ?, 'task.status_changed', ?, ?)
      `)
        .run(eventKey, taskId, JSON.stringify({ from, to: target }), now);
    })();
  }

  /** Atomically retires one safe task, its direct unapproved generated children, and ready dependents. */
  retireTask(input: TaskRetirementInput): TaskRetirementResult {
    const taskId = TaskCreateSchema.shape.id.parse(input.taskId);
    const reason = input.reason.trim();
    if (reason.length === 0) throw new Error("Retirement reason is required");
    const replacementTaskId =
      input.replacementTaskId === undefined
        ? undefined
        : TaskCreateSchema.shape.id.parse(input.replacementTaskId);
    const eventKey = `task:retire:${taskId}`;

    return this.db.transaction(() => {
      const task = this.db
        .query<RetirementTaskRow, [string]>(`
          SELECT id, status, approved, retirement_reason, replacement_task_id, retired_at
          FROM tasks WHERE id = ?
        `)
        .get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      const existingEvent = this.db
        .query<RetirementEventRow, [string]>(`
          SELECT task_id, type, payload_json, occurred_at
          FROM events WHERE idempotency_key = ?
        `)
        .get(eventKey);
      if (existingEvent) {
        const payload = parseRetirementEventPayload(existingEvent.payload_json);
        if (
          existingEvent.task_id === taskId &&
          existingEvent.type === "task.retired" &&
          payload?.reason === reason &&
          payload.replacementTaskId === replacementTaskId &&
          task.status === "retired" &&
          task.retirement_reason === reason &&
          task.replacement_task_id === (replacementTaskId ?? null) &&
          task.retired_at === payload.retiredAt &&
          existingEvent.occurred_at === payload.retiredAt
        ) {
          return {
            taskId,
            ...(replacementTaskId === undefined ? {} : { replacementTaskId }),
            retiredAt: payload.retiredAt,
          };
        }
        throw new Error(`Retirement conflict: ${taskId}`);
      }

      const sourceStatus = TaskStatusSchema.parse(task.status);
      if (
        sourceStatus !== "draft" &&
        sourceStatus !== "needs_input" &&
        sourceStatus !== "needs_replan" &&
        sourceStatus !== "ready"
      ) {
        throw new Error(`Task cannot be retired from status: ${sourceStatus}`);
      }
      if (replacementTaskId === taskId)
        throw new Error("Task replacement cannot be the retired task itself");
      if (replacementTaskId !== undefined) {
        const replacement = this.db
          .query<{ status: string }, [string]>(
            "SELECT status FROM tasks WHERE id = ?",
          )
          .get(replacementTaskId);
        if (!replacement)
          throw new Error(`Replacement task not found: ${replacementTaskId}`);
        const replacementStatus = TaskStatusSchema.parse(replacement.status);
        if (
          replacementStatus === "retired" ||
          replacementStatus === "rejected" ||
          replacementStatus === "failed_infra"
        ) {
          throw new Error(
            `Replacement task is not usable: ${replacementTaskId} (${replacementStatus})`,
          );
        }
      }

      const dependents = this.db
        .query<RetirementTaskRow, [string]>(`
          SELECT id, status, approved, retirement_reason, replacement_task_id, retired_at
          FROM tasks
          WHERE id IN (SELECT task_id FROM task_deps WHERE depends_on_task_id = ?)
          ORDER BY id ASC
        `)
        .all(taskId);
      const activeDependent = dependents.find((dependent) =>
        isActiveTaskStatus(TaskStatusSchema.parse(dependent.status)),
      );
      if (activeDependent)
        throw new Error(
          `Active dependent blocks retirement: ${activeDependent.id}`,
        );

      const children = this.db
        .query<RetirementTaskRow, [string, string, string, string]>(`
          SELECT id, status, approved, retirement_reason, replacement_task_id, retired_at
          FROM tasks
          WHERE id <> ?
            AND id <> ?
            AND (
              parent_task_id = ?
              OR discovered_from_review_id IN (SELECT id FROM reviews WHERE task_id = ?)
            )
          ORDER BY id ASC
        `)
        .all(taskId, replacementTaskId ?? "", taskId, taskId);
      const unsafeChild = children.find(
        (child) => !isRetirableGeneratedChild(child),
      );
      if (unsafeChild)
        throw new Error(`Generated child blocks retirement: ${unsafeChild.id}`);
      const retiringChildIds = new Set(children.map((child) => child.id));

      const retiredAt = this.now();
      const payload = {
        from: sourceStatus,
        reason,
        ...(replacementTaskId === undefined ? {} : { replacementTaskId }),
        retiredAt,
      };
      this.db
        .query(`
          UPDATE tasks
          SET status = 'retired', retirement_reason = ?, replacement_task_id = ?,
              retired_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(reason, replacementTaskId ?? null, retiredAt, retiredAt, taskId);
      this.db
        .query(`
          INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
          VALUES(?, ?, 'task.retired', ?, ?)
        `)
        .run(eventKey, taskId, JSON.stringify(payload), retiredAt);

      for (const child of children) {
        const childStatus = TaskStatusSchema.parse(child.status);
        this.db
          .query(`
            UPDATE tasks
            SET status = 'retired', retirement_reason = ?, replacement_task_id = ?,
                retired_at = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(
            reason,
            replacementTaskId ?? null,
            retiredAt,
            retiredAt,
            child.id,
          );
        this.db
          .query(`
            INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
            VALUES(?, ?, 'task.retired', ?, ?)
          `)
          .run(
            `task:retire:${child.id}`,
            child.id,
            JSON.stringify({
              ...payload,
              from: childStatus,
              initiatingTaskId: taskId,
            }),
            retiredAt,
          );
      }

      for (const dependent of dependents) {
        if (retiringChildIds.has(dependent.id)) continue;
        const dependentStatus = TaskStatusSchema.parse(dependent.status);
        if (dependentStatus !== "draft" && dependentStatus !== "ready")
          continue;
        this.db
          .query(
            "UPDATE tasks SET status = 'needs_replan', updated_at = ? WHERE id = ?",
          )
          .run(retiredAt, dependent.id);
        this.db
          .query(`
            INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
            VALUES(?, ?, 'task.needs_replan', ?, ?)
          `)
          .run(
            `task:retire:${taskId}:dependent:${dependent.id}`,
            dependent.id,
            JSON.stringify({ retiredTaskId: taskId }),
            retiredAt,
          );
      }

      return {
        taskId,
        ...(replacementTaskId === undefined ? {} : { replacementTaskId }),
        retiredAt,
      };
    })();
  }
}
