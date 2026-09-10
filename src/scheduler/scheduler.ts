import type { TaskPublisher } from "../github/pr-publisher";
import type { AgentHarness, HarnessStepRequest } from "../harness/contracts";
import type { OrchestrationRepository } from "../store/orchestration-repository";
import { taskBranchName } from "../workspace/task-branch";
import type { TaskHookService } from "./task-hooks";

export type TickResult =
  | {
      kind: "delivery";
      attemptId: string;
      eventId: string;
      roleEnded?: boolean;
    }
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

type PendingTick = { taskId: string } & (
  | { ok: true; result: TickResult }
  | { ok: false; error: unknown }
);

export class Scheduler {
  private readonly reconcile = new Set<string>();
  private readonly pending = new Map<string, Promise<PendingTick>>();

  /** Creates a scheduler and marks any recovered running attempt for reconciliation. */
  constructor(
    private readonly repo: OrchestrationRepository,
    private readonly harness: AgentHarness,
    private readonly fault: (point: SchedulerFaultPoint) => void = () => {},
    private readonly hooks?: TaskHookService,
    private readonly publisher?: TaskPublisher,
    private readonly remoteOnly = false,
    private readonly localOnly = false,
    private readonly concurrency = 1,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new Error("Concurrency must be an integer from 1 through 8");
    for (const active of repo.getRunningAttempts())
      this.reconcile.add(active.descriptor.attemptId);
  }

  /** Advances one orchestration step unless its owning session has sealed continuation. */
  async tick(
    leaseOwnerId?: string,
    signal?: AbortSignal,
    allowStart = true,
  ): Promise<TickResult> {
    signal?.throwIfAborted();
    if (allowStart && this.pending.size < this.concurrency) {
      const claimed = this.repo.claimNext(
        leaseOwnerId,
        this.remoteOnly,
        this.localOnly,
        this.concurrency,
      );
      if (claimed) return { kind: "task_claimed", taskId: claimed.taskId };
    }
    const candidates = new Set(this.repo.activeTaskIds());
    if (allowStart && this.hooks !== undefined) {
      for (const task of this.repo.listPosthookTasks()) {
        if (
          task.spec.posthook !== undefined &&
          this.repo.getTaskHook(task.id, "posthook")?.status !== "succeeded"
        )
          candidates.add(task.id);
      }
    }
    for (const taskId of candidates) {
      if (this.pending.size >= this.concurrency) break;
      if (
        this.pending.has(taskId) ||
        (!allowStart && this.repo.getRunningAttempt(taskId) === undefined)
      )
        continue;
      const work = this.tickTask(taskId, leaseOwnerId, signal).then(
        (result): PendingTick => ({ taskId, ok: true, result }),
        (error: unknown): PendingTick => ({ taskId, ok: false, error }),
      );
      this.pending.set(taskId, work);
    }
    while (this.pending.size > 0) {
      const completed = await Promise.race(this.pending.values());
      this.pending.delete(completed.taskId);
      if (!completed.ok) throw completed.error;
      if (completed.result.kind !== "idle") return completed.result;
    }
    return { kind: "idle" };
  }

  /** Waits for every owned task step before the daemon closes its database. */
  async drain(): Promise<void> {
    const results = await Promise.all(this.pending.values());
    for (const result of results) {
      if (!result.ok) throw result.error;
    }
  }

  /** Advances one task without reading or switching another task's active attempt. */
  private async tickTask(
    taskId: string,
    leaseOwnerId?: string,
    signal?: AbortSignal,
  ): Promise<TickResult> {
    signal?.throwIfAborted();
    const running = this.repo.getRunningAttempt(taskId);
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
      return {
        kind: "delivery",
        attemptId,
        eventId: delivery.event.eventId,
        ...([
          "attempt.completed",
          "attempt.failed_infra",
          "attempt.blocked_policy",
        ].includes(delivery.event.type)
          ? { roleEnded: true }
          : {}),
      };
    }

    if (this.hooks !== undefined) {
      for (const task of this.repo
        .listPosthookTasks()
        .filter((task) => task.id === taskId)) {
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

      const claimed = this.repo.getTask(taskId);
      if (claimed?.status === "claimed") {
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
      const publishing = this.repo
        .listPublishingTasks()
        .find((entry) => entry.task.id === taskId);
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

    const started = this.repo.beginNextAttempt(leaseOwnerId, taskId);
    if (started)
      return { kind: "attempt_started", attemptId: started.attemptId };
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
