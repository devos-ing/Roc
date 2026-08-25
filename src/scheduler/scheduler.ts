import type { AgentHarness, HarnessStepRequest } from "../harness/contracts";
import type { OrchestrationRepository } from "../store/orchestration-repository";

export type TickResult =
  | { kind: "delivery"; attemptId: string; eventId: string }
  | { kind: "attempt_started"; attemptId: string }
  | { kind: "task_claimed"; taskId: string }
  | { kind: "idle" };

export type SchedulerFaultPoint = "after_delivery_commit";

export class Scheduler {
  private readonly reconcile = new Set<string>();

  constructor(
    private readonly repo: OrchestrationRepository,
    private readonly harness: AgentHarness,
    private readonly fault: (point: SchedulerFaultPoint) => void = () => {},
  ) {
    const active = repo.getRunningAttempt();
    if (active) this.reconcile.add(active.descriptor.attemptId);
  }

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
      if (delivery.kind === "closed") throw new Error(`Harness closed before attempt completion: ${attemptId}`);
      this.repo.applyHarnessEvent(attemptId, delivery.nextCursor, delivery.event, leaseOwnerId);
      this.fault("after_delivery_commit");
      return { kind: "delivery", attemptId, eventId: delivery.event.eventId };
    }

    const started = this.repo.beginNextAttempt();
    if (started) return { kind: "attempt_started", attemptId: started.attemptId };
    const claimed = this.repo.claimNext();
    if (claimed) return { kind: "task_claimed", taskId: claimed.taskId };
    return { kind: "idle" };
  }

  async runUntilIdle(maxTicks: number): Promise<void> {
    for (let tick = 0; tick < maxTicks; tick += 1) {
      if ((await this.tick()).kind === "idle") return;
    }
    throw new Error(`Scheduler exceeded ${maxTicks} ticks`);
  }
}
