import { expect, test } from "bun:test";
import {
  currentIsoWeekId,
  renderTokenUsageChart,
} from "../../src/cli/token-chart";

const ansiSgrPattern = "\\u001B\\[[0-9;]*m";

const raw = [
  { category: "review", inputTokens: 50, outputTokens: 10 },
  { category: "implement", inputTokens: 100, outputTokens: 20 },
  { category: "weekly_grilling", inputTokens: 5, outputTokens: 5 },
  { category: "ticket_grilling", inputTokens: 10, outputTokens: 0 },
  { category: "unrecognized", inputTokens: 3, outputTokens: 2 },
];

test("normalizes, combines, ranks, and totals workflow categories with proportional colored bars", () => {
  const colored = renderTokenUsageChart("2026-W35", raw, { width: 80 });
  const plain = renderTokenUsageChart("2026-W35", raw, {
    width: 80,
    color: false,
  });
  const advisorColored = renderTokenUsageChart("2026-W35", [
    { category: "advisor", inputTokens: 1, outputTokens: 0 },
  ]);

  expect(colored).toContain("\u001B[32m" + "█".repeat(51) + "\u001B[0m");
  expect(colored).toContain("\u001B[35m" + "█".repeat(26) + "\u001B[0m");
  expect(advisorColored).toContain("\u001B[33m" + "█".repeat(55) + "\u001B[0m");
  expect(colored).toContain("\u001B[34m" + "█".repeat(9) + "\u001B[0m");
  expect(colored).toContain("\u001B[90m" + "█".repeat(2) + "\u001B[0m");
  expect(colored.replace(new RegExp(ansiSgrPattern, "g"), "")).toBe(plain);
  expect(plain).toBe(
    [
      "Token usage · 2026-W35",
      "",
      "Implement  120 tokens   59%  ███████████████████████████████████████████████████",
      "Review      60 tokens   29%  ██████████████████████████",
      "Grilling    20 tokens   10%  █████████",
      "Other        5 tokens    2%  ██",
      "",
      "Total: 205 tokens",
    ].join("\n"),
  );
});

test("shows only known categories when a present week has no usage", () => {
  const output = renderTokenUsageChart("2026-W35", [], { color: false });
  expect(output).toContain("Scout");
  expect(output).toContain("Implement");
  expect(output).toContain("Review");
  expect(output).toContain("Advisor");
  expect(output).toContain("Grilling");
  expect(output).not.toContain("Other");
  expect(output).toContain("Total: 0 tokens");
});

test("uses the 40-column minimum when the requested width is smaller", () => {
  const clamped = renderTokenUsageChart("2026-W35", raw, {
    width: 20,
    color: false,
  });
  const minimum = renderTokenUsageChart("2026-W35", raw, {
    width: 40,
    color: false,
  });

  expect(clamped).toBe(minimum);
  expect(clamped.split("\n").find((line) => line.startsWith("Implement"))).toBe(
    "Implement  120 tokens   59%  ███████████",
  );
});

test("computes local-calendar ISO week IDs across a year boundary", () => {
  expect(currentIsoWeekId(new Date(2026, 7, 26))).toBe("2026-W35");
  expect(currentIsoWeekId(new Date(2027, 0, 1))).toBe("2026-W53");
});
