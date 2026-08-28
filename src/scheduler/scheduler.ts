import type { AgentHarness, HarnessStepRequest } from "../harness/contracts";
import type { OrchestrationRepository } from "../store/orchestration-repository";
import type { TaskHookService } from "./task-hooks";

export type TickResult =
  | { kind: "delivery"; attemptId: string; eventId: string }
  | { kind: "attempt_started"; attemptId: string }
  | { kind: "task_claimed"; taskId: string }
  | { kind: "hook_retry"; taskId: string; phase: "prehook" | "posthook" }
  | { kind: "prehook_failed"; taskId: string }
  | { kind: "idle" };

export type SchedulerFaultPoint = "after_delivery_commit";

/** Signals that a terminal task's posthook exhausted retries without changing the task outcome. */
export class TaskPosthookFailedError extends Error {
  /** Identifies the terminal task whose posthook exhausted all permitted attempts. */
  constructor(readonly taskId: string) {
    super(`Task posthook failed after ${3} attempts: ${taskId}`);
    this.name = "TaskPosthookFailedError";
  }
}

export class Scheduler {
  private readonly reconcile = new Set<string>();

  /** Creates a scheduler and marks any recovered running attempt for reconciliation. */
  constructor(
    private readonly repo: OrchestrationRepository,
    private readonly harness: AgentHarness,
    private readonly fault: (point: SchedulerFaultPoint) => void = () => {},
    private readonly hooks?: TaskHookService,
  ) {
    const active = repo.getRunningAttempt();
    if (active) this.reconcile.add(active.descriptor.attemptId);
  }

  /** Advances orchestration by one delivery, attempt start, task claim, or idle result. */
  async tick(leaseOwnerId?: string): Promise<TickResult> {
    const running = this.repo.getRunningAttempt();
    if (running) {
      const attemptId = running.descriptor.attemptId;
      const request: HarnessStepRequest = {
        mode: this.reconcile.delete(attemptId) ? "reconcile" : "dispatch",
        attempt: running.descriptor,
        input: running.input,
        backendCursor: running.backendCursor,
      };
      const delivery = await this.harness.step(request);
      if (delivery.kind === "idle") return { kind: "idle" };
      if (delivery.kind === "closed")
        throw new Error(
          `Harness closed before attempt completion: ${attemptId}`,
        );
      this.repo.applyHarnessEvent(
        attemptId,
        delivery.nextCursor,
        delivery.event,
        leaseOwnerId,
      );
      this.fault("after_delivery_commit");
      return { kind: "delivery", attemptId, eventId: delivery.event.eventId };
    }

    if (this.hooks !== undefined) {
      for (const task of this.repo.listTerminalTasks()) {
        const posthook = await this.hooks.run(task, "posthook", leaseOwnerId);
        if (posthook.kind === "skipped" || posthook.kind === "succeeded")
          continue;
        if (posthook.kind === "untrusted") return { kind: "idle" };
        if (posthook.kind === "retrying")
          return { kind: "hook_retry", taskId: task.id, phase: "posthook" };
        throw new TaskPosthookFailedError(task.id);
      }

      const claimed = this.repo.getClaimedTask();
      if (claimed !== undefined) {
        const prehook = await this.hooks.run(claimed, "prehook", leaseOwnerId);
        if (prehook.kind === "untrusted") return { kind: "idle" };
        if (prehook.kind === "retrying")
          return { kind: "hook_retry", taskId: claimed.id, phase: "prehook" };
        if (prehook.kind === "failed") {
          this.repo.failClaimedTaskHook(claimed.id, leaseOwnerId);
          return { kind: "prehook_failed", taskId: claimed.id };
        }
      }
    }

    const started = this.repo.beginNextAttempt(leaseOwnerId);
    if (started)
      return { kind: "attempt_started", attemptId: started.attemptId };
    const claimed = this.repo.claimNext(leaseOwnerId);
    if (claimed) return { kind: "task_claimed", taskId: claimed.taskId };
    return { kind: "idle" };
  }

  /** Repeatedly advances orchestration until idle or the tick limit is exceeded. */
  async runUntilIdle(maxTicks: number): Promise<void> {
    for (let tick = 0; tick < maxTicks; tick += 1) {
      if ((await this.tick()).kind === "idle") return;
    }
    throw new Error(`Scheduler exceeded ${maxTicks} ticks`);
  }

  /** Stops any hook process currently owned by this scheduler instance. */
  async cancelHooks(): Promise<void> {
    await this.hooks?.stop();
  }
}
