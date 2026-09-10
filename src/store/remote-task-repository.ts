import type { Database } from "bun:sqlite";
import {
  type BacklogManifest,
  BacklogTaskSchema,
  type TaskStatus,
} from "../domain/schemas";

export type RemoteTaskRecord = {
  taskId: string;
  repository: string;
  planId: string;
  issueNumber: number;
  issueUrl: string;
  envelopeHash: string;
  approvalAuthor?: string;
  approvalHash?: string;
  remoteState: "OPEN" | "CLOSED";
  statusCommentId?: number;
  statusSyncedAt?: string;
  statusSyncedValue?: TaskStatus;
  pendingSync: boolean;
  lastSyncError?: string;
};

export type RemoteFollowUpDraft = {
  task: BacklogManifest["tasks"][number];
  cycleId: string;
  goal: string;
  parentTaskId: string;
  parentIssueNumber: number;
};

export type RemoteTaskProjection = RemoteTaskRecord & {
  status: TaskStatus;
  updatedAt: string;
  summary?: string;
  pullRequestUrl?: string;
  pullRequestState?: "OPEN" | "MERGED";
  followUpUrl?: string;
};

export type RemoteDependencyCheck = {
  taskId: string;
  baseCommit?: string;
  dependencies: Array<{
    taskId: string;
    status: TaskStatus;
    replacementTaskId?: string;
    replacementStatus?: TaskStatus;
    pullRequestNumber?: number;
    replacementPullRequestNumber?: number;
  }>;
};

type RemoteTaskRow = {
  task_id: string;
  repository: string;
  plan_id: string;
  issue_number: number;
  issue_url: string;
  envelope_hash: string;
  approval_author: string | null;
  approval_hash: string | null;
  remote_state: "OPEN" | "CLOSED";
  status_comment_id: number | null;
  status_synced_at: string | null;
  status_synced_value: TaskStatus | null;
  pending_sync: number;
  last_sync_error: string | null;
};

/** Converts a database row into the public remote-task synchronization record. */
function remoteTaskRecord(row: RemoteTaskRow): RemoteTaskRecord {
  return {
    taskId: row.task_id,
    repository: row.repository,
    planId: row.plan_id,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    envelopeHash: row.envelope_hash,
    ...(row.approval_author === null
      ? {}
      : { approvalAuthor: row.approval_author }),
    ...(row.approval_hash === null ? {} : { approvalHash: row.approval_hash }),
    remoteState: row.remote_state,
    ...(row.status_comment_id === null
      ? {}
      : { statusCommentId: row.status_comment_id }),
    ...(row.status_synced_at === null
      ? {}
      : { statusSyncedAt: row.status_synced_at }),
    ...(row.status_synced_value === null
      ? {}
      : { statusSyncedValue: row.status_synced_value }),
    pendingSync: Boolean(row.pending_sync),
    ...(row.last_sync_error === null
      ? {}
      : { lastSyncError: row.last_sync_error }),
  };
}

/** Persists frozen remote task identities and synchronization receipts. */
export class RemoteTaskRepository {
  /** Connects remote task persistence to one project database and clock. */
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Runs one local import and its remote bindings as a single SQLite transaction. */
  transaction<T>(action: () => T): T {
    return this.db.transaction(action)();
  }

  /** Inserts one frozen remote identity or confirms its exact existing snapshot. */
  add(input: Omit<RemoteTaskRecord, "pendingSync">): void {
    const existing = this.get(input.taskId);
    if (existing !== undefined) {
      const unchanged =
        existing.repository === input.repository &&
        existing.planId === input.planId &&
        existing.issueNumber === input.issueNumber &&
        existing.envelopeHash === input.envelopeHash &&
        existing.approvalAuthor === input.approvalAuthor &&
        existing.approvalHash === input.approvalHash;
      if (!unchanged) throw new Error(`Remote task conflict: ${input.taskId}`);
      return;
    }
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .query(`
        INSERT INTO remote_tasks(
          task_id, repository, plan_id, issue_number, issue_url, envelope_hash,
          approval_author, approval_hash, remote_state, status_comment_id,
          status_synced_at, status_synced_value, pending_sync, last_sync_error,
          created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `)
        .run(
          input.taskId,
          input.repository,
          input.planId,
          input.issueNumber,
          input.issueUrl,
          input.envelopeHash,
          input.approvalAuthor ?? null,
          input.approvalHash ?? null,
          input.remoteState,
          input.statusCommentId ?? null,
          input.statusSyncedAt ?? null,
          input.statusSyncedValue ?? null,
          input.lastSyncError ?? null,
          now,
          now,
        );
      this.db
        .query(`
          UPDATE remote_tasks SET pending_sync = 1, updated_at = ?
          WHERE task_id = (SELECT parent_task_id FROM tasks WHERE id = ?)
        `)
        .run(now, input.taskId);
    })();
  }

  /** Promotes the already-published local follow-up after exact remote approval. */
  approve(taskId: string, author: string, hash: string): void {
    const now = this.now();
    this.db.transaction(() => {
      const changed = this.db
        .query(`
          UPDATE remote_tasks
          SET approval_author = ?, approval_hash = ?, pending_sync = 1, updated_at = ?
          WHERE task_id = ? AND approval_author IS NULL AND approval_hash IS NULL
        `)
        .run(author, hash, now, taskId).changes;
      if (changed !== 1)
        throw new Error(`Remote follow-up cannot be approved: ${taskId}`);
      const promoted = this.db
        .query(`
          UPDATE tasks SET approved = 1, status = 'ready', updated_at = ?
          WHERE id = ? AND status = 'draft' AND approved = 0
        `)
        .run(now, taskId).changes;
      if (promoted !== 1)
        throw new Error(`Local follow-up cannot be promoted: ${taskId}`);
      this.db
        .query(`
          INSERT INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
          VALUES(?, ?, 'task.remote_approved', ?, ?)
        `)
        .run(
          `remote-approved:${taskId}:${hash}`,
          taskId,
          JSON.stringify({ author, hash }),
          now,
        );
    })();
  }

  /** Returns the frozen remote record for one local task. */
  get(taskId: string): RemoteTaskRecord | undefined {
    const row = this.db
      .query<RemoteTaskRow, [string]>(`
        SELECT task_id, repository, plan_id, issue_number, issue_url,
               envelope_hash, approval_author, approval_hash, remote_state,
               status_comment_id, status_synced_at, status_synced_value,
               pending_sync, last_sync_error
        FROM remote_tasks WHERE task_id = ?
      `)
      .get(taskId);
    return row === null ? undefined : remoteTaskRecord(row);
  }

  /** Lists every remote task with local status in deterministic identity order. */
  list(): Array<RemoteTaskRecord & { status: TaskStatus; updatedAt: string }> {
    return this.db
      .query<RemoteTaskRow & { status: TaskStatus; updated_at: string }, []>(`
        SELECT remote_tasks.task_id, repository, plan_id, issue_number, issue_url,
               envelope_hash, approval_author, approval_hash, remote_state,
               status_comment_id, status_synced_at, status_synced_value,
               pending_sync, last_sync_error,
               tasks.status, tasks.updated_at
        FROM remote_tasks JOIN tasks ON tasks.id = remote_tasks.task_id
        ORDER BY repository, plan_id, remote_tasks.task_id
      `)
      .all()
      .map((row) => ({
        ...remoteTaskRecord(row),
        status: row.status,
        updatedAt: row.updated_at,
      }));
  }

  /** Lists rejected-task children that still need one unapproved remote draft. */
  listUnpublishedFollowUps(): RemoteFollowUpDraft[] {
    return this.db
      .query<
        {
          id: string;
          cycle_id: string;
          title: string;
          priority: number;
          spec_json: string;
          goal: string;
          parent_task_id: string;
          parent_issue_number: number;
        },
        []
      >(`
        SELECT child.id, child.cycle_id, child.title, child.priority, child.spec_json,
               cycle.goal, child.parent_task_id, parent_remote.issue_number AS parent_issue_number
        FROM tasks AS child
        JOIN cycles AS cycle ON cycle.id = child.cycle_id
        JOIN remote_tasks AS parent_remote ON parent_remote.task_id = child.parent_task_id
        LEFT JOIN remote_tasks AS child_remote ON child_remote.task_id = child.id
        WHERE child.status = 'draft' AND child.approved = 0
          AND child.discovered_from_review_id IS NOT NULL
          AND child_remote.task_id IS NULL
        ORDER BY child.created_at, child.id
      `)
      .all()
      .map((row) => ({
        task: BacklogTaskSchema.parse({
          id: row.id,
          title: row.title,
          priority: row.priority,
          spec: JSON.parse(row.spec_json),
        }),
        cycleId: row.cycle_id,
        goal: row.goal,
        parentTaskId: row.parent_task_id,
        parentIssueNumber: row.parent_issue_number,
      }));
  }

  /** Returns projections whose local state is newer than the last remote receipt. */
  pendingProjections(): RemoteTaskProjection[] {
    return this.list()
      .filter(
        (record) =>
          record.pendingSync ||
          record.statusSyncedAt === undefined ||
          record.updatedAt > record.statusSyncedAt ||
          record.status !== record.statusSyncedValue,
      )
      .map((record) => this.projection(record));
  }

  /** Lists remote ready tasks and the publication receipts that gate their dependencies. */
  readyDependencyChecks(): RemoteDependencyCheck[] {
    const tasks = this.db
      .query<{ task_id: string; base_commit: string | null }, []>(`
        SELECT remote_tasks.task_id, tasks.base_commit
        FROM remote_tasks JOIN tasks ON tasks.id = remote_tasks.task_id
        WHERE tasks.status = 'ready'
        ORDER BY tasks.priority, tasks.created_at, tasks.id
      `)
      .all();
    const dependencies = this.db.query<
      {
        task_id: string;
        dependency_id: string;
        dependency_status: TaskStatus;
        replacement_task_id: string | null;
        replacement_status: TaskStatus | null;
        pull_request_number: number | null;
        replacement_pull_request_number: number | null;
      },
      [string]
    >(`
      SELECT dep.task_id, dependency.id AS dependency_id,
             dependency.status AS dependency_status,
             dependency.replacement_task_id, replacement.status AS replacement_status,
             publication.pull_request_number,
             replacement_publication.pull_request_number AS replacement_pull_request_number
      FROM task_deps AS dep
      JOIN tasks AS dependency ON dependency.id = dep.depends_on_task_id
      LEFT JOIN tasks AS replacement ON replacement.id = dependency.replacement_task_id
      LEFT JOIN task_publications AS publication ON publication.task_id = dependency.id
      LEFT JOIN task_publications AS replacement_publication
        ON replacement_publication.task_id = replacement.id
      WHERE dep.task_id = ?
      ORDER BY dependency.id
    `);
    return tasks.map((task) => ({
      taskId: task.task_id,
      ...(task.base_commit === null ? {} : { baseCommit: task.base_commit }),
      dependencies: dependencies.all(task.task_id).map((dependency) => ({
        taskId: dependency.dependency_id,
        status: dependency.dependency_status,
        ...(dependency.replacement_task_id === null
          ? {}
          : { replacementTaskId: dependency.replacement_task_id }),
        ...(dependency.replacement_status === null
          ? {}
          : { replacementStatus: dependency.replacement_status }),
        ...(dependency.pull_request_number === null
          ? {}
          : { pullRequestNumber: dependency.pull_request_number }),
        ...(dependency.replacement_pull_request_number === null
          ? {}
          : {
              replacementPullRequestNumber:
                dependency.replacement_pull_request_number,
            }),
      })),
    }));
  }

  /** Counts occupied task slots, including attempts paused by remote authority. */
  activeTaskCount(): number {
    return (
      this.db
        .query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE status IN ('claimed', 'scouting', 'implementing', 'reviewing', 'publishing')
         OR EXISTS (SELECT 1 FROM attempts WHERE task_id = tasks.id AND status = 'running')
    `)
        .get()?.count ?? 0
    );
  }

  /** Pins a freshly fetched full target-branch commit before the task can be claimed. */
  pinBaseCommit(taskId: string, baseCommit: string): void {
    if (!/^[0-9a-f]{40}$/u.test(baseCommit)) {
      throw new Error(`Invalid remote task base commit: ${baseCommit}`);
    }
    const changed = this.db
      .query(`
        UPDATE tasks SET base_commit = ?, updated_at = ?
        WHERE id = ? AND status = 'ready'
      `)
      .run(baseCommit, this.now(), taskId).changes;
    if (changed !== 1) {
      const current = this.db
        .query<{ base_commit: string | null }, [string]>(
          "SELECT base_commit FROM tasks WHERE id = ?",
        )
        .get(taskId)?.base_commit;
      if (current !== baseCommit) {
        throw new Error(
          `Remote task base commit could not be pinned: ${taskId}`,
        );
      }
    }
    this.markPending(taskId);
  }

  /** Records a dependency pull request whose merge is present in the fetched target. */
  markDependencyMerged(taskId: string): void {
    const changed = this.db
      .query(`
        UPDATE task_publications
        SET pull_request_state = 'MERGED', updated_at = ?
        WHERE task_id = ? AND pull_request_state <> 'MERGED'
      `)
      .run(this.now(), taskId).changes;
    if (changed === 1) this.markPending(taskId);
  }

  /** Builds the latest safe task state and publication links for one remote Issue. */
  private projection(
    record: RemoteTaskRecord & { status: TaskStatus; updatedAt: string },
  ): RemoteTaskProjection {
    const publication = this.db
      .query<
        {
          pull_request_url: string | null;
          pull_request_state: "OPEN" | "MERGED" | null;
          failure_message: string | null;
        },
        [string]
      >(`
        SELECT pull_request_url, pull_request_state, failure_message
        FROM task_publications WHERE task_id = ?
      `)
      .get(record.taskId);
    const event = this.db
      .query<{ payload_json: string }, [string]>(`
        SELECT payload_json FROM events
        WHERE task_id = ? AND type IN (
          'task.remote_paused', 'task.needs_replan'
        )
        ORDER BY seq DESC LIMIT 1
      `)
      .get(record.taskId);
    let summary = publication?.failure_message ?? undefined;
    if (summary === undefined && record.status === "rejected") {
      const review = this.db
        .query<{ findings_json: string }, [string]>(`
          SELECT findings_json FROM reviews
          WHERE task_id = ? AND decision = 'rejected'
          ORDER BY rowid DESC LIMIT 1
        `)
        .get(record.taskId);
      if (review !== null) {
        const findings = JSON.parse(review.findings_json) as unknown;
        if (
          Array.isArray(findings) &&
          findings.every((item) => typeof item === "string")
        ) {
          summary = findings.join("; ") || "Review rejected the implementation";
        }
      }
    }
    if (summary === undefined && record.status === "failed_infra") {
      const failure = this.db
        .query<{ payload_json: string }, [string]>(`
          SELECT payload_json FROM events
          WHERE task_id = ? AND type = 'attempt.failed_infra'
          ORDER BY seq DESC LIMIT 1
        `)
        .get(record.taskId);
      if (failure !== null) {
        const payload = JSON.parse(failure.payload_json) as Record<
          string,
          unknown
        >;
        const value = payload.message ?? payload.code;
        if (typeof value === "string") summary = value;
      }
    }
    if (summary === undefined && event !== null) {
      try {
        const payload = JSON.parse(event.payload_json) as Record<
          string,
          unknown
        >;
        const value =
          payload.reason ?? payload.failure ?? payload.rejectedTaskId;
        if (typeof value === "string") summary = value;
      } catch {
        summary = "Task requires operator attention";
      }
    }
    const followUp = this.db
      .query<{ issue_url: string }, [string]>(`
        SELECT remote_tasks.issue_url
        FROM tasks AS child
        JOIN remote_tasks ON remote_tasks.task_id = child.id
        WHERE child.parent_task_id = ? AND child.discovered_from_review_id IS NOT NULL
        ORDER BY child.created_at LIMIT 1
      `)
      .get(record.taskId);
    return {
      ...record,
      ...(summary === undefined ? {} : { summary }),
      ...(publication?.pull_request_url === null ||
      publication?.pull_request_url === undefined
        ? {}
        : { pullRequestUrl: publication.pull_request_url }),
      ...(publication?.pull_request_state === null ||
      publication?.pull_request_state === undefined
        ? {}
        : { pullRequestState: publication.pull_request_state }),
      ...(followUp === null ? {} : { followUpUrl: followUp.issue_url }),
    };
  }

  /** Moves unfinished work to a user-visible recovery state before its next boundary. */
  pauseTask(
    taskId: string,
    status: "needs_input" | "needs_replan",
    reason: string,
  ): void {
    const now = this.now();
    this.db.transaction(() => {
      const changed = this.db
        .query(`
          UPDATE tasks SET status = ?, updated_at = ?
          WHERE id = ?
            AND status IN ('draft', 'ready', 'claimed', 'scouting', 'implementing', 'reviewing', 'publishing')
            AND NOT EXISTS (
              SELECT 1 FROM attempts WHERE attempts.task_id = tasks.id AND attempts.status = 'running'
            )
        `)
        .run(status, now, taskId).changes;
      if (changed === 0) return;
      this.db
        .query(`
          INSERT OR IGNORE INTO events(idempotency_key, task_id, type, payload_json, occurred_at)
          VALUES(?, ?, 'task.remote_paused', ?, ?)
        `)
        .run(
          `remote-pause:${taskId}:${status}:${reason}`,
          taskId,
          JSON.stringify({ status, reason }),
          now,
        );
      this.markPending(taskId);
    })();
  }

  /** Marks a remote task for projection after its local state changes. */
  markPending(taskId: string): void {
    this.db
      .query(
        "UPDATE remote_tasks SET pending_sync = 1, updated_at = ? WHERE task_id = ?",
      )
      .run(this.now(), taskId);
  }

  /** Records a successful status projection receipt and its stable comment identity. */
  synced(
    taskId: string,
    commentId: number,
    syncedAt: string,
    status: TaskStatus,
  ): void {
    this.db
      .query(`
        UPDATE remote_tasks
        SET status_comment_id = ?, status_synced_at = ?, status_synced_value = ?,
            pending_sync = 0, last_sync_error = NULL, updated_at = ?
        WHERE task_id = ?
      `)
      .run(commentId, syncedAt, status, syncedAt, taskId);
  }

  /** Retains pending work with a sanitized synchronization failure summary. */
  syncFailed(taskId: string, message: string): void {
    this.db
      .query(`
        UPDATE remote_tasks
        SET pending_sync = 1, last_sync_error = ?, updated_at = ?
        WHERE task_id = ?
      `)
      .run(message.slice(0, 1000), this.now(), taskId);
  }
}
