import { z } from "zod";
import type { StoredTask } from "../domain/schemas";
import type { ImplementOutput } from "../harness/contracts";
import type { TaskPublicationRecord } from "../store/orchestration-repository";
import type { TaskBranchManager } from "../workspace/task-branch";

const NonEmpty = z.string().trim().min(1);
const PullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    url: NonEmpty,
    state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  })
  .strict();

/** Describes the remote pull request that safely represents a published task branch. */
export type PullRequest = z.infer<typeof PullRequestSchema>;

/** Supplies the task state needed to publish or reconcile one pull request. */
export type PublishTaskInput = {
  task: StoredTask;
  implementation: ImplementOutput;
  publication: TaskPublicationRecord;
};

/** Publishes a prepared task branch to its configured GitHub base branch. */
export type TaskPublisher = {
  baseBranch: string;
  publish(input: PublishTaskInput): Promise<PullRequest>;
};

/** Verifies that GitHub access is ready before a real scheduler starts work. */
export type GitHubPreflight = { assertReady(): Promise<void> };

/** Runs one argv-only command and preserves its bounded textual diagnostics. */
export type GitHubCommandRunner = {
  run(input: { command: string[]; cwd: string }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
};

/** Signals an unavailable GitHub prerequisite or unrecoverable publication result. */
export class GitHubPublicationError extends Error {
  /** Creates a classified GitHub publication failure with useful operator diagnostics. */
  constructor(message: string) {
    super(message);
    this.name = "GitHubPublicationError";
  }
}

/** Executes GitHub and Git commands without a shell. */
export class BunGitHubCommandRunner implements GitHubCommandRunner {
  /** Runs one command in its repository workspace and collects its complete output. */
  async run(input: {
    command: string[];
    cwd: string;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const process = Bun.spawn({
      cmd: input.command,
      cwd: input.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }
}

/** Throws a stable error when a command does not complete successfully. */
async function mustRun(
  runner: GitHubCommandRunner,
  command: string[],
  cwd: string,
): Promise<string> {
  const result = await runner.run({ command, cwd });
  if (result.exitCode === 0) return result.stdout.trim();
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  throw new GitHubPublicationError(
    `${command[0] ?? "command"} failed${diagnostic === "" ? "" : `: ${diagnostic}`}`,
  );
}

/** Rejects local refs that cannot safely name a GitHub pull-request base branch. */
function assertBaseBranch(baseBranch: string): void {
  if (
    baseBranch === "" ||
    baseBranch === "HEAD" ||
    baseBranch.trim() !== baseBranch ||
    ["~", "^", ":", "?", "*", "\\", "[", "]"].some((character) =>
      baseBranch.includes(character),
    ) ||
    baseBranch.startsWith("-")
  ) {
    throw new GitHubPublicationError(
      `GitHub base branch must be an explicit branch name, not ${baseBranch}`,
    );
  }
}

/** Finds the single matching pull request for a task branch and configured base. */
async function matchingPullRequest(
  runner: GitHubCommandRunner,
  cwd: string,
  branch: string,
  baseBranch: string,
): Promise<PullRequest | undefined> {
  const output = await mustRun(
    runner,
    [
      "gh",
      "pr",
      "list",
      "--head",
      branch,
      "--base",
      baseBranch,
      "--state",
      "all",
      "--json",
      "number,url,state",
    ],
    cwd,
  );
  const pullRequests = z.array(PullRequestSchema).parse(JSON.parse(output));
  if (pullRequests.length > 1) {
    throw new GitHubPublicationError(
      `Multiple pull requests exist for ${branch} into ${baseBranch}`,
    );
  }
  return pullRequests[0];
}

/** Renders the durable Implement output as the standard pull-request body. */
function pullRequestBody(input: PublishTaskInput): string {
  const lines = [
    "## Task",
    input.task.title,
    "",
    "## Validation",
    ...input.implementation.validation.map((item) => `- ${item}`),
    "",
    "## Risks",
    ...(input.implementation.risks.length === 0
      ? ["- None reported"]
      : input.implementation.risks.map((item) => `- ${item}`)),
    "",
    "## Limitations",
    ...(input.implementation.limitations.length === 0
      ? ["- None reported"]
      : input.implementation.limitations.map((item) => `- ${item}`)),
  ];
  return lines.join("\n");
}

/** Checks GitHub CLI authentication and repository access before scheduler work begins. */
export class GitHubCliPreflight implements GitHubPreflight {
  /** Connects preflight checks to an explicit repository and GitHub base branch. */
  constructor(
    private readonly repoPath: string,
    private readonly baseBranch: string,
    private readonly runner: GitHubCommandRunner = new BunGitHubCommandRunner(),
  ) {}

  /** Confirms the configured base, gh login, and current repository are available. */
  async assertReady(): Promise<void> {
    assertBaseBranch(this.baseBranch);
    await mustRun(this.runner, ["gh", "auth", "status"], this.repoPath);
    await mustRun(
      this.runner,
      ["gh", "repo", "view", "--json", "nameWithOwner"],
      this.repoPath,
    );
  }
}

/** Reconciles existing pull requests before creating exactly one pull request per task branch. */
export class GitHubPullRequestPublisher implements TaskPublisher {
  /** Connects branch validation and GitHub commands to one explicit PR base branch. */
  constructor(
    readonly baseBranch: string,
    private readonly branches: TaskBranchManager,
    private readonly runner: GitHubCommandRunner = new BunGitHubCommandRunner(),
  ) {}

  /** Pushes a validated branch only when needed and creates or returns its pull request. */
  async publish(input: PublishTaskInput): Promise<PullRequest> {
    assertBaseBranch(this.baseBranch);
    if (
      input.publication.baseBranch !== this.baseBranch ||
      input.publication.commitSha !== input.implementation.commitSha
    ) {
      throw new GitHubPublicationError(
        `Publication state does not match the current task implementation: ${input.task.id}`,
      );
    }
    const workspace = await this.branches.prepare(
      input.task.id,
      input.task.baseCommit,
    );
    if (workspace.branch !== input.publication.branch) {
      throw new GitHubPublicationError(
        `Publication branch does not match task branch: ${input.task.id}`,
      );
    }
    await this.branches.assertReviewReady(
      input.task.id,
      input.implementation.commitSha,
      input.task.baseCommit,
    );

    const existing = await matchingPullRequest(
      this.runner,
      workspace.path,
      workspace.branch,
      this.baseBranch,
    );
    if (existing?.state === "MERGED") return existing;
    if (existing?.state === "CLOSED") {
      throw new GitHubPublicationError(
        `Pull request #${existing.number} is closed without merge for ${workspace.branch}`,
      );
    }

    await mustRun(
      this.runner,
      ["git", "push", "origin", workspace.branch],
      workspace.path,
    );
    if (existing !== undefined) return existing;

    await mustRun(
      this.runner,
      [
        "gh",
        "pr",
        "create",
        "--base",
        this.baseBranch,
        "--head",
        workspace.branch,
        "--title",
        input.task.title,
        "--body",
        pullRequestBody(input),
      ],
      workspace.path,
    );
    const created = await matchingPullRequest(
      this.runner,
      workspace.path,
      workspace.branch,
      this.baseBranch,
    );
    if (created === undefined) {
      throw new GitHubPublicationError(
        `GitHub did not return the created pull request for ${workspace.branch}`,
      );
    }
    return created;
  }
}
