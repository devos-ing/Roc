import { expect, test } from "bun:test";
import { SchedulerDaemon } from "../../src/scheduler/daemon";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";

test("allows one lease owner and takeover only after expiry", () => {
  const db = openDatabase(":memory:");
  const repo = new OrchestrationRepository(db);
  try {
    expect(repo.acquireLease("owner-1", "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:10.000Z")).toBe(true);
    expect(repo.acquireLease("owner-2", "2026-08-25T00:00:05.000Z", "2026-08-25T00:00:15.000Z")).toBe(false);
    expect(repo.heartbeatLease("owner-1", "2026-08-25T00:00:11.000Z", "2026-08-25T00:00:21.000Z")).toBe(false);
    expect(repo.acquireLease("owner-2", "2026-08-25T00:00:11.000Z", "2026-08-25T00:00:21.000Z")).toBe(true);
    expect(repo.releaseLease("owner-1")).toBe(false);
    expect(repo.releaseLease("owner-2")).toBe(true);
  } finally {
    db.close();
  }
});

test("polls after idle and releases its lease on stop", async () => {
  const calls: string[] = [];
  let stop = false;
  const scheduler = {
    async tick() {
      calls.push("tick");
      return { kind: "idle" as const };
    },
  };
  const lease = {
    acquireLease() { calls.push("acquire"); return true; },
    heartbeatLease() { calls.push("heartbeat"); return true; },
    releaseLease() { calls.push("release"); return true; },
  };
  const daemon = new SchedulerDaemon(scheduler, lease, {
    ownerId: "owner-1",
    now: () => new Date("2026-08-25T00:00:00.000Z"),
    sleep: async (milliseconds) => { expect(milliseconds).toBe(1_000); stop = true; },
  });

  await daemon.run(() => stop);

  expect(calls).toEqual(["acquire", "tick", "release"]);
});

test("heartbeats every three seconds with a ten-second lease", async () => {
  const calls: string[] = [];
  let now = Date.parse("2026-08-25T00:00:00.000Z");
  let stop = false;
  const scheduler = {
    async tick() {
      calls.push("tick");
      now += 1_000;
      return { kind: "task_claimed" as const, taskId: "T1" };
    },
  };
  const lease = {
    acquireLease(ownerId: string, acquiredAt: string, expiresAt: string) {
      calls.push("acquire");
      expect({ ownerId, acquiredAt, expiresAt }).toEqual({
        ownerId: "owner-1",
        acquiredAt: "2026-08-25T00:00:00.000Z",
        expiresAt: "2026-08-25T00:00:10.000Z",
      });
      return true;
    },
    heartbeatLease(ownerId: string, heartbeatAt: string, expiresAt: string) {
      calls.push("heartbeat");
      expect({ ownerId, heartbeatAt, expiresAt }).toEqual({
        ownerId: "owner-1",
        heartbeatAt: "2026-08-25T00:00:03.000Z",
        expiresAt: "2026-08-25T00:00:13.000Z",
      });
      stop = true;
      return true;
    },
    releaseLease() { calls.push("release"); return true; },
  };
  const daemon = new SchedulerDaemon(scheduler, lease, {
    ownerId: "owner-1",
    now: () => new Date(now),
    sleep: async () => { throw new Error("Busy ticks must not sleep"); },
  });

  await daemon.run(() => stop);

  expect(calls).toEqual(["acquire", "tick", "tick", "tick", "heartbeat", "release"]);
});
