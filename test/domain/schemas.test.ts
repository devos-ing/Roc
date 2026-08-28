import { describe, expect, test } from "bun:test";
import {
  AgileCyclePlanSchema,
  ModelDecisionSchema,
  ModelProfileSchema,
  TaskHookSchema,
  TicketSpecSchema,
} from "../../src/domain/schemas";

const ticket = {
  problem: "Tasks can be claimed twice",
  desiredOutcome: "Exactly one worker owns a task",
  scope: ["atomic claim"],
  nonGoals: ["distributed scheduling"],
  acceptanceCriteria: ["two claim attempts yield one owner"],
  validation: ["bun test test/store/claim.test.ts"],
  dependencies: [],
  risk: "high" as const,
  contextCandidates: [],
  tokenCeiling: 60_000,
};

describe("domain schemas", () => {
  test("accepts only supported model profiles", () => {
    for (const profile of ["luna", "terra", "sol"] as const) {
      expect(ModelProfileSchema.parse(profile)).toBe(profile);
    }
    expect(() => ModelProfileSchema.parse("nova")).toThrow();
  });

  test("accepts a complete ticket", () => {
    expect(TicketSpecSchema.parse(ticket)).toEqual(ticket);
  });

  test("accepts one strict argv hook and rejects unsafe hook shapes", () => {
    expect(
      TaskHookSchema.parse({
        command: "codegraph",
        args: ["init", "-i"],
        timeoutSeconds: 120,
      }),
    ).toEqual({
      command: "codegraph",
      args: ["init", "-i"],
      timeoutSeconds: 120,
    });
    expect(() => TaskHookSchema.parse([])).toThrow();
    expect(() =>
      TaskHookSchema.parse({ command: " ", args: [], timeoutSeconds: 1 }),
    ).toThrow();
    expect(() =>
      TaskHookSchema.parse({ command: "x", args: [], timeoutSeconds: 0 }),
    ).toThrow();
    expect(() =>
      TaskHookSchema.parse({
        command: "x",
        args: [],
        timeoutSeconds: 1,
        shell: true,
      }),
    ).toThrow();
  });

  test("rejects an empty acceptance list", () => {
    expect(() =>
      TicketSpecSchema.parse({ ...ticket, acceptanceCriteria: [] }),
    ).toThrow();
  });

  test("rejects low reasoning effort", () => {
    expect(() =>
      ModelDecisionSchema.parse({
        modelProfile: "terra",
        model: "gpt-5.6-terra",
        reasoningEffort: "low",
        tokenBudget: 20_000,
        fallbackModels: [],
        decidedBy: "rule",
        confidence: 1,
        rationale: ["bounded task"],
      }),
    ).toThrow();
  });

  test("accepts an ISO cycle plan", () => {
    expect(
      AgileCyclePlanSchema.parse({
        id: "2026-W35",
        goal: "Ship the foundation slice",
        nonGoals: ["Codex integration"],
        tokenBudget: 500_000,
        ticketIds: ["F1"],
      }).id,
    ).toBe("2026-W35");
  });
});
