import { expect, test } from "bun:test";
import {
  renderTaskBoard,
  type TaskBoardSnapshot,
} from "../../src/cli/task-board-renderer";

const ansiSgrPattern = "\\u001B\\[[0-9;]*m";

const snapshot: TaskBoardSnapshot = {
  cycleId: "2026-W35",
  activeTaskId: "active",
  tasks: [
    { id: "ready", title: "Ready work", status: "ready", phase: "Plan" },
    {
      id: "active",
      title:
        "Implement board rendering with a deliberately long Unicode title 你好世界",
      status: "implementing",
      activeAttempt: {
        role: "implement",
        model: "gpt-5",
        retryIndex: 1,
        inputTokens: 12,
        outputTokens: 8,
      },
      spec: {
        problem: "No board",
        desiredOutcome: "A readable board",
        acceptanceCriteria: ["It renders"],
        dependencies: ["ready"],
      },
    },
    {
      id: "blocked",
      title: "Needs input",
      status: "needs_input",
      blockedBy: ["ready"],
    },
    { id: "done", title: "Finished work", status: "done" },
    { id: "done-2", title: "Second finished work", status: "done" },
  ],
};

test("renders columns, compact state, collapsed Done, and a right-side detail panel", () => {
  const output = renderTaskBoard(snapshot, {
    width: 120,
    color: false,
    selectedTaskId: "active",
  });

  expect(output).toContain("Ready (1)");
  expect(output).toContain("In progress (1)");
  expect(output).toContain("Attention (1)");
  expect(output).toContain("Done (2)");
  expect(output).toContain("collapsed");
  expect(output).toContain("● active");
  expect(output).toContain("Blocked: ready");
  expect(output).toContain("Problem: No board");
  expect(output).toContain("Desired outcome: A readable board");
  expect(output).toContain("Acceptance criteria:");
  expect(
    output.split("\n").every((line) => Array.from(line).length <= 120),
  ).toBe(true);
});

test("uses a vertical list and full-screen detail in narrow terminals", () => {
  const list = renderTaskBoard(snapshot, {
    width: 60,
    color: false,
    doneExpanded: true,
  });
  const detail = renderTaskBoard(snapshot, {
    width: 60,
    color: false,
    selectedTaskId: "active",
  });

  expect(list).toContain("Done (2)");
  expect(list).toContain("Finished work");
  expect(list.indexOf("Finished work")).toBeLessThan(
    list.indexOf("Second finished work"),
  );
  expect(detail).toStartWith("Task active");
  expect(detail).not.toContain("Ready (1)");
  expect(detail).toContain("Role: implement");
  expect(detail).toContain("Tokens: 20");
});

test("keeps plain output ANSI-free and truncates Unicode titles safely", () => {
  const plain = renderTaskBoard(
    {
      ...snapshot,
      tasks: [{ id: "unicode", title: "你好世界".repeat(20), status: "ready" }],
    },
    { width: 40, isTTY: false },
  );

  expect(plain).not.toMatch(new RegExp(ansiSgrPattern));
  expect(plain).toContain("…");
  expect(plain).not.toContain("�");
  expect(plain.split("\n").every((line) => Array.from(line).length <= 40)).toBe(
    true,
  );
});

test("guides users when the cycle has no tasks", () => {
  expect(renderTaskBoard({ cycleId: "2026-W35" }, { color: false })).toContain(
    "No tasks in this cycle.",
  );
});
