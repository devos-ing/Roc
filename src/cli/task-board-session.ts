import type { TaskBoardSnapshot } from "./task-board-model";
import { renderTaskBoard, taskBoardHitTest } from "./task-board-renderer";
import type { CliTerminalInput, CliTerminalOutput } from "./types";

export type TaskBoardSessionOptions = {
  input: CliTerminalInput;
  output: CliTerminalOutput;
  /** Reads the next immutable board snapshot. */
  read(): TaskBoardSnapshot | Promise<TaskBoardSnapshot>;
  refreshIntervalMs?: number;
};

type DetailMode = "peek" | "full" | "none";

const alternateScreen = "\u001B[?1049h";
const leaveAlternateScreen = "\u001B[?1049l";
const hideCursor = "\u001B[?25l";
const showCursor = "\u001B[?25h";
const enableMouse = "\u001B[?1000h\u001B[?1006h";
const disableMouse = "\u001B[?1000l\u001B[?1006l";
const clearScreen = "\u001B[2J\u001B[H";

/** Converts an unknown failure into text that is safe to place in the status area. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Clips one status line to the current terminal width. */
function statusLine(value: string, width: number): string {
  return Array.from(value).slice(0, Math.max(1, width)).join("");
}

/** Renders the keyboard fallback reference without requiring a board snapshot. */
function renderHelp(width: number): string {
  return [
    "Task board controls",
    "↑/↓ or J/K  Select a task",
    "Space         Peek at the selected task",
    "Enter         Open full task details",
    "D             Expand or collapse Done",
    "R             Refresh now",
    "?             Show this help",
    "Esc           Return to the board",
    "Q or Ctrl-C   Quit",
  ]
    .map((line) => statusLine(line, width))
    .join("\n");
}

/** Runs the terminal task board until the user quits or terminal I/O fails. */
export async function runTaskBoardSession(
  options: TaskBoardSessionOptions,
): Promise<void> {
  const { input, output } = options;
  if (input.isTTY === false || output.isTTY === false || !input.setRawMode)
    throw new Error("Task board requires an interactive terminal");

  let snapshot: TaskBoardSnapshot | undefined;
  let selectedTaskId: string | undefined;
  let detailMode: DetailMode = "none";
  let doneExpanded = false;
  let helpVisible = false;
  let lastError: string | undefined;
  let inputBuffer = "";
  let refreshInFlight = false;
  let refreshQueued = false;
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  const decoder = new TextDecoder();

  /** Keeps the selected identity when possible and otherwise selects the first task. */
  const normalizeSelection = () => {
    if (snapshot?.tasks.some((task) => task.id === selectedTaskId)) return;
    selectedTaskId = snapshot?.tasks.at(0)?.id;
    if (detailMode !== "none" && selectedTaskId === undefined)
      detailMode = "none";
  };

  /** Draws the latest successful frame or a readable recovery status after a failed read. */
  const render = () => {
    const width = Math.max(1, output.columns ?? 80);
    let frame: string;
    if (helpVisible) frame = renderHelp(width);
    else if (snapshot === undefined) frame = "Task board data is unavailable.";
    else {
      frame = renderTaskBoard(snapshot, {
        width,
        isTTY: output.isTTY,
        selectedTaskId,
        ...(detailMode === "none"
          ? { detailMode: "none" as const }
          : { detailMode, detailTaskId: selectedTaskId }),
        doneExpanded,
      });
    }
    if (lastError !== undefined)
      frame = `${frame}\n\n${statusLine(`Error: ${lastError}`, width)}`;
    output.write(`${clearScreen}${frame}`);
  };

  /** Reads one snapshot and leaves the previous frame in place when that read fails. */
  const refresh = async () => {
    try {
      const next = await options.read();
      if (closed) return;
      snapshot = next;
      normalizeSelection();
      lastError = undefined;
    } catch (error) {
      if (closed) return;
      lastError = errorText(error);
    }
    render();
  };

  /** Requests a serialized refresh and preserves one request that arrives during a read. */
  const requestRefresh = () => {
    if (closed) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    void refresh()
      .catch(finish)
      .finally(() => {
        refreshInFlight = false;
        if (!refreshQueued || closed) return;
        refreshQueued = false;
        requestRefresh();
      });
  };

  /** Selects the next visible card in the requested direction. */
  const moveSelection = (offset: number) => {
    const tasks =
      snapshot?.tasks.filter(
        (task) => doneExpanded || task.column !== "done",
      ) ?? [];
    if (tasks.length === 0) return;
    const current = tasks.findIndex((task) => task.id === selectedTaskId);
    selectedTaskId =
      tasks[(current + offset + tasks.length) % tasks.length]?.id;
    detailMode = "none";
    helpVisible = false;
    render();
  };

  /** Applies one supported task-board action without changing task or scheduler state. */
  const act = (
    action:
      | "next"
      | "previous"
      | "peek"
      | "details"
      | "done"
      | "refresh"
      | "help"
      | "escape"
      | "quit",
  ) => {
    if (action === "quit") {
      finish();
      return;
    }
    if (action === "next" || action === "previous") {
      moveSelection(action === "next" ? 1 : -1);
      return;
    }
    if (action === "refresh") {
      requestRefresh();
      return;
    }
    if (action === "help") {
      helpVisible = true;
      render();
      return;
    }
    if (action === "escape") {
      if (!helpVisible && detailMode === "none") return;
      helpVisible = false;
      detailMode = "none";
      render();
      return;
    }
    if (action === "done") {
      doneExpanded = !doneExpanded;
      render();
      return;
    }
    if (selectedTaskId === undefined) return;
    helpVisible = false;
    detailMode = action === "peek" ? "peek" : "full";
    render();
  };

  /** Handles a decoded mouse-reporting click if it lands on a board control. */
  const click = (button: number, x: number, y: number) => {
    if (snapshot === undefined || button >= 64 || (button & 3) !== 0) return;
    const hit = taskBoardHitTest(
      snapshot,
      { x, y },
      {
        width: Math.max(1, output.columns ?? 80),
        selectedTaskId,
        detailMode,
        detailTaskId: detailMode === "none" ? undefined : selectedTaskId,
        doneExpanded,
      },
    );
    if (hit?.kind === "done") {
      act("done");
      return;
    }
    if (hit?.kind === "task") {
      selectedTaskId = hit.taskId;
      helpVisible = false;
      detailMode = "full";
      render();
    }
  };

  /** Delays a lone escape byte briefly so an arrow sequence split across chunks remains intact. */
  const deferEscape = () => {
    if (escapeTimer !== undefined) return;
    escapeTimer = setTimeout(() => {
      escapeTimer = undefined;
      if (!inputBuffer.startsWith("\u001B")) return;
      inputBuffer = inputBuffer.slice(1);
      act("escape");
      parseInput();
    }, 20);
  };

  /** Parses buffered raw terminal input into keyboard and SGR mouse actions. */
  const parseInput = () => {
    while (inputBuffer.length > 0) {
      if (closed) return;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: parses terminal SGR mouse reports.
      const mouse = inputBuffer.match(/^\u001B\[<(\d+);(\d+);(\d+)([Mm])/u);
      if (mouse) {
        inputBuffer = inputBuffer.slice(mouse[0].length);
        if (mouse[4] === "M")
          click(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]));
        continue;
      }
      if (inputBuffer.startsWith("\u001B[<")) return;
      if (inputBuffer.startsWith("\u001B[A")) {
        inputBuffer = inputBuffer.slice(3);
        act("previous");
        continue;
      }
      if (inputBuffer.startsWith("\u001B[B")) {
        inputBuffer = inputBuffer.slice(3);
        act("next");
        continue;
      }
      if (inputBuffer === "\u001B" || inputBuffer === "\u001B[") {
        deferEscape();
        return;
      }
      const key = inputBuffer[0];
      inputBuffer = inputBuffer.slice(1);
      if (key === "\u0003") act("quit");
      else if (key === "\u001B") act("escape");
      else if (key === "\r" || key === "\n") act("details");
      else if (key === " ") act("peek");
      else if (key === "j" || key === "J") act("next");
      else if (key === "k" || key === "K") act("previous");
      else if (key === "d" || key === "D") act("done");
      else if (key === "r" || key === "R") act("refresh");
      else if (key === "?") act("help");
      else if (key === "q" || key === "Q") act("quit");
    }
  };

  /** Parses one terminal input chunk and converts any parser or rendering failure into session failure. */
  const onData = (data: string | Uint8Array) => {
    try {
      if (escapeTimer !== undefined) {
        clearTimeout(escapeTimer);
        escapeTimer = undefined;
      }
      inputBuffer +=
        typeof data === "string"
          ? data
          : decoder.decode(data, { stream: true });
      parseInput();
    } catch (error) {
      finish(error);
    }
  };

  /** Re-renders at the current width while retaining the existing selected identity. */
  const onResize = () => {
    try {
      render();
    } catch (error) {
      finish(error);
    }
  };

  /** Ends the pending session with an optional terminal or rendering failure. */
  let finish: (error?: unknown) => void = () => {};
  /** Removes listeners and resolves or rejects the session exactly once. */
  const stopped = new Promise<void>((resolve, reject) => {
    finish = (error?: unknown) => {
      if (closed) return;
      closed = true;
      if (interval !== undefined) clearInterval(interval);
      if (escapeTimer !== undefined) clearTimeout(escapeTimer);
      input.off("data", onData);
      input.off("error", onInputError);
      input.off("end", onInputEnd);
      input.off("close", onInputClose);
      output.off("resize", onResize);
      output.off("close", onOutputClose);
      process.off("SIGINT", onSignal);
      error === undefined ? resolve() : reject(error);
    };
  });

  /** Treats terminal input errors as an abnormal session exit. */
  const onInputError = (error: Error) => finish(error);
  /** Treats terminal input ending as a normal session exit. */
  const onInputEnd = () => finish();
  /** Treats terminal input closing as a normal session exit. */
  const onInputClose = () => finish();
  /** Treats terminal output errors as an abnormal session exit. */
  const onOutputError = (error: Error) => finish(error);
  /** Treats terminal output closing as a normal session exit. */
  const onOutputClose = () => finish();
  /** Treats process Ctrl-C consistently with the raw Ctrl-C byte. */
  const onSignal = () => finish();

  /** Performs one restoration step without preventing the remaining terminal cleanup. */
  const restore = (operation: () => void) => {
    try {
      operation();
    } catch {
      // Terminal restoration is best effort; every independent reset still runs.
    }
  };

  try {
    input.setRawMode(true);
    output.write(`${alternateScreen}${hideCursor}${enableMouse}`);
    input.resume();
    input.on("data", onData);
    input.on("error", onInputError);
    input.on("end", onInputEnd);
    input.on("close", onInputClose);
    output.on("error", onOutputError);
    output.on("resize", onResize);
    output.on("close", onOutputClose);
    process.once("SIGINT", onSignal);
    interval = setInterval(requestRefresh, options.refreshIntervalMs ?? 1_000);
    refreshInFlight = true;
    try {
      await refresh();
    } catch (error) {
      finish(error);
    } finally {
      refreshInFlight = false;
      if (refreshQueued && !closed) {
        refreshQueued = false;
        requestRefresh();
      }
    }
    await stopped;
  } finally {
    restore(() => output.write(disableMouse));
    restore(() => output.write(showCursor));
    restore(() => output.write(leaveAlternateScreen));
    restore(() => input.setRawMode(false));
    restore(() => input.pause());
    output.off("error", onOutputError);
  }
}
