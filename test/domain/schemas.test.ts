import { describe, expect, test } from "bun:test";
import {
  ModelDecisionSchema,
  TicketSpecSchema,
  WeeklyPlanSchema,
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
  test("accepts a complete ticket", () => {
    expect(TicketSpecSchema.parse(ticket)).toEqual(ticket);
  });

  test("rejects an empty acceptance list", () => {
    expect(() => TicketSpecSchema.parse({ ...ticket, acceptanceCriteria: [] })).toThrow();
  });

  test("rejects low reasoning effort", () => {
    expect(() => ModelDecisionSchema.parse({
      model: "gpt-5.6-terra",
      reasoningEffort: "low",
      tokenBudget: 20_000,
      fallbackModels: [],
      decidedBy: "rule",
      confidence: 1,
      rationale: ["bounded task"],
    })).toThrow();
  });

  test("accepts an ISO week plan", () => {
    expect(WeeklyPlanSchema.parse({
      id: "2026-W35",
      goal: "Ship the foundation slice",
      nonGoals: ["Codex integration"],
      tokenBudget: 500_000,
      ticketIds: ["F1"],
    }).id).toBe("2026-W35");
  });
});
