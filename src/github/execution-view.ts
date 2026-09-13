import { projectAcceptanceChecklist } from "../domain/acceptance-checklist";
import type {
  InspectionSnapshot,
  InspectionTask,
  TokenTotals,
} from "../domain/inspection";
import type { StoredTask } from "../domain/schemas";
import type { NativeTask } from "./execution-store";
import { jsonHash } from "./remote-tasks";

export type GitHubTaskSnapshot = {
  tasks: StoredTask[];
  chainMembers: ReadonlyMap<string, readonly string[]>;
  incompleteChainWorktrees: ReadonlySet<string>;
  inspection: InspectionSnapshot;
  diagnostics: string[];
  usageIncomplete: boolean;
};

/** Adds recorded usage without counting cached or reasoning tokens twice. */
function sumUsage(items: TokenTotals[]): TokenTotals {
  return items.reduce(
    (sum, item) => ({
      inputTokens: sum.inputTokens + item.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + item.cachedInputTokens,
      outputTokens: sum.outputTokens + item.outputTokens,
      reasoningOutputTokens:
        sum.reasoningOutputTokens + item.reasoningOutputTokens,
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  );
}

/** Derives phase and attempt durations from recorded boundaries without inventing historical timing. */
function executionTiming(
  task: NativeTask,
  now: number,
): InspectionTask["timing"] {
  const record = task.execution;
  const timeline = record?.timeline;
  const first = timeline?.[0];
  const last = timeline?.at(-1);
  if (
    !record ||
    !timeline ||
    !first ||
    !last ||
    task.task.status !== record.phase
  )
    return undefined;
  if (
    last.phase !== record.phase ||
    timeline.some(
      (entry, index) =>
        index > 0 && Date.parse(entry.at) < Date.parse(timeline[index - 1]!.at),
    )
  )
    return undefined;
  const active = [
    "claimed",
    "scouting",
    "implementing",
    "reviewing",
    "publishing",
    "awaiting_merge",
  ].includes(task.task.status);
  const end = active ? now : Date.parse(last.at);
  const phaseDurationsMs: Record<string, number> = {};
  for (const [index, entry] of timeline.entries()) {
    const next = timeline[index + 1];
    const until = next ? Math.min(end, Date.parse(next.at)) : end;
    phaseDurationsMs[entry.phase] =
      (phaseDurationsMs[entry.phase] ?? 0) +
      Math.max(0, until - Date.parse(entry.at));
  }
  const attemptMs = record.attempts.some(
    (attempt) => !attempt.endedAt && (attempt.status !== "running" || !active),
  )
    ? undefined
    : record.attempts.reduce(
        (sum, attempt) =>
          sum +
          Math.max(
            0,
            Math.min(end, attempt.endedAt ? Date.parse(attempt.endedAt) : end) -
              Date.parse(attempt.startedAt),
          ),
        0,
      );
  return {
    startedAt: first.at,
    elapsedMs: Math.max(0, end - Date.parse(first.at)),
    phaseElapsedMs: Math.max(0, end - Date.parse(last.at)),
    attemptMs,
    waitingMs: phaseDurationsMs.awaiting_merge ?? 0,
    phaseDurationsMs,
  };
}

/** Projects the latest Review result only when its exact recorded target still matches the task checkpoint. */
function acceptanceChecklist(task: NativeTask) {
  const record = task.execution;
  const review = record?.attempts.findLast(
    (attempt) => attempt.output?.kind === "review",
  );
  const output = review?.output;
  const head = record?.publication?.commitSha ?? review?.reviewTarget?.headSha;
  return projectAcceptanceChecklist(
    task.task.spec.acceptanceCriteria,
    output?.kind === "review" ? output.acceptanceResults : undefined,
    review?.reviewTarget
      ? {
          currentSpecHash: jsonHash(task.envelope),
          reviewedSpecHash: record?.specHash ?? "",
          currentHeadSha: head ?? "",
          reviewedHeadSha: review.reviewTarget.headSha,
          currentBaseSha: record?.baseCommit ?? "",
          reviewedBaseSha: review.reviewTarget.baseSha,
        }
      : undefined,
  );
}

/** Returns findings only when the latest saved Review remains the current rejection. */
function rejectedReviewFailure(task: NativeTask): string | undefined {
  if (!["rejected", "needs_replan"].includes(task.task.status))
    return undefined;
  const review = task.execution?.attempts.findLast(
    (attempt) => attempt.descriptor.role === "review",
  );
  if (
    review?.output?.kind !== "review" ||
    review.output.decision !== "rejected"
  )
    return undefined;
  const reason = [...review.output.findings, ...review.output.remainingGaps]
    .join("; ")
    .trim();
  return reason || "Review rejected without a recorded finding";
}

/** Maps a local continuation reference to the scheduler-facing task ID for cleanup and display. */
function continuationView(task: NativeTask, native: NativeTask[]) {
  const continues = task.envelope.task.spec.continues;
  if (!continues || !("task" in continues)) return continues;
  return {
    task:
      native.find(
        (candidate) =>
          candidate.envelope.planId === task.envelope.planId &&
          candidate.envelope.task.id === continues.task,
      )?.task.id ?? continues.task,
  };
}

/** Projects same-plan local continuation IDs into the runtime IDs that own worktree directories. */
function worktreeChainMembership(native: NativeTask[]): {
  chainMembers: ReadonlyMap<string, readonly string[]>;
  incompleteWorktrees: ReadonlySet<string>;
} {
  const byKey = new Map(
    native.map((task) => [
      `${task.envelope.planId}\u0000${task.envelope.task.id}`,
      task,
    ]),
  );
  const groups = new Map<string, string[]>();
  const incompleteWorktrees = new Set<string>();
  for (const task of native) {
    let current = task;
    const seen = new Set<string>();
    while (current.envelope.task.spec.continues) {
      const currentKey = `${current.envelope.planId}\u0000${current.envelope.task.id}`;
      if (seen.has(currentKey)) {
        for (const key of seen) {
          const member = byKey.get(key);
          if (member) incompleteWorktrees.add(member.task.id);
        }
        break;
      }
      seen.add(currentKey);
      const continues = current.envelope.task.spec.continues;
      if (!("task" in continues)) {
        for (const key of seen) {
          const member = byKey.get(key);
          if (member) incompleteWorktrees.add(member.task.id);
        }
        incompleteWorktrees.add(`issue-${continues.issue}`);
        break;
      }
      const predecessor = byKey.get(
        `${current.envelope.planId}\u0000${continues.task}`,
      );
      if (!predecessor) {
        for (const key of seen) {
          const member = byKey.get(key);
          if (member) incompleteWorktrees.add(member.task.id);
        }
        break;
      }
      current = predecessor;
    }
    const members = groups.get(current.task.id) ?? [];
    members.push(task.task.id);
    groups.set(current.task.id, members);
  }
  return { chainMembers: groups, incompleteWorktrees };
}

/** Adapts remote checkpoints to the existing read-only task board and token views. */
export function githubTaskSnapshot(
  native: NativeTask[],
  diagnostics: string[] = [],
  now = Date.now(),
): GitHubTaskSnapshot {
  const membership = worktreeChainMembership(native);
  const tasks = native.map((item) => ({
    ...item.task,
    spec: {
      ...item.task.spec,
      dependencies: item.envelope.task.spec.dependencies.map(
        (id) =>
          native.find(
            (candidate) =>
              candidate.envelope.planId === item.envelope.planId &&
              candidate.envelope.task.id === id,
          )?.task.id ?? id,
      ),
      continues: continuationView(item, native),
    },
  }));
  const inspected = native.map((item) => {
    const attempts = (item.execution?.attempts ?? []).map((attempt) => ({
      id: attempt.descriptor.attemptId,
      role: attempt.descriptor.role,
      modelProfile: attempt.descriptor.modelProfile,
      model: attempt.descriptor.model,
      effort: attempt.descriptor.effort,
      status: attempt.status,
      retryIndex: attempt.descriptor.retryIndex,
      startedAt: attempt.startedAt,
      usageKnown: attempt.usageKnown,
      ...(attempt.activity ? { activity: attempt.activity } : {}),
      ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
      ...(attempt.failure
        ? { failure: attempt.failure }
        : attempt.output?.kind === "review" &&
            attempt.output.decision === "rejected"
          ? {
              failure:
                [...attempt.output.findings, ...attempt.output.remainingGaps]
                  .join("; ")
                  .trim() || "Review rejected without a recorded finding",
            }
          : {}),
      ...(attempt.output?.kind === "review"
        ? { reviewDecision: attempt.output.decision }
        : {}),
      ...(attempt.output?.kind === "implement"
        ? { gitCommit: attempt.output.commitSha }
        : {}),
      ...attempt.usage,
    }));
    return {
      id: item.task.id,
      issueUrl: item.issue.url,
      pullRequestUrl: item.execution?.publication?.url,
      acceptanceChecklist: acceptanceChecklist(item),
      failure:
        item.blockedReason ??
        ([item.execution?.failure, rejectedReviewFailure(item)]
          .filter(Boolean)
          .join("\n") ||
          undefined),
      status: item.task.status,
      timing: executionTiming(item, now),
      usageIncomplete: (item.execution?.attempts ?? []).some(
        (attempt) => !attempt.usageKnown,
      ),
      priority: item.task.priority,
      tokenTarget: item.task.spec.tokenCeiling,
      actual: sumUsage(attempts),
      modelDecisions: [],
      roles: (["scout", "implement", "review"] as const).map((role) => ({
        role,
        actual: sumUsage(attempts.filter((attempt) => attempt.role === role)),
      })),
      attempts,
    };
  });
  const active = inspected.flatMap((task) =>
    ["scouting", "implementing", "reviewing"].includes(task.status)
      ? task.attempts
          .filter((attempt) => attempt.status === "running")
          .map((attempt) => ({ taskId: task.id, attemptId: attempt.id }))
      : [],
  );
  const cycleIds = [...new Set(tasks.map((task) => task.cycleId))];
  return {
    tasks,
    chainMembers: membership.chainMembers,
    incompleteChainWorktrees: membership.incompleteWorktrees,
    diagnostics,
    usageIncomplete: native.some((task) =>
      task.execution?.attempts.some((attempt) => !attempt.usageKnown),
    ),
    inspection: {
      scheduler: { active },
      tasks: inspected,
      cycles: cycleIds.map((id) => {
        const members = tasks.filter((task) => task.cycleId === id);
        const ids = new Set(members.map((task) => task.id));
        return {
          id,
          tokenTarget: members.reduce(
            (sum, task) => sum + task.spec.tokenCeiling,
            0,
          ),
          actual: sumUsage(
            inspected
              .filter((task) => ids.has(task.id))
              .map((task) => task.actual),
          ),
        };
      }),
    },
  };
}
