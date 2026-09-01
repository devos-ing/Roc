import { describe, expect, test } from "bun:test";
import {
  assertTransition,
  canTransition,
  isTerminal,
} from "../../src/domain/transitions";

describe("task transitions", () => {
  test("allows the happy path", () => {
    expect(canTransition("draft", "ready")).toBe(true);
    expect(canTransition("ready", "claimed")).toBe(true);
    expect(canTransition("reviewing", "publishing")).toBe(true);
    expect(canTransition("publishing", "done")).toBe(true);
  });

  test("permits ready tasks to return for input or replanning", () => {
    expect(canTransition("ready", "needs_input")).toBe(true);
    expect(canTransition("ready", "needs_replan")).toBe(true);
  });

  test("permits every active task state to return for replanning", () => {
    for (const status of [
      "claimed",
      "scouting",
      "implementing",
      "reviewing",
      "publishing",
    ] as const) {
      expect(canTransition(status, "needs_replan")).toBe(true);
    }
  });

  test("never reopens terminal tasks", () => {
    for (const status of ["done", "rejected", "failed_infra"] as const) {
      expect(isTerminal(status)).toBe(true);
      expect(canTransition(status, "ready")).toBe(false);
    }
  });

  test("throws a descriptive error for an invalid transition", () => {
    expect(() => assertTransition("rejected", "ready")).toThrow(
      "Invalid task transition: rejected -> ready",
    );
  });
});
