import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type {
  TaskBoardSnapshot,
  TaskBoardTask,
} from "../../src/cli/task-board-model";
import {
  renderTaskBoard,
  taskBoardHitTest,
} from "../../src/cli/task-board-renderer";

const tokens = {
  inputTokens: 12,
  cachedInputTokens: 2,
  outputTokens: 8,
  reasoningOutputTokens: 3,
};
const spec = {
  problem:
    "No readable board with a deliberately long explanation that must wrap.",
  desiredOutcome:
    "A readable board with detailed task information that also wraps.",
  scope: ["task board"],
  nonGoals: [],
  acceptanceCriteria: [
    "A deliberately long acceptance criterion remains readable in the detail panel.",
  ],
  validation: ["bun test"],
  dependencies: ["ready"],
  risk: "medium" as const,
  contextCandidates: [],
  tokenCeiling: 1_000,
};

/** Creates a canonical task-board task with overridable board-facing fields. */
function task(
  input: Partial<TaskBoardTask> & Pick<TaskBoardTask, "id">,
): TaskBoardTask {
  return {
    cycleId: "2026-W35",
    title: `${input.id} work`,
    rawStatus: "ready",
    column: "ready",
    priority: 0,
    dependencies: [],
    blockingDependencyIds: [],
    isActive: false,
    spec,
    attempts: [],
    modelDecisions: [],
    roles: [],
    tokenTarget: 100,
    tokenTotals: tokens,
    ...input,
    id: input.id,
  };
}

const ready = task({ id: "ready", title: "Ready work" });
const active = task({
  id: "active",
  title:
    "Implement board rendering with a deliberately long Unicode title 你好世界",
  rawStatus: "implementing",
  column: "inProgress",
  isActive: true,
  attempts: [
    {
      id: "attempt-active",
      role: "implement",
      modelProfile: "terra",
      model: "gpt-5",
      effort: "high",
      status: "running",
      retryIndex: 1,
      ...tokens,
    },
  ],
});
const blocked = task({
  id: "blocked",
  title: "Needs input",
  rawStatus: "needs_input",
  column: "attention",
  blockingDependencyIds: ["ready"],
});
const done = task({
  id: "done",
  title: "Finished work",
  rawStatus: "done",
  column: "done",
});
const doneTwo = task({
  id: "done-2",
  title: "Second finished work",
  rawStatus: "done",
  column: "done",
});
const snapshot: TaskBoardSnapshot = {
  currentCycleId: "2026-W35",
  scheduler: { activeTaskId: "active", activeAttemptId: "attempt-active" },
  active: {
    taskId: "active",
    attemptId: "attempt-active",
    role: "implement",
    model: "gpt-5",
    retryCount: 1,
  },
  cycles: [{ id: "2026-W35", tokenTarget: 1_000, actual: tokens }],
  tasks: [ready, active, blocked, done, doneTwo],
  columns: {
    ready: [ready],
    inProgress: [active],
    attention: [blocked],
    done: [done, doneTwo],
  },
};

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Counts terminal cells for the CJK and emoji cases exercised below. */
function displayWidth(value: string): number {
  return Array.from(graphemes.segment(stripVTControlCharacters(value))).reduce(
    (width, { segment }) =>
      width +
      (/\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uffef]/u.test(
        segment,
      )
        ? 2
        : 1),
    0,
  );
}

test("renders canonical model columns, compact state, and a right-side detail panel", () => {
  const output = renderTaskBoard(snapshot, {
    width: 120,
    color: false,
    selectedTaskId: "active",
  });

  expect(output).toContain(
    "Cycle 2026-W35 · 5 tasks · 1 active · 20 / 1000 tok",
  );
  expect(output).toContain("Ready · 1");
  expect(output).toContain("In progress · 1");
  expect(output).toContain("Attention · 1");
  expect(output).toContain("Done · 2");
  expect(output).toContain("[d] expand");
  expect(output).toContain("● active");
  expect(output).toContain("blocked by re");
  expect(output).toContain("Status");
  expect(output).toContain("State: implementing");
  expect(output).not.toContain("Phase: implement");
  expect(output).toContain("Execution");
  expect(output).toContain("Attempt: attempt-active");
  expect(output).toContain("Model: gpt-5");
  expect(output).toContain("Retry: 1");
  expect(output).toContain("Tokens: 20/100");
});

test("separates cards while retaining their narrow and wide mouse rows", () => {
  const first = task({ id: "first" });
  const second = task({ id: "second" });
  const twoReady: TaskBoardSnapshot = {
    ...snapshot,
    tasks: [first, second],
    columns: {
      ready: [first, second],
      inProgress: [],
      attention: [],
      done: [],
    },
  };

  const wide = renderTaskBoard(twoReady, { width: 120, color: false });
  const narrow = renderTaskBoard(twoReady, { width: 60, color: false });

  expect(wide).toContain("first work");
  expect(narrow).toContain("second work");
  expect(
    taskBoardHitTest(twoReady, { x: 1, y: 7 }, { width: 120 }),
  ).toBeUndefined();
  expect(taskBoardHitTest(twoReady, { x: 1, y: 8 }, { width: 120 })).toEqual({
    kind: "task",
    taskId: "second",
  });
  expect(
    taskBoardHitTest(twoReady, { x: 1, y: 6 }, { width: 60 }),
  ).toBeUndefined();
  expect(taskBoardHitTest(twoReady, { x: 1, y: 7 }, { width: 60 })).toEqual({
    kind: "task",
    taskId: "second",
  });
});

test("compacts numeric card IDs without changing canonical hit-test IDs", () => {
  const numeric = task({ id: "phase7-TASK-012", title: "Numeric work" });
  const allZero = task({ id: "all-000", title: "Zero work" });
  const longNumeric = task({
    id: "batch-000123456789012345678901234567890",
    title: "Long work",
  });
  const noDigits = task({ id: "no-digits", title: "Fallback work" });
  const compactSnapshot: TaskBoardSnapshot = {
    ...snapshot,
    tasks: [numeric, allZero, longNumeric, noDigits],
    columns: {
      ready: [numeric, allZero, longNumeric, noDigits],
      inProgress: [],
      attention: [],
      done: [],
    },
  };

  const wide = renderTaskBoard(compactSnapshot, { width: 200, color: false });
  const narrow = renderTaskBoard(compactSnapshot, {
    width: 80,
    color: false,
  });

  for (const output of [wide, narrow]) {
    expect(output).toContain("12  Numeric work");
    expect(output).toContain("0  Zero work");
    expect(output).toContain("no-digits  Fallback work");
    expect(output).not.toContain("phase7-TASK-012  Numeric work");
  }
  expect(narrow).toContain("123456789012345678901234567890  Long work");
  expect(
    taskBoardHitTest(compactSnapshot, { x: 1, y: 5 }, { width: 200 }),
  ).toEqual({ kind: "task", taskId: "phase7-TASK-012" });
  expect(
    taskBoardHitTest(compactSnapshot, { x: 1, y: 4 }, { width: 80 }),
  ).toEqual({ kind: "task", taskId: "phase7-TASK-012" });
});

test("omits empty optional detail groups without placeholder noise", () => {
  const sparse = task({
    id: "sparse",
    spec: {
      ...spec,
      problem: "",
      desiredOutcome: "",
      acceptanceCriteria: [],
      dependencies: [],
    },
  });
  const sparseSnapshot: TaskBoardSnapshot = {
    ...snapshot,
    tasks: [sparse],
    columns: { ready: [sparse], inProgress: [], attention: [], done: [] },
  };
  const detail = renderTaskBoard(sparseSnapshot, {
    width: 60,
    color: false,
    detailTaskId: sparse.id,
    detailMode: "full",
  });

  expect(detail).toContain("Status");
  expect(detail).toContain("State: ready");
  expect(detail).toContain("Execution");
  expect(detail).toContain("Tokens: 20/100");
  expect(detail).not.toContain("Dependencies");
  expect(detail).not.toContain("Brief");
  expect(detail).not.toContain("Role:");
  expect(detail).not.toContain("Attempt:");
  expect(detail).not.toContain("—");
});

test("pads colored wide columns and keeps ANSI resets intact", () => {
  const output = renderTaskBoard(snapshot, {
    width: 120,
    color: true,
    selectedTaskId: "active",
    doneExpanded: true,
  });
  const boardLines = output
    .split("\n")
    .map((line) => stripVTControlCharacters(line))
    .filter((line) => line.split(" │ ").length === 5);

  expect(boardLines).not.toHaveLength(0);
  expect(new Set(boardLines.map((line) => line.indexOf(" │ "))).size).toBe(1);
  expect(output).toContain("\u001B[0m");
  const footer = output.split("\n").at(-1) ?? "";
  expect(stripVTControlCharacters(footer)).toBe(footer);
});

test("uses a vertical list and full-screen wrapped detail in narrow terminals", () => {
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

  expect(list.indexOf("Finished work")).toBeLessThan(
    list.indexOf("Second finished work"),
  );
  expect(detail).toStartWith("Task active");
  expect(detail).not.toContain("Ready · 1");
  expect(detail).toContain(
    "Problem: No readable board with a deliberately long",
  );
  expect(detail).toContain("Outcome: A readable board with detailed task");
  expect(detail).toContain("Acceptance");
  expect(detail.split("\n").every((line) => displayWidth(line) <= 60)).toBe(
    true,
  );
});

test("wraps colored failed statuses and blockers without splitting ANSI controls", () => {
  const failed = task({
    id: "failed",
    rawStatus: "failed_infra",
    column: "attention",
    blockingDependencyIds: [
      "dependency-alpha",
      "dependency-bravo",
      "dependency-charlie",
    ],
  });
  const failedSnapshot: TaskBoardSnapshot = {
    ...snapshot,
    tasks: [failed],
    columns: { ready: [], inProgress: [], attention: [failed], done: [] },
  };
  const colored = renderTaskBoard(failedSnapshot, {
    width: 16,
    color: true,
    selectedTaskId: failed.id,
  });
  const plain = renderTaskBoard(failedSnapshot, {
    width: 16,
    color: false,
    selectedTaskId: failed.id,
  });

  expect(colored).toContain("\u001B[31m");
  expect(colored).toContain("\u001B[33m");
  const ansiColorPattern = new RegExp(
    `${String.fromCharCode(27)}\\[[0-9;]*m`,
    "g",
  );
  expect(colored.replace(ansiColorPattern, "")).not.toContain("\u001B");
  expect(
    stripVTControlCharacters(colored)
      .split("\n")
      .every((line) => displayWidth(line) <= 16),
  ).toBe(true);
  expect(stripVTControlCharacters(plain)).toBe(plain);
});

test("honors NO_COLOR even when an interactive frame requests color", () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const output = renderTaskBoard(snapshot, {
      width: 120,
      selectedTaskId: "active",
    });

    expect(stripVTControlCharacters(output)).toBe(output);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test("keeps plain Unicode output cell-bounded without splitting graphemes", () => {
  const unicode = task({ id: "unicode", title: "你好e\u0301👩‍💻".repeat(20) });
  const unicodeSnapshot: TaskBoardSnapshot = {
    ...snapshot,
    tasks: [unicode],
    columns: { ready: [unicode], inProgress: [], attention: [], done: [] },
  };
  const output = renderTaskBoard(unicodeSnapshot, { width: 20, isTTY: false });

  expect(stripVTControlCharacters(output)).toBe(output);
  expect(output).toContain("…");
  expect(output).not.toContain("�");
  expect(output.split("\n").every((line) => displayWidth(line) <= 20)).toBe(
    true,
  );
});

test("removes stored terminal controls from plain task details", () => {
  const unsafe = task({
    id: "\u001B[31munsafe\u001B[0m",
    title: "\u001B[2J\u001B[32mUnsafe title\u001B[0m",
    spec: {
      ...spec,
      problem:
        "\u001B]8;;https://example.com\u001B\\Unsafe problem\u001B]8;;\u001B\\",
      desiredOutcome: "\u001B[34mUnsafe outcome\u001B[0m",
      acceptanceCriteria: ["\u001B[35mUnsafe criterion\u001B[0m"],
      dependencies: ["\u001B[36munsafe-dependency\u001B[0m"],
    },
  });
  const unsafeSnapshot: TaskBoardSnapshot = {
    ...snapshot,
    tasks: [unsafe],
    columns: { ready: [unsafe], inProgress: [], attention: [], done: [] },
  };
  const output = renderTaskBoard(unsafeSnapshot, {
    width: 120,
    isTTY: false,
    detailTaskId: unsafe.id,
    detailMode: "full",
  });

  expect(stripVTControlCharacters(output)).toBe(output);
  expect(output).toContain("Task unsafe");
  expect(output).toContain("Unsafe title");
  expect(output).toContain("Unsafe problem");
  expect(output).toContain("Unsafe outcome");
  expect(output).toContain("Unsafe criterion");
  expect(output).toContain("unsafe-dependency");
});

test("keeps widths below forty bounded and frames empty boards completely", () => {
  const empty: TaskBoardSnapshot = {
    currentCycleId: "2026-W35",
    scheduler: {},
    cycles: [],
    tasks: [],
    columns: { ready: [], inProgress: [], attention: [], done: [] },
  };
  const output = renderTaskBoard(empty, { width: 24, color: false });

  expect(output).toContain("Cycle 2026-W35");
  expect(output).toContain("Ready · 0");
  expect(output).toContain("In progress · 0");
  expect(output).toContain("Attention · 0");
  expect(output).toContain("Done · 0");
  expect(output).toContain("No tasks.");
  expect(output).toContain("/roc-create-tasks");
  expect(output).toContain("$roc-create-tasks");
  expect(output).toContain("↑↓ move");
  expect(output.split("\n").every((line) => displayWidth(line) <= 24)).toBe(
    true,
  );
});

test("keeps selected details bounded when labels exceed the terminal width", () => {
  const output = renderTaskBoard(snapshot, {
    width: 10,
    color: false,
    selectedTaskId: "active",
  });

  expect(output.split("\n").every((line) => displayWidth(line) <= 10)).toBe(
    true,
  );
});
