import type { StoredTask, TaskStatus, TicketSpec } from "../domain/schemas";
import type {
  InspectionAttempt,
  InspectionCycle,
  InspectionModelDecision,
  InspectionRole,
  InspectionScheduler,
  InspectionSnapshot,
  TokenTotals,
} from "../store/orchestration-repository";

export type TaskBoardColumn = "ready" | "inProgress" | "attention" | "done";

export type TaskBoardActiveState = {
  taskId: string;
  attemptId?: string;
  role?: InspectionAttempt["role"];
  model?: string;
  retryCount?: number;
};

export type TaskBoardTask = {
  id: string;
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
  tokenTarget: number;
  tokenTotals: TokenTotals;
};

export type TaskBoardSnapshot = {
  currentCycleId: string;
  scheduler: InspectionScheduler;
  active?: TaskBoardActiveState;
  cycles: InspectionCycle[];
  tasks: TaskBoardTask[];
  columns: Record<TaskBoardColumn, TaskBoardTask[]>;
};

export type TaskBoardSnapshotInput = {
  tasks: StoredTask[];
  inspection: InspectionSnapshot;
  currentCycleId: string;
  allCycles?: boolean;
};

/** Maps a raw task status into its task-board column. */
function boardColumn(status: TaskStatus): TaskBoardColumn {
  if (status === "done") return "done";
  if (
    status === "claimed" ||
    status === "scouting" ||
    status === "implementing" ||
    status === "reviewing"
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
  const tasks = input.allCycles
    ? input.tasks
    : input.tasks.filter((task) => task.cycleId === input.currentCycleId);
  const inspectedTasks = new Map(
    input.inspection.tasks.map((task) => [task.id, task]),
  );
  const statuses = new Map(input.tasks.map((task) => [task.id, task.status]));
  const activeTaskId = input.inspection.scheduler.activeTaskId;
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
      isActive: task.id === activeTaskId,
      spec: task.spec,
      attempts: inspected.attempts,
      modelDecisions: inspected.modelDecisions,
      roles: inspected.roles,
      tokenTarget: inspected.tokenTarget,
      tokenTotals: inspected.actual,
    };
  });
  const activeTask = taskBoard.find((task) => task.isActive);
  const activeAttempt = activeTask?.attempts.find(
    (attempt) => attempt.id === input.inspection.scheduler.activeAttemptId,
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
