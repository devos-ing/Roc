import { z } from "zod";
import { AgileError } from "../runtime/errors";
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
const RestCommentSchema = z
  .object({
    id: z.number().int().positive(),
    body: z.string(),
    user: z.object({ login: NonEmpty }),
  })
  .passthrough();

export type RemoteIssue = z.infer<typeof RemoteIssueSchema>;
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

  /** Reads one Issue and its complete comment history for a role boundary. */
  async get(repository: string, number: number): Promise<RemoteIssue> {
    const issue = RemoteIssueBaseSchema.parse(
      JSON.parse(
        await this.mustRun([
          "gh",
          "issue",
          "view",
          String(number),
          "--repo",
          repository,
          "--json",
          "number,title,body,url,state,labels",
        ]),
      ),
    );
    const pages = z
      .array(z.array(RestCommentSchema))
      .parse(
        JSON.parse(
          await this.mustRun([
            "gh",
            "api",
            "--paginate",
            "--slurp",
            `repos/${repository}/issues/${number}/comments?per_page=100`,
          ]),
        ),
      );
    return {
      ...issue,
      comments: pages.flat().map((comment) => ({
        body: comment.body,
        author: { login: comment.user.login },
        databaseId: comment.id,
      })),
    };
  }

  /** Writes one checkpoint without interpreting an uncertain response as success. */
  async writeComment(
    repository: string,
    number: number,
    body: string,
    commentId?: number,
  ): Promise<void> {
    await withGitHubBodyFile(JSON.stringify({ body }), (path) =>
      this.mustRun([
        "gh",
        "api",
        "--method",
        commentId === undefined ? "POST" : "PATCH",
        commentId === undefined
          ? `repos/${repository}/issues/${number}/comments`
          : `repos/${repository}/issues/comments/${commentId}`,
        "--input",
        path,
      ]),
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
    await this.mustRun([
      "gh",
      "label",
      "create",
      label,
      "--repo",
      repository,
      "--color",
      "5319E7",
      "--force",
    ]);
    const remove = issue.labels
      .filter((item) => owned.has(item.name) && item.name !== label)
      .flatMap((item) => ["--remove-label", item.name]);
    await this.mustRun([
      "gh",
      "issue",
      "edit",
      String(number),
      "--repo",
      repository,
      "--add-label",
      label,
      ...remove,
    ]);
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

  /** Executes a GitHub operation and exposes safe read/write diagnostics without raw CLI output. */
  private async mustRun(command: string[]): Promise<string> {
    const write =
      command.includes("--method") ||
      command[1] === "label" ||
      command[2] === "edit";
    let status: string | undefined;
    let cause: unknown;
    try {
      const result = await this.runner.run({ command, cwd: this.cwd });
      if (result.exitCode === 0) return result.stdout;
      status = result.stderr.match(/HTTP (\d{3})\b/u)?.[1];
    } catch (error) {
      cause = error;
    }
    throw new AgileError({
      code: write ? "GITHUB_WRITE_FAILED" : "GITHUB_READ_FAILED",
      category: "infra",
      component: "github-state",
      retryable: !write && status !== "401" && status !== "403",
      message: `GitHub task ${write ? "write" : "read"} failed${status ? ` (HTTP ${status})` : ""}; check connection, authentication and repository access${write ? "; reconcile the remote result before retrying" : ""}`,
      cause,
    });
  }
}
