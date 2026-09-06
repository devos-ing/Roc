import { z } from "zod";
import { type BacklogManifest, BacklogManifestSchema } from "../domain/schemas";
import type { PlanningRepository } from "../store/planning-repository";
import type {
  RemoteTaskRecord,
  RemoteTaskRepository,
} from "../store/remote-task-repository";
import type { GitHubCommandRunner } from "./pr-publisher";
import {
  jsonHash,
  parseRemoteTaskApproval,
  parseRemoteTaskEnvelope,
  REMOTE_READY_LABEL,
  type RemoteTaskEnvelope,
  remotePlanId,
} from "./remote-tasks";

const NonEmpty = z.string().trim().min(1);
const RemoteIssueBaseSchema = z
  .object({
    number: z.number().int().positive(),
    title: NonEmpty,
    body: z.string(),
    url: NonEmpty,
    state: z.enum(["OPEN", "CLOSED"]),
    labels: z.array(z.object({ name: NonEmpty }).passthrough()),
  })
  .passthrough();
const RemoteIssueSchema = RemoteIssueBaseSchema.extend({
  comments: z.array(
    z
      .object({
        body: z.string(),
        author: z.object({ login: NonEmpty }).nullable(),
        databaseId: z.number().int().positive(),
      })
      .passthrough(),
  ),
});
const RestCommentSchema = z
  .object({
    id: z.number().int().positive(),
    body: z.string(),
    user: z.object({ login: NonEmpty }),
  })
  .passthrough();

export type RemoteIssue = z.infer<typeof RemoteIssueSchema>;
export type RemotePollResult = {
  imported: number;
  tracked: number;
  errors: string[];
};

/** Drives bounded remote polling without allowing outages to advance idle work. */
export class RemoteSchedulerSource {
  private nextPollAt = 0;
  private retryDelayMs = 1_000;
  private hadRunningAttempt = false;
  private available = false;

  /** Connects one validated source to scheduler boundary and retry timing. */
  constructor(
    private readonly source: Pick<GitHubRemoteTaskSource, "poll">,
    private readonly running: { getRunningAttempt(): unknown },
    private readonly now: () => number = Date.now,
    private readonly onDiagnostic: (
      kind: "validation" | "network",
      error: unknown,
    ) => void | Promise<void> = () => {},
    private readonly sync: () => Promise<void> = async () => {},
  ) {}

  /** Refreshes remote authority when due and gates advancement during network failure. */
  async beforeTick(): Promise<boolean> {
    const running = this.running.getRunningAttempt() !== undefined;
    const crossedBoundary = this.hadRunningAttempt && !running;
    this.hadRunningAttempt = running;
    const timestamp = this.now();
    if (!crossedBoundary && timestamp < this.nextPollAt) {
      return this.available || running;
    }
    try {
      const result = await this.source.poll();
      for (const error of result.errors) {
        await this.onDiagnostic("validation", error);
      }
      this.available = true;
      this.retryDelayMs = 1_000;
      this.nextPollAt = timestamp + 30_000;
      return true;
    } catch (error) {
      this.available = false;
      await this.onDiagnostic("network", error);
      this.nextPollAt = timestamp + this.retryDelayMs;
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, 300_000);
      return running;
    }
  }

  /** Projects durable state while containing writeback failures to synchronization. */
  async afterTick(): Promise<void> {
    try {
      await this.sync();
    } catch (error) {
      await this.onDiagnostic("network", error);
    }
  }
}

/** Parses a comma-separated allowlist while rejecting an unsafe empty configuration. */
export function trustedGitHubPublishers(
  value: string | undefined,
): Set<string> {
  const publishers = new Set(
    (value ?? "")
      .split(",")
      .map((publisher) => publisher.trim())
      .filter(Boolean),
  );
  if (publishers.size === 0) {
    throw new Error(
      "ROC_GITHUB_PUBLISHERS must name at least one trusted GitHub login",
    );
  }
  return publishers;
}

/** Reads managed remote Issues through explicit bounded gh commands. */
export class GitHubRemoteIssueReader {
  /** Connects Issue reads to one checkout and argv-only runner. */
  constructor(
    private readonly cwd: string,
    private readonly runner: GitHubCommandRunner,
  ) {}

  /** Resolves the repository selected by the configured checkout. */
  async repository(): Promise<string> {
    return (
      await this.mustRun([
        "gh",
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
      ])
    ).trim();
  }

  /** Resolves the authenticated GitHub login that owns Roc status comments. */
  async authenticatedLogin(): Promise<string> {
    return (await this.mustRun(["gh", "api", "user", "--jq", ".login"])).trim();
  }

  /** Lists managed active and completed Issues independently of their ready label. */
  async read(repository: string): Promise<RemoteIssue[]> {
    const output = await this.mustRun([
      "gh",
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--label",
      "roc:task",
      "--limit",
      "1000",
      "--json",
      "number,title,body,url,state,labels",
    ]);
    const baseIssues = z.array(RemoteIssueBaseSchema).parse(JSON.parse(output));
    const issues: RemoteIssue[] = [];
    for (const issue of baseIssues) {
      const commentOutput = await this.mustRun([
        "gh",
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/issues/${issue.number}/comments?per_page=100`,
      ]);
      const pages = z
        .array(z.array(RestCommentSchema))
        .parse(JSON.parse(commentOutput));
      issues.push(
        RemoteIssueSchema.parse({
          ...issue,
          comments: pages.flat().map((comment) => ({
            body: comment.body,
            author: { login: comment.user.login },
            databaseId: comment.id,
          })),
        }),
      );
    }
    if (issues.length >= 1000) {
      throw new Error("GitHub task source reached its 1000-Issue safety bound");
    }
    return issues;
  }

  /** Executes one GitHub read and converts failures into retryable source diagnostics. */
  private async mustRun(command: string[]): Promise<string> {
    const result = await this.runner.run({ command, cwd: this.cwd });
    if (result.exitCode === 0) return result.stdout;
    const diagnostic = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `GitHub task source unavailable${diagnostic === "" ? "" : `: ${diagnostic}`}`,
    );
  }
}

type ParsedIssue = {
  issue: RemoteIssue;
  envelope: RemoteTaskEnvelope;
  approvalAuthor?: string;
};

/** Validates remote plans and freezes eligible tasks into the local project database. */
export class GitHubRemoteTaskSource {
  /** Connects a remote reader to planning and synchronization persistence. */
  constructor(
    private readonly repositoryName: string,
    private readonly trustedPublishers: ReadonlySet<string>,
    private readonly planning: PlanningRepository,
    private readonly remote: RemoteTaskRepository,
    private readonly readIssues: () => Promise<RemoteIssue[]>,
  ) {}

  /** Polls all managed Issues while isolating validation failures by plan. */
  async poll(): Promise<RemotePollResult> {
    const issues = await this.readIssues();
    const errors: string[] = [];
    const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
    for (const record of this.remote.list()) {
      if (record.approvalHash === undefined) continue;
      const issue = issueByNumber.get(record.issueNumber);
      if (
        issue === undefined ||
        !remoteIssueStillApproved(issue, record, this.trustedPublishers)
      ) {
        this.remote.pauseTask(
          record.taskId,
          "needs_replan",
          issue === undefined
            ? "Managed GitHub Issue is no longer available"
            : "Remote task payload or trusted approval changed",
        );
      }
    }
    const parsed: ParsedIssue[] = [];
    for (const issue of issues) {
      try {
        const envelope = parseRemoteTaskEnvelope(issue.body);
        const approvalAuthor = this.approvalAuthor(issue, envelope);
        parsed.push({
          issue,
          envelope,
          ...(approvalAuthor === undefined ? {} : { approvalAuthor }),
        });
      } catch (error) {
        errors.push(this.issueError(issue.number, error));
      }
    }

    const identities = new Map<string, ParsedIssue[]>();
    for (const item of parsed) {
      const identity = `${item.envelope.planId}\u0000${item.envelope.task.id}`;
      const matches = identities.get(identity) ?? [];
      matches.push(item);
      identities.set(identity, matches);
    }
    const duplicates = new Set(
      [...identities]
        .filter(([, matches]) => matches.length > 1)
        .map(([identity]) => identity),
    );
    for (const identity of duplicates) {
      errors.push(
        `Conflicting duplicate remote task identity: ${identity.replace("\u0000", "/")}`,
      );
    }

    const plans = new Map<string, ParsedIssue[]>();
    for (const item of parsed) {
      const identity = `${item.envelope.planId}\u0000${item.envelope.task.id}`;
      if (duplicates.has(identity)) continue;
      const existing = this.remote.get(item.envelope.task.id);
      if (existing !== undefined && existing.approvalHash === undefined) {
        const exactDraft =
          existing.repository === this.repositoryName &&
          existing.planId === item.envelope.planId &&
          existing.issueNumber === item.issue.number &&
          existing.envelopeHash === jsonHash(item.envelope);
        if (!exactDraft) {
          errors.push(
            this.issueError(
              item.issue.number,
              new Error(
                `Remote follow-up identity conflicts with existing draft: ${item.envelope.task.id}`,
              ),
            ),
          );
          continue;
        }
        if (
          item.approvalAuthor !== undefined &&
          item.issue.state === "OPEN" &&
          item.issue.labels.some(
            (label) => label.name === REMOTE_READY_LABEL,
          ) &&
          jsonHash(item.envelope) === existing.envelopeHash
        ) {
          try {
            this.remote.approve(
              item.envelope.task.id,
              item.approvalAuthor,
              jsonHash(item.envelope),
            );
          } catch (error) {
            errors.push(this.issueError(item.issue.number, error));
          }
        }
        continue;
      }
      const tasks = plans.get(item.envelope.planId) ?? [];
      tasks.push(item);
      plans.set(item.envelope.planId, tasks);
    }

    let imported = 0;
    for (const [planId, tasks] of plans) {
      try {
        imported += this.admitPlan(planId, tasks);
      } catch (error) {
        errors.push(`Remote plan ${planId}: ${this.errorMessage(error)}`);
      }
    }
    return { imported, tracked: this.remote.list().length, errors };
  }

  /** Validates and atomically imports one complete same-cycle dependency graph. */
  private admitPlan(planId: string, parsed: ParsedIssue[]): number {
    const first = parsed[0];
    if (first === undefined) return 0;
    const tasksById = new Map(
      parsed.map((item) => [item.envelope.task.id, item]),
    );
    for (const item of parsed) {
      if (
        item.envelope.cycleId !== first.envelope.cycleId ||
        item.envelope.goal !== first.envelope.goal
      ) {
        throw new Error("tasks disagree on cycleId or goal");
      }
      for (const dependency of item.envelope.task.spec.dependencies) {
        if (!tasksById.has(dependency)) {
          throw new Error(`Missing task dependency: ${dependency}`);
        }
      }
      if (this.remote.get(item.envelope.task.id) === undefined) {
        if (item.issue.state !== "OPEN") {
          throw new Error(
            `Initial task Issue is closed: #${item.issue.number}`,
          );
        }
        if (
          !item.issue.labels.some((label) => label.name === REMOTE_READY_LABEL)
        ) {
          throw new Error(
            `Initial task Issue is not ready: #${item.issue.number}`,
          );
        }
        if (item.approvalAuthor === undefined) {
          throw new Error(
            `Initial task Issue lacks trusted approval: #${item.issue.number}`,
          );
        }
      }
    }
    this.assertAcyclic(tasksById);

    const manifest: BacklogManifest = BacklogManifestSchema.parse({
      cycleId: first.envelope.cycleId,
      goal: first.envelope.goal,
      tasks: parsed.map((item) => item.envelope.task),
    });
    if (remotePlanId(manifest) !== planId) {
      throw new Error("plan identity does not match its tasks");
    }
    const existingCycleGoal = this.planning.findCycleGoal(manifest.cycleId);
    if (
      existingCycleGoal !== undefined &&
      existingCycleGoal !== manifest.goal
    ) {
      throw new Error(
        `Existing cycle goal conflicts with remote plan: ${manifest.cycleId}`,
      );
    }
    const existingTaskIds = this.planning.findExistingTaskIds(
      parsed.map((item) => item.envelope.task.id),
    );
    for (const item of parsed) {
      const binding = this.remote.get(item.envelope.task.id);
      if (existingTaskIds.has(item.envelope.task.id) && binding === undefined) {
        throw new Error(
          `Local task ID is already in use: ${item.envelope.task.id}`,
        );
      }
      if (
        binding !== undefined &&
        (binding.repository !== this.repositoryName ||
          binding.planId !== planId ||
          binding.issueNumber !== item.issue.number ||
          binding.envelopeHash !== jsonHash(item.envelope))
      ) {
        throw new Error(`Remote task conflict: ${item.envelope.task.id}`);
      }
    }
    return this.remote.transaction(() => {
      const result = this.planning.importBacklog(manifest);
      for (const item of parsed) {
        this.remote.add({
          taskId: item.envelope.task.id,
          repository: this.repositoryName,
          planId,
          issueNumber: item.issue.number,
          issueUrl: item.issue.url,
          envelopeHash: jsonHash(item.envelope),
          approvalAuthor: item.approvalAuthor,
          approvalHash: jsonHash(item.envelope),
          remoteState: item.issue.state,
        });
        if (item.envelope.task.spec.contextCandidates.length > 0) {
          this.remote.pauseTask(
            item.envelope.task.id,
            "needs_input",
            "Remote workers cannot resolve machine-local context references",
          );
        }
      }
      return result.created;
    });
  }

  /** Finds a trusted comment approving the exact immutable envelope hash. */
  private approvalAuthor(
    issue: RemoteIssue,
    envelope: RemoteTaskEnvelope,
  ): string | undefined {
    const expectedHash = jsonHash(envelope);
    const author = issue.comments.find((comment) => {
      if (
        comment.author === null ||
        !this.trustedPublishers.has(comment.author.login)
      ) {
        return false;
      }
      try {
        return parseRemoteTaskApproval(comment.body)?.hash === expectedHash;
      } catch {
        return false;
      }
    })?.author?.login;
    return author;
  }

  /** Rejects cycles before any task in a remote plan becomes executable. */
  private assertAcyclic(tasks: ReadonlyMap<string, ParsedIssue>): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    /** Visits one task and rejects a dependency back-edge. */
    const visit = (taskId: string): void => {
      if (visiting.has(taskId))
        throw new Error(`Cyclic task dependency: ${taskId}`);
      if (visited.has(taskId)) return;
      visiting.add(taskId);
      for (const dependency of tasks.get(taskId)?.envelope.task.spec
        .dependencies ?? []) {
        visit(dependency);
      }
      visiting.delete(taskId);
      visited.add(taskId);
    };
    for (const taskId of tasks.keys()) visit(taskId);
  }

  /** Prefixes one malformed candidate with its stable Issue identity. */
  private issueError(issueNumber: number, error: unknown): string {
    return `GitHub Issue #${issueNumber}: ${this.errorMessage(error)}`;
  }

  /** Converts an unknown failure into a concise validation diagnostic. */
  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Compares a fetched Issue with the locally frozen approval and payload snapshot. */
export function remoteIssueStillApproved(
  issue: RemoteIssue,
  record: RemoteTaskRecord,
  trustedPublishers: ReadonlySet<string>,
): boolean {
  try {
    if (record.approvalHash === undefined) return false;
    const envelope = parseRemoteTaskEnvelope(issue.body);
    if (jsonHash(envelope) !== record.envelopeHash) return false;
    return issue.comments.some((comment) => {
      const author = comment.author?.login;
      if (author === undefined || !trustedPublishers.has(author)) return false;
      try {
        return (
          parseRemoteTaskApproval(comment.body)?.hash === record.approvalHash
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
