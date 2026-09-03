const reset = "\u001B[0m";

/** Defines the shared terminal palette for task statuses. */
export const taskDisplayColors = {
  active: "\u001B[36m",
  attention: "\u001B[33m",
  done: "\u001B[32m",
  error: "\u001B[31m",
  muted: "\u001B[90m",
} as const;

export type TaskDisplayTone = keyof typeof taskDisplayColors;

/** Formats a canonical task ID as its shared project-scoped display label when it has an ASCII number. */
export function formatTaskDisplayId(id: string, projectSlug: string): string {
  const digits = id.match(/[0-9]+/gu)?.at(-1);
  if (digits === undefined) return id;
  return `#${projectSlug}-${digits.replace(/^0+(?=[0-9])/u, "")}`;
}

/** Maps a task status and the current active identity to its shared semantic terminal tone. */
export function taskStatusTone(
  status: string,
  taskId: string,
  activeTaskId: string | undefined,
): TaskDisplayTone {
  if (status === "done") return "done";
  if (status === "rejected" || status === "failed_infra") return "error";
  if (status === "needs_input" || status === "needs_replan") return "attention";
  if (taskId === activeTaskId) return "active";
  return "muted";
}

/** Applies one shared task display tone only when terminal color is enabled. */
export function colorTaskDisplay(
  value: string,
  tone: TaskDisplayTone,
  enabled: boolean,
): string {
  return enabled ? `${taskDisplayColors[tone]}${value}${reset}` : value;
}
