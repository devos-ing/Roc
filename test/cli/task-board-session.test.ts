import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { runCli } from "../../src/cli/run";
import { runBackendSession } from "../../src/cli/runtime";
import type {
  TaskBoardSnapshot,
  TaskBoardTask,
} from "../../src/cli/task-board-model";
import { runTaskBoardSession } from "../../src/cli/task-board-session";
import type { CliRuntime, SchedulerRunInput } from "../../src/cli/types";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { BunGitHubCommandRunner } from "../../src/github/pr-publisher";
import { createFakeHarness } from "../../src/harness/fake";
import { saveRocSettings } from "../../src/settings";
import { git } from "../helpers/git";
import { memoryPlan } from "../helpers/github-plan";

const tokens = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};
const spec = {
  problem: "Show task state",
  desiredOutcome: "A visible board",
  scope: ["board"],
  nonGoals: [],
  acceptanceCriteria: ["tasks remain read only"],
  validation: ["bun test"],
  dependencies: [],
  risk: "medium" as const,
  contextCandidates: [],
  tokenCeiling: 1_000,
};

/** Creates one task that is sufficient to exercise terminal board navigation. */
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
    acceptanceChecklist: [],
    attempts: [],
    modelDecisions: [],
    roles: [],
    tokenTarget: 1_000,
    tokenTotals: tokens,
    ...input,
    id: input.id,
  };
}

/** Creates a compact canonical snapshot for a session test. */
function board(firstTitle = "first work"): TaskBoardSnapshot {
  const first = task({ id: "first", title: firstTitle });
  const second = task({ id: "second", priority: 1 });
  const done = task({
    id: "done",
    title: "finished work",
    rawStatus: "done",
    column: "done",
    priority: 2,
  });
  return {
    currentCycleId: "2026-W35",
    scheduler: {},
    cycles: [{ id: "2026-W35", tokenTarget: 1_000, actual: tokens }],
    tasks: [first, second, done],
    columns: {
      ready: [first, second],
      inProgress: [],
      attention: [],
      done: [done],
    },
  };
}

class Input extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  paused = false;

  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }
}

class Output extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 60;
  writes: string[] = [];
  failFrame = false;
  deferWriteCallbacks = false;
  private readonly writeCallbacks: (() => void)[] = [];

  write(value: string, callback?: () => void): boolean {
    if (this.failFrame && value.startsWith("\u001B[2J"))
      throw new Error("render failed");
    this.writes.push(value);
    if (callback === undefined) return true;
    if (this.deferWriteCallbacks) this.writeCallbacks.push(callback);
    else callback();
    return true;
  }

  /** Emits a deferred write failure after its write call has returned. */
  failDeferredWrite(error: Error): void {
    queueMicrotask(() => {
      this.emit("error", error);
      this.deferWriteCallbacks = false;
      for (const callback of this.writeCallbacks.splice(0)) callback();
    });
  }
}

/** Waits for a deterministic test-visible state without relying on arbitrary long delays. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for terminal session state");
}

/** Returns the most recently rendered alternate-screen frame. */
function frame(output: Output): string {
  return (
    [...output.writes]
      .reverse()
      .find((entry) => entry.startsWith("\u001B[2J")) ?? ""
  );
}

/** Verifies that a terminal path restored every independently managed terminal mode. */
function expectRestored(input: Input, output: Output): void {
  expect(input.rawModes).toEqual([true, false]);
  expect(output.writes).toContain("\u001B[?1000l\u001B[?1006l");
  expect(output.writes).toContain("\u001B[?25h");
  expect(output.writes).toContain("\u001B[?1049l");
  expect(input.listenerCount("end")).toBe(0);
  expect(input.listenerCount("close")).toBe(0);
  expect(output.listenerCount("error")).toBe(0);
  expect(output.listenerCount("close")).toBe(0);
}

test("refreshes serialized snapshots and supports keyboard navigation, detail modes, help, Done, and quit", async () => {
  const input = new Input();
  const output = new Output();
  let reads = 0;
  const running = runTaskBoardSession({
    input: input as never,
    output: output as never,
    read: () => {
      reads += 1;
      return board();
    },
    refreshIntervalMs: 1_000,
  });

  await waitFor(() => reads === 1);
  input.emit("data", "j");
  expect(stripVTControlCharacters(frame(output))).toContain("▌   second");
  input.emit("data", " ");
  expect(frame(output)).toContain("Task second");
  input.emit("data", "\u001B");
  await Bun.sleep(25);
  expect(frame(output)).toContain("Task second");
  input.emit("data", "\r");
  expect(frame(output)).toContain("Task second");
  input.emit("data", "\u001B");
  await Bun.sleep(25);
  input.emit("data", "?");
  expect(frame(output)).toContain("Task board controls");
  input.emit("data", "\u001B");
  await Bun.sleep(25);
  input.emit("data", "D");
  expect(frame(output)).toContain("finished work");
  input.emit("data", "R");
  await waitFor(() => reads === 2);
  input.emit("data", "Q");
  await running;
  expectRestored(input, output);
});

test("opens clicked cards as full details, toggles Done by mouse, and retains selection after resize", async () => {
  const input = new Input();
  const output = new Output();
  const running = runTaskBoardSession({
    input: input as never,
    output: output as never,
    read: () => board(),
    refreshIntervalMs: 1_000,
  });

  await waitFor(() => frame(output).includes("Ready · 2"));
  const offset = stripVTControlCharacters(frame(output))
    .split("\n")
    .findIndex((line) => line.startsWith("Roc"));
  input.emit("data", `\u001B[<0;1;${7 + offset}M`);
  expect(frame(output)).toContain("Task first");
  input.emit("data", `\u001B[<0;1;${8 + offset}M`);
  expect(frame(output)).toContain("Task second");
  input.emit("data", "\u001B");
  await Bun.sleep(25);
  output.columns = 60;
  output.emit("resize");
  expect(stripVTControlCharacters(frame(output))).toContain("▌   second");
  output.columns = 120;
  output.emit("resize");
  input.emit("data", `\u001B[<0;1;${3 + offset}M`);
  expect(frame(output)).toContain("finished work");
  input.emit("data", "\u0003");
  await running;
  expectRestored(input, output);
});

test.each([120, 80, 40])(
  "keeps keyboard selection visible on a long board at %i columns",
  async (width) => {
    const input = new Input();
    const output = new Output();
    output.columns = width;
    output.rows = 24;
    const tasks = Array.from({ length: 12 }, (_, index) =>
      task({ id: `row-${String(index + 1).padStart(2, "0")}` }),
    );
    const snapshot = {
      ...board(),
      tasks,
      columns: { ready: tasks, inProgress: [], attention: [], done: [] },
    };
    const running = runTaskBoardSession({
      input: input as never,
      output: output as never,
      read: () => snapshot,
    });

    try {
      await waitFor(() => frame(output).includes("Ready · 12"));
      input.emit("data", "jjjjjj");
      expect(stripVTControlCharacters(frame(output))).toMatch(
        /▌[^\n]*row-07 work[^\n]*\n {4}ready/u,
      );
      const selectedFrame = frame(output);
      input.emit("data", "\u001B[6~");
      expect(frame(output)).not.toBe(selectedFrame);
      for (const [keys, expectedId] of [
        ["j", "#project-8"],
        ["\u001B[A", "#project-7"],
        ["k", "#project-6"],
        ["\u001B[5~j", "#project-7"],
        ["jjjjj", "#project-12"],
        ["\u001B[B", "#project-1"],
        ["k", "#project-12"],
      ]) {
        input.emit("data", keys);
        expect(stripVTControlCharacters(frame(output))).toContain(
          `▌   ${expectedId} `,
        );
      }
    } finally {
      input.emit("data", "q");
      await running;
    }
    expectRestored(input, output);
  },
);

test("reveals the selected task after returning from Welcome at a narrower size", async () => {
  const input = new Input();
  const output = new Output();
  output.columns = 120;
  output.rows = 30;
  const tasks = Array.from({ length: 20 }, (_, index) =>
    task({ id: `return-${index + 1}` }),
  );
  const snapshot = {
    ...board(),
    tasks,
    columns: { ready: tasks, inProgress: [], attention: [], done: [] },
  };
  const running = runTaskBoardSession({
    input: input as never,
    output: output as never,
    read: () => snapshot,
  });
  try {
    await waitFor(() => frame(output).includes("Ready · 20"));
    input.emit("data", "j".repeat(19));
    input.emit("data", "1");
    output.columns = 40;
    output.rows = 24;
    output.emit("resize");
    input.emit("data", "2");
    expect(stripVTControlCharacters(frame(output))).toContain("return-20 work");
  } finally {
    input.emit("data", "q");
    await running;
  }
});

test("history keeps Done selectable while ordinary boards hide it", async () => {
  const input = new Input();
  const output = new Output();
  const done = task({ id: "history-done", rawStatus: "done", column: "done" });
  const snapshot = {
    ...board(),
    history: true,
    tasks: [done],
    columns: { ready: [], inProgress: [], attention: [], done: [done] },
  };
  const running = runTaskBoardSession({
    input: input as never,
    output: output as never,
    read: () => snapshot,
  });
  try {
    await waitFor(() => frame(output).includes("history-done"));
    input.emit("data", "\rR");
    await waitFor(() => frame(output).includes("Task history-done"));
  } finally {
    input.emit("data", "q");
    await running;
  }
});

test("pins selected details while scrolling a twenty-task wide list", async () => {
  const input = new Input();
  const output = new Output();
  output.columns = 120;
  output.rows = 30;
  const tasks = Array.from({ length: 20 }, (_, index) =>
    task({ id: `wide-${index + 1}` }),
  );
  const snapshot = {
    ...board(),
    tasks,
    columns: { ready: tasks, inProgress: [], attention: [], done: [] },
  };
  const running = runTaskBoardSession({
    input: input as never,
    output: output as never,
    read: () => snapshot,
  });
  try {
    await waitFor(() => frame(output).includes("Ready · 20"));
    input.emit("data", "j".repeat(19));
    const selected = stripVTControlCharacters(frame(output));
    expect(selected).toContain("wide-20 work");
    expect(selected).toContain("Task wide-20");
    input.emit("data", "\r");
    input.emit("data", "\u001B");
    await Bun.sleep(25);
    expect(stripVTControlCharacters(frame(output))).toContain("wide-20 work");
  } finally {
    input.emit("data", "q");
    await running;
  }
  expectRestored(input, output);
});

test.each([40, 80, 120])(
  "selects across populated columns and clicks scrolled cards at %i columns",
  async (width) => {
    const input = new Input();
    const output = new Output();
    output.columns = width;
    output.rows = 24;
    const tasks = Array.from({ length: 12 }, (_, index) =>
      task({
        id: `mixed-${index + 1}`,
        title: `work ${index + 1}`,
        column: index < 6 ? "ready" : "attention",
        rawStatus: index < 6 ? "ready" : "needs_input",
        blockingDependencyIds: index < 6 ? [] : ["setup"],
      }),
    );
    const snapshot = {
      ...board(),
      tasks,
      columns: {
        ready: tasks.slice(0, 6),
        inProgress: [],
        attention: tasks.slice(6),
        done: [],
      },
    };
    const running = runTaskBoardSession({
      input: input as never,
      output: output as never,
      read: () => snapshot,
    });
    try {
      await waitFor(() => frame(output).includes("Ready · 6"));
      for (const [keys, id] of [
        ["jjjjjj", 7],
        ["\u001B[6~\u001B[B", 8],
        ["\u001B[A", 7],
        ["jjjjj", 12],
        ["j", 1],
        ["k", 12],
      ] as const) {
        input.emit("data", keys);
        const lines = stripVTControlCharacters(frame(output)).split("\n");
        const row = lines.findIndex((line) => line.includes("▌"));
        expect(lines[row]).toContain(`#project-${id} `);
        expect(lines[row + 1]).toContain(id < 7 ? "ready" : "needs_input");
      }
      // The last card is selected below the initial viewport in every layout.
      const lines = stripVTControlCharacters(frame(output)).split("\n");
      const row = lines.findIndex((line) => line.includes("▌"));
      const x = (lines[row]?.indexOf("▌") ?? -1) + 1;
      input.emit("data", `\u001B[<0;${x};${row + 1}M`);
      expect(frame(output)).toContain("Task mixed-12");
    } finally {
      input.emit("data", "q");
      await running;
    }
    expectRestored(input, output);
  },
);

test("keeps the last valid frame on a transient read failure and retries on demand", async () => {
  const input = new Input();
  const output = new Output();
  let reads = 0;
  const running = runTaskBoardSession({
    input: input as never,
    output: output as never,
    read: () => {
      reads += 1;
      if (reads === 2) throw new Error("temporary read failure");
      return board(reads === 3 ? "recovered work" : "first work");
    },
    refreshIntervalMs: 1_000,
  });

  await waitFor(() => reads === 1);
  input.emit("data", "R");
  await waitFor(() => frame(output).includes("temporary read failure"));
  const errorFrame = frame(output);
  expect(errorFrame).toContain("STALE");
  expect(errorFrame).toContain("Last successful read:");
  expect(errorFrame).toContain("saved task progress retained");
  expect(stripVTControlCharacters(errorFrame)).toContain(
    "Error: temporary read failure",
  );
  expect(stripVTControlCharacters(frame(output))).toContain("first work");
  input.emit("data", "R");
  await waitFor(() => frame(output).includes("recovered work"));
  expect(frame(output)).not.toContain("Error:");
  input.emit("data", "q");
  await running;
});

test("does not overlap interval or manual reads", async () => {
  const input = new Input();
  const output = new Output();
  let reads = 0;
  let active = 0;
  let maxActive = 0;
  let release: (() => void) | undefined;
  const running = runTaskBoardSession({
    input: input as never,
    output: output as never,
    read: () => {
      reads += 1;
      if (reads === 1) return board();
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<TaskBoardSnapshot>((resolve) => {
        release = () => {
          active -= 1;
          resolve(board());
        };
      });
    },
    refreshIntervalMs: 5,
  });

  await waitFor(() => reads === 1);
  input.emit("data", "R");
  await waitFor(() => active === 1);
  await Bun.sleep(20);
  input.emit("data", "R");
  expect(maxActive).toBe(1);
  release?.();
  await waitFor(() => reads >= 3);
  input.emit("data", "q");
  await running;
});

test("restores the terminal after input and output closures", async () => {
  for (const event of ["end", "close", "output close"] as const) {
    const input = new Input();
    const output = new Output();
    const running = runTaskBoardSession({
      input: input as never,
      output: output as never,
      read: () => board(),
    });
    await waitFor(() => frame(output).includes("Ready · 2"));
    if (event === "output close") output.emit("close");
    else input.emit(event);
    await running;
    expectRestored(input, output);
  }
});

test("restores the terminal after input, output, and render failures", async () => {
  const inputFailure = new Input();
  const inputOutput = new Output();
  const inputRunning = runTaskBoardSession({
    input: inputFailure as never,
    output: inputOutput as never,
    read: () => board(),
  });
  await waitFor(() => frame(inputOutput).includes("Ready · 2"));
  inputFailure.emit("error", new Error("input failed"));
  await expect(inputRunning).rejects.toThrow("input failed");
  expectRestored(inputFailure, inputOutput);

  const outputInput = new Input();
  const outputFailure = new Output();
  const outputRunning = runTaskBoardSession({
    input: outputInput as never,
    output: outputFailure as never,
    read: () => board(),
  });
  await waitFor(() => frame(outputFailure).includes("Ready · 2"));
  outputFailure.emit("error", new Error("output failed"));
  await expect(outputRunning).rejects.toThrow("output failed");
  expectRestored(outputInput, outputFailure);

  const renderInput = new Input();
  const renderOutput = new Output();
  renderOutput.failFrame = true;
  await expect(
    runTaskBoardSession({
      input: renderInput as never,
      output: renderOutput as never,
      read: () => board(),
    }),
  ).rejects.toThrow("render failed");
  expectRestored(renderInput, renderOutput);
});

test("keeps the output error listener through deferred restoration writes", async () => {
  const input = new Input();
  const output = new Output();
  const running = runTaskBoardSession({
    input: input as never,
    output: output as never,
    read: () => board(),
  });

  await waitFor(() => frame(output).includes("Ready · 2"));
  output.deferWriteCallbacks = true;
  input.emit("data", "q");
  await waitFor(() => output.writes.includes("\u001B[?1000l\u001B[?1006l"));
  output.failDeferredWrite(new Error("late output failure"));
  await running;
  expectRestored(input, output);
});

test("Welcome navigation retains details across keyboard, mouse, resize and paged evidence", async () => {
  const input = new Input();
  const output = new Output();
  output.columns = 80;
  output.rows = 24;
  const snapshot = board();
  const second = snapshot.tasks[1];
  if (!second) throw new Error("Missing fixture task");
  second.issueUrl = "https://github.com/example/repo/issues/2";
  second.pullRequestUrl = "https://github.com/example/repo/pull/3";
  second.acceptanceChecklist = [
    {
      criterionIndex: 0,
      criterion: "read only",
      status: "passed",
      evidence: "fixture evidence",
    },
  ];
  const running = runTaskBoardSession({
    input: input as never,
    output: output as never,
    initialTab: "welcome",
    read: () => snapshot,
  });
  await waitFor(() => frame(output).includes("checkpoints loaded"));
  expect(frame(output)).toContain("Welcome to Roc");
  input.emit("data", "\tj\r");
  expect(frame(output)).toContain("Task second");
  input.emit("data", "1");
  expect(frame(output)).toContain("Welcome to Roc");
  output.columns = 40;
  output.emit("resize");
  input.emit("data", "\u001B[<0;15;1M");
  expect(frame(output)).toContain("Task second");
  const pages: string[] = [frame(output)];
  for (let i = 0; i < 10; i++) {
    input.emit("data", "\u001B[6~");
    pages.push(frame(output));
    expect(frame(output).split("\n").length).toBeLessThanOrEqual(24);
    expect(stripVTControlCharacters(frame(output)).split("\n")[0]).toContain(
      "1 Welcome",
    );
  }
  expect(pages.join("\n")).toContain("Issue:");
  expect(pages.join("\n")).toContain("PR:");
  expect(pages.join("\n")).toContain("fixture evidence");
  input.emit("data", "\u001B[5~");
  input.emit("data", "q");
  await running;
  expectRestored(input, output);
});

test("quit and terminal errors restore immediately during the pending initial read", async () => {
  for (const failure of [false, true]) {
    const input = new Input();
    const output = new Output();
    let release!: (snapshot: TaskBoardSnapshot) => void;
    const running = runTaskBoardSession({
      input: input as never,
      output: output as never,
      initialTab: "welcome",
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    expect(frame(output)).toContain("Welcome to Roc");
    expect(frame(output)).toContain("Checking settings");
    if (failure) {
      output.emit("error", new Error("pending output failure"));
      await expect(running).rejects.toThrow("pending output failure");
    } else {
      input.emit("data", "q");
      await running;
    }
    expectRestored(input, output);
    const writes = output.writes.length;
    release(board());
    await Bun.sleep(1);
    expect(output.writes.length).toBe(writes);
  }
});

test("CLI entries are read only, Welcome survives absent settings and rejected GitHub reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-tui-entry-"));
  let runs = 0;
  let reads = 0;
  let rejectRead = false;
  const runtime = {
    projectRoot: root,
    homeRoot: root,
    async runScheduler() {
      runs++;
    },
    async readTasks() {
      reads++;
      if (rejectRead) throw new Error("GitHub authentication unavailable");
      return githubTaskSnapshot([], []);
    },
  };
  try {
    for (const mode of ["missing", "remote failure", "welcome", "tasks"]) {
      if (mode !== "missing")
        await saveRocSettings({ cycle: { type: "weekly" } }, root);
      rejectRead = mode === "remote failure";
      const input = new Input();
      const output = new Output();
      const errors: string[] = [];
      const running = runCli(
        mode === "tasks" ? ["task", "board"] : ["tui"],
        {
          input: input as never,
          output: output as never,
          out() {},
          err(message) {
            errors.push(message);
          },
        },
        runtime,
      );
      await waitFor(() =>
        frame(output).includes(
          mode === "missing"
            ? "not configured"
            : mode === "remote failure"
              ? "authentication unavailable"
              : "checkpoints loaded",
        ),
      );
      expect(frame(output)).toContain(
        mode === "tasks" ? "GitHub checkpoints" : "Welcome to Roc",
      );
      if (mode === "missing") expect(reads).toBe(0);
      input.emit("data", "q");
      expect(await running).toBe(0);
      expect(errors).toEqual([]);
      expectRestored(input, output);
    }
    expect(runs).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Holds owned work pending so tests can observe cancellation and terminal restoration ordering. */
function controlledSchedulerSession(
  read: () => TaskBoardSnapshot = () => board(),
) {
  const input = new Input();
  const output = new Output();
  const calls = { starts: 0, stops: 0 };
  let work: Promise<void> | undefined;
  let resolveWork: () => void = () => {};
  let rejectWork: (error: Error) => void = () => {};
  let notifyStart: () => void = () => {};
  const session = runTaskBoardSession({
    input: input as never,
    output: output as never,
    read,
    scheduler: {
      preview: "acme/test → main · concurrency 2 · manual merge",
      start() {
        calls.starts++;
        work = new Promise<void>((resolve, reject) => {
          resolveWork = resolve;
          rejectWork = reject;
        });
        return work;
      },
      async stop() {
        calls.stops++;
        await work;
      },
      onStarted(notify) {
        notifyStart = notify;
      },
    },
  });
  const outcome = session.then(
    () => undefined,
    (error: unknown) => error,
  );
  return {
    input,
    output,
    calls,
    outcome,
    release: () => resolveWork(),
    reject: (error: Error) => rejectWork(error),
    notifyStarted: () => notifyStart(),
  };
}

test.each([
  "q",
  "ctrl-c",
  "sigterm",
  "sighup",
  "input-end",
  "input-close",
  "input-error",
  "output-close",
  "output-error",
  "render-error",
])(
  "owned scheduler cleanup precedes terminal restoration on %s",
  async (event) => {
    const hangupListeners = process.listenerCount("SIGHUP");
    const fixture = controlledSchedulerSession();
    const { input, output, calls } = fixture;
    await waitFor(() => frame(output).includes("first work"));
    input.emit("data", "s");
    await waitFor(() => calls.starts === 1);
    const failure = new Error(`terminal ${event}`);
    if (event === "q") input.emit("data", "q");
    else if (event === "ctrl-c") input.emit("data", "\u0003");
    else if (event === "sigterm") process.emit("SIGTERM");
    else if (event === "sighup") process.emit("SIGHUP");
    else if (event === "input-end") input.emit("end");
    else if (event === "input-close") input.emit("close");
    else if (event === "input-error") input.emit("error", failure);
    else if (event === "output-close") output.emit("close");
    else if (event === "output-error") output.emit("error", failure);
    else {
      output.failFrame = true;
      output.emit("resize");
    }
    await Bun.sleep(1);
    const beforeSettlement = {
      stops: calls.stops,
      restored: input.rawModes.includes(false),
    };
    output.failFrame = false;
    fixture.release();
    const outcome = await fixture.outcome;
    await Bun.sleep(1);
    expect(beforeSettlement).toEqual({ stops: 1, restored: false });
    if (event.endsWith("error")) expect(outcome).toBeInstanceOf(Error);
    else expect(outcome).toBeUndefined();
    expectRestored(input, output);
    expect(process.listenerCount("SIGHUP")).toBe(hangupListeners);
    const restoredAt = output.writes.indexOf("\u001B[?1049l");
    expect(
      output.writes
        .slice(restoredAt + 1)
        .some((write) => write.startsWith("\u001B[2J")),
    ).toBe(false);
  },
);

test("quit closes scheduler admission before parsing a following Start key", async () => {
  const fixture = controlledSchedulerSession();
  await waitFor(() => frame(fixture.output).includes("first work"));
  fixture.input.emit("data", "qs");
  await Bun.sleep(1);
  fixture.release();
  expect(await fixture.outcome).toBeUndefined();
  expect(fixture.calls.starts).toBe(0);
  expectRestored(fixture.input, fixture.output);
});

test("successful Stop stays in the monitor and permits a later explicit Start", async () => {
  const fixture = controlledSchedulerSession();
  await waitFor(() => frame(fixture.output).includes("first work"));
  fixture.input.emit("data", "s");
  await waitFor(() => fixture.calls.starts === 1);
  fixture.input.emit("data", "s");
  await waitFor(() => fixture.calls.stops === 1);
  fixture.release();
  await Bun.sleep(2);
  const stoppedFrame = frame(fixture.output);
  const restoredWhileMonitoring = fixture.input.rawModes.includes(false);
  fixture.input.emit("data", "s");
  await Bun.sleep(1);
  const restartCount = fixture.calls.starts;
  fixture.input.emit("data", "q");
  fixture.release();
  const outcome = await fixture.outcome;
  expect(stoppedFrame).toContain("Scheduler: stopped");
  expect(restoredWhileMonitoring).toBe(false);
  expect(restartCount).toBe(2);
  expect(outcome).toBeUndefined();
  expectRestored(fixture.input, fixture.output);
});

test("cleanup uncertainty remains a failing outcome after scheduler settlement", async () => {
  const fixture = controlledSchedulerSession();
  await waitFor(() => frame(fixture.output).includes("first work"));
  fixture.input.emit("data", "s");
  await waitFor(() => fixture.calls.starts === 1);
  fixture.reject(new Error("SCHEDULER_CHECKOUT_RETAINED: cleanup unconfirmed"));
  await Bun.sleep(2);
  fixture.input.emit("data", "q");
  expect(await fixture.outcome).toBeInstanceOf(Error);
  expectRestored(fixture.input, fixture.output);
});

test("Tasks keeps an unexpected scheduler exit and its error visible", async () => {
  const fixture = controlledSchedulerSession();
  await waitFor(() => frame(fixture.output).includes("first work"));
  fixture.input.emit("data", "s2");
  await waitFor(() => fixture.calls.starts === 1);
  fixture.reject(new Error("scheduler exited unexpectedly"));
  await waitFor(() =>
    frame(fixture.output).includes(
      "Scheduler error: scheduler exited unexpectedly",
    ),
  );
  fixture.input.emit("data", "q");
  expect(await fixture.outcome).toBeInstanceOf(Error);
  expectRestored(fixture.input, fixture.output);
});

test.each(["initial", "stale"])(
  "Tasks preserves scheduler failures alongside %s checkpoint read failures",
  async (mode) => {
    let failedRead = mode === "initial";
    const fixture = controlledSchedulerSession(() => {
      if (failedRead) throw new Error("checkpoint connection unavailable");
      return board();
    });
    try {
      await waitFor(() =>
        frame(fixture.output).includes(
          failedRead ? "checkpoint connection unavailable" : "first work",
        ),
      );
      fixture.input.emit("data", "s");
      await waitFor(() => fixture.calls.starts === 1);
      failedRead = true;
      fixture.input.emit("data", "r");
      await waitFor(() =>
        frame(fixture.output).includes("checkpoint connection unavailable"),
      );
      fixture.reject(new Error("scheduler cleanup unconfirmed"));
      await Bun.sleep(5);
      const displayed = stripVTControlCharacters(frame(fixture.output));
      expect(displayed).toContain("checkpoint connection unavailable");
      expect(displayed).toContain("Scheduler: failed");
      expect(displayed).toContain("scheduler cleanup unconfirmed");
      if (mode === "stale") expect(displayed).toContain("first work");
    } finally {
      fixture.input.emit("data", "q");
      fixture.release();
      expect(await fixture.outcome).toBeInstanceOf(Error);
      expectRestored(fixture.input, fixture.output);
    }
  },
);

test.each(["started", "settled"])(
  "an asynchronous scheduler %s render failure closes the session safely",
  async (phase) => {
    const fixture = controlledSchedulerSession();
    let completed = false;
    void fixture.outcome.then(() => {
      completed = true;
    });
    await waitFor(() => frame(fixture.output).includes("first work"));
    fixture.input.emit("data", "s");
    await waitFor(() => fixture.calls.starts === 1);
    fixture.output.failFrame = true;
    let escaped: unknown;
    if (phase === "started") {
      try {
        fixture.notifyStarted();
      } catch (error) {
        escaped = error;
      }
      await Bun.sleep(1);
    }
    fixture.release();
    await Bun.sleep(5);
    const closedWithoutAnotherKey = completed;
    fixture.output.failFrame = false;
    fixture.input.emit("data", "q");
    const outcome = await fixture.outcome;
    expect(escaped).toBeUndefined();
    expect(closedWithoutAnotherKey).toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expectRestored(fixture.input, fixture.output);
  },
);

/** Runs the real TUI command with local settings and an observable, held scheduler boundary. */
async function controlledTuiCommand() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "roc-tui-control-")),
  );
  await saveRocSettings(
    { cycle: { type: "weekly" }, execution: { allowUnsandboxed: true } },
    root,
  );
  const input = new Input();
  const output = new Output();
  const errors: string[] = [];
  const calls = { metadata: 0, runs: [] as SchedulerRunInput[] };
  let resolveRun: () => void = () => {};
  let rejectRun: (error: Error) => void = () => {};
  const runtime: CliRuntime = {
    projectRoot: root,
    homeRoot: root,
    async schedulerMetadata() {
      calls.metadata++;
      return { repository: "acme/test", baseBranch: "trunk" };
    },
    async readTasks() {
      return githubTaskSnapshot([]);
    },
    runScheduler(options) {
      calls.runs.push(options);
      return new Promise<void>((resolve, reject) => {
        resolveRun = resolve;
        rejectRun = reject;
      });
    },
  };
  const outcome = runCli(
    ["tui"],
    {
      input: input as never,
      output: output as never,
      out: () => {},
      err: (text) => errors.push(text),
    },
    runtime,
  );
  return {
    root,
    input,
    output,
    runtime,
    calls,
    errors,
    outcome,
    release: () => resolveRun(),
    reject: (error: Error) => rejectRun(error),
    async dispose() {
      input.emit("data", "q");
      resolveRun();
      await outcome;
      await rm(root, { recursive: true, force: true });
      await rm(`${root}.agile-checkout.lock`, { force: true });
    },
  };
}

test("TUI previews real metadata before Start and pins that branch at dispatch", async () => {
  const fixture = await controlledTuiCommand();
  try {
    await waitFor(() => frame(fixture.output).includes("acme/test"));
    expect(frame(fixture.output)).toContain("trunk");
    expect(frame(fixture.output)).not.toContain("repository target branch");
    expect(fixture.calls.runs).toHaveLength(0);
    fixture.input.emit("data", "s");
    await waitFor(() => fixture.calls.runs.length === 1);
    expect(fixture.calls.metadata).toBeGreaterThanOrEqual(2);
    expect(fixture.calls.runs[0]).toMatchObject({
      repoPath: fixture.root,
      baseBranch: "trunk",
      concurrency: 2,
      autoMerge: false,
    });
    fixture.input.emit("data", "q");
    await waitFor(() => fixture.calls.runs[0]?.signal?.aborted === true);
    expect(fixture.input.rawModes).toEqual([true]);
    fixture.release();
    expect(await fixture.outcome).toBe(0);
    expectRestored(fixture.input, fixture.output);
  } finally {
    await fixture.dispose();
  }
});

test("TUI cancels pending readiness before invoking the scheduler", async () => {
  const fixture = await controlledTuiCommand();
  let releaseMetadata: () => void = () => {};
  const pendingMetadata = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });
  let waiting = false;
  try {
    await waitFor(() => frame(fixture.output).includes("acme/test"));
    fixture.runtime.schedulerMetadata = async () => {
      waiting = true;
      await pendingMetadata;
      return { repository: "acme/test", baseBranch: "trunk" };
    };
    fixture.input.emit("data", "s");
    await waitFor(() => waiting);
    const whileWaiting = frame(fixture.output);
    fixture.input.emit("data", "q");
    releaseMetadata();
    await Bun.sleep(5);
    fixture.release();
    expect(await fixture.outcome).toBe(0);
    expect(fixture.calls.runs).toHaveLength(0);
    expect(whileWaiting).toContain("Scheduler: starting");
    expect(whileWaiting).not.toContain("Scheduler: running");
    expect(fixture.errors).toEqual([]);
    expectRestored(fixture.input, fixture.output);
  } finally {
    releaseMetadata();
    await fixture.dispose();
  }
});

test("TUI reports unconfirmed cleanup as a nonzero command result", async () => {
  const fixture = await controlledTuiCommand();
  try {
    await waitFor(() => frame(fixture.output).includes("acme/test"));
    fixture.input.emit("data", "s");
    await waitFor(() => fixture.calls.runs.length === 1);
    fixture.reject(
      new Error("SCHEDULER_CHECKOUT_RETAINED: cleanup unconfirmed"),
    );
    await Bun.sleep(2);
    fixture.input.emit("data", "q");
    expect(await fixture.outcome).toBe(1);
    expect(fixture.errors.join("\n")).toContain("SCHEDULER_CHECKOUT_RETAINED");
    expectRestored(fixture.input, fixture.output);
  } finally {
    await fixture.dispose();
  }
});

test("a cancelled restart cannot erase an unconfirmed scheduler cleanup failure", async () => {
  const fixture = await controlledTuiCommand();
  try {
    await waitFor(() => frame(fixture.output).includes("acme/test"));
    fixture.input.emit("data", "s");
    await waitFor(() => fixture.calls.runs.length === 1);
    fixture.reject(
      new Error("SCHEDULER_CHECKOUT_RETAINED: cleanup unconfirmed"),
    );
    await waitFor(() => frame(fixture.output).includes("Scheduler: failed"));
    fixture.input.emit("data", "sq");
    expect(await fixture.outcome).toBe(1);
    expect(fixture.calls.runs).toHaveLength(1);
    expect(fixture.errors.join("\n")).toContain("SCHEDULER_CHECKOUT_RETAINED");
    expect(frame(fixture.output)).not.toContain("Scheduler: stopped");
    expectRestored(fixture.input, fixture.output);
  } finally {
    await fixture.dispose();
  }
});

test.each(["welcome", "tasks"])(
  "TUI displays the captured startup target before dispatch from %s",
  async (tab) => {
    const fixture = await controlledTuiCommand();
    let previewAtDispatch = "";
    try {
      await waitFor(() => frame(fixture.output).includes("acme/test"));
      expect(frame(fixture.output)).toContain("trunk");
      if (tab === "tasks") fixture.input.emit("data", "2");
      fixture.runtime.schedulerMetadata = async () => ({
        repository: "acme/test",
        baseBranch: "release-target",
      });
      const dispatch = fixture.runtime.runScheduler;
      fixture.runtime.runScheduler = (options) => {
        previewAtDispatch = frame(fixture.output);
        return dispatch(options);
      };
      fixture.input.emit("data", "s");
      await waitFor(() => fixture.calls.runs.length === 1);
      expect(fixture.calls.runs[0]?.baseBranch).toBe("release-target");
      expect(previewAtDispatch).toContain("acme/test");
      expect(previewAtDispatch).toContain("release-target");
      expect(previewAtDispatch).toContain("concurrency 2");
      expect(previewAtDispatch).toContain("manual merge");
    } finally {
      await fixture.dispose();
    }
  },
);

test("TUI refresh cannot replace the displayed target of an active owned run", async () => {
  const fixture = await controlledTuiCommand();
  try {
    await waitFor(() => frame(fixture.output).includes("acme/test"));
    fixture.input.emit("data", "s");
    await waitFor(() => fixture.calls.runs.length === 1);
    let refreshed = false;
    fixture.runtime.schedulerMetadata = async () => {
      refreshed = true;
      return { repository: "acme/test", baseBranch: "next-default" };
    };
    fixture.input.emit("data", "r");
    await waitFor(() => refreshed);
    await Bun.sleep(10);
    expect(fixture.calls.runs[0]?.baseBranch).toBe("trunk");
    expect(frame(fixture.output)).toContain("trunk");
    expect(frame(fixture.output)).not.toContain("next-default");
  } finally {
    await fixture.dispose();
  }
});

test("a failed startup preview cannot dispatch work after terminal shutdown begins", async () => {
  const fixture = await controlledTuiCommand();
  try {
    await waitFor(() => frame(fixture.output).includes("acme/test"));
    fixture.runtime.schedulerMetadata = async () => {
      fixture.output.failFrame = true;
      return { repository: "acme/test", baseBranch: "trunk" };
    };
    fixture.input.emit("data", "s");
    await Bun.sleep(10);
    fixture.output.failFrame = false;
    fixture.release();
    fixture.input.emit("data", "q");
    expect(await fixture.outcome).toBe(1);
    expect(fixture.calls.runs).toHaveLength(0);
    expectRestored(fixture.input, fixture.output);
  } finally {
    await fixture.dispose();
  }
});

test.each(["live", "stale", "unreadable"])(
  "TUI refresh displays an external %s guard and cannot start or remove it",
  async (state) => {
    const fixture = await controlledTuiCommand();
    try {
      await waitFor(() => frame(fixture.output).includes("guard absent"));
      let pid = process.pid;
      if (state === "stale") {
        const exited = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
        pid = exited.pid;
        await exited.exited;
      }
      const source =
        state === "unreadable"
          ? "not an ownership record"
          : JSON.stringify({
              version: 1,
              ownerPid: pid,
              runId: "external-fixture",
              ownerToken: "fixture-token",
              acquiredAt: "2026-09-13T00:00:00.000Z",
            });
      const lock = `${fixture.root}.agile-checkout.lock`;
      await writeFile(lock, source);
      fixture.input.emit("data", "r");
      await waitFor(() => frame(fixture.output).includes(`guard ${state}`));
      fixture.input.emit("data", "s");
      await Bun.sleep(20);
      fixture.input.emit("data", "q");
      await fixture.outcome;
      expect(fixture.calls.runs).toHaveLength(0);
      expect(await Bun.file(lock).text()).toBe(source);
      expectRestored(fixture.input, fixture.output);
    } finally {
      await fixture.dispose();
    }
  },
);

test("TUI runs the real backend through review and publication before awaiting manual merge", async () => {
  const fixture = await controlledTuiCommand();
  const remote = memoryPlan([["answer.ts"]]);
  const real = new BunGitHubCommandRunner();
  let launches = 0;
  let activity = "";
  let schedulerFailure: unknown;
  let implementationHead = "";
  let dispatched: SchedulerRunInput | undefined;
  let fake: ReturnType<typeof createFakeHarness> | undefined;
  try {
    await git(["init"], fixture.root);
    await git(["config", "user.name", "Test"], fixture.root);
    await git(["config", "user.email", "test@example.test"], fixture.root);
    await writeFile(join(fixture.root, "README.md"), "fixture\n");
    await git(["add", "."], fixture.root);
    await git(["commit", "-m", "seed"], fixture.root);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"], fixture.root);
    fixture.runtime.schedulerMetadata = async () => ({
      repository: "acme/test",
      baseBranch: "main",
    });
    fixture.runtime.readTasks = async () => {
      const { tasks, diagnostics } = await remote.store.list();
      return githubTaskSnapshot(tasks, diagnostics);
    };
    fixture.runtime.runScheduler = async (input) => {
      launches++;
      dispatched = input;
      try {
        await runBackendSession(
          async ({ branches }) => {
            const at = new Date().toISOString();
            const scripted = createFakeHarness({
              attempts: (["scout", "review"] as const).map((role) => ({
                taskId: "issue-41",
                role,
                retryIndex: 0,
                expect: {
                  model: role === "scout" ? "luna" : "sol",
                  effort: "high",
                },
                deliveries: [
                  {
                    nextCursor: "output",
                    event: {
                      type: "attempt.output",
                      eventId: `${role}-output`,
                      attemptId: "fixture",
                      sequence: 1,
                      occurredAt: at,
                      output:
                        role === "scout"
                          ? {
                              kind: "scout",
                              summary: "Inspect answer",
                              files: ["answer.ts"],
                              tests: [],
                              risks: [],
                            }
                          : {
                              kind: "review",
                              decision: "accepted",
                              findings: [],
                              remainingGaps: [],
                            },
                    },
                  },
                  {
                    nextCursor: "complete",
                    event: {
                      type: "attempt.completed",
                      eventId: `${role}-complete`,
                      attemptId: "fixture",
                      sequence: 2,
                      occurredAt: at,
                    },
                  },
                ],
              })),
            });
            fake = scripted;
            return {
              catalog: ["luna", "terra", "sol"].map((id) => ({
                id,
                supportedReasoningEfforts: ["medium", "high"],
              })),
              harness: {
                async step(request) {
                  if (request.attempt.role !== "implement")
                    return scripted.harness.step(request);
                  if (request.backendCursor === undefined) {
                    const taskId = request.attempt.taskId;
                    const workspace = await branches.prepare(taskId);
                    await writeFile(
                      join(workspace.path, "answer.ts"),
                      "export const answer = 42;\n",
                    );
                    const commitSha = await branches.commitChanges(taskId);
                    implementationHead = commitSha;
                    return {
                      kind: "event" as const,
                      nextCursor: "output",
                      event: {
                        type: "attempt.output" as const,
                        eventId: "implement-output",
                        attemptId: request.attempt.attemptId,
                        sequence: 1,
                        occurredAt: at,
                        output: {
                          kind: "implement" as const,
                          commitSha,
                          validation: ["fixture"],
                          risks: [],
                          limitations: [],
                        },
                      },
                    };
                  }
                  return {
                    kind: "event" as const,
                    nextCursor: "complete",
                    event: {
                      type: "attempt.completed" as const,
                      eventId: "implement-complete",
                      attemptId: request.attempt.attemptId,
                      sequence: 2,
                      occurredAt: at,
                    },
                  };
                },
                async cancel(attemptId) {
                  await scripted.harness.cancel(attemptId);
                },
              },
              async close() {},
            };
          },
          input,
          "tui-real-happy",
          {
            store: remote.store,
            command: {
              async run(command) {
                if (command.command[0] === "gh") {
                  const stdout =
                    command.command[1] === "pr"
                      ? JSON.stringify({
                          number: 99,
                          state: "OPEN",
                          baseRefName: "main",
                          headRefName: "agile/issue-41",
                          headRefOid: implementationHead,
                          mergeCommit: null,
                        })
                      : '{"nameWithOwner":"acme/test"}';
                  return { exitCode: 0, stdout, stderr: "" };
                }
                if (command.command[1] === "fetch")
                  return { exitCode: 0, stdout: "", stderr: "" };
                return real.run(command);
              },
            },
            publisherFactory: (branches) => ({
              baseBranch: "main",
              async publish(published) {
                await branches.assertReviewReady(
                  published.task.id,
                  published.publication.commitSha,
                  published.task.baseCommit,
                );
                return {
                  number: 99,
                  url: "https://github.com/acme/test/pull/99",
                  state: "OPEN" as const,
                };
              },
            }),
            onActivity: (_taskId, summary) => {
              activity = summary;
            },
          },
        );
      } catch (error) {
        schedulerFailure = error;
        throw error;
      }
    };
    await waitFor(() => frame(fixture.output).includes("acme/test"));
    fixture.input.emit("data", "s");
    await waitFor(
      () =>
        activity.includes("awaiting_merge") ||
        frame(fixture.output).includes("Scheduler: failed"),
      5_000,
    );
    expect(schedulerFailure).toBeUndefined();
    expect(activity).toContain("awaiting_merge");
    fake?.assertComplete();
    const completed = await remote.store.get(41);
    expect(
      completed.execution?.attempts.map(({ descriptor }) => ({
        role: descriptor.role,
        model: descriptor.model,
        effort: descriptor.effort,
      })),
    ).toEqual([
      { role: "scout", model: "luna", effort: "high" },
      { role: "implement", model: "terra", effort: "medium" },
      { role: "review", model: "sol", effort: "high" },
    ]);
    expect(completed.execution?.phase).toBe("awaiting_merge");
    expect(completed.execution?.publication?.url).toBe(
      "https://github.com/acme/test/pull/99",
    );
    expect(dispatched).toMatchObject({
      repoPath: fixture.root,
      baseBranch: "main",
      concurrency: 2,
      autoMerge: false,
    });
    fixture.input.emit("data", "2r");
    await waitFor(
      () => frame(fixture.output).includes("awaiting_merge"),
      5_000,
    );
    fixture.input.emit("data", "s");
    await waitFor(
      () => frame(fixture.output).includes("Scheduler: stopped"),
      5_000,
    );
    expect(launches).toBe(1);
    expect(fixture.input.rawModes).toEqual([true]);
  } finally {
    fixture.input.emit("data", "q");
    expect(await fixture.outcome).toBe(0);
    expectRestored(fixture.input, fixture.output);
    await rm(fixture.root, { recursive: true, force: true });
    await rm(`${fixture.root}.agile-checkout.lock`, { force: true });
  }
}, 15_000);
