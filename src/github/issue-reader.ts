import { z } from "zod";
import { AgileError } from "../runtime/errors";
import { GitHubGraphQLReader } from "./graphql-reader";
import type { GitHubCommandRunner } from "./pr-publisher";
import { withGitHubBodyFile } from "./remote-tasks";

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
export type RemoteIssue = z.infer<typeof RemoteIssueSchema>;

type GitHubOperation =
  | "repository-lookup"
  | "authenticated-login"
  | "issue-read"
  | "issue-comments-read"
  | "issue-list-read"
  | "comment-write"
  | "label-create"
  | "issue-label-write"
  | "issue-close";

const GitHubOperationNames: Record<GitHubOperation, string> = {
  "repository-lookup": "repository lookup",
  "authenticated-login": "authenticated login",
  "issue-read": "Issue read",
  "issue-comments-read": "Issue comment read",
  "issue-list-read": "Issue list",
  "comment-write": "comment write",
  "label-create": "label create",
  "issue-label-write": "Issue label update",
  "issue-close": "Issue close",
};

/** Returns a safe allowlisted category for a failed GitHub command result. */
function failureCategory(exitCode: number, status: string | undefined): string {
  if (exitCode === 124) return "timeout";
  if (status !== undefined) return `HTTP ${status}`;
  return `exit ${exitCode}`;
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
  ) {
    this.graphql = new GitHubGraphQLReader(cwd, runner);
  }
  private readonly graphql: GitHubGraphQLReader;

  /** Resolves the repository selected by the configured checkout. */
  async repository(signal?: AbortSignal): Promise<string> {
    return (
      await this.mustRun(
        [
          "gh",
          "repo",
          "view",
          "--json",
          "nameWithOwner",
          "--jq",
          ".nameWithOwner",
        ],
        "repository-lookup",
        signal,
      )
    ).trim();
  }

  /** Resolves the authenticated GitHub login that owns Roc status comments. */
  async authenticatedLogin(signal?: AbortSignal): Promise<string> {
    return (
      await this.mustRun(
        ["gh", "api", "user", "--jq", ".login"],
        "authenticated-login",
        signal,
      )
    ).trim();
  }

  /** Reads one Issue and its complete comment history for a role boundary. */
  async get(
    repository: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<RemoteIssue> {
    const issues = await this.graphql.getMany(repository, [number], signal);
    return RemoteIssueSchema.parse(issues[0]);
  }

  /** Reads a complete known plan with validated numbers and bounded GraphQL batches. */
  async getMany(
    repository: string,
    numbers: readonly number[],
    signal?: AbortSignal,
  ): Promise<RemoteIssue[]> {
    return this.graphql.getMany(repository, numbers, signal);
  }

  /** Closes an open Issue as completed, reconciling uncertain writes without changing closed reasons. */
  async closeCompleted(repository: string, number: number): Promise<void> {
    if ((await this.get(repository, number)).state === "CLOSED") return;
    try {
      await this.mustRun(
        [
          "gh",
          "issue",
          "close",
          String(number),
          "--repo",
          repository,
          "--reason",
          "completed",
        ],
        "issue-close",
      );
    } catch {
      // The server may have applied a write whose response was lost.
    }
    if ((await this.get(repository, number)).state !== "CLOSED")
      throw new AgileError({
        code: "GITHUB_ISSUE_CLOSE_PENDING",
        category: "infra",
        component: "github-state",
        retryable: true,
        message:
          "Issue closure is pending; check repository write access and retry polling",
      });
  }

  /** Writes one checkpoint without interpreting an uncertain response as success. */
  async writeComment(
    repository: string,
    number: number,
    body: string,
    commentId?: number,
  ): Promise<void> {
    await withGitHubBodyFile(JSON.stringify({ body }), (path) =>
      this.mustRun(
        [
          "gh",
          "api",
          "--method",
          commentId === undefined ? "POST" : "PATCH",
          commentId === undefined
            ? `repos/${repository}/issues/${number}/comments`
            : `repos/${repository}/issues/comments/${commentId}`,
          "--input",
          path,
        ],
        "comment-write",
      ),
    );
  }

  /** Updates only Roc lifecycle labels, leaving human labels and comments intact. */
  async setStatusLabel(
    repository: string,
    number: number,
    label: string,
  ): Promise<void> {
    const issue = await this.get(repository, number);
    const owned = new Set([
      "roc:ready",
      "roc:running",
      "roc:attention",
      "roc:failed",
      "roc:done",
      "roc:awaiting-merge",
    ]);
    await this.mustRun(
      [
        "gh",
        "label",
        "create",
        label,
        "--repo",
        repository,
        "--color",
        "5319E7",
        "--force",
      ],
      "label-create",
    );
    const remove = issue.labels
      .filter((item) => owned.has(item.name) && item.name !== label)
      .flatMap((item) => ["--remove-label", item.name]);
    await this.mustRun(
      [
        "gh",
        "issue",
        "edit",
        String(number),
        "--repo",
        repository,
        "--add-label",
        label,
        ...remove,
      ],
      "issue-label-write",
    );
  }

  /** Lists managed active and completed Issues independently of their ready label. */
  async read(repository: string, signal?: AbortSignal): Promise<RemoteIssue[]> {
    return this.graphql.read(repository, signal);
  }

  /** Executes a GitHub operation and exposes safe read/write diagnostics without raw CLI output. */
  private async mustRun(
    command: string[],
    operation: GitHubOperation,
    signal?: AbortSignal,
  ): Promise<string> {
    const write =
      command.includes("--method") ||
      command[1] === "label" ||
      command[2] === "edit" ||
      command[2] === "close";
    let category = "runner or process-start failure";
    let status: string | undefined;
    let cause: unknown;
    try {
      const result = await this.runner.run({ command, cwd: this.cwd, signal });
      if (result.exitCode === 0) return result.stdout;
      status = result.stderr.match(/HTTP (\d{3})\b/u)?.[1];
      category = failureCategory(result.exitCode, status);
    } catch (error) {
      cause = error;
    }
    throw new AgileError({
      code: write ? "GITHUB_WRITE_FAILED" : "GITHUB_READ_FAILED",
      category: "infra",
      component: "github-state",
      retryable: !write && status !== "401" && status !== "403",
      message: `GitHub task ${write ? "write" : "read"} failed (${GitHubOperationNames[operation]}; ${category}); check connection, authentication and repository access${write ? "; reconcile the remote result before retrying" : ""}`,
      cause,
    });
  }
}
