import { z } from "zod";
import { TicketSpecSchema } from "../domain/schemas";

const REQUIRED_HEADINGS = [
  "Problem",
  "Desired outcome",
  "Scope",
  "Non-goals",
  "Acceptance criteria",
  "Validation",
] as const;

const ApprovedIssueSpecSchema = TicketSpecSchema.pick({
  problem: true,
  desiredOutcome: true,
  scope: true,
  nonGoals: true,
  acceptanceCriteria: true,
  validation: true,
});

const GhIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().trim().min(1),
  body: z.string().nullable(),
  html_url: z.url().optional(),
  state: z.literal("open"),
  labels: z.array(z.object({ name: z.string() }).passthrough()),
  pull_request: z.unknown().optional(),
});

const GhPagesSchema = z.array(z.array(GhIssueSchema));
const GhRepositorySchema = z
  .object({ nameWithOwner: z.string().trim().min(1), url: z.url() })
  .strict();

export type ApprovedIssueSpec = z.infer<typeof ApprovedIssueSpecSchema>;
export type ApprovedGitHubIssue = ApprovedIssueSpec & {
  number: number;
  title: string;
  url: string;
};

export type GitHubIssueCandidate = {
  number: number;
  title: string;
  body: string | null;
  url: string;
};

export type GhCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type GhCommandRunner = (args: string[]) => Promise<GhCommandResult>;

export type GitHubImportOptions = {
  run?: GhCommandRunner;
  stderr?: (message: string) => void;
  platform?: NodeJS.Platform;
};

/** Runs gh and captures its complete output for a single command. */
async function runGh(args: string[]): Promise<GhCommandResult> {
  const process = Bun.spawn(["gh", ...args], {
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

/** Reports whether an error means that the gh executable could not be started. */
function isMissingExecutable(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Converts a validated Markdown list section into its trimmed item values. */
function parseList(
  issueNumber: number,
  heading: string,
  content: string,
): string[] {
  const lines = content.trim().split("\n");
  const values = lines.map((line) => {
    const match = /^-\s+(.+)$/.exec(line);
    if (!match) {
      throw new Error(
        `Invalid GitHub Issue #${issueNumber}: ${heading} must be a dash-prefixed list`,
      );
    }
    return match[1]!.trim();
  });
  if (values.some((value) => value.length === 0)) {
    throw new Error(
      `Invalid GitHub Issue #${issueNumber}: ${heading} cannot be empty`,
    );
  }
  return values;
}

/** Parses one Issue body using the fixed approved-ticket Markdown template. */
export function parseApprovedIssueBody(
  issueNumber: number,
  body: string,
): ApprovedIssueSpec {
  const headings = Array.from(body.matchAll(/^##(?:[ \t]+(.*?))?[ \t]*$/gm));
  const names = headings.map((heading) => heading[1] ?? "");
  if (
    names.length !== REQUIRED_HEADINGS.length ||
    names.some((name, index) => name !== REQUIRED_HEADINGS[index])
  ) {
    throw new Error(
      `Invalid GitHub Issue #${issueNumber}: second-level headings must be exactly ${REQUIRED_HEADINGS.join(", ")}`,
    );
  }

  /** Extracts trimmed content between one required heading and the next. */
  const section = (index: number) => {
    const heading = headings[index]!;
    const start = heading.index! + heading[0].length;
    const end = headings[index + 1]?.index ?? body.length;
    const content = body.slice(start, end).trim();
    if (!content) {
      throw new Error(
        `Invalid GitHub Issue #${issueNumber}: ${REQUIRED_HEADINGS[index]} cannot be empty`,
      );
    }
    return content;
  };

  try {
    const nonGoals = parseList(issueNumber, "Non-goals", section(3));
    return ApprovedIssueSpecSchema.parse({
      problem: section(0),
      desiredOutcome: section(1),
      scope: parseList(issueNumber, "Scope", section(2)),
      nonGoals: nonGoals.length === 1 && nonGoals[0] === "None" ? [] : nonGoals,
      acceptanceCriteria: parseList(
        issueNumber,
        "Acceptance criteria",
        section(4),
      ),
      validation: parseList(issueNumber, "Validation", section(5)),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(`Issue #${issueNumber}`)
    ) {
      throw error;
    }
    throw new Error(`Invalid GitHub Issue #${issueNumber} body`, {
      cause: error,
    });
  }
}

/** Reads raw ready Issue candidates after checking the current repository's gh prerequisites. */
export async function readApprovedGitHubIssueCandidates(
  options: GitHubImportOptions = {},
): Promise<GitHubIssueCandidate[]> {
  const run = options.run ?? runGh;
  const stderr =
    options.stderr ?? ((message) => process.stderr.write(`${message}\n`));
  /** Runs gh or reports how to install it when the executable is unavailable. */
  const runRequiredGh = async (args: string[]) => {
    try {
      return await run(args);
    } catch (error) {
      if (!isMissingExecutable(error)) throw error;
      const installation =
        (options.platform ?? process.platform) === "darwin"
          ? "brew install gh"
          : "https://cli.github.com/";
      const message = `GitHub CLI is not installed. Install it with: ${installation}`;
      stderr(message);
      throw new Error(message, { cause: error });
    }
  };

  const repository = await runRequiredGh([
    "repo",
    "view",
    "--json",
    "nameWithOwner,url",
  ]);
  if (repository.exitCode !== 0) {
    if (
      /gh auth login|authentication required|not logged in|HTTP 401/i.test(
        repository.stderr,
      )
    ) {
      const message = "GitHub CLI is not authenticated. Run: gh auth login";
      stderr(message);
      throw new Error(message);
    }
    throw new Error(`gh repo view failed: ${repository.stderr.trim()}`);
  }
  const { nameWithOwner, url } = GhRepositorySchema.parse(
    JSON.parse(repository.stdout),
  );
  const host = new URL(url).hostname;
  const auth = await runRequiredGh([
    "auth",
    "status",
    "--active",
    "--hostname",
    host,
  ]);
  if (auth.exitCode !== 0) {
    const message = "GitHub CLI is not authenticated. Run: gh auth login";
    stderr(message);
    throw new Error(message);
  }

  const issues = await runRequiredGh([
    "api",
    "--hostname",
    host,
    "--paginate",
    "--slurp",
    `repos/${nameWithOwner}/issues?state=open&labels=roc%3Aready&per_page=100`,
  ]);
  if (issues.exitCode !== 0) {
    throw new Error(`gh api failed: ${issues.stderr.trim()}`);
  }

  return GhPagesSchema.parse(JSON.parse(issues.stdout))
    .flat()
    .filter(
      (issue) =>
        issue.state === "open" &&
        issue.pull_request === undefined &&
        issue.labels.some((label) => label.name === "roc:ready"),
    )
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.html_url ?? `${url}/issues/${issue.number}`,
    }));
}

/** Reads and validates every ready Issue in the current GitHub repository. */
export async function readApprovedGitHubIssues(
  options: GitHubImportOptions = {},
): Promise<ApprovedGitHubIssue[]> {
  const issues = await readApprovedGitHubIssueCandidates(options);
  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    ...parseApprovedIssueBody(issue.number, issue.body ?? ""),
  }));
}
