import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
  renderTuiFrame,
  renderWelcome,
  tabTargets,
} from "../../src/cli/tui-renderer";

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
