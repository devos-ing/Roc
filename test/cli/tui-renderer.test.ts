import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
  renderTuiFrame,
  renderWelcome,
  tabTargets,
} from "../../src/cli/tui-renderer";

test("reveals only out-of-view cards without undoing manual paging", () => {
  const options = {
    tab: "tasks" as const,
    width: 80,
    rows: 24,
    scroll: 20,
    body: Array.from({ length: 100 }, (_, index) => `row ${index}`).join("\n"),
    status: "Read-only",
  };
  const paged = renderTuiFrame(options);
  expect(paged.scroll).toBe(20);
  expect(
    renderTuiFrame({ ...options, revealRows: { start: 20, end: 22 } }).scroll,
  ).toBe(20);
  expect(
    renderTuiFrame({ ...options, revealRows: { start: 0, end: 2 } }).scroll,
  ).toBe(0);
  const below = renderTuiFrame({
    ...options,
    revealRows: { start: 60, end: 64 },
  });
  expect(below.scroll).toBe(64 - below.bodyRows);
  expect(below.text).toContain("row 60\nrow 61\nrow 62\nrow 63");
});

test("shared tabs and bordered Welcome fit narrow and short viewports", () => {
  for (const width of [1, 10, 20, 40, 80]) {
    for (const rows of [1, 6, 24]) {
      const frame = renderTuiFrame({
        tab: "welcome",
        width,
        rows,
        scroll: 0,
        body: renderWelcome(width),
        status: "Setup needs attention. GitHub connection not checked.",
      });
      const lines = stripVTControlCharacters(frame.text).split("\n");
      expect(lines.length).toBeLessThanOrEqual(rows);
      for (const line of lines)
        expect(Array.from(line).length).toBeLessThanOrEqual(width);
    }
  }
  const frame = renderTuiFrame({
    tab: "tasks",
    width: 80,
    rows: 24,
    scroll: 100,
    body: "one\ntwo",
    status: "Read-only",
  });
  const tabs = stripVTControlCharacters(frame.text).split("\n")[0] ?? "";
  for (const target of tabTargets())
    expect(tabs.slice(target.start - 1, target.end)).toBe(target.text);
  expect(frame.scroll).toBe(0);
  expect(frame.text).toContain("\u001B[1;7m 2 Tasks ");
});
