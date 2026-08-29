export type TaskBoardTask = {
  id: string;
  title: string;
  status?: string;
  rawStatus?: string;
  phase?: string;
  active?: boolean;
  blocker?: string;
  blockedBy?: readonly string[];
  dependencies?: readonly string[];
  role?: string;
  attempt?: number | string;
  model?: string;
  retry?: number | string;
  retryIndex?: number | string;
  tokens?: number | string;
  actualTokens?: number | string;
  spec?: {
    problem?: string;
    desiredOutcome?: string;
    acceptanceCriteria?: readonly string[];
    dependencies?: readonly string[];
  };
  problem?: string;
  desiredOutcome?: string;
  acceptanceCriteria?: readonly string[];
  activeAttempt?: {
    id?: string;
    role?: string;
    model?: string;
    retryIndex?: number | string;
    inputTokens?: number;
    outputTokens?: number;
  };
};

export type TaskBoardSnapshot = {
  cycleId?: string;
  cycle?: { id?: string; goal?: string };
  goal?: string;
  activeTaskId?: string;
  tasks?: readonly TaskBoardTask[];
  columns?: readonly {
    name?: string;
    label?: string;
    id?: string;
    tasks?: readonly TaskBoardTask[];
  }[];
  tokenTotal?: number | string;
  totalTokens?: number | string;
};

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

type BoardColumn = { name: ColumnName; tasks: TaskBoardTask[] };

const columnNames: ColumnName[] = ["Ready", "In progress", "Attention", "Done"];
const reset = "\u001B[0m";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal SGR sequences emitted above.
const ansiSgrPattern = /\u001B\[[0-9;]*m/g;
const colors = {
  active: "\u001B[36m",
  attention: "\u001B[33m",
  done: "\u001B[32m",
  muted: "\u001B[90m",
};
const narrowWidth = 88;

/** Converts an unknown value to a displayable string when it is a string or number. */
function text(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

/** Returns the first non-empty displayable value from a list of candidates. */
function firstText(...values: unknown[]): string | undefined {
  return values
    .map(text)
    .find((value) => value !== undefined && value.length > 0);
}

/** Truncates text at Unicode code-point boundaries. */
function truncate(value: string, width: number): string {
  const characters = Array.from(value);
  if (characters.length <= width) return value;
  if (width <= 1) return "…".slice(0, width);
  return `${characters.slice(0, width - 1).join("")}…`;
}

/** Pads and clips a line to the supplied terminal width. */
function fit(value: string, width: number): string {
  return truncate(value, Math.max(1, width));
}

/** Counts visible Unicode code points after excluding renderer color sequences. */
function visibleLength(value: string): number {
  return Array.from(value.replace(ansiSgrPattern, "")).length;
}

/** Pads a possibly colored line to its visible display width. */
function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

/** Colors text only when the renderer is producing interactive terminal output. */
function color(
  value: string,
  tone: keyof typeof colors,
  enabled: boolean,
): string {
  return enabled ? `${colors[tone]}${value}${reset}` : value;
}

/** Normalizes a model column label to the renderer's stable heading. */
function columnName(value: string | undefined): ColumnName | undefined {
  const normalized = value?.replace(/[ _-]/g, "").toLowerCase();
  if (normalized === "ready") return "Ready";
  if (normalized === "inprogress" || normalized === "progress")
    return "In progress";
  if (normalized === "attention") return "Attention";
  if (normalized === "done") return "Done";
  return undefined;
}

/** Maps a raw scheduler status to the board column that communicates its urgency. */
function statusColumn(status: string): ColumnName {
  if (status === "done") return "Done";
  if (
    ["needs_input", "needs_replan", "rejected", "failed_infra"].includes(status)
  )
    return "Attention";
  if (["claimed", "scouting", "implementing", "reviewing"].includes(status))
    return "In progress";
  return "Ready";
}

/** Returns a task's raw scheduler status with a stable fallback. */
function rawStatus(task: TaskBoardTask): string {
  return firstText(task.rawStatus, task.status) ?? "unknown";
}

/** Infers the current workflow phase from explicit and active-attempt metadata. */
function phase(task: TaskBoardTask): string {
  return (
    firstText(task.phase, task.activeAttempt?.role, task.role) ??
    rawStatus(task)
  );
}

/** Returns the task dependency that is currently blocking progress, when supplied by the model. */
function blocker(task: TaskBoardTask): string | undefined {
  return firstText(task.blocker, task.blockedBy?.join(", "));
}

/** Returns the recorded attempt identity or one-based retry number for task details. */
function attemptLabel(task: TaskBoardTask): string | undefined {
  const attempt = task.activeAttempt;
  const recorded = firstText(task.attempt, attempt?.id);
  if (recorded !== undefined) return recorded;
  const retry = attempt?.retryIndex;
  return typeof retry === "number" ? String(retry + 1) : undefined;
}

/** Collects the model's ordered columns while preserving their task order. */
function columns(snapshot: TaskBoardSnapshot): BoardColumn[] {
  const result: BoardColumn[] = columnNames.map((name) => ({
    name,
    tasks: [],
  }));
  const namedColumns = snapshot.columns ?? [];
  if (namedColumns.length > 0) {
    for (const source of namedColumns) {
      const name = columnName(firstText(source.name, source.label, source.id));
      if (name === undefined) continue;
      result
        .find((column) => column.name === name)
        ?.tasks.push(...(source.tasks ?? []));
    }
    return result;
  }
  for (const task of snapshot.tasks ?? []) {
    result
      .find((column) => column.name === statusColumn(rawStatus(task)))
      ?.tasks.push(task);
  }
  return result;
}

/** Finds the selected task across all board columns. */
function selectedTask(
  boardColumns: BoardColumn[],
  options: TaskBoardRenderOptions,
): TaskBoardTask | undefined {
  const id = firstText(
    options.detailTaskId,
    options.selectedTaskId,
    options.selectedId,
  );
  return id === undefined
    ? undefined
    : boardColumns
        .flatMap((column) => column.tasks)
        .find((task) => task.id === id);
}

/** Identifies whether a task is the scheduler's active work item. */
function isActive(task: TaskBoardTask, snapshot: TaskBoardSnapshot): boolean {
  return task.active === true || task.id === snapshot.activeTaskId;
}

/** Renders one compact task card for a board column or vertical list. */
function renderCard(input: {
  task: TaskBoardTask;
  snapshot: TaskBoardSnapshot;
  selected: boolean;
  width: number;
  colorEnabled: boolean;
}): string[] {
  const marker = input.selected ? "›" : " ";
  const active = isActive(input.task, input.snapshot);
  const blocked = blocker(input.task);
  const lines = [
    fit(
      `${marker} ${active ? "● " : ""}${input.task.id}  ${input.task.title}`,
      input.width,
    ),
    fit(`  Status: ${rawStatus(input.task)}`, input.width),
    fit(`  Phase: ${phase(input.task)}`, input.width),
  ];
  if (blocked) lines.push(fit(`  Blocked: ${blocked}`, input.width));
  if (input.selected)
    return lines.map((line) => color(line, "active", input.colorEnabled));
  if (blocked || statusColumn(rawStatus(input.task)) === "Attention")
    return lines.map((line) => color(line, "attention", input.colorEnabled));
  if (statusColumn(rawStatus(input.task)) === "Done")
    return lines.map((line) => color(line, "done", input.colorEnabled));
  return lines;
}

/** Renders one width-bounded board column including its collapsed-Done state. */
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
  const heading = `${input.column.name} (${input.column.tasks.length})`;
  const lines = [
    fit(heading, input.width),
    fit("─".repeat(input.width), input.width),
  ];
  if (collapsed) lines.push(fit("  collapsed", input.width));
  for (const task of tasks) {
    lines.push(
      ...renderCard({
        task,
        snapshot: input.snapshot,
        selected: task.id === input.selectedId,
        width: input.width,
        colorEnabled: input.colorEnabled,
      }),
    );
  }
  if (!collapsed && tasks.length === 0)
    lines.push(color("  —", "muted", input.colorEnabled));
  return lines;
}

/** Combines equal-height columns into a horizontal board without exceeding its width. */
function joinColumns(columnsToJoin: string[][], width: number): string[] {
  const height = Math.max(...columnsToJoin.map((column) => column.length));
  return Array.from({ length: height }, (_, index) =>
    fit(columnsToJoin.map((column) => column[index] ?? "").join(" │ "), width),
  );
}

/** Renders one task's full details for either a side panel or narrow full-screen view. */
function renderDetails(
  task: TaskBoardTask,
  width: number,
  colorEnabled: boolean,
): string[] {
  const spec = task.spec;
  const criteria = task.acceptanceCriteria ?? spec?.acceptanceCriteria ?? [];
  const dependencies = task.dependencies ?? spec?.dependencies ?? [];
  const attempt = task.activeAttempt;
  const lines = [
    color(fit(`Task ${task.id}`, width), "active", colorEnabled),
    fit(task.title, width),
    "",
    fit(`Status: ${rawStatus(task)}`, width),
    fit(`Phase: ${phase(task)}`, width),
    fit(`Role: ${firstText(attempt?.role, task.role) ?? "—"}`, width),
    fit(`Attempt: ${attemptLabel(task) ?? "—"}`, width),
    fit(`Model: ${firstText(attempt?.model, task.model) ?? "—"}`, width),
    fit(
      `Retry: ${firstText(attempt?.retryIndex, task.retry, task.retryIndex) ?? "—"}`,
      width,
    ),
    fit(
      `Tokens: ${firstText(task.tokens, task.actualTokens, attempt ? (attempt.inputTokens ?? 0) + (attempt.outputTokens ?? 0) : undefined) ?? "—"}`,
      width,
    ),
    fit(`Blocker: ${blocker(task) ?? "—"}`, width),
    fit(
      `Dependencies: ${dependencies.length ? dependencies.join(", ") : "—"}`,
      width,
    ),
    "",
    fit(`Problem: ${firstText(task.problem, spec?.problem) ?? "—"}`, width),
    fit(
      `Desired outcome: ${firstText(task.desiredOutcome, spec?.desiredOutcome) ?? "—"}`,
      width,
    ),
    "Acceptance criteria:",
    ...(criteria.length
      ? criteria.map((criterion) => fit(`- ${criterion}`, width))
      : ["- —"]),
  ];
  return lines;
}

/** Renders the compact non-interactive shortcut reminder. */
function footer(width: number): string {
  return fit("↑↓ select · Enter details · d toggle Done · q quit", width);
}

/** Renders a plain empty-board prompt that tells users how to create work. */
function renderEmptyBoard(width: number): string {
  return [
    fit("No tasks in this cycle.", width),
    fit("Create a backlog, then run: roc-it task import <manifest>", width),
  ].join("\n");
}

/** Renders a stable, width-aware task board without terminal I/O or control sequences. */
export function renderTaskBoard(
  snapshot: TaskBoardSnapshot,
  options: TaskBoardRenderOptions = {},
): string {
  const width = Math.max(40, Math.floor(options.width ?? 100));
  const colorEnabled =
    options.color !== false && options.isTTY !== false && options.tty !== false;
  const boardColumns = columns(snapshot);
  const taskCount = boardColumns.reduce(
    (count, column) => count + column.tasks.length,
    0,
  );
  if (taskCount === 0) return renderEmptyBoard(width);

  const selected = selectedTask(boardColumns, options);
  if (selected !== undefined && width < narrowWidth)
    return [
      ...renderDetails(selected, width, colorEnabled),
      "",
      footer(width),
    ].join("\n");

  const cycleId =
    firstText(snapshot.cycleId, snapshot.cycle?.id) ?? "Current cycle";
  const goal = firstText(snapshot.goal, snapshot.cycle?.goal);
  const totalTokens = firstText(snapshot.totalTokens, snapshot.tokenTotal);
  const summary = fit(
    `Cycle ${cycleId} · ${taskCount} task${taskCount === 1 ? "" : "s"}${totalTokens ? ` · ${totalTokens} tokens` : ""}${goal ? ` · ${goal}` : ""}`,
    width,
  );
  const selectedId = selected?.id;
  const doneExpanded =
    options.doneExpanded === true || options.expandedDone === true;

  if (width < narrowWidth) {
    const lines = [summary, ""];
    for (const column of boardColumns) {
      lines.push(`${column.name} (${column.tasks.length})`);
      if (column.name === "Done" && !doneExpanded) {
        lines.push("  collapsed");
        continue;
      }
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
    return [...lines, "", footer(width)].join("\n");
  }

  const detailWidth =
    selected === undefined ? 0 : Math.max(28, Math.floor(width * 0.3));
  const boardWidth = selected === undefined ? width : width - detailWidth - 3;
  const columnWidth = Math.max(10, Math.floor((boardWidth - 9) / 4));
  const boardLines = joinColumns(
    boardColumns.map((column) =>
      renderColumn({
        column,
        snapshot,
        selectedId,
        width: columnWidth,
        doneExpanded,
        colorEnabled,
      }),
    ),
    boardWidth,
  );
  const lines = [summary, "", ...boardLines];
  if (selected !== undefined) {
    const details = renderDetails(selected, detailWidth, colorEnabled);
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
  return [...lines, "", footer(width)].join("\n");
}
