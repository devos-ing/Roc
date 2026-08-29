import type {
  TaskBoardSnapshot,
  TaskBoardTask,
} from "./task-board-model";

export type { TaskBoardSnapshot, TaskBoardTask } from "./task-board-model";

export type TaskBoardRenderOptions = {
  width?: number;
  color?: boolean;
  isTTY?: boolean;
  tty?: boolean;
  selectedTaskId?: string;
  selectedId?: string;
  detailTaskId?: string;
  doneExpanded?: boolean;
  expandedDone?: boolean;
};

type ColumnName = "Ready" | "In progress" | "Attention" | "Done";

type BoardColumn = { name: ColumnName; tasks: readonly TaskBoardTask[] };

const reset = "\u001B[0m";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal SGR sequences emitted below.
const ansiSgrPattern = /\u001B\[[0-9;]*m/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const colors = {
  active: "\u001B[36m",
  attention: "\u001B[33m",
  done: "\u001B[32m",
  muted: "\u001B[90m",
};
const narrowWidth = 88;

/** Splits text into user-perceived characters without separating combining or ZWJ sequences. */
function splitGraphemes(value: string): string[] {
  return Array.from(graphemes.segment(value), ({ segment }) => segment);
}

/** Returns a terminal-cell approximation for one complete grapheme cluster. */
function graphemeWidth(value: string): number {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value))
    return 2;
  const codePoint = value.codePointAt(0) ?? 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
    return 2;
  return /^\p{Mark}|^[\u200d\ufe0e\ufe0f]/u.test(value) ? 0 : 1;
}

/** Counts visible terminal cells while ignoring renderer ANSI SGR controls. */
function visibleWidth(value: string): number {
  return splitGraphemes(value.replace(ansiSgrPattern, "")).reduce(
    (width, grapheme) => width + graphemeWidth(grapheme),
    0,
  );
}

/** Clips a string to a terminal-cell width without splitting ANSI or grapheme sequences. */
function fit(value: string, width: number): string {
  const limit = Math.max(1, width);
  const plain = value.replace(ansiSgrPattern, "");
  if (visibleWidth(plain) <= limit) return value;
  const ellipsis = limit > 1 ? "…" : "";
  const contentWidth = limit - visibleWidth(ellipsis);
  let result = "";
  let used = 0;
  let offset = 0;
  let activeColor = false;
  for (const match of value.matchAll(ansiSgrPattern)) {
    for (const grapheme of splitGraphemes(value.slice(offset, match.index))) {
      const size = graphemeWidth(grapheme);
      if (used + size > contentWidth) return `${result}${ellipsis}${activeColor ? reset : ""}`;
      result += grapheme;
      used += size;
    }
    result += match[0];
    activeColor = match[0] !== reset;
    offset = (match.index ?? 0) + match[0].length;
  }
  for (const grapheme of splitGraphemes(value.slice(offset))) {
    const size = graphemeWidth(grapheme);
    if (used + size > contentWidth) return `${result}${ellipsis}${activeColor ? reset : ""}`;
    result += grapheme;
    used += size;
  }
  return result;
}

/** Pads a possibly colored line to its visible terminal-cell width. */
function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

/** Colors text only when the renderer is producing interactive terminal output. */
function color(value: string, tone: keyof typeof colors, enabled: boolean): string {
  return enabled ? `${colors[tone]}${value}${reset}` : value;
}

/** Sums every token category exposed by the canonical inspection model. */
function tokenCount(tokens: TaskBoardTask["tokenTotals"]): number {
  return (
    tokens.inputTokens +
    tokens.cachedInputTokens +
    tokens.outputTokens +
    tokens.reasoningOutputTokens
  );
}

/** Returns the model attempt currently running for a task, or its most recent attempt. */
function currentAttempt(
  task: TaskBoardTask,
  snapshot: TaskBoardSnapshot,
) {
  const activeAttemptId = task.isActive ? snapshot.active?.attemptId : undefined;
  return (
    task.attempts.find((attempt) => attempt.id === activeAttemptId) ??
    task.attempts.find((attempt) => attempt.status === "running") ??
    task.attempts.at(-1)
  );
}

/** Returns the task's current role, falling back to its raw scheduler status. */
function phase(task: TaskBoardTask, snapshot: TaskBoardSnapshot): string {
  return currentAttempt(task, snapshot)?.role ?? task.rawStatus;
}

/** Joins dependency identifiers that presently block a task. */
function blocker(task: TaskBoardTask): string | undefined {
  return task.blockingDependencyIds.length > 0
    ? task.blockingDependencyIds.join(", ")
    : undefined;
}

/** Returns the four stable renderer columns backed by the canonical record-valued model columns. */
function boardColumns(snapshot: TaskBoardSnapshot): BoardColumn[] {
  return [
    { name: "Ready", tasks: snapshot.columns.ready },
    { name: "In progress", tasks: snapshot.columns.inProgress },
    { name: "Attention", tasks: snapshot.columns.attention },
    { name: "Done", tasks: snapshot.columns.done },
  ];
}

/** Finds the selected task across all canonical board columns. */
function selectedTask(
  taskColumns: readonly BoardColumn[],
  options: TaskBoardRenderOptions,
): TaskBoardTask | undefined {
  const id = options.detailTaskId ?? options.selectedTaskId ?? options.selectedId;
  return id === undefined
    ? undefined
    : taskColumns.flatMap((column) => column.tasks).find((task) => task.id === id);
}

/** Renders one compact task card for a board column or vertical list. */
function renderCard(input: {
  task: TaskBoardTask;
  snapshot: TaskBoardSnapshot;
  selected: boolean;
  width: number;
  colorEnabled: boolean;
}): string[] {
  const blocked = blocker(input.task);
  const lines = [
    fit(
      `${input.selected ? "›" : " "} ${input.task.isActive ? "● " : ""}${input.task.id}  ${input.task.title}`,
      input.width,
    ),
    fit(`  Status: ${input.task.rawStatus}`, input.width),
    fit(`  Phase: ${phase(input.task, input.snapshot)}`, input.width),
  ];
  if (blocked) lines.push(fit(`  Blocked: ${blocked}`, input.width));
  const tone = input.selected
    ? "active"
    : blocked || input.task.column === "attention"
      ? "attention"
      : input.task.column === "done"
        ? "done"
        : undefined;
  return tone === undefined
    ? lines
    : lines.map((line) => color(line, tone, input.colorEnabled));
}

/** Renders one width-bounded board column including its collapsed Done state. */
function renderColumn(input: {
  column: BoardColumn;
  snapshot: TaskBoardSnapshot;
  selectedId?: string;
  width: number;
  doneExpanded: boolean;
  colorEnabled: boolean;
}): string[] {
  const collapsed = input.column.name === "Done" && !input.doneExpanded;
  const tasks = collapsed ? [] : input.column.tasks;
  const lines = [
    fit(`${input.column.name} (${input.column.tasks.length})`, input.width),
    "─".repeat(input.width),
  ];
  if (collapsed) lines.push(fit("  collapsed", input.width));
  for (const task of tasks)
    lines.push(
      ...renderCard({
        task,
        snapshot: input.snapshot,
        selected: task.id === input.selectedId,
        width: input.width,
        colorEnabled: input.colorEnabled,
      }),
    );
  if (!collapsed && tasks.length === 0)
    lines.push(color(fit("  —", input.width), "muted", input.colorEnabled));
  return lines;
}

/** Combines equal-height padded columns into a width-bounded horizontal board. */
function joinColumns(columnsToJoin: readonly string[][], cellWidth: number): string[] {
  const height = Math.max(...columnsToJoin.map((column) => column.length));
  return Array.from({ length: height }, (_, index) =>
    columnsToJoin
      .map((column) => pad(column[index] ?? "", cellWidth))
      .join(" │ "),
  );
}

/** Wraps plain text at terminal-cell boundaries, preserving every grapheme cluster. */
function wrap(value: string, width: number, prefix = ""): string[] {
  const limit = Math.max(1, width);
  const indentation = visibleWidth(prefix) < limit ? prefix : "";
  const lines: string[] = [];
  let line = prefix;
  for (const word of value.trim().split(/\s+/u)) {
    if (word.length === 0) continue;
    const separator = visibleWidth(line) > visibleWidth(indentation) ? " " : "";
    if (visibleWidth(line) + visibleWidth(separator) + visibleWidth(word) <= limit) {
      line += `${separator}${word}`;
      continue;
    }
    if (visibleWidth(line) > visibleWidth(indentation)) lines.push(line);
    line = indentation;
    for (const grapheme of splitGraphemes(word)) {
      if (visibleWidth(line) + graphemeWidth(grapheme) > limit && visibleWidth(line) > visibleWidth(indentation)) {
        lines.push(line);
        line = indentation;
      }
      line += grapheme;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [fit(prefix.trimEnd() || "—", limit)];
}

/** Wraps a labelled detail field while retaining its label on the first line. */
function detailField(label: string, value: string, width: number): string[] {
  return wrap(value || "—", width, `${label}: `);
}

/** Renders one task's complete details for either a side panel or narrow full-screen view. */
function renderDetails(
  task: TaskBoardTask,
  snapshot: TaskBoardSnapshot,
  width: number,
  colorEnabled: boolean,
): string[] {
  const attempt = currentAttempt(task, snapshot);
  const criteria = task.spec.acceptanceCriteria;
  const dependencies = task.spec.dependencies;
  return [
    color(fit(`Task ${task.id}`, width), "active", colorEnabled),
    ...wrap(task.title, width),
    "",
    ...detailField("Status", task.rawStatus, width),
    ...detailField("Phase", phase(task, snapshot), width),
    ...detailField("Role", attempt?.role ?? "—", width),
    ...detailField("Attempt", attempt?.id ?? String(task.attempts.length || "—"), width),
    ...detailField("Model", attempt?.model ?? task.modelDecisions.at(-1)?.model ?? "—", width),
    ...detailField("Retry", attempt === undefined ? "—" : String(attempt.retryIndex), width),
    ...detailField("Tokens", `${tokenCount(task.tokenTotals)}/${task.tokenTarget}`, width),
    ...detailField("Blocker", blocker(task) ?? "—", width),
    ...detailField("Dependencies", dependencies.join(", ") || "—", width),
    "",
    ...detailField("Problem", task.spec.problem, width),
    ...detailField("Desired outcome", task.spec.desiredOutcome, width),
    "Acceptance criteria:",
    ...(criteria.length
      ? criteria.flatMap((criterion) => wrap(criterion, width, "- "))
      : ["- —"]),
  ];
}

/** Renders the compact non-interactive shortcut reminder. */
function footer(width: number): string {
  return fit("↑↓ select · Enter details · d toggle Done · q quit", width);
}

/** Renders the canonical current-cycle summary and token progress. */
function summary(snapshot: TaskBoardSnapshot, taskCount: number, width: number): string {
  const cycle = snapshot.cycles.find((candidate) => candidate.id === snapshot.currentCycleId);
  const tokens = cycle === undefined ? "" : ` · ${tokenCount(cycle.actual)}/${cycle.tokenTarget} tokens`;
  return fit(
    `Cycle ${snapshot.currentCycleId} · ${taskCount} task${taskCount === 1 ? "" : "s"}${tokens}`,
    width,
  );
}

/** Renders a stable, width-aware task board without terminal I/O or control sequences. */
export function renderTaskBoard(
  snapshot: TaskBoardSnapshot,
  options: TaskBoardRenderOptions = {},
): string {
  const width = Math.max(1, Math.floor(options.width ?? 100));
  const colorEnabled =
    options.color !== false && options.isTTY !== false && options.tty !== false;
  const taskColumns = boardColumns(snapshot);
  const taskCount = snapshot.tasks.length;
  const selected = selectedTask(taskColumns, options);
  const selectedId = selected?.id;
  const doneExpanded = options.doneExpanded === true || options.expandedDone === true;

  if (selected !== undefined && width < narrowWidth)
    return [
      ...renderDetails(selected, snapshot, width, colorEnabled),
      "",
      footer(width),
    ].join("\n");

  const heading = summary(snapshot, taskCount, width);
  if (width < narrowWidth) {
    const lines = [heading, ""];
    for (const column of taskColumns) {
      lines.push(fit(`${column.name} (${column.tasks.length})`, width));
      if (column.name === "Done" && !doneExpanded) lines.push(fit("  collapsed", width));
      else if (column.tasks.length === 0) lines.push(fit("  —", width));
      else
        for (const task of column.tasks)
          lines.push(
            ...renderCard({
              task,
              snapshot,
              selected: task.id === selectedId,
              width,
              colorEnabled,
            }),
          );
    }
    if (taskCount === 0)
      lines.push("", ...wrap("No tasks in this cycle. Create a backlog, then run: roc-it task import <manifest>", width));
    return [...lines, "", footer(width)].join("\n");
  }

  const detailWidth = selected === undefined ? 0 : Math.floor(width * 0.3);
  const boardWidth = selected === undefined ? width : width - detailWidth - 3;
  const cellWidth = Math.max(1, Math.floor((boardWidth - 9) / 4));
  const boardLines = joinColumns(
    taskColumns.map((column) =>
      renderColumn({
        column,
        snapshot,
        selectedId,
        width: cellWidth,
        doneExpanded,
        colorEnabled,
      }),
    ),
    cellWidth,
  );
  const lines = [heading, "", ...boardLines];
  if (selected !== undefined) {
    const details = renderDetails(selected, snapshot, detailWidth, colorEnabled);
    const height = Math.max(boardLines.length, details.length);
    lines.splice(
      2,
      boardLines.length,
      ...Array.from(
        { length: height },
        (_, index) => `${pad(boardLines[index] ?? "", boardWidth)} │ ${details[index] ?? ""}`,
      ),
    );
  }
  if (taskCount === 0)
    lines.push("", ...wrap("No tasks in this cycle. Create a backlog, then run: roc-it task import <manifest>", width));
  return [...lines, "", footer(width)].join("\n");
}
