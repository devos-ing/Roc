import type { TaskStatus } from "./schemas";

const allowed: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["needs_input", "needs_replan", "ready"],
  needs_input: ["draft"],
  needs_replan: ["draft"],
  ready: ["needs_input", "needs_replan", "claimed"],
  claimed: ["needs_replan", "scouting", "failed_infra"],
  scouting: ["needs_replan", "implementing", "failed_infra"],
  implementing: ["needs_replan", "reviewing", "failed_infra"],
  reviewing: ["needs_replan", "publishing", "rejected", "failed_infra"],
  publishing: ["needs_replan", "done"],
  done: [],
  rejected: [],
  failed_infra: [],
};

const terminal = new Set<TaskStatus>(["done", "rejected", "failed_infra"]);

/** Reports whether a task status may transition directly to another status. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return allowed[from].includes(to);
}

/** Throws when a requested direct task-status transition is invalid. */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

/** Reports whether a task status is terminal. */
export function isTerminal(status: TaskStatus): boolean {
  return terminal.has(status);
}
