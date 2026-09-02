import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import type {
  TaskBoardSnapshot,
  TaskBoardTask,
} from "../../src/cli/task-board-model";
import { runTaskBoardSession } from "../../src/cli/task-board-session";

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
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
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
  expect(frame(output)).not.toContain("Task second");
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
  input.emit("data", "\u001B[<0;1;5M");
  expect(frame(output)).toContain("Task first");
  input.emit("data", "\u001B");
  await Bun.sleep(25);
  input.emit("data", "j");
  output.columns = 60;
  output.emit("resize");
  expect(stripVTControlCharacters(frame(output))).toContain("▌   second");
  output.columns = 120;
  output.emit("resize");
  input.emit("data", "\u001B[<0;91;3M");
  expect(frame(output)).toContain("finished work");
  input.emit("data", "\u0003");
  await running;
  expectRestored(input, output);
});

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
  if (process.env.NO_COLOR === undefined)
    expect(errorFrame).toContain(
      "\u001B[31mError: temporary read failure\u001B[0m",
    );
  else expect(errorFrame).not.toContain("\u001B[31m");
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
