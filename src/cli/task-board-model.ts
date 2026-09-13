import type { AcceptanceChecklistItem } from "../domain/acceptance-checklist";
import type {
  InspectionAttempt,
  InspectionCycle,
  InspectionModelDecision,
  InspectionRole,
  InspectionScheduler,
  InspectionSnapshot,
  InspectionTask,
  TokenTotals,
} from "../domain/inspection";
import type { StoredTask, TaskStatus, TicketSpec } from "../domain/schemas";

export type TaskBoardColumn = "ready" | "inProgress" | "attention" | "done";

export type TaskBoardActiveState = {
  taskId: string;
  attemptId?: string;
  role?: InspectionAttempt["role"];
  model?: string;
  retryCount?: number;
};

export type TaskBoardStage = {
  label: string;
  status: string;
  tone: "muted" | "active" | "attention" | "error" | "done";
  retryIndex?: number;
};

export type TaskBoardTask = {
  id: string;
  issueUrl?: string;
  pullRequestUrl?: string;
  acceptanceChecklist: AcceptanceChecklistItem[];
  failure?: string;
  timing?: InspectionTask["timing"];
  usageIncomplete?: boolean;
  cycleId: string;
  title: string;
  rawStatus: TaskStatus;
  column: TaskBoardColumn;
  priority: number;
  dependencies: string[];
  blockingDependencyIds: string[];
  isActive: boolean;
  spec: TicketSpec;
  attempts: InspectionAttempt[];
  modelDecisions: InspectionModelDecision[];
  roles: InspectionRole[];
  progress?: TaskBoardStage[];
  tokenTarget: number;
  tokenTotals: TokenTotals;
  retirementReason?: string | null;
  replacementTaskId?: string | null;
  retiredAt?: string | null;
};

export type TaskBoardSnapshot = {
  remoteCheckpoints?: boolean;
  usageIncomplete?: boolean;
  currentCycleId: string;
  history?: boolean;
  scheduler: InspectionScheduler;
  active?: TaskBoardActiveState;
  cycles: InspectionCycle[];
  tasks: TaskBoardTask[];
  columns: Record<TaskBoardColumn, TaskBoardTask[]>;
};

export type TaskBoardSnapshotInput = {
  remoteCheckpoints?: boolean;
  usageIncomplete?: boolean;
  tasks: StoredTask[];
  inspection: InspectionSnapshot;
  currentCycleId: string;
  allCycles?: boolean;
  history?: boolean;
};

/** Maps a raw task status into its task-board column. */
function boardColumn(status: TaskStatus): TaskBoardColumn {
  if (status === "done" || status === "retired") return "done";
  if (
    status === "claimed" ||
    status === "scouting" ||
    status === "implementing" ||
    status === "reviewing" ||
    status === "publishing" ||
    status === "awaiting_merge"
  ) {
    return "inProgress";
  }
  if (
    status === "needs_input" ||
    status === "needs_replan" ||
    status === "rejected" ||
    status === "failed_infra"
  ) {
    return "attention";
  }
  return "ready";
}

/** Projects checkpoint attempts and receipts into the six read-only workflow stages. */
function progressStages(input: {
  attempts: InspectionAttempt[];
  skipScout: boolean;
  rawStatus: TaskStatus;
  pullRequestUrl?: string;
}): TaskBoardStage[] {
  /** Finds the newest persisted attempt for one workflow role. */
  const latest = (role: InspectionAttempt["role"]) =>
    input.attempts.filter((attempt) => attempt.role === role).at(-1);
  /** Maps one persisted role attempt to its visible workflow stage. */
  const attemptStage = (
    label: string,
    attempt: InspectionAttempt | undefined,
  ) => {
    if (!attempt)
      return { label, status: "Not recorded", tone: "muted" as const };
    if (attempt.status === "running")
      return {
        label,
        status: "Running",
        tone: "active" as const,
        retryIndex: attempt.retryIndex,
      };
    if (
      attempt.status === "failed_infra" ||
      attempt.reviewDecision === "rejected"
    )
      return {
        label,
        status: attempt.reviewDecision === "rejected" ? "Rejected" : "Failed",
        tone: "error" as const,
        retryIndex: attempt.retryIndex,
      };
    if (attempt.status === "blocked_policy")
      return {
        label,
        status: "Blocked",
        tone: "attention" as const,
        retryIndex: attempt.retryIndex,
      };
    if (attempt.role === "review" && attempt.reviewDecision === undefined)
      return {
        label,
        status: "Evidence unavailable",
        tone: "muted" as const,
        retryIndex: attempt.retryIndex,
      };
    return {
      label,
      status: attempt.reviewDecision === "accepted" ? "Accepted" : "Completed",
      tone: "done" as const,
      retryIndex: attempt.retryIndex,
    };
  };
  const scout =
    input.skipScout && !latest("scout")
      ? {
          label: "Scout",
          status: "Skipped by approved ticket",
          tone: "muted" as const,
        }
      : attemptStage("Scout", latest("scout"));
  const implement = attemptStage("Implement", latest("implement"));
  const review = attemptStage("Independent Review", latest("review"));
  const hasPr = input.pullRequestUrl !== undefined;
  return [
    scout,
    implement,
    review,
    hasPr
      ? { label: "Publish PR", status: "Published", tone: "done" as const }
      : input.rawStatus === "publishing"
        ? { label: "Publish PR", status: "Publishing", tone: "active" as const }
        : {
            label: "Publish PR",
            status: "Not recorded",
            tone: "muted" as const,
          },
    input.rawStatus === "done"
      ? {
          label: "Waiting merge",
          status: "Merge verified",
          tone: "done" as const,
        }
      : hasPr || input.rawStatus === "awaiting_merge"
        ? {
            label: "Waiting merge",
            status: "Awaiting merge",
            tone: "attention" as const,
          }
        : {
            label: "Waiting merge",
            status: "Not recorded",
            tone: "muted" as const,
          },
    input.rawStatus === "done"
      ? {
          label: "Confirm complete",
          status: "Confirmed complete",
          tone: "done" as const,
        }
      : {
          label: "Confirm complete",
          status: "Not confirmed",
          tone: "muted" as const,
        },
  ];
}

/** Compares task board entries by priority and then task identifier. */
function compareTasks(left: TaskBoardTask, right: TaskBoardTask): number {
  return (
    left.priority - right.priority ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/** Builds a deterministic, read-only task-board snapshot from repository read models. */
export function buildTaskBoardSnapshot(
  input: TaskBoardSnapshotInput,
): TaskBoardSnapshot {
  const cycleTasks = input.allCycles
    ? input.tasks
    : input.tasks.filter((task) => task.cycleId === input.currentCycleId);
  const tasks = input.history
    ? cycleTasks
    : cycleTasks.filter((task) => task.status !== "retired");
  const inspectedTasks = new Map(
    input.inspection.tasks.map((task) => [task.id, task]),
  );
  const statuses = new Map(input.tasks.map((task) => [task.id, task.status]));
  const activeIds = new Set(
    input.inspection.scheduler.active?.map((item) => item.taskId),
  );
  const taskBoard = tasks.map((task) => {
    const inspected = inspectedTasks.get(task.id);
    if (inspected === undefined)
      throw new Error(`Missing inspection data for task ${task.id}`);
    return {
      id: task.id,
      cycleId: task.cycleId,
      title: task.title,
      rawStatus: task.status,
      column: boardColumn(task.status),
      priority: task.priority,
      dependencies: task.spec.dependencies,
      blockingDependencyIds: task.spec.dependencies.filter(
        (dependencyId) => statuses.get(dependencyId) !== "done",
      ),
      isActive: activeIds.has(task.id),
      spec: task.spec,
      attempts: inspected.attempts,
      issueUrl: inspected.issueUrl,
      pullRequestUrl: inspected.pullRequestUrl,
      acceptanceChecklist: inspected.acceptanceChecklist,
      failure: inspected.failure,
      timing: inspected.timing,
      usageIncomplete: inspected.usageIncomplete,
      modelDecisions: inspected.modelDecisions,
      roles: inspected.roles,
      progress: progressStages({
        attempts: inspected.attempts,
        skipScout: task.spec.skipScout === true,
        rawStatus: task.status,
        pullRequestUrl: inspected.pullRequestUrl,
      }),
      tokenTarget: inspected.tokenTarget,
      tokenTotals: inspected.actual,
      retirementReason: task.retirementReason,
      replacementTaskId: task.replacementTaskId,
      retiredAt: task.retiredAt,
    };
  });
  const activeTask = taskBoard.find((task) => task.isActive);
  const activeAttempt = activeTask?.attempts.find(
    (attempt) => attempt.status === "running",
  );
  const active =
    activeTask === undefined
      ? undefined
      : {
          taskId: activeTask.id,
          ...(activeAttempt === undefined
            ? {}
            : {
                attemptId: activeAttempt.id,
                role: activeAttempt.role,
                model: activeAttempt.model,
                retryCount: activeAttempt.retryIndex,
              }),
        };
  const orderedTasks = taskBoard.sort(compareTasks);
  if (activeTask !== undefined) {
    orderedTasks.splice(orderedTasks.indexOf(activeTask), 1);
    orderedTasks.unshift(activeTask);
  }
  const columns: Record<TaskBoardColumn, TaskBoardTask[]> = {
    ready: [],
    inProgress: [],
    attention: [],
    done: [],
  };
  for (const task of orderedTasks) columns[task.column].push(task);

  return {
    currentCycleId: input.currentCycleId,
    ...(input.remoteCheckpoints
      ? { remoteCheckpoints: true, usageIncomplete: input.usageIncomplete }
      : {}),
    ...(input.history === true ? { history: true } : {}),
    scheduler: input.inspection.scheduler,
    ...(active === undefined ? {} : { active }),
    cycles: input.allCycles
      ? input.inspection.cycles
      : input.inspection.cycles.filter(
          (cycle) => cycle.id === input.currentCycleId,
        ),
    tasks: orderedTasks,
    columns,
  };
}
