import type { Database } from "bun:sqlite";
import type { z } from "zod";
import { ContextRefSchema, StoredTaskSchema, TaskStatusSchema } from "../domain/schemas";
import { assertTransition } from "../domain/transitions";
import {
  AgentRoleSchema,
  HarnessAttemptSchema,
  HarnessEventSchema,
  HarnessRoleInputSchema,
  type HarnessEvent,
  type HarnessStepRequest,
} from "../harness/contracts";
import { baselineRoute } from "../scheduler/model-routing";

export type IdFactory = (kind: "attempt" | "decision" | "event" | "review" | "task") => string;

export type RunningAttempt = {
  descriptor: HarnessStepRequest["attempt"];
  input: z.infer<typeof HarnessRoleInputSchema>;
  backendCursor?: string;
};

type TaskRow = {
  id: string;
  week_id: string;
  title: string;
  spec_json: string;
  spec_path: string | null;
  spec_hash: string | null;
  status: string;
  priority: number;
  approval_required: number;
  approved: number;
  context_id: string | null;
};

type RunningAttemptRow = TaskRow & {
  attempt_id: string;
  role: string;
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

function storedTask(row: TaskRow) {
  return StoredTaskSchema.parse({
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
  });
}

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

  getRunningAttempt(): RunningAttempt | undefined {
    const row = this.db.query<RunningAttemptRow, []>(`
      SELECT
        attempt.id AS attempt_id,
        attempt.role,
        attempt.model,
        attempt.effort,
        attempt.retry_index,
        attempt.backend_cursor,
        task.id,
        task.week_id,
        task.title,
        task.spec_json,
        task.spec_path,
        task.spec_hash,
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
    `).get();
    if (!row) return undefined;

    const ticket = storedTask(row);
    const role = AgentRoleSchema.parse(row.role);
    const contextRef = row.context_id === null
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

  beginNextAttempt(): { attemptId: string; taskId: string; role: "scout" | "implement" | "review" } | undefined {
    return this.db.transaction(() => {
      const row = this.db.query<TaskRow, []>(`
        SELECT id, week_id, title, spec_json, spec_path, spec_hash, status,
               priority, approval_required, approved, context_id
        FROM tasks AS task
        WHERE task.status IN ('claimed', 'scouting', 'implementing', 'reviewing')
          AND NOT EXISTS (
            SELECT 1 FROM attempts AS attempt
            WHERE attempt.task_id = task.id AND attempt.status = 'running'
          )
        ORDER BY task.priority ASC, task.created_at ASC, task.id ASC
        LIMIT 1
      `).get();
      if (!row || row.status === "reviewing") return undefined;

      const ticket = storedTask(row);
      const from = TaskStatusSchema.parse(row.status);
      const role: "scout" | "implement" | "review" =
        from === "claimed" ? "scout" : from === "scouting" ? "implement" : "review";
      const to = role === "scout" ? "scouting" : role === "implement" ? "implementing" : "reviewing";
      if (role === "implement") this.latestRoleOutput(row.id, "scout");
      if (role === "review") this.latestRoleOutput(row.id, "implement");

      const route = baselineRoute(role, ticket.spec.risk);
      const decisionId = this.id("decision");
      const attemptId = this.id("attempt");
      const now = this.now();
      this.db.query(`
        INSERT INTO model_decisions(
          id, task_id, role, model, effort, token_budget, context_id,
          fallback_models_json, decided_by, confidence, rationale_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'rule', 1, ?)
      `).run(
        decisionId,
        row.id,
        role,
        route.model,
        route.effort,
        ticket.spec.tokenCeiling,
        row.context_id,
        JSON.stringify(route.fallbacks),
        JSON.stringify(route.rationale),
      );
      this.db.query(`
        INSERT INTO attempts(
          id, task_id, role, model, effort, status, retry_index, started_at
        ) VALUES(?, ?, ?, ?, ?, 'running', 0, ?)
      `).run(attemptId, row.id, role, route.model, route.effort, now);

      assertTransition(from, to);
      this.db.query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(to, now, row.id);
      this.db.query(`
        INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
        VALUES(?, ?, 'task.status_changed', ?, ?)
      `).run(this.id("event"), row.id, JSON.stringify({ from, to }), now);
      this.db.query(`
        INSERT INTO events(idempotency_key, task_id, attempt_id, type, payload_json, occurred_at)
        VALUES(?, ?, ?, 'attempt.created', ?, ?)
      `).run(
        this.id("event"),
        row.id,
        attemptId,
        JSON.stringify({ role, model: route.model, effort: route.effort, retryIndex: 0, decisionId }),
        now,
      );
      return { attemptId, taskId: row.id, role };
    })();
  }

  applyHarnessEvent(attemptId: string, nextCursor: string, rawEvent: HarnessEvent): void {
    this.db.transaction(() => {
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

      this.db.query(`
        INSERT INTO events(idempotency_key, task_id, attempt_id, type, payload_json, occurred_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(event.eventId, attempt.task_id, attemptId, event.type, JSON.stringify(event), event.occurredAt);

      if (event.type === "attempt.started") {
        if (event.threadId !== undefined) {
          this.db.query("UPDATE attempts SET thread_id = ? WHERE id = ?").run(event.threadId, attemptId);
        }
      } else if (event.type === "attempt.output") {
        if (event.output.kind !== attempt.role) {
          throw new Error(`Harness output role mismatch: ${event.output.kind} !== ${attempt.role}`);
        }
        if (event.output.kind === "implement") {
          this.db.query("UPDATE attempts SET git_commit = ? WHERE id = ?").run(event.output.commitSha, attemptId);
        }
      } else if (event.type === "attempt.completed") {
        const outputRow = this.db.query<{ payload_json: string }, [string, string]>(`
          SELECT payload_json FROM events
          WHERE attempt_id = ?
            AND type = 'attempt.output'
            AND json_extract(payload_json, '$.output.kind') = ?
          ORDER BY seq DESC LIMIT 1
        `).get(attemptId, attempt.role);
        if (!outputRow) throw new Error(`Attempt completed without ${attempt.role} output: ${attemptId}`);
        this.db.query(`
          UPDATE attempts SET status = 'succeeded', ended_at = ? WHERE id = ?
        `).run(event.occurredAt, attemptId);

        const outputEvent = HarnessEventSchema.parse(JSON.parse(outputRow.payload_json));
        if (
          attempt.role === "review" &&
          outputEvent.type === "attempt.output" &&
          outputEvent.output.kind === "review" &&
          outputEvent.output.decision === "accepted"
        ) {
          this.db.query(`
            INSERT INTO reviews(id, task_id, attempt_id, decision, findings_json)
            VALUES(?, ?, ?, ?, ?)
          `).run(
            this.id("review"),
            attempt.task_id,
            attemptId,
            outputEvent.output.decision,
            JSON.stringify(outputEvent.output.findings),
          );
          const status = this.db.query<{ status: string }, [string]>(
            "SELECT status FROM tasks WHERE id = ?",
          ).get(attempt.task_id)?.status;
          if (status === undefined) throw new Error(`Task not found: ${attempt.task_id}`);
          const from = TaskStatusSchema.parse(status);
          assertTransition(from, "done");
          this.db.query("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(
            event.occurredAt,
            attempt.task_id,
          );
          this.db.query(`
            INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
            VALUES(?, ?, 'task.status_changed', ?, ?)
          `).run(
            this.id("event"),
            attempt.task_id,
            JSON.stringify({ from, to: "done" }),
            event.occurredAt,
          );
        }
      } else {
        throw new Error(`Unsupported harness event in happy-path repository: ${event.type}`);
      }

      this.db.query("UPDATE attempts SET backend_cursor = ? WHERE id = ?").run(nextCursor, attemptId);
    })();
  }

  inspectTask(taskId: string): { id: string; status: string } | undefined {
    return this.db.query<{ id: string; status: string }, [string]>(
      "SELECT id, status FROM tasks WHERE id = ?",
    ).get(taskId) ?? undefined;
  }

  listAttempts(taskId: string): Array<{ role: string; model: string; effort: string; status: string }> {
    return this.db.query<{ role: string; model: string; effort: string; status: string }, [string]>(`
      SELECT role, model, effort, status FROM attempts
      WHERE task_id = ? ORDER BY started_at ASC, id ASC
    `).all(taskId);
  }

  listReviews(taskId: string): Array<{ decision: string; findings: string[] }> {
    return this.db.query<{ decision: string; findings_json: string }, [string]>(`
      SELECT decision, findings_json FROM reviews WHERE task_id = ? ORDER BY rowid ASC
    `).all(taskId).map((row) => ({
      decision: row.decision,
      findings: JSON.parse(row.findings_json),
    }));
  }

  private latestRoleOutput(taskId: string, role: "scout" | "implement") {
    const row = this.db.query<{ payload_json: string }, [string, string]>(`
      SELECT event.payload_json
      FROM events AS event
      JOIN attempts AS attempt ON attempt.id = event.attempt_id
      WHERE event.task_id = ?
        AND attempt.role = ?
        AND attempt.status = 'succeeded'
        AND event.type = 'attempt.output'
      ORDER BY event.seq DESC
      LIMIT 1
    `).get(taskId, role);
    if (!row) throw new Error(`Missing succeeded ${role} output for task ${taskId}`);
    const event = HarnessEventSchema.parse(JSON.parse(row.payload_json));
    if (event.type !== "attempt.output" || event.output.kind !== role) {
      throw new Error(`Invalid ${role} output for task ${taskId}`);
    }
    return event.output;
  }
}
