import type { Scheduler, TickResult } from "./scheduler";

export type LeaseStore = {
  acquireLease(ownerId: string, now: string, expiresAt: string): boolean;
  heartbeatLease(ownerId: string, now: string, expiresAt: string): boolean;
  releaseLease(ownerId: string): boolean;
};

type Runtime = {
  ownerId: string;
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
};

export class SchedulerDaemon {
  constructor(
    private readonly scheduler: Pick<Scheduler, "tick">,
    private readonly leases: LeaseStore,
    private readonly runtime: Runtime,
  ) {}

  async run(shouldStop: () => boolean): Promise<void> {
    const leaseTimes = () => {
      const now = this.runtime.now();
      return {
        now: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10_000).toISOString(),
      };
    };
    let times = leaseTimes();
    if (!this.leases.acquireLease(this.runtime.ownerId, times.now, times.expiresAt)) {
      throw new Error("Scheduler lease is already held");
    }
    let nextHeartbeat = this.runtime.now().getTime() + 3_000;
    try {
      while (!shouldStop()) {
        const result: TickResult = await this.scheduler.tick();
        const now = this.runtime.now();
        if (now.getTime() >= nextHeartbeat) {
          times = leaseTimes();
          if (!this.leases.heartbeatLease(this.runtime.ownerId, times.now, times.expiresAt)) {
            throw new Error("Scheduler lease was lost");
          }
          nextHeartbeat = now.getTime() + 3_000;
        }
        if (result.kind === "idle") await this.runtime.sleep(1_000);
      }
    } finally {
      this.leases.releaseLease(this.runtime.ownerId);
    }
  }
}
