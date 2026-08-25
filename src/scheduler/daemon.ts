import type { Scheduler, TickResult } from "./scheduler";

export type LeaseStore = {
  acquireLease(ownerId: string, now: string, expiresAt: string): boolean;
  heartbeatLease(ownerId: string, now: string, expiresAt: string): boolean;
  releaseLease(ownerId: string): boolean;
};

type Runtime = {
  ownerId: string;
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
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
        timestamp: now.getTime(),
        now: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10_000).toISOString(),
      };
    };
    let times = leaseTimes();
    if (!this.leases.acquireLease(this.runtime.ownerId, times.now, times.expiresAt)) {
      throw new Error("Scheduler lease is already held");
    }
    let nextHeartbeat = times.timestamp + 3_000;
    const heartbeat = () => {
      times = leaseTimes();
      if (!this.leases.heartbeatLease(this.runtime.ownerId, times.now, times.expiresAt)) {
        throw new Error("Scheduler lease was lost");
      }
      nextHeartbeat = times.timestamp + 3_000;
    };
    const tickWithHeartbeats = async (): Promise<TickResult> => {
      const tick = this.scheduler.tick();
      let stopHeartbeats = false;
      let activeWait: AbortController | undefined;
      const heartbeats = (async () => {
        while (!stopHeartbeats) {
          const controller = new AbortController();
          activeWait = controller;
          try {
            const delay = Math.max(0, nextHeartbeat - this.runtime.now().getTime());
            await this.runtime.sleep(delay, controller.signal);
          } catch (error) {
            if (stopHeartbeats && controller.signal.aborted) return;
            throw error;
          } finally {
            if (activeWait === controller) activeWait = undefined;
          }
          if (!stopHeartbeats) heartbeat();
        }
      })();
      try {
        // Lease loss stops the daemon, but the already-started durable tick has no cancellation contract.
        return await Promise.race([tick, heartbeats as Promise<never>]);
      } finally {
        stopHeartbeats = true;
        activeWait?.abort();
        await heartbeats;
      }
    };
    try {
      while (!shouldStop()) {
        const result = await tickWithHeartbeats();
        if (this.runtime.now().getTime() >= nextHeartbeat) heartbeat();
        if (result.kind === "idle") await this.runtime.sleep(1_000);
      }
    } finally {
      this.leases.releaseLease(this.runtime.ownerId);
    }
  }
}
