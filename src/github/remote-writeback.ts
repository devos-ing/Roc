import type { TaskStatus } from "../domain/schemas";
import type {
  RemoteFollowUpDraft,
  RemoteTaskProjection,
  RemoteTaskRepository,
} from "../store/remote-task-repository";
import type { GitHubCommandRunner } from "./pr-publisher";
import type { RemoteIssue } from "./remote-source";
import {
  jsonHash,
  parseRemoteTaskEnvelope,
  remoteTaskEnvelope,
  renderRemoteTaskBody,
  withGitHubBodyFile,
} from "./remote-tasks";

const statusLabels = [
  "roc:draft",
  "roc:ready",
  "roc:running",
  "roc:done",
  "roc:attention",
  "roc:failed",
  "roc:retired",
] as const;

/** Maps one local lifecycle phase to its single Roc-owned status label. */
export function remoteStatusLabel(
  status: TaskStatus,
): (typeof statusLabels)[number] {
  if (status === "draft") return "roc:draft";
  if (status === "ready") return "roc:ready";
  if (
    status === "claimed" ||
    status === "scouting" ||
    status === "implementing" ||
    status === "reviewing" ||
    status === "publishing"
  ) {
    return "roc:running";
  }
  if (status === "done") return "roc:done";
  if (status === "needs_input" || status === "needs_replan") {
    return "roc:attention";
  }
  if (status === "retired") return "roc:retired";
  return "roc:failed";
}

/** Redacts common credential forms and machine-local paths from remote diagnostics. */
export function sanitizeRemoteDiagnostic(value: string): string {
  return value
    .replace(
      /\bAuthorization\s*:\s*Bearer\s+\S+/giu,
      "Authorization: Bearer [redacted]",
    )
    .replace(
      /\b(token|password|secret|api[_-]?key)\s*[:=]\s*\S+/giu,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/giu, "https://[redacted]@")
    .replace(/\/(?:Users|home)\/[^\s]+/gu, "[local-path]")
    .slice(0, 1000);
}

/** Renders the stable Roc-owned status comment for one frozen remote task. */
export function renderRemoteStatus(projection: RemoteTaskProjection): string {
  const lines = [
    `<!-- roc:status task=${encodeURIComponent(projection.taskId)} -->`,
    "## Roc worker status",
    `- Task: ${projection.taskId}`,
    `- Phase/outcome: ${projection.status}`,
    `- Last local update: ${projection.updatedAt}`,
  ];
  if (projection.status === "done") {
    lines.push(
      projection.pullRequestState === "MERGED"
        ? "- Result: execution complete; dependency merge confirmed"
        : "- Result: execution complete, awaiting merge",
    );
  }
  if (projection.summary !== undefined) {
    lines.push(
      `- Blocker/failure: ${sanitizeRemoteDiagnostic(projection.summary)}`,
    );
  }
  if (projection.pullRequestUrl !== undefined) {
    lines.push(`- Pull request: ${projection.pullRequestUrl}`);
  }
  if (projection.followUpUrl !== undefined) {
    lines.push(`- Follow-up: ${projection.followUpUrl}`);
  }
  return lines.join("\n");
}

/** Publishes pending follow-ups and projects durable local state onto managed Issues. */
export class GitHubRemoteTaskWriter {
  private labelsReady = false;

  /** Connects writeback to one repository, database, reader, and argv-only runner. */
  constructor(
    private readonly cwd: string,
    private readonly repositoryName: string,
    private readonly workerLogin: string,
    private readonly remote: RemoteTaskRepository,
    private readonly readIssues: () => Promise<RemoteIssue[]>,
    private readonly runner: GitHubCommandRunner,
  ) {}

  /** Retries only pending synchronization work after local outcomes are durable. */
  async sync(): Promise<void> {
    await this.ensureLabels();
    await this.publishFollowUps();
    for (const projection of this.remote.pendingProjections()) {
      try {
        await this.syncProjection(projection);
      } catch (error) {
        this.remote.syncFailed(
          projection.taskId,
          sanitizeRemoteDiagnostic(
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }

  /** Publishes each existing local follow-up once without granting execution approval. */
  private async publishFollowUps(): Promise<void> {
    for (const draft of this.remote.listUnpublishedFollowUps()) {
      try {
        await this.publishFollowUp(draft);
      } catch (error) {
        this.remote.syncFailed(
          draft.parentTaskId,
          sanitizeRemoteDiagnostic(
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }

  /** Reconciles one draft child by its stable envelope identity before creating it. */
  private async publishFollowUp(draft: RemoteFollowUpDraft): Promise<void> {
    const manifest = {
      cycleId: draft.cycleId,
      goal: draft.goal,
      tasks: [draft.task],
    };
    const envelope = remoteTaskEnvelope(manifest, draft.task.id);
    const rendered = renderRemoteTaskBody(envelope);
    const body = rendered.replace(
      "\n<!-- roc:task-envelope\n",
      `\nSource rejected task: #${draft.parentIssueNumber}\n\n<!-- roc:task-envelope\n`,
    );
    let issues = await this.readIssues();
    let matches = issues.filter((issue) => {
      try {
        const candidate = parseRemoteTaskEnvelope(issue.body);
        return (
          candidate.planId === envelope.planId &&
          candidate.task.id === draft.task.id
        );
      } catch {
        return false;
      }
    });
    if (matches.length > 1) {
      throw new Error(
        `Conflicting remote follow-up identity: ${draft.task.id}`,
      );
    }
    if (matches.length === 0) {
      await withGitHubBodyFile(body, (path) =>
        this.run([
          "gh",
          "issue",
          "create",
          "--repo",
          this.repositoryName,
          "--title",
          draft.task.title,
          "--body-file",
          path,
          "--label",
          "roc:task,roc:draft",
        ]),
      );
      issues = await this.readIssues();
      matches = issues.filter((issue) => {
        try {
          const candidate = parseRemoteTaskEnvelope(issue.body);
          return (
            candidate.planId === envelope.planId &&
            candidate.task.id === draft.task.id
          );
        } catch {
          return false;
        }
      });
    }
    const issue = matches[0];
    if (matches.length !== 1 || issue === undefined) {
      throw new Error(
        `Remote follow-up creation outcome is ambiguous: ${draft.task.id}`,
      );
    }
    this.remote.add({
      taskId: draft.task.id,
      repository: this.repositoryName,
      planId: envelope.planId,
      issueNumber: issue.number,
      issueUrl: issue.url,
      envelopeHash: jsonHash(envelope),
      remoteState: issue.state,
    });
  }

  /** Replaces only Roc status labels and the one stable Roc status comment. */
  private async syncProjection(
    projection: RemoteTaskProjection,
  ): Promise<void> {
    const targetLabel = remoteStatusLabel(projection.status);
    for (const label of statusLabels) {
      if (label === targetLabel) continue;
      const result = await this.run([
        "gh",
        "issue",
        "edit",
        String(projection.issueNumber),
        "--repo",
        this.repositoryName,
        "--remove-label",
        label,
      ]);
      if (result.exitCode !== 0 && !result.stderr.includes("not found")) {
        throw new Error(
          `Could not remove remote task status label: ${result.stderr}`,
        );
      }
    }
    await this.mustRun([
      "gh",
      "issue",
      "edit",
      String(projection.issueNumber),
      "--repo",
      this.repositoryName,
      "--add-label",
      targetLabel,
    ]);

    const body = renderRemoteStatus(projection);
    let commentId = projection.statusCommentId;
    if (commentId === undefined) {
      const issue = (await this.readIssues()).find(
        (candidate) => candidate.number === projection.issueNumber,
      );
      const owned = issue?.comments.filter(
        (comment) =>
          comment.author?.login === this.workerLogin &&
          comment.body.includes(
            `<!-- roc:status task=${encodeURIComponent(projection.taskId)} -->`,
          ),
      );
      if ((owned?.length ?? 0) > 1) {
        throw new Error(
          `Multiple Roc-owned status comments exist for ${projection.taskId}`,
        );
      }
      commentId = owned?.[0]?.databaseId;
    }
    if (commentId === undefined) {
      await withGitHubBodyFile(body, (path) =>
        this.mustRun([
          "gh",
          "issue",
          "comment",
          String(projection.issueNumber),
          "--repo",
          this.repositoryName,
          "--body-file",
          path,
        ]),
      );
      const issue = (await this.readIssues()).find(
        (candidate) => candidate.number === projection.issueNumber,
      );
      const owned = issue?.comments.filter(
        (comment) =>
          comment.author?.login === this.workerLogin &&
          comment.body.includes(
            `<!-- roc:status task=${encodeURIComponent(projection.taskId)} -->`,
          ),
      );
      if ((owned?.length ?? 0) > 1) {
        throw new Error(
          `Multiple Roc-owned status comments exist for ${projection.taskId}`,
        );
      }
      commentId = owned?.[0]?.databaseId;
    } else {
      await withGitHubBodyFile(JSON.stringify({ body }), (path) =>
        this.mustRun([
          "gh",
          "api",
          "--method",
          "PATCH",
          `repos/${this.repositoryName}/issues/comments/${commentId}`,
          "--input",
          path,
        ]),
      );
    }
    if (commentId === undefined) {
      throw new Error(
        `GitHub did not return the Roc status comment for ${projection.taskId}`,
      );
    }
    this.remote.synced(
      projection.taskId,
      commentId,
      projection.updatedAt,
      projection.status,
    );
  }

  /** Creates every Roc-owned status label once per writer session. */
  private async ensureLabels(): Promise<void> {
    if (this.labelsReady) return;
    for (const label of statusLabels) {
      await this.mustRun([
        "gh",
        "label",
        "create",
        label,
        "--repo",
        this.repositoryName,
        "--color",
        "5319E7",
        "--force",
      ]);
    }
    this.labelsReady = true;
  }

  /** Runs one writeback command for reconciliation-aware error handling. */
  private run(command: string[]) {
    return this.runner.run({ command, cwd: this.cwd });
  }

  /** Requires one writeback command to complete successfully. */
  private async mustRun(command: string[]): Promise<string> {
    const result = await this.run(command);
    if (result.exitCode === 0) return result.stdout;
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "GitHub writeback failed",
    );
  }
}
