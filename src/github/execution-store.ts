import { z } from "zod";
import {
  type StoredTask,
  StoredTaskSchema,
  TaskStatusSchema,
} from "../domain/schemas";
import { assertTransition } from "../domain/transitions";
import {
  HarnessAttemptSchema,
  ImplementOutputSchema,
  ReviewOutputSchema,
  ScoutOutputSchema,
} from "../harness/contracts";
import { AgileError } from "../runtime/errors";
import type { GitHubRemoteIssueReader, RemoteIssue } from "./issue-reader";
import {
  jsonHash,
  parseRemoteTaskApproval,
  parseRemoteTaskEnvelope,
  type RemoteTaskEnvelope,
  remotePlanId,
} from "./remote-tasks";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
export const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  })
  .strict();
export const AttemptReceiptSchema = z
  .object({
    descriptor: HarnessAttemptSchema,
    status: z.enum(["running", "succeeded", "failed_infra", "blocked_policy"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    cursor: z.string().optional(),
    sequence: z.number().int().nonnegative(),
    events: z.record(z.string(), z.string()),
    usage: UsageSchema,
    usageKnown: z.boolean(),
    output: z
      .discriminatedUnion("kind", [
        ScoutOutputSchema,
        ImplementOutputSchema,
        ReviewOutputSchema,
      ])
      .optional(),
    failure: z.string().optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
const HookReceiptSchema = z
  .object({
    hash: z.string(),
    status: z.enum(["running", "succeeded", "failed"]),
    attempts: z.number().int().min(1).max(3),
  })
  .strict();
export const ExecutionRecordSchema = z
  .object({
    version: z.literal(1),
    issueNumber: z.number().int().positive(),
    specHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    revision: z.number().int().nonnegative(),
    baseBranch: z.string().min(1),
    baseCommit: Sha,
    phase: TaskStatusSchema,
    updatedAt: z.string().datetime(),
    attempts: z.array(AttemptReceiptSchema),
    hooks: z
      .object({
        prehook: HookReceiptSchema.optional(),
        posthook: HookReceiptSchema.optional(),
      })
      .strict(),
    publication: z
      .object({
        branch: z.string(),
        commitSha: Sha,
        number: z.number().int().positive().optional(),
        url: z.string().url().optional(),
        mergeCommit: Sha.optional(),
      })
      .strict()
      .optional(),
    failure: z.string().optional(),
  })
  .strict();
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
export type AttemptReceipt = z.infer<typeof AttemptReceiptSchema>;
export type NativeTask = {
  issue: RemoteIssue;
  envelope: RemoteTaskEnvelope;
  task: StoredTask;
  approved: boolean;
  execution?: ExecutionRecord;
  commentId?: number;
  blockedReason?: string;
};
export type IssueAccess = Pick<
  GitHubRemoteIssueReader,
  "read" | "get" | "writeComment" | "setStatusLabel"
>;
const marker = "<!-- roc:execution\n";

/** Creates the first remote checkpoint before any role begins. */
export function initialExecution(
  task: NativeTask,
  baseBranch: string,
  baseCommit: string,
): ExecutionRecord {
  return ExecutionRecordSchema.parse({
    version: 1,
    issueNumber: task.issue.number,
    specHash: jsonHash(task.envelope),
    revision: 0,
    baseBranch,
    baseCommit,
    phase: "claimed",
    updatedAt: new Date().toISOString(),
    attempts: [],
    hooks: {},
  });
}

/** Renders a readable status followed by an escaped, lossless execution checkpoint. */
export function renderExecution(record: ExecutionRecord): string {
  const json = JSON.stringify(record, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `## Roc execution\nTask: #${record.issueNumber}\nPhase: ${record.phase}\nUpdated: ${record.updatedAt}\n${record.failure ? `Reason: ${record.failure}\n` : ""}${record.publication?.url ? `PR: ${record.publication.url}\n` : ""}\n${marker}${json}\nroc:execution -->`;
}

/** Parses exactly one complete execution record, rejecting trailing or repeated markers. */
function parseExecution(body: string): ExecutionRecord {
  const start = body.indexOf(marker);
  const end = body.indexOf("\nroc:execution -->", start);
  if (
    start < 0 ||
    start !== body.lastIndexOf(marker) ||
    end < 0 ||
    body.slice(end + "\nroc:execution -->".length).trim()
  )
    throw new Error("Invalid Roc execution checkpoint");
  return ExecutionRecordSchema.parse(
    JSON.parse(body.slice(start + marker.length, end)),
  );
}

/** Maps the authoritative phase onto a non-authoritative GitHub status label. */
function statusLabel(phase: ExecutionRecord["phase"]): string {
  if (phase === "done") return "roc:done";
  if (phase === "awaiting_merge") return "roc:awaiting-merge";
  if (phase === "failed_infra") return "roc:failed";
  if (["needs_input", "needs_replan", "rejected", "retired"].includes(phase))
    return "roc:attention";
  return "roc:running";
}

/** Stores all task checkpoints in daemon-owned GitHub comments, without a local task database. */
export class GitHubExecutionStore {
  /** Binds remote state to one repository, daemon identity and publisher allowlist. */
  constructor(
    readonly repository: string,
    readonly daemonLogin: string,
    readonly publishers: ReadonlySet<string>,
    private readonly api: IssueAccess,
  ) {}

  /** Validates all complete remote plans while isolating malformed Issues. */
  async list(): Promise<{ tasks: NativeTask[]; diagnostics: string[] }> {
    const tasks: NativeTask[] = [];
    const diagnostics: string[] = [];
    for (const issue of await this.api.read(this.repository)) {
      try {
        tasks.push(this.decode(issue));
      } catch {
        diagnostics.push(
          `Issue #${issue.number} has an invalid task or execution record`,
        );
      }
    }
    const groups = new Map<string, NativeTask[]>();
    for (const task of tasks)
      groups.set(task.envelope.planId, [
        ...(groups.get(task.envelope.planId) ?? []),
        task,
      ]);
    for (const group of groups.values()) {
      try {
        const first = group[0];
        if (!first) continue;
        const manifest = {
          cycleId: first.envelope.cycleId,
          goal: first.envelope.goal,
          tasks: group.map((task) => task.envelope.task),
        };
        if (
          remotePlanId(manifest) !== first.envelope.planId ||
          group.some(
            (task) =>
              task.envelope.cycleId !== manifest.cycleId ||
              task.envelope.goal !== manifest.goal,
          )
        )
          throw Error("Plan changed");
        const visiting = new Set<string>();
        const visited = new Set<string>();
        const byId = new Map(
          group.map((task) => [task.envelope.task.id, task]),
        );
        /** Verifies that every dependency exists and the plan contains no cycle. */
        function visit(id: string): void {
          if (visited.has(id)) return;
          const task = byId.get(id);
          if (!task || visiting.has(id))
            throw Error("Invalid dependency graph");
          visiting.add(id);
          for (const dependency of task.envelope.task.spec.dependencies)
            visit(dependency);
          visiting.delete(id);
          visited.add(id);
        }
        for (const task of group) visit(task.envelope.task.id);
      } catch {
        for (const task of group) {
          task.blockedReason = "Remote plan is incomplete, changed or cyclic";
          task.task.status = "needs_input";
        }
      }
    }
    return {
      tasks: tasks.sort(
        (a, b) =>
          a.task.priority - b.task.priority || a.issue.number - b.issue.number,
      ),
      diagnostics,
    };
  }

  /** Refreshes one Issue before a role boundary or checkpoint mutation. */
  async get(number: number): Promise<NativeTask> {
    return this.decode(await this.api.get(this.repository, number));
  }

  /** Saves a checkpoint only after reading back its exact content, including lost responses. */
  async save(task: NativeTask, input: ExecutionRecord): Promise<void> {
    const record = ExecutionRecordSchema.parse(input);
    const fresh = await this.get(task.issue.number);
    if (
      record.issueNumber !== fresh.issue.number ||
      record.specHash !== jsonHash(fresh.envelope) ||
      record.specHash !== jsonHash(task.envelope)
    )
      throw new Error(
        "Task specification changed before checkpoint publication",
      );
    if (fresh.execution && jsonHash(fresh.execution) === jsonHash(record))
      return;
    if (
      record.revision !== (fresh.execution ? fresh.execution.revision + 1 : 0)
    )
      throw new Error("Remote checkpoint revision changed");
    if (fresh.execution && record.phase !== fresh.execution.phase)
      assertTransition(fresh.execution.phase, record.phase);
    if (
      !fresh.execution &&
      (!fresh.approved ||
        !fresh.issue.labels.some((label) => label.name === "roc:ready"))
    )
      throw new Error("Issue is not approved and ready");
    try {
      await this.api.writeComment(
        this.repository,
        task.issue.number,
        renderExecution(record),
        fresh.commentId,
      );
    } catch {
      // A failed response can follow a successful remote write; read before retrying.
    }
    let confirmed: NativeTask;
    try {
      confirmed = await this.get(task.issue.number);
    } catch {
      throw this.unconfirmed();
    }
    if (
      !confirmed.execution ||
      jsonHash(confirmed.execution) !== jsonHash(record)
    )
      throw this.unconfirmed();
    await this.syncLabels(confirmed).catch(() => undefined);
  }

  /** Repairs the readable status label from the confirmed checkpoint without replaying work. */
  async syncLabels(task: NativeTask): Promise<void> {
    const label = statusLabel(task.task.status);
    if (
      task.execution &&
      !task.issue.labels.some((item) => item.name === label)
    ) {
      await this.api.setStatusLabel(this.repository, task.issue.number, label);
    }
  }

  /** Checks a hook-specific approval without treating ticket approval as command trust. */
  hookTrusted(task: NativeTask, phase: "prehook" | "posthook"): boolean {
    const hook = task.envelope.task.spec[phase];
    if (!hook) return true;
    const expected = `<!-- roc:hook-trust ${jsonHash({ phase, hook })} -->`;
    return task.issue.comments.some(
      (comment) =>
        this.publishers.has(comment.author?.login ?? "") &&
        comment.body.trim() === expected,
    );
  }

  /** Builds a validated task view from the approved envelope and one owned checkpoint. */
  private decode(issue: RemoteIssue): NativeTask {
    if (!issue.labels.some((label) => label.name === "roc:task"))
      throw Error("Not a managed Issue");
    const envelope = parseRemoteTaskEnvelope(issue.body);
    const hash = jsonHash(envelope);
    const approved = issue.comments.some((comment) => {
      if (!this.publishers.has(comment.author?.login ?? "")) return false;
      try {
        return parseRemoteTaskApproval(comment.body)?.hash === hash;
      } catch {
        return false;
      }
    });
    const owned = issue.comments.filter(
      (comment) =>
        comment.author?.login === this.daemonLogin &&
        comment.body.includes(marker),
    );
    if (owned.length > 1) throw Error("Conflicting owned checkpoints");
    const comment = owned[0];
    const execution = comment ? parseExecution(comment.body) : undefined;
    if (execution && execution.issueNumber !== issue.number)
      throw Error("Checkpoint belongs to another Issue");
    if (
      execution?.attempts.some(
        (attempt) =>
          attempt.descriptor.taskId !== `issue-${issue.number}` ||
          (attempt.output && attempt.output.kind !== attempt.descriptor.role),
      )
    )
      throw Error("Checkpoint attempt belongs to another task or role");
    const legacy =
      !execution &&
      issue.comments.some(
        (comment) =>
          comment.author?.login === this.daemonLogin &&
          comment.body.includes("<!-- roc:status "),
      );
    const blockedReason = legacy
      ? "Legacy SQLite execution requires explicit migration"
      : execution?.specHash !== undefined && execution.specHash !== hash
        ? "Approved specification changed; execution requires replan"
        : !approved
          ? "Trusted approval is missing or withdrawn"
          : undefined;
    const phase = blockedReason
      ? execution
        ? "needs_replan"
        : "needs_input"
      : (execution?.phase ??
        (issue.labels.some((label) => label.name === "roc:ready")
          ? "ready"
          : "draft"));
    const task = StoredTaskSchema.parse({
      id: `issue-${issue.number}`,
      cycleId: envelope.cycleId,
      title: envelope.task.title,
      spec: envelope.task.spec,
      priority: envelope.task.priority,
      approvalRequired: true,
      approved,
      status: issue.state === "CLOSED" && phase !== "done" ? "retired" : phase,
      ...(execution ? { baseCommit: execution.baseCommit } : {}),
    });
    return {
      issue,
      envelope,
      task,
      approved,
      execution,
      commentId: comment?.databaseId,
      blockedReason,
    };
  }

  /** Marks an unknown write outcome so runtime ownership remains retained for recovery. */
  private unconfirmed(): AgileError {
    return new AgileError({
      code: "GITHUB_CHECKPOINT_UNCONFIRMED",
      category: "infra",
      retryable: false,
      component: "github-state",
      message:
        "GitHub checkpoint write could not be confirmed; reconcile it before restarting work",
    });
  }
}
