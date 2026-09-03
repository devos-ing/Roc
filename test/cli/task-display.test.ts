import { expect, test } from "bun:test";
import {
  colorTaskDisplay,
  formatTaskDisplayId,
  taskStatusTone,
} from "../../src/cli/task-display";

test("formats final ASCII digit segments without changing canonical no-digit IDs", () => {
  expect(formatTaskDisplayId("phase7-TASK-012", "roc")).toBe("#roc-12");
  expect(formatTaskDisplayId("all-000", "roc")).toBe("#roc-0");
  expect(
    formatTaskDisplayId("batch-000123456789012345678901234567890", "roc"),
  ).toBe("#roc-123456789012345678901234567890");
  expect(formatTaskDisplayId("no-digits", "roc")).toBe("no-digits");
});

test("uses the shared status palette with canonical active identity precedence", () => {
  expect(taskStatusTone("done", "active-1", "active-1")).toBe("done");
  expect(taskStatusTone("failed_infra", "task-1", undefined)).toBe("error");
  expect(taskStatusTone("rejected", "task-1", undefined)).toBe("error");
  expect(taskStatusTone("needs_input", "task-1", undefined)).toBe("attention");
  expect(taskStatusTone("needs_replan", "task-1", undefined)).toBe("attention");
  expect(taskStatusTone("implementing", "active-1", "active-1")).toBe("active");
  expect(taskStatusTone("scouting", "task-1", undefined)).toBe("muted");
  expect(taskStatusTone("publishing", "task-1", undefined)).toBe("muted");
  expect(colorTaskDisplay("ready", "muted", false)).toBe("ready");
  expect(colorTaskDisplay("ready", "muted", true)).toBe(
    "\u001B[90mready\u001B[0m",
  );
});
