import type { PlanningRepository } from "../store/planning-repository";
import {
  type GitHubIssueCandidate,
  parseApprovedIssueBody,
  readApprovedGitHubIssueCandidates,
} from "./import-source";

const IMPORTED_TASK_TOKEN_CEILING = 12_000;

export type GitHubImportResult = {
  created: number;
  skipped: number;
  total: number;
};

export type GitHubImportServiceOptions = {
  repository: PlanningRepository;
  cycleId: string;
  readIssues?: () => Promise<GitHubIssueCandidate[]>;
};

/** Imports valid unseen approved GitHub Issues into the active Agile Cycle. */
export async function importApprovedGitHubIssues(
  options: GitHubImportServiceOptions,
): Promise<GitHubImportResult> {
  const issues = await (options.readIssues
    ? options.readIssues()
    : readApprovedGitHubIssueCandidates());
  const total = issues.length;
  const existing = options.repository.findExistingTaskIds(
    issues.map((issue) => `github-${issue.number}`),
  );
  const pending = issues.filter(
    (issue) => !existing.has(`github-${issue.number}`),
  );
  if (pending.length === 0) return { created: 0, skipped: total, total };

  const parsed: Array<{
    issue: GitHubIssueCandidate;
    spec: ReturnType<typeof parseApprovedIssueBody>;
  }> = [];
  const validationErrors: string[] = [];
  for (const issue of pending) {
    try {
      parsed.push({
        issue,
        spec: parseApprovedIssueBody(issue.number, issue.body ?? ""),
      });
    } catch (error) {
      validationErrors.push(
        error instanceof Error
          ? error.message
          : `Invalid GitHub Issue #${issue.number} body`,
      );
    }
  }
  if (validationErrors.length > 0) {
    throw new Error(
      `GitHub Issue validation failed:\n${validationErrors.join("\n")}`,
    );
  }

  const result = options.repository.importBacklog({
    cycleId: options.cycleId,
    goal: "Deliver approved GitHub Issues",
    tasks: parsed.map(({ issue, spec }) => ({
      id: `github-${issue.number}`,
      title: issue.title,
      priority: issue.number,
      spec: {
        ...spec,
        problem: `GitHub source: ${issue.url}\n\n${spec.problem}`,
        dependencies: [],
        risk: "medium" as const,
        contextCandidates: [],
        tokenCeiling: IMPORTED_TASK_TOKEN_CEILING,
      },
    })),
  });

  return {
    created: result.created,
    skipped: existing.size + result.skipped,
    total,
  };
}
