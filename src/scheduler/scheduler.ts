import type { TaskPublisher } from "../github/pr-publisher";
import type { AgentHarness, HarnessStepRequest } from "../harness/contracts";
import type { OrchestrationRepository } from "../store/orchestration-repository";
import { taskBranchName } from "../workspace/task-branch";
import type { TaskHookService } from "./task-hooks";

export type TickResult =
  | { kind: "delivery"; attemptId: string; eventId: string }
  | { kind: "attempt_started"; attemptId: string }
  | { kind: "task_claimed"; taskId: string }
  | { kind: "hook_retry"; taskId: string; phase: "prehook" | "posthook" }
  | { kind: "prehook_failed"; taskId: string }
  | { kind: "published"; taskId: string; pullRequestNumber: number }
  | { kind: "publication_failed"; taskId: string }
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

/** Converts unknown publishing errors into the durable replanning diagnostic. */
function publicationFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Scheduler {
  private readonly reconcile = new Set<string>();

  /** Creates a scheduler and marks any recovered running attempt for reconciliation. */
  constructor(
    private readonly repo: OrchestrationRepository,
    private readonly harness: AgentHarness,
    private readonly fault: (point: SchedulerFaultPoint) => void = () => {},
    private readonly hooks?: TaskHookService,
    private readonly publisher?: TaskPublisher,
  ) {
    const active = repo.getRunningAttempt();
    if (active) this.reconcile.add(active.descriptor.attemptId);
  }

  /** Advances one orchestration step unless its owning session has sealed continuation. */
  async tick(leaseOwnerId?: string, signal?: AbortSignal): Promise<TickResult> {
    signal?.throwIfAborted();
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
      signal?.throwIfAborted();
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
      for (const task of this.repo.listPosthookTasks()) {
        const posthook = await this.hooks.run(
          task,
          "posthook",
          leaseOwnerId,
          signal,
        );
        signal?.throwIfAborted();
        if (posthook.kind === "skipped" || posthook.kind === "succeeded")
          continue;
        if (posthook.kind === "untrusted") return { kind: "idle" };
        if (posthook.kind === "retrying")
          return { kind: "hook_retry", taskId: task.id, phase: "posthook" };
        if (task.status === "publishing") {
          this.repo.failPublishing(
            task.id,
            `Task posthook failed after 3 attempts: ${task.id}`,
            leaseOwnerId,
          );
          return { kind: "publication_failed", taskId: task.id };
        }
        throw new TaskPosthookFailedError(task.id);
      }

      const claimed = this.repo.getClaimedTask();
      if (claimed !== undefined) {
        const prehook = await this.hooks.run(
          claimed,
          "prehook",
          leaseOwnerId,
          signal,
        );
        signal?.throwIfAborted();
        if (prehook.kind === "untrusted") return { kind: "idle" };
        if (prehook.kind === "retrying")
          return { kind: "hook_retry", taskId: claimed.id, phase: "prehook" };
        if (prehook.kind === "failed") {
          this.repo.failClaimedTaskHook(claimed.id, leaseOwnerId);
          return { kind: "prehook_failed", taskId: claimed.id };
        }
      }
    }

    if (this.publisher !== undefined) {
      const publishing = this.repo.listPublishingTasks()[0];
      if (publishing !== undefined) {
        try {
          const publication = this.repo.beginPublication({
            taskId: publishing.task.id,
            branch: taskBranchName(publishing.task.id),
            baseBranch: this.publisher.baseBranch,
            commitSha: publishing.implementation.commitSha,
            leaseOwnerId,
          });
          const pullRequest = await this.publisher.publish({
            ...publishing,
            publication,
          });
          signal?.throwIfAborted();
          const pullRequestState = pullRequest.state;
          if (pullRequestState === "CLOSED") {
            throw new Error(
              `Pull request #${pullRequest.number} is closed without merge`,
            );
          }
          this.repo.completePublication({
            taskId: publishing.task.id,
            pullRequest: { ...pullRequest, state: pullRequestState },
            leaseOwnerId,
          });
          return {
            kind: "published",
            taskId: publishing.task.id,
            pullRequestNumber: pullRequest.number,
          };
        } catch (error) {
          signal?.throwIfAborted();
          this.repo.failPublishing(
            publishing.task.id,
            publicationFailureMessage(error),
            leaseOwnerId,
          );
          return { kind: "publication_failed", taskId: publishing.task.id };
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
