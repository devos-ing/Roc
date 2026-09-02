import type { HarnessStepRequest } from "../harness/contracts";
import { normalizeError } from "../runtime/errors";
import type { TaskBranchManager } from "../workspace/task-branch";

type SourceCommitRestoration = {
  branches: TaskBranchManager;
  request: HarnessStepRequest;
  baseCommit: string;
  component: "codex-harness" | "zcode-harness";
};

/** Restores an approved source commit before Implement while preserving existing task work. */
export async function restoreApprovedSourceCommit(
  input: SourceCommitRestoration,
): Promise<void> {
  const sourceCommit = input.request.input.ticket.spec.sourceCommit;
  if (input.request.attempt.role !== "implement" || sourceCommit === undefined)
    return;
  try {
    await input.branches.restoreChanges(
      input.request.attempt.taskId,
      sourceCommit,
      input.baseCommit,
    );
  } catch (error) {
    throw normalizeError(error, {
      code: "source_commit_restore_failed",
      category: "infra",
      retryable: true,
      component: input.component,
      message: "Could not restore the approved source commit",
      taskId: input.request.attempt.taskId,
      attemptId: input.request.attempt.attemptId,
    });
  }
}

/** Builds a stable public reason for a trusted implementation commit failure. */
export function implementationCommitFailureMessage(error: unknown): string {
  if (
    error instanceof Error &&
    error.message.includes("has no uncommitted changes")
  ) {
    return "The trusted Harness found no uncommitted implementation changes";
  }
  return "The trusted Harness could not create or reuse the sole trusted implementation commit";
}
