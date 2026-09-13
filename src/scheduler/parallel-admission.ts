import type { NativeTask } from "../github/execution-store";

/** Returns the local root task ID for a validated continuation chain. */
function chainRoot(
  task: NativeTask,
  allTasks: readonly NativeTask[],
): string | undefined {
  /** Builds a collision-safe same-plan local task identity. */
  const key = (planId: string, taskId: string) => `${planId}\u0000${taskId}`;
  const byId = new Map(
    allTasks.map((candidate) => [
      key(candidate.envelope.planId, candidate.envelope.task.id),
      candidate,
    ]),
  );
  let current: NativeTask | undefined = task;
  const seen = new Set<string>();
  while (current?.task.spec.continues) {
    const currentKey = key(current.envelope.planId, current.envelope.task.id);
    if (seen.has(currentKey)) return undefined;
    seen.add(currentKey);
    const continues = current.task.spec.continues;
    if (!("task" in continues)) return undefined;
    current = byId.get(key(current.envelope.planId, continues.task));
  }
  return current
    ? key(current.envelope.planId, current.envelope.task.id)
    : undefined;
}

/** Parses literal path scopes conservatively so unclear or shared-resource scopes stay exclusive. */
function paths(task: NativeTask): string[] | undefined {
  if (task.task.spec.prehook || task.task.spec.posthook) return undefined;
  const result: string[] = [];
  for (const scope of task.task.spec.scope) {
    const path = scope.replace(/^\.\//u, "").replace(/\/$/u, "").toLowerCase();
    if (!/^[a-z0-9_@.-]+(?:\/[a-z0-9_@.-]+)*$/u.test(path)) return undefined;
    if (
      path
        .split("/")
        .some((part) => [".", "..", ".git", ".agile"].includes(part))
    )
      return undefined;
    if (!path.includes("/") && !path.includes(".")) return undefined;
    result.push(path);
  }
  return result.length ? result : undefined;
}

/** Allows concurrent work only when both approved scopes name distinct paths without hooks. */
export function canRunTogether(
  left: NativeTask,
  right: NativeTask,
  allTasks: readonly NativeTask[] = [left, right],
): boolean {
  if (left.task.id === right.task.id) return false;
  // Sibling successors of one predecessor resolve to the same shared worktree and branch, so they must serialize.
  const leftContinues = left.task.spec.continues;
  const rightContinues = right.task.spec.continues;
  if (
    leftContinues &&
    rightContinues &&
    "issue" in leftContinues &&
    "issue" in rightContinues &&
    leftContinues.issue === rightContinues.issue
  )
    return false;
  const leftRoot = chainRoot(left, allTasks);
  const rightRoot = chainRoot(right, allTasks);
  if (leftRoot === undefined || rightRoot === undefined) return false;
  if (leftRoot === rightRoot) return false;
  const a = paths(left);
  const b = paths(right);
  return (
    !!a &&
    !!b &&
    !a.some((x) =>
      b.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)),
    )
  );
}
