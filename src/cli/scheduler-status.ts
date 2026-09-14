import { readCheckoutOwnerRecord } from "../workspace/checkout-ownership";

export type SchedulerStatus =
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "live"; pid: number; runId: string; acquiredAt: string }
  | { state: "stale"; pid: number; runId: string; acquiredAt: string };

/** Inspects a checkout guard without changing it or signalling its owner. */
export async function readSchedulerStatus(
  repoPath: string,
): Promise<SchedulerStatus> {
  const owner = await readCheckoutOwnerRecord(repoPath);
  if (owner.state === "absent") return { state: "absent" };
  if (owner.state === "unreadable") return { state: "unreadable" };
  const { ownerPid: pid, runId, acquiredAt } = owner.record;
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    alive = error instanceof Error && "code" in error && error.code === "EPERM";
  }
  return alive
    ? { state: "live", pid, runId, acquiredAt }
    : { state: "stale", pid, runId, acquiredAt };
}

/** Keeps the scheduler status command's established public JSON shape. */
export function schedulerStatusReport(
  status: SchedulerStatus,
): Record<string, unknown> {
  if (status.state === "absent") return { running: false, reason: "no-lock" };
  if (status.state === "unreadable")
    return {
      running: false,
      reason: "unreadable-lock",
      hint: "the checkout lock exists but its owner record is unreadable; inspect it and confirm no scheduler is running before removing it",
    };
  if (status.state === "live")
    return {
      running: true,
      pid: status.pid,
      runId: status.runId,
      acquiredAt: status.acquiredAt,
    };
  return {
    running: false,
    staleLock: true,
    pid: status.pid,
    runId: status.runId,
    acquiredAt: status.acquiredAt,
    hint: "owner process is gone; the stale guard can be removed after verifying no scheduler is running",
  };
}
