import type { NativeTask } from "../github/execution-store";

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
export function canRunTogether(left: NativeTask, right: NativeTask): boolean {
  if (left.task.id === right.task.id) return false;
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
