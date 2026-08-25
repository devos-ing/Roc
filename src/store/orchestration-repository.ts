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
