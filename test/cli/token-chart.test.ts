import { expect, test } from "bun:test";
import { currentIsoWeekId, formatTokenReport } from "../../src/cli/token-chart";

const raw = [
  { category: "review", inputTokens: 50, outputTokens: 10 },
  { category: "implement", inputTokens: 100, outputTokens: 20 },
  { category: "weekly_grilling", inputTokens: 5, outputTokens: 5 },
  { category: "ticket_grilling", inputTokens: 10, outputTokens: 0 },
  { category: "unrecognized", inputTokens: 3, outputTokens: 2 },
];

test("normalizes, combines, ranks, and totals workflow categories", () => {
  expect(formatTokenReport("2026-W35", raw)).toBe([
    "Token usage · 2026-W35",
    "",
    "Implement  120 tokens   59%",
    "Review      60 tokens   29%",
    "Grilling    20 tokens   10%",
    "Other        5 tokens    2%",
    "",
    "Total: 205 tokens",
  ].join("\n"));
});

test("shows only known categories when a present week has no usage", () => {
  const output = formatTokenReport("2026-W35", []);
  expect(output).toContain("Scout");
  expect(output).toContain("Implement");
  expect(output).toContain("Review");
  expect(output).toContain("Advisor");
  expect(output).toContain("Grilling");
  expect(output).not.toContain("Other");
  expect(output).toContain("Total: 0 tokens");
});

test("computes local-calendar ISO week IDs across a year boundary", () => {
  expect(currentIsoWeekId(new Date(2026, 7, 26))).toBe("2026-W35");
  expect(currentIsoWeekId(new Date(2027, 0, 1))).toBe("2026-W53");
});
