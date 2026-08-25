import type { TaskStatus } from "./schemas";

const allowed: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["needs_input", "needs_replan", "ready"],
  needs_input: ["draft"],
  needs_replan: ["draft"],
  ready: ["needs_input", "needs_replan", "claimed"],
  claimed: ["needs_replan", "scouting", "failed_infra"],
  scouting: ["needs_replan", "implementing", "failed_infra"],
  implementing: ["needs_replan", "reviewing", "failed_infra"],
  reviewing: ["needs_replan", "done", "rejected", "failed_infra"],
  done: [],
  rejected: [],
  failed_infra: [],
};

const terminal = new Set<TaskStatus>(["done", "rejected", "failed_infra"]);

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return allowed[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return terminal.has(status);
}
