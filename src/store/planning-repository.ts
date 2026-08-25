import type { Database } from "bun:sqlite";
import {
  StoredTaskSchema,
  TaskCreateSchema,
  TaskStatusSchema,
  WeeklyPlanSchema,
  type StoredTask,
  type TaskCreate,
  type TaskStatus,
  type WeeklyPlan,
} from "../domain/schemas";
import { assertTransition, canTransition } from "../domain/transitions";

type TaskRow = {
  id: string;
  week_id: string;
  title: string;
  spec_json: string;
  spec_path: string | null;
  spec_hash: string | null;
  base_commit: string | null;
  status: TaskStatus;
  priority: number;
  approval_required: number;
  approved: number;
};

type StatusChangedEventRow = {
  task_id: string | null;
  type: string;
  payload_json: string;
};

function parseStatusChangePayload(payloadJson: string): { from: TaskStatus; to: TaskStatus } | undefined {
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const keys = Object.keys(payload);
    if (keys.length !== 2 || !keys.includes("from") || !keys.includes("to")) return undefined;
    const values = payload as Record<string, unknown>;
    return {
      from: TaskStatusSchema.parse(values.from),
      to: TaskStatusSchema.parse(values.to),
    };
  } catch {
    return undefined;
  }
}

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
    `).run({ id: plan.id, goal: plan.goal, tokenBudget: plan.tokenBudget, now: this.now() });
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
      id: task.id,
      weekId: task.weekId,
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

  listTasks(): StoredTask[] {
    const rows = this.db.query<TaskRow, []>(`
      SELECT id, week_id, title, spec_json, spec_path, spec_hash, base_commit, status,
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
      baseCommit: row.base_commit ?? undefined,
    }));
  }

  transitionTask(id: string, to: TaskStatus, idempotencyKey: string): void {
    const taskId = TaskCreateSchema.shape.id.parse(id);
    const target = TaskStatusSchema.parse(to);
    const eventKey = TaskCreateSchema.shape.id.parse(idempotencyKey);

    this.db.transaction(() => {
      const row = this.db.query<{ status: string }, [string]>(
        "SELECT status FROM tasks WHERE id = ?",
      ).get(taskId);
      if (!row) throw new Error(`Task not found: ${taskId}`);
      const from = TaskStatusSchema.parse(row.status);

      const existingEvent = this.db.query<StatusChangedEventRow, [string]>(`
        SELECT task_id, type, payload_json
        FROM events WHERE idempotency_key = ?
      `).get(eventKey);
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
      this.db.query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(target, now, taskId);
      this.db.query(`
        INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
        VALUES(?, ?, 'task.status_changed', ?, ?)
      `).run(eventKey, taskId, JSON.stringify({ from, to: target }), now);
    })();
  }
}
