import { stripVTControlCharacters } from "node:util";
import { renderHelpBox } from "./help-box";
import type { TaskBoardSnapshot } from "./task-board-model";
import {
  renderTaskBoard,
  taskBoardHitTest,
  taskBoardSelectionRows,
} from "./task-board-renderer";
import {
  renderTuiFrame,
  renderWelcome,
  type TuiTab,
  tabTargets,
  tuiTabs,
} from "./tui-renderer";
import type { CliTerminalInput, CliTerminalOutput } from "./types";

export type TaskBoardSessionOptions = {
  input: CliTerminalInput;
  output: CliTerminalOutput;
  /** Reads the next immutable board snapshot. */
  read(): TaskBoardSnapshot | Promise<TaskBoardSnapshot>;
  /** Optionally supplies the project-scoped label prefix resolved for this session. */
  projectSlug?: string;
  refreshIntervalMs?: number;
  initialTab?: TuiTab;
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
  return stripVTControlCharacters(
    error instanceof Error ? error.message : String(error),
  ).replace(/[\r\t]/gu, " ");
}

/** Renders the keyboard fallback reference without requiring a board snapshot. */
function renderHelp(width: number): string {
  return renderHelpBox(
    "Task board controls",
    [
      "Tab / 1 / 2  Switch pages (or click a tab)",
      "PgUp/PgDn     Scroll page or task details",
      "↑/↓ or J/K  Select a task",
      "Space         Peek at the selected task",
      "Enter         Open full task details",
      "D             Expand or collapse Done",
      "R             Refresh now",
      "?             Show this help",
      "Esc           Return to the board",
      "Q or Ctrl-C   Quit",
    ].join("\n"),
    width,
  );
}

/** Runs the terminal task board until the user quits or terminal I/O fails. */
export async function runTaskBoardSession(
  options: TaskBoardSessionOptions,
): Promise<void> {
  const { input, output } = options;
  if (input.isTTY === false || output.isTTY === false || !input.setRawMode)
    throw new Error("Task board requires an interactive terminal");

  let tab = options.initialTab ?? "tasks";
  const scrolls: Record<TuiTab, number> = { welcome: 0, tasks: 0 };
  let bodyOffset = 0;
  let bodyRows = 1;
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
  const render = (revealSelection = false) => {
    const width = Math.max(1, output.columns ?? 80);
    let frame: string;
    if (helpVisible) frame = renderHelp(width);
    else if (tab === "welcome") frame = renderWelcome(width);
    else if (snapshot === undefined)
      frame = renderHelpBox(
        "Tasks",
        "Data unavailable. Refresh with R after setup.",
        width,
      );
    else {
      frame = renderTaskBoard(snapshot, {
        width,
        isTTY: output.isTTY,
        projectSlug: options.projectSlug,
        selectedTaskId,
        ...(detailMode === "none"
          ? { detailMode: "none" as const }
          : { detailMode, detailTaskId: selectedTaskId }),
        doneExpanded,
      });
    }
    const status =
      lastError !== undefined
        ? `${snapshot ? "STALE — last successful snapshot retained" : "Setup / connection needs attention"}\nError: ${errorText(lastError)}\nR retries; this monitor never starts execution.`
        : snapshot
          ? "GitHub checkpoints loaded · Read-only"
          : "Checking settings and GitHub connection… · Read-only";
    const viewport = renderTuiFrame({
      tab,
      body: frame,
      status,
      width,
      rows: Math.max(1, output.rows ?? 40),
      scroll: scrolls[tab],
      revealRows:
        revealSelection && tab === "tasks" && detailMode === "none" && snapshot
          ? taskBoardSelectionRows(snapshot, {
              width,
              selectedTaskId,
              detailMode,
              doneExpanded,
            })
          : undefined,
    });
    bodyOffset = viewport.bodyOffset;
    bodyRows = viewport.bodyRows;
    scrolls[tab] = viewport.scroll;
    output.write(`${clearScreen}${viewport.text}`);
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
    render(true);
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
    if (tab !== "tasks" && !["refresh", "help", "escape"].includes(action))
      return;
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
      scrolls[tab] = 0;
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
    scrolls.tasks = 0;
    render();
  };

  /** Changes only the page, retaining task identity, detail mode and viewport. */
  const switchTab = (next: TuiTab) => {
    tab = next;
    helpVisible = false;
    render();
  };

  /** Handles a decoded mouse-reporting click if it lands on a board control. */
  const click = (button: number, x: number, y: number) => {
    if (button >= 64 || (button & 3) !== 0) return;
    if (y === 1) {
      const target = tabTargets().find(
        (target) =>
          x >= target.start && x <= target.end && x <= (output.columns ?? 80),
      );
      if (target) switchTab(target.id);
      return;
    }
    if (
      tab !== "tasks" ||
      helpVisible ||
      snapshot === undefined ||
      y <= bodyOffset ||
      y > bodyOffset + bodyRows
    )
      return;
    if (detailMode === "peek" && (output.columns ?? 80) < 88) return;
    const hit = taskBoardHitTest(
      snapshot,
      { x, y: y - bodyOffset + scrolls.tasks },
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
      scrolls.tasks = 0;
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
      // biome-ignore lint/suspicious/noControlCharactersInRegex: parses terminal paging keys.
      const page = inputBuffer.match(/^\u001B\[([56])~/u);
      if (page) {
        inputBuffer = inputBuffer.slice(page[0].length);
        scrolls[tab] += (page[1] === "6" ? 1 : -1) * bodyRows;
        render();
        continue;
      }
      if (["\u001B[5", "\u001B[6"].includes(inputBuffer)) return;
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
      if (key === "\t")
        switchTab(
          tuiTabs[
            (tuiTabs.findIndex((item) => item.id === tab) + 1) % tuiTabs.length
          ]?.id ?? "welcome",
        );
      else if (key === "1") switchTab("welcome");
      else if (key === "2") switchTab("tasks");
      else if (key === "\u0003") act("quit");
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

  /** Performs one restoration write without preventing the remaining terminal cleanup. */
  const restore = async (operation: (callback: () => void) => void) => {
    await new Promise<void>((resolve) => {
      try {
        operation(resolve);
      } catch {
        // Terminal restoration is best effort; every independent reset still runs.
        resolve();
      }
    });
  };

  try {
    input.setRawMode(true);
    output.on("error", onOutputError);
    output.write(`${alternateScreen}${hideCursor}${enableMouse}`);
    if (closed) await stopped;
    input.resume();
    input.on("data", onData);
    input.on("error", onInputError);
    input.on("end", onInputEnd);
    input.on("close", onInputClose);
    output.on("resize", onResize);
    output.on("close", onOutputClose);
    process.once("SIGINT", onSignal);
    interval = setInterval(requestRefresh, options.refreshIntervalMs ?? 1_000);
    try {
      render();
      requestRefresh();
    } catch (error) {
      finish(error);
    }
    await stopped;
  } finally {
    await restore((callback) => output.write(disableMouse, callback));
    await restore((callback) => output.write(showCursor, callback));
    await restore((callback) => output.write(leaveAlternateScreen, callback));
    await restore((callback) => {
      input.setRawMode(false);
      callback();
    });
    await restore((callback) => {
      input.pause();
      callback();
    });
    output.off("error", onOutputError);
  }
}
