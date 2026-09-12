import { z } from "zod";
import {
  type AcceptanceChecklistBinding,
  projectAcceptanceChecklist,
} from "../domain/acceptance-checklist";
import type { StoredTask } from "../domain/schemas";
import type { ImplementOutput, ReviewOutput } from "../harness/contracts";
import { AgileError } from "../runtime/errors";
import { gitPathResolutionEnvironment } from "../workspace/git-environment";
import {
  type TaskBranchManager,
  taskBranchName,
} from "../workspace/task-branch";

export type TaskPublicationRecord = {
  taskId: string;
  branch: string;
  baseBranch: string;
  commitSha: string;
  status: "pending" | "published" | "failed";
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestState?: "OPEN" | "MERGED";
  failureMessage?: string;
};

const NonEmpty = z.string().trim().min(1);
const PullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    url: NonEmpty,
    state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  })
  .strict();
const PullRequestSearchSchema = PullRequestSchema.extend({
  headRepositoryOwner: z.object({ login: NonEmpty }).nullable(),
  headRefOid: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
}).strict();

/** Describes the remote pull request that safely represents a published task branch. */
export type PullRequest = z.infer<typeof PullRequestSchema>;

/** Supplies the task state needed to publish or reconcile one pull request. */
export type PublishTaskInput = {
  task: StoredTask;
  implementation: ImplementOutput;
  publication: TaskPublicationRecord;
  reconcileOnly?: boolean;
  acceptance?: {
    review: ReviewOutput;
    binding: AcceptanceChecklistBinding;
  };
};

/** Publishes a prepared task branch to its configured GitHub base branch. */
export type TaskPublisher = {
  baseBranch: string;
  publish(input: PublishTaskInput): Promise<PullRequest>;
};

/** Verifies that GitHub access is ready before a real scheduler starts work. */
export type GitHubPreflight = { assertReady(): Promise<void> };

/** Runs a local gh or git subprocess with argv-only input and bounded diagnostics. */
export type GitHubCommandRunner = {
  run(input: {
    command: string[];
    cwd: string;
    signal?: AbortSignal;
    intent?: "graphql-read";
  }): Promise<GitHubCommandResult>;
};

export type GitHubCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  httpStatus?: number;
  rateLimit?: {
    cost?: number;
    limit?: number;
    remaining?: number;
    resetAt?: number;
    retryAfterMs?: number;
  };
};

/** Removes gh API response headers, including paginated headers, while preserving the JSON body. */
function githubApiResponse(
  stdout: string,
): Pick<GitHubCommandResult, "stdout" | "httpStatus" | "rateLimit"> {
  let httpStatus: number | undefined;
  let rateLimit: GitHubCommandResult["rateLimit"];
  const body = stdout.replace(
    /(^|[\n[,])HTTP\/[\d.]+ (\d{3})[A-Za-z \t-]*\r?\n(?:[\w-]+:[^\r\n]*\r?\n)*\r?\n/gu,
    (headers: string, prefix: string, status: string) => {
      httpStatus = Number(status);
      const remaining = headers.match(
        /^x-ratelimit-remaining:\s*(\d+)/imu,
      )?.[1];
      const reset = headers.match(/^x-ratelimit-reset:\s*(\d+)/imu)?.[1];
      const retry = headers.match(/^retry-after:\s*([^\r\n]+)/imu)?.[1];
      rateLimit = {
        remaining: remaining === undefined ? undefined : Number(remaining),
        resetAt: reset === undefined ? undefined : Number(reset) * 1_000,
        retryAfterMs:
          retry === undefined
            ? undefined
            : /^\d+$/u.test(retry)
              ? Number(retry) * 1_000
              : Date.parse(retry) - Date.now(),
      };
      return prefix;
    },
  );
  return httpStatus === undefined
    ? { stdout }
    : { stdout: body, httpStatus, rateLimit };
}

/** Signals an unavailable GitHub prerequisite or unrecoverable publication result. */
export class GitHubPublicationError extends Error {
  /** Creates a classified GitHub publication failure with useful operator diagnostics. */
  constructor(message: string) {
    super(message);
    this.name = "GitHubPublicationError";
  }
}

/** Executes local gh and git subprocesses through Bun without a shell. */
export class BunGitHubCommandRunner implements GitHubCommandRunner {
  /** Creates a subprocess runner with a bounded wall-clock command timeout. */
  constructor(private readonly timeoutMs = 30_000) {}

  /** Runs one command in its repository workspace and collects its complete output. */
  async run(input: {
    command: string[];
    cwd: string;
    signal?: AbortSignal;
    intent?: "graphql-read";
  }): Promise<GitHubCommandResult> {
    input.signal?.throwIfAborted();
    const api = input.command[0] === "gh" && input.command[1] === "api";
    const command =
      api &&
      !input.command.includes("--include") &&
      !input.command.includes("-i")
        ? [...input.command, "--include"]
        : input.command;
    const process = Bun.spawn({
      cmd: command,
      cwd: input.cwd,
      env: gitPathResolutionEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    /** Terminates an aborted read and lets output collection drain before returning. */
    const abort = () => process.kill("SIGKILL");
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      process.kill("SIGKILL");
    }, this.timeoutMs);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      input.signal?.throwIfAborted();
      return {
        exitCode: timedOut ? 124 : exitCode,
        ...(api ? githubApiResponse(stdout) : { stdout }),
        stderr: timedOut
          ? `${stderr}${stderr === "" ? "" : "\n"}command timed out`
          : stderr,
      };
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
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

/** Resolves the owner of the GitHub repository associated with a checkout. */
async function repositoryOwner(
  runner: GitHubCommandRunner,
  cwd: string,
): Promise<string> {
  const output = await mustRun(
    runner,
    ["gh", "repo", "view", "--json", "nameWithOwner"],
    cwd,
  );
  const nameWithOwner = z
    .object({ nameWithOwner: NonEmpty })
    .strict()
    .parse(JSON.parse(output)).nameWithOwner;
  const [owner, repository, ...rest] = nameWithOwner.split("/");
  if (owner === undefined || repository === undefined || rest.length > 0) {
    throw new GitHubPublicationError(
      `GitHub repository has an invalid nameWithOwner: ${nameWithOwner}`,
    );
  }
  return owner;
}

/** Finds the single matching same-repository pull request for a task branch and base. */
async function matchingPullRequest(
  runner: GitHubCommandRunner,
  cwd: string,
  branch: string,
  baseBranch: string,
  owner: string,
): Promise<z.infer<typeof PullRequestSearchSchema> | undefined> {
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
      "number,url,state,headRepositoryOwner,headRefOid",
    ],
    cwd,
  );
  const pullRequests = z
    .array(PullRequestSearchSchema)
    .parse(JSON.parse(output))
    .filter((pullRequest) => pullRequest.headRepositoryOwner?.login === owner);
  if (pullRequests.length > 1) {
    throw new GitHubPublicationError(
      `Multiple pull requests exist for ${branch} into ${baseBranch}`,
    );
  }
  return pullRequests[0];
}

/** Renders item evidence beneath the original criterion without changing its wording. */
function checklistLines(input: PublishTaskInput): string[] {
  const acceptance = input.acceptance;
  const binding = acceptance && {
    ...acceptance.binding,
    currentHeadSha: input.publication.commitSha,
    currentBaseSha: input.task.baseCommit ?? "",
  };
  const checklist = projectAcceptanceChecklist(
    input.task.spec.acceptanceCriteria,
    acceptance?.review.acceptanceResults,
    binding,
  );
  return [
    "## Acceptance checklist",
    `Automated Review evidence for head \`${input.publication.commitSha}\`; human acceptance is separate.`,
    ...checklist.flatMap((item) => [
      `- [${item.status === "passed" ? "x" : " "}] ${item.criterion}`,
      ...(item.status === "passed"
        ? ["  Status: passed"]
        : [
            `  Status: ${item.status}`,
            ...(item.status === "unverified" && item.evidence === undefined
              ? ["  Evidence: No item-level evidence recorded."]
              : []),
          ]),
      ...(item.evidence === undefined
        ? []
        : [
            "  Evidence:",
            ...item.evidence.split("\n").map((line) => `    ${line}`),
          ]),
    ]),
  ];
}

/** Renders durable implementation and bound Review evidence as the pull-request body. */
function pullRequestBody(input: PublishTaskInput): string {
  const lines = [
    "## Task",
    input.task.title,
    ...(/^issue-[1-9]\d*$(?![\s\S])/.test(input.task.id)
      ? [`Related issue: #${input.task.id.slice(6)}`]
      : []),
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
    "",
    ...checklistLines(input),
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

  /** Confirms base and GitHub access, retrying a timed-out repository read once before any task starts. */
  async assertReady(): Promise<void> {
    assertBaseBranch(this.baseBranch);
    await mustRun(this.runner, ["gh", "auth", "status"], this.repoPath);
    const input = {
      command: ["gh", "repo", "view", "--json", "nameWithOwner"],
      cwd: this.repoPath,
    };
    let result = await this.runner.run(input);
    if (result.exitCode === 124) result = await this.runner.run(input);
    if (result.exitCode !== 0)
      throw new AgileError({
        code: "GITHUB_REPOSITORY_UNAVAILABLE",
        category: "startup",
        component: "github-preflight",
        retryable: result.exitCode === 124,
        message:
          "GitHub repository lookup failed before task startup; check connection and repository access, then restart the daemon",
      });
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

  /** Pushes a validated branch only when needed and creates or reconciles its pull request. */
  async publish(input: PublishTaskInput): Promise<PullRequest> {
    const baseBranch = input.publication.baseBranch;
    assertBaseBranch(baseBranch);
    const acceptedReviewHead =
      input.acceptance?.review.decision === "accepted" &&
      input.acceptance.binding.currentHeadSha === input.publication.commitSha &&
      input.acceptance.binding.currentBaseSha === input.task.baseCommit &&
      input.acceptance.binding.currentSpecHash ===
        input.acceptance.binding.reviewedSpecHash &&
      input.acceptance.binding.reviewedHeadSha ===
        input.publication.commitSha &&
      input.acceptance.binding.reviewedBaseSha === input.task.baseCommit;
    if (
      input.publication.commitSha !== input.implementation.commitSha &&
      !acceptedReviewHead &&
      !input.reconcileOnly
    ) {
      throw new GitHubPublicationError(
        `Publication state does not match the current task implementation: ${input.task.id}`,
      );
    }
    const workspace = await this.branches.prepare(
      input.task.id,
      input.task.baseCommit,
      input.publication.branch !== taskBranchName(input.task.id)
        ? input.publication.branch
        : undefined,
    );
    if (workspace.branch !== input.publication.branch) {
      throw new GitHubPublicationError(
        `Publication branch does not match task branch: ${input.task.id}`,
      );
    }
    await this.branches.assertReviewReady(
      input.task.id,
      input.publication.commitSha,
      input.task.baseCommit,
    );

    const owner = await repositoryOwner(this.runner, workspace.path);
    const existing = await matchingPullRequest(
      this.runner,
      workspace.path,
      workspace.branch,
      baseBranch,
      owner,
    );
    if (existing?.state === "MERGED") return existing;
    if (existing?.state === "CLOSED") {
      throw new GitHubPublicationError(
        `Pull request #${existing.number} is closed without merge for ${workspace.branch}`,
      );
    }
    if (input.reconcileOnly) {
      if (!existing || existing.headRefOid !== input.publication.commitSha) {
        throw new GitHubPublicationError(
          `Pull request head does not match the reviewed task head: ${input.task.id}`,
        );
      }
    }
    if (!input.reconcileOnly)
      await mustRun(
        this.runner,
        ["git", "push", "origin", workspace.branch],
        workspace.path,
      );
    if (existing !== undefined) {
      await mustRun(
        this.runner,
        [
          "gh",
          "pr",
          "edit",
          String(existing.number),
          "--title",
          input.task.title,
          "--body",
          pullRequestBody(input),
        ],
        workspace.path,
      );
      return existing;
    }

    await mustRun(
      this.runner,
      [
        "gh",
        "pr",
        "create",
        "--base",
        baseBranch,
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
      baseBranch,
      owner,
    );
    if (created === undefined) {
      throw new GitHubPublicationError(
        `GitHub did not return the created pull request for ${workspace.branch}`,
      );
    }
    return created;
  }
}
