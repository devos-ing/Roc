import type {
  InspectionSnapshot,
  InspectionTask,
  TokenTotals,
} from "../domain/inspection";
import type { StoredTask } from "../domain/schemas";
import type { NativeTask } from "./execution-store";

export type GitHubTaskSnapshot = {
  tasks: StoredTask[];
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

/** Adapts remote checkpoints to the existing read-only task board and token views. */
export function githubTaskSnapshot(
  native: NativeTask[],
  diagnostics: string[] = [],
  now = Date.now(),
): GitHubTaskSnapshot {
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
      ...(attempt.failure ? { failure: attempt.failure } : {}),
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
      failure: item.blockedReason ?? item.execution?.failure,
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
