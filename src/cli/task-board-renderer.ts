import { stripVTControlCharacters } from "node:util";
import { renderEmptyTaskList } from "./presentation";
import type { TaskBoardSnapshot, TaskBoardTask } from "./task-board-model";
import {
  formatTaskDisplayId,
  taskDisplayColors,
  taskStatusTone,
} from "./task-display";

export type { TaskBoardSnapshot, TaskBoardTask } from "./task-board-model";

export type TaskBoardRenderOptions = {
  width?: number;
  color?: boolean;
  isTTY?: boolean;
  tty?: boolean;
  selectedTaskId?: string;
  selectedId?: string;
  detailTaskId?: string;
  detailMode?: "peek" | "full" | "none";
  doneExpanded?: boolean;
  expandedDone?: boolean;
  projectSlug?: string;
};

export type TaskBoardHit = { kind: "task"; taskId: string } | { kind: "done" };

type ColumnName = "Ready" | "In progress" | "Attention" | "Done";

type BoardColumn = { name: ColumnName; tasks: readonly TaskBoardTask[] };

const reset = "\u001B[0m";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal SGR sequences emitted below.
const ansiSgrPattern = /\u001B\[[0-9;]*m/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const colors = taskDisplayColors;
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
      if (used + size > contentWidth)
        return `${result}${ellipsis}${activeColor ? reset : ""}`;
      result += grapheme;
      used += size;
    }
    result += match[0];
    activeColor = match[0] !== reset;
    offset = (match.index ?? 0) + match[0].length;
  }
  for (const grapheme of splitGraphemes(value.slice(offset))) {
    const size = graphemeWidth(grapheme);
    if (used + size > contentWidth)
      return `${result}${ellipsis}${activeColor ? reset : ""}`;
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
function color(
  value: string,
  tone: keyof typeof colors,
  enabled: boolean,
): string {
  return enabled ? `${colors[tone]}${value}${reset}` : value;
}

/** Removes terminal control sequences from a non-interactive board snapshot. */
function plainSnapshot(value: string, colorEnabled: boolean): string {
  return colorEnabled ? value : stripVTControlCharacters(value);
}

/** Sums input and output tokens without double-counting their reported subsets. */
function tokenCount(tokens: TaskBoardTask["tokenTotals"]): number {
  return tokens.inputTokens + tokens.outputTokens;
}

/** Returns the model attempt currently running for a task, or its most recent attempt. */
function currentAttempt(task: TaskBoardTask, snapshot: TaskBoardSnapshot) {
  const activeAttemptId = task.isActive
    ? snapshot.active?.attemptId
    : undefined;
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

/** Summarizes a retired task's preserved history in the compact board card. */
function retirementSummary(task: TaskBoardTask): string {
  const label = task.replacementTaskId == null ? "Archived" : "Superseded";
  const replacement =
    task.replacementTaskId == null ? "" : ` by ${task.replacementTaskId}`;
  return `${label}${replacement}: ${task.retirementReason ?? "—"} · ${task.retiredAt ?? "—"}`;
}

/** Maps a task status to its semantic terminal tone when it needs emphasis. */
function statusTone(task: TaskBoardTask): keyof typeof colors | undefined {
  return taskStatusTone(
    task.rawStatus,
    task.id,
    task.isActive ? task.id : undefined,
  );
}

/** Maps a task status to the detail tone while leaving ordinary states uncolored. */
function detailStatusTone(
  task: TaskBoardTask,
): keyof typeof colors | undefined {
  if (task.rawStatus === "done") return "done";
  if (task.rawStatus === "failed_infra" || task.rawStatus === "rejected")
    return "error";
  if (task.column === "attention") return "attention";
  return task.isActive ? "active" : undefined;
}

/** Renders the current phase and status once, coloring only the semantic status. */
function cardStatus(
  task: TaskBoardTask,
  snapshot: TaskBoardSnapshot,
  colorEnabled: boolean,
): string {
  const currentPhase = phase(task, snapshot);
  const status = color(
    task.rawStatus,
    statusTone(task) ?? "muted",
    colorEnabled,
  );
  return currentPhase === task.rawStatus
    ? status
    : `${color(currentPhase, "muted", colorEnabled)} · ${status}`;
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

/** Finds one task across all canonical board columns. */
function taskById(
  taskColumns: readonly BoardColumn[],
  id: string | undefined,
): TaskBoardTask | undefined {
  return id === undefined
    ? undefined
    : taskColumns
        .flatMap((column) => column.tasks)
        .find((task) => task.id === id);
}

/** Renders one compact task card for a board column or vertical list. */
function renderCard(input: {
  task: TaskBoardTask;
  snapshot: TaskBoardSnapshot;
  selected: boolean;
  width: number;
  colorEnabled: boolean;
  projectSlug: string;
}): string[] {
  const blocked = blocker(input.task);
  const lines = [
    fit(
      `${input.selected ? color("▌", "active", input.colorEnabled) : " "} ${input.task.isActive ? color("●", "active", input.colorEnabled) : " "} ${formatTaskDisplayId(input.task.id, input.projectSlug)}  ${input.task.title}`,
      input.width,
    ),
    fit(
      `    ${cardStatus(input.task, input.snapshot, input.colorEnabled)}`,
      input.width,
    ),
  ];
  if (blocked)
    lines.push(
      fit(
        `    ${color(`blocked by ${blocked}`, "attention", input.colorEnabled)}`,
        input.width,
      ),
    );
  if (input.task.rawStatus === "retired")
    lines.push(fit(`    ${retirementSummary(input.task)}`, input.width));
  return lines;
}

/** Renders one width-bounded board column including its collapsed Done state. */
function renderColumn(input: {
  column: BoardColumn;
  snapshot: TaskBoardSnapshot;
  selectedId?: string;
  width: number;
  doneExpanded: boolean;
  colorEnabled: boolean;
  projectSlug: string;
}): string[] {
  const collapsed = input.column.name === "Done" && !input.doneExpanded;
  const tasks = collapsed ? [] : input.column.tasks;
  const lines = [
    fit(`${input.column.name} · ${input.column.tasks.length}`, input.width),
    "─".repeat(input.width),
  ];
  if (collapsed)
    lines.push(
      color(fit("  [d] expand", input.width), "muted", input.colorEnabled),
    );
  for (const [index, task] of tasks.entries()) {
    if (index > 0) lines.push("");
    lines.push(
      ...renderCard({
        task,
        snapshot: input.snapshot,
        selected: task.id === input.selectedId,
        width: input.width,
        colorEnabled: input.colorEnabled,
        projectSlug: input.projectSlug,
      }),
    );
  }
  if (!collapsed && tasks.length === 0)
    lines.push(color(fit("  —", input.width), "muted", input.colorEnabled));
  return lines;
}

/** Returns the number of terminal rows occupied by one rendered card. */
function cardHeight(task: TaskBoardTask): number {
  return (
    2 +
    Number(blocker(task) !== undefined) +
    Number(task.rawStatus === "retired")
  );
}

/** Combines equal-height padded columns into a width-bounded horizontal board. */
function joinColumns(
  columnsToJoin: readonly string[][],
  cellWidth: number,
): string[] {
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
    if (
      visibleWidth(line) + visibleWidth(separator) + visibleWidth(word) <=
      limit
    ) {
      line += `${separator}${word}`;
      continue;
    }
    if (visibleWidth(line) > visibleWidth(indentation)) lines.push(line);
    line = indentation;
    for (const grapheme of splitGraphemes(word)) {
      if (
        visibleWidth(line) + graphemeWidth(grapheme) > limit &&
        visibleWidth(line) > visibleWidth(indentation)
      ) {
        lines.push(line);
        line = indentation;
      }
      line += grapheme;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [fit(prefix.trimEnd() || "—", limit)];
}

/** Wraps and then optionally colors a labelled detail field without splitting terminal controls. */
function detailField(
  label: string,
  value: string,
  width: number,
  tone: keyof typeof colors | undefined = undefined,
  colorEnabled = false,
): string[] {
  const prefix = `${label}: `;
  const lines =
    visibleWidth(prefix) < Math.max(1, width)
      ? wrap(value || "—", width, prefix)
      : [fit(label, width), ...wrap(value || "—", width)];
  return tone === undefined
    ? lines
    : lines.map((line) => color(line, tone, colorEnabled));
}

/** Renders a subdued heading for one non-empty detail group. */
function detailSection(
  label: string,
  width: number,
  colorEnabled: boolean,
): string {
  return color(fit(label, width), "muted", colorEnabled);
}

/** Renders one task's complete details for either a side panel or narrow full-screen view. */
function renderDetails(
  task: TaskBoardTask,
  snapshot: TaskBoardSnapshot,
  width: number,
  colorEnabled: boolean,
): string[] {
  const attempt = currentAttempt(task, snapshot);
  const blocked = blocker(task);
  const criteria = task.spec.acceptanceCriteria;
  const dependencies = task.spec.dependencies;
  const remainingDependencies = dependencies.filter(
    (dependency) => !task.blockingDependencyIds.includes(dependency),
  );
  const model = attempt?.model ?? task.modelDecisions.at(-1)?.model;
  const execution = [
    ...(attempt?.role === undefined
      ? []
      : [detailField("Role", attempt.role, width)]),
    ...(attempt?.id === undefined
      ? []
      : [detailField("Attempt", attempt.id, width)]),
    ...(model === undefined ? [] : [detailField("Model", model, width)]),
    ...(attempt === undefined
      ? []
      : [detailField("Retry", String(attempt.retryIndex), width)]),
    detailField(
      "Tokens",
      `${tokenCount(task.tokenTotals)}/${task.tokenTarget}`,
      width,
    ),
  ].flat();
  const dependencyDetails = [
    ...(blocked === undefined
      ? []
      : [detailField("Blocked by", blocked, width, "attention", colorEnabled)]),
    ...(remainingDependencies.length === 0
      ? []
      : [
          detailField(
            blocked === undefined ? "Depends on" : "Also needs",
            remainingDependencies.join(", "),
            width,
          ),
        ]),
  ].flat();
  const brief = [
    ...(task.spec.problem.trim().length === 0
      ? []
      : [detailField("Problem", task.spec.problem, width)]),
    ...(task.spec.desiredOutcome.trim().length === 0
      ? []
      : [detailField("Outcome", task.spec.desiredOutcome, width)]),
    ...(criteria.length === 0
      ? []
      : [
          detailSection("Acceptance", width, colorEnabled),
          ...criteria.flatMap((criterion) => wrap(criterion, width, "- ")),
        ]),
  ].flat();
  const retirement =
    task.rawStatus !== "retired"
      ? []
      : [
          "",
          detailSection("Retirement", width, colorEnabled),
          ...detailField("Reason", task.retirementReason ?? "—", width),
          ...(task.replacementTaskId === null ||
          task.replacementTaskId === undefined
            ? []
            : detailField("Replacement", task.replacementTaskId, width)),
          ...detailField("Retired at", task.retiredAt ?? "—", width),
        ];
  return [
    color(fit(`Task ${task.id}`, width), "active", colorEnabled),
    ...wrap(task.title, width),
    "",
    detailSection("Status", width, colorEnabled),
    ...detailField(
      "State",
      task.rawStatus,
      width,
      detailStatusTone(task),
      colorEnabled,
    ),
    "",
    detailSection("Execution", width, colorEnabled),
    ...execution,
    ...(dependencyDetails.length === 0
      ? []
      : [
          "",
          detailSection("Dependencies", width, colorEnabled),
          ...dependencyDetails,
        ]),
    ...(brief.length === 0
      ? []
      : ["", detailSection("Brief", width, colorEnabled), ...brief]),
    ...retirement,
  ];
}

/** Renders the compact non-interactive shortcut reminder. */
function footer(width: number): string {
  return fit(
    "↑↓ move · Space preview · Enter details · d Done · ? help · q quit",
    width,
  );
}

/** Wraps the shared empty-backlog guidance for the available terminal width. */
function emptyBoardGuidance(width: number): string[] {
  return renderEmptyTaskList()
    .split("\n")
    .flatMap((line) => wrap(line, width));
}

/** Renders the canonical current-cycle summary and token progress. */
function summary(
  snapshot: TaskBoardSnapshot,
  taskCount: number,
  width: number,
): string {
  const cycle = snapshot.cycles.find(
    (candidate) => candidate.id === snapshot.currentCycleId,
  );
  const tokens =
    cycle === undefined
      ? ""
      : ` · ${tokenCount(cycle.actual)} / ${cycle.tokenTarget} tok`;
  const activeCount = snapshot.tasks.filter((task) => task.isActive).length;
  const activity = activeCount === 0 ? "" : ` · ${activeCount} active`;
  return fit(
    `Cycle ${snapshot.currentCycleId} · ${taskCount} task${taskCount === 1 ? "" : "s"}${activity}${tokens}`,
    width,
  );
}

/** Renders a stable, width-aware task board without terminal I/O or control sequences. */
export function renderTaskBoard(
  snapshot: TaskBoardSnapshot,
  options: TaskBoardRenderOptions = {},
): string {
  const width = Math.max(1, Math.floor(options.width ?? 100));
  const projectSlug = options.projectSlug ?? "project";
  const colorEnabled =
    (options.color === true || process.env.NO_COLOR === undefined) &&
    options.color !== false &&
    options.isTTY !== false &&
    options.tty !== false;
  const taskColumns = boardColumns(snapshot);
  const taskCount = snapshot.tasks.length;
  const selected = taskById(
    taskColumns,
    options.selectedTaskId ?? options.selectedId,
  );
  const selectedId = selected?.id;
  const detail = taskById(
    taskColumns,
    options.detailTaskId ??
      (options.detailMode === undefined ? selectedId : undefined),
  );
  const doneExpanded =
    options.doneExpanded === true ||
    options.expandedDone === true ||
    snapshot.history === true;

  if (
    detail !== undefined &&
    (options.detailMode === "full" || width < narrowWidth)
  )
    return plainSnapshot(
      [
        ...renderDetails(detail, snapshot, width, colorEnabled),
        "",
        footer(width),
      ].join("\n"),
      colorEnabled,
    );

  const heading = summary(snapshot, taskCount, width);
  if (width < narrowWidth) {
    const lines = [heading, ""];
    for (const column of taskColumns) {
      lines.push(fit(`${column.name} · ${column.tasks.length}`, width));
      if (column.name === "Done" && !doneExpanded)
        lines.push(color(fit("  [d] expand", width), "muted", colorEnabled));
      else if (column.tasks.length === 0) lines.push(fit("  —", width));
      else
        for (const [index, task] of column.tasks.entries()) {
          if (index > 0) lines.push("");
          lines.push(
            ...renderCard({
              task,
              snapshot,
              selected: task.id === selectedId,
              width,
              colorEnabled,
              projectSlug,
            }),
          );
        }
    }
    if (taskCount === 0) lines.push("", ...emptyBoardGuidance(width));
    return plainSnapshot(
      [...lines, "", footer(width)].join("\n"),
      colorEnabled,
    );
  }

  const detailWidth = detail === undefined ? 0 : Math.floor(width * 0.3);
  const boardWidth = detail === undefined ? width : width - detailWidth - 3;
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
        projectSlug,
      }),
    ),
    cellWidth,
  );
  const lines = [heading, "", ...boardLines];
  if (detail !== undefined) {
    const details = renderDetails(detail, snapshot, detailWidth, colorEnabled);
    const height = Math.max(boardLines.length, details.length);
    lines.splice(
      2,
      boardLines.length,
      ...Array.from(
        { length: height },
        (_, index) =>
          `${pad(boardLines[index] ?? "", boardWidth)} │ ${details[index] ?? ""}`,
      ),
    );
  }
  if (taskCount === 0) lines.push("", ...emptyBoardGuidance(width));
  return plainSnapshot([...lines, "", footer(width)].join("\n"), colorEnabled);
}

/** Maps a one-based terminal mouse position to a board card or Done header control. */
export function taskBoardHitTest(
  snapshot: TaskBoardSnapshot,
  point: { x: number; y: number },
  options: TaskBoardRenderOptions = {},
): TaskBoardHit | undefined {
  const width = Math.max(1, Math.floor(options.width ?? 100));
  const columns = boardColumns(snapshot);
  const doneExpanded =
    options.doneExpanded === true ||
    options.expandedDone === true ||
    snapshot.history === true;
  if (options.detailMode === "full") return undefined;

  if (width < narrowWidth) {
    let row = 3;
    for (const column of columns) {
      if (point.y === row && column.name === "Done") return { kind: "done" };
      row += 1;
      if (column.name === "Done" && !doneExpanded) {
        row += 1;
        continue;
      }
      if (column.tasks.length === 0) {
        row += 1;
        continue;
      }
      for (const [index, task] of column.tasks.entries()) {
        const height = cardHeight(task);
        if (point.y >= row && point.y < row + height)
          return { kind: "task", taskId: task.id };
        row += height + (index < column.tasks.length - 1 ? 1 : 0);
      }
    }
    return undefined;
  }

  const detail = taskById(
    columns,
    options.detailTaskId ??
      (options.detailMode === undefined
        ? (options.selectedTaskId ?? options.selectedId)
        : undefined),
  );
  const detailWidth = detail === undefined ? 0 : Math.floor(width * 0.3);
  const boardWidth = detail === undefined ? width : width - detailWidth - 3;
  const cellWidth = Math.max(1, Math.floor((boardWidth - 9) / 4));
  const columnIndex = Math.floor((point.x - 1) / (cellWidth + 3));
  const column = columns[columnIndex];
  const columnStart = columnIndex * (cellWidth + 3) + 1;
  if (
    column === undefined ||
    point.x < columnStart ||
    point.x >= columnStart + cellWidth ||
    point.y < 3
  )
    return undefined;
  if (point.y === 3 && column.name === "Done") return { kind: "done" };
  if (point.y <= 4 || (column.name === "Done" && !doneExpanded))
    return undefined;
  let row = 5;
  for (const [index, task] of column.tasks.entries()) {
    const height = cardHeight(task);
    if (point.y >= row && point.y < row + height)
      return { kind: "task", taskId: task.id };
    row += height + (index < column.tasks.length - 1 ? 1 : 0);
  }
  return undefined;
}
