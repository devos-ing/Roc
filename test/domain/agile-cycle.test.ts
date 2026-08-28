import { describe, expect, test } from "bun:test";
import { activeAgileCycle } from "../../src/domain/agile-cycle";

describe("activeAgileCycle", () => {
  test("uses the current local calendar day for Daily", () => {
    expect(
      activeAgileCycle({ type: "daily" }, new Date(2026, 7, 28, 23, 59)),
    ).toEqual({
      id: "2026-08-28",
      startDate: "2026-08-28",
      endDate: "2026-08-28",
    });
  });

  test("starts a Weekly cycle on Monday", () => {
    expect(
      activeAgileCycle({ type: "weekly" }, new Date(2026, 7, 31, 12)),
    ).toEqual({
      id: "2026-W36",
      startDate: "2026-08-31",
      endDate: "2026-09-06",
    });
  });

  test("advances a Custom cycle at its duration boundary", () => {
    expect(
      activeAgileCycle(
        { type: "custom", days: 14, anchorDate: "2026-08-01" },
        new Date(2026, 7, 15, 12),
      ),
    ).toEqual({
      id: "2026-08-15-P14D",
      startDate: "2026-08-15",
      endDate: "2026-08-28",
    });
  });

  test("rejects a date before the Custom anchor", () => {
    expect(() =>
      activeAgileCycle(
        { type: "custom", days: 14, anchorDate: "2026-08-15" },
        new Date(2026, 7, 14, 12),
      ),
    ).toThrow("Current date is before the custom cycle anchor");
  });
});
