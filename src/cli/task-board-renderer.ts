import { stripVTControlCharacters } from "node:util";
import { activitySummary } from "../harness/contracts";
import { renderHelpBox } from "./help-box";
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
  now?: number;
};

export type TaskBoardHit = { kind: "task"; taskId: string } | { kind: "done" };

export type TaskBoardPanes = {
  list: string;
  detail: string;
  listWidth: number;
};

const reset = "\u001B[0m";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal SGR sequences emitted below.
const ansiSgrPattern = /\u001B\[[0-9;]*m/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const colors = taskDisplayColors;
const narrowWidth = 100;

/** Reports whether the task board uses its two-pane layout at this width. */
export function taskBoardUsesWidePanes(width: number): boolean {
  return width >= narrowWidth;
}

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
/** Pads text to a visible terminal-cell width. */
export function padToVisibleWidth(value: string, width: number): string {
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

/** Describes the latest tool action without leaving a finished attempt marked as running. */
function latestActivity(
  attempt: TaskBoardTask["attempts"][number] | undefined,
  compact = false,
): string | undefined {
  const activity = attempt?.activity;
  if (activity === undefined) return undefined;
  const state =
    activity.status === "running" && attempt?.status !== "running"
      ? "Last activity"
      : activity.status === "running"
        ? "Running"
        : activity.status === "failed"
          ? "Failed"
          : "Completed";
  const summary = activitySummary(activity.summary);
  if (!compact) return `${state}: ${summary}`;
  const symbol =
    state === "Running"
      ? "◌"
      : state === "Failed"
        ? "×"
        : state === "Completed"
          ? "✓"
          : "·";
  return `${symbol} ${summary}`;
}

/** Formats a measured duration without treating unavailable timing as zero. */
function duration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "Unavailable";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Renders all persisted workflow stages without inferring missing checkpoint evidence. */
function renderProgress(
  task: TaskBoardTask,
  width: number,
  colorEnabled: boolean,
  _now: number,
): string[] {
  const stages = task.progress ?? [
    { label: "Scout", status: "Not recorded", tone: "muted" as const },
    { label: "Implement", status: "Not recorded", tone: "muted" as const },
    {
      label: "Independent Review",
      status: "Not recorded",
      tone: "muted" as const,
    },
    {
      label: "Publish PR",
      status: task.pullRequestUrl ? "Published" : "Not recorded",
      tone: task.pullRequestUrl ? ("done" as const) : ("muted" as const),
    },
    {
      label: "Waiting merge",
      status:
        task.rawStatus === "awaiting_merge" ? "Awaiting merge" : "Not recorded",
      tone:
        task.rawStatus === "awaiting_merge"
          ? ("attention" as const)
          : ("muted" as const),
    },
    {
      label: "Confirm complete",
      status:
        task.rawStatus === "done" ? "Confirmed complete" : "Not confirmed",
      tone: task.rawStatus === "done" ? ("done" as const) : ("muted" as const),
    },
  ];
  return stages.flatMap((stage, index) => {
    const symbol =
      stage.tone === "done"
        ? "✓"
        : stage.tone === "error"
          ? "×"
          : stage.tone === "attention"
            ? "!"
            : stage.tone === "active"
              ? "◌"
              : "○";
    const branch = index === stages.length - 1 ? "└─" : "├─";
    return wrap(
      `${branch} ${symbol} ${stage.label} · ${stage.status}${stage.retryIndex === undefined ? "" : ` · retry ${stage.retryIndex}`}`,
      width,
    ).map((line) => color(line, stage.tone, colorEnabled));
  });
}

/** Returns the task's current role, falling back to its raw scheduler status. */
function phase(task: TaskBoardTask, snapshot: TaskBoardSnapshot): string {
  const attempt = currentAttempt(task, snapshot);
  return attempt?.status === "running" ? attempt.role : task.rawStatus;
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
  const activity = latestActivity(
    currentAttempt(input.task, input.snapshot),
    true,
  );
  const lines = [
    fit(
      `${input.selected ? color("▌", "active", input.colorEnabled) : " "} ${input.task.isActive ? color("●", "active", input.colorEnabled) : " "} ${color(formatTaskDisplayId(input.task.id, input.projectSlug), statusTone(input.task) ?? "muted", input.colorEnabled)}  ${input.task.title}`,
      input.width,
    ),
    fit(
      `    ${cardStatus(input.task, input.snapshot, input.colorEnabled)}`,
      input.width,
    ),
  ];
  if (activity !== undefined) lines.push(fit(`    ${activity}`, input.width));
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

/** Returns the number of terminal rows occupied by one rendered card. */
function cardHeight(task: TaskBoardTask, snapshot: TaskBoardSnapshot): number {
  return (
    2 +
    Number(latestActivity(currentAttempt(task, snapshot)) !== undefined) +
    Number(blocker(task) !== undefined) +
    Number(task.rawStatus === "retired")
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
  now: number,
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
    detailField("Elapsed", duration(task.timing?.elapsedMs), width),
    detailField("Attempt time", duration(task.timing?.attemptMs), width),
    detailField("Merge wait", duration(task.timing?.waitingMs), width),
    ...(task.issueUrl ? [detailField("Issue", task.issueUrl, width)] : []),
    ...(task.pullRequestUrl
      ? [detailField("PR", task.pullRequestUrl, width)]
      : []),
    ...(task.failure || task.column === "attention"
      ? [
          detailField(
            "Reason",
            task.failure
              ? activitySummary(task.failure)
              : "No failure reason recorded.",
            width,
          ),
        ]
      : []),
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
      `${tokenCount(task.tokenTotals)}/${task.tokenTarget}${task.usageIncomplete ? " · partial usage" : ""}`,
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
  const acceptance =
    task.acceptanceChecklist.length === 0
      ? []
      : [
          detailSection("Acceptance checklist", width, colorEnabled),
          ...task.acceptanceChecklist.flatMap((item) => [
            ...wrap(
              `${item.status === "passed" ? "[x]" : "[ ]"} ${item.criterion}`,
              width,
            ),
            ...wrap(`Status: ${item.status}`, width, "  "),
            ...(item.evidence
              ? item.evidence
                  .split("\n")
                  .flatMap((line) => wrap(`Evidence: ${line}`, width, "  "))
              : wrap(
                  "Evidence: No item-level evidence recorded.",
                  width,
                  "  ",
                )),
          ]),
        ];
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
    detailSection("Progress", width, colorEnabled),
    ...renderProgress(task, width, colorEnabled, now),
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
    ...(acceptance.length === 0 ? [] : ["", ...acceptance]),
    ...(task.failure || task.column === "attention"
      ? [
          "",
          detailSection("Recovery guidance", width, colorEnabled),
          ...wrap(
            "Read-only monitor: run scheduler inspect or inspect .agile/runtime/agile.log on the execution host. Review the saved Issue, PR, and retained worktree; no recovery action is available here.",
            width,
          ),
        ]
      : []),
    ...retirement,
  ];
}

/** Renders the keyboard shortcuts in a wrapping help box below the board. */
function footer(width: number, colorEnabled: boolean): string {
  return color(
    renderHelpBox(
      "Controls",
      "↑↓ move · Space preview · Enter details · d Done · ? help · q quit",
      width,
    ),
    "muted",
    colorEnabled,
  );
}

/** Wraps the shared empty-backlog guidance for the available terminal width. */
function emptyBoardGuidance(width: number): string[] {
  return renderEmptyTaskList(width)
    .split("\n")
    .map((line) => fit(line, width));
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
    `Roc${snapshot.remoteCheckpoints ? " · GitHub checkpoints" : ""} · Cycle ${snapshot.currentCycleId} · ${taskCount} task${taskCount === 1 ? "" : "s"}${activity}${tokens}${snapshot.usageIncomplete ? " · partial usage" : ""}`,
    width,
  );
}

/** Returns the task-list entries while preserving the existing Done filtering behavior. */
function listedTasks(
  snapshot: TaskBoardSnapshot,
  doneExpanded: boolean,
): TaskBoardTask[] {
  return snapshot.tasks.filter(
    (task) => doneExpanded || task.column !== "done",
  );
}

/** Renders the task-list half of either responsive board layout at its assigned width. */
function renderListLines(input: {
  snapshot: TaskBoardSnapshot;
  tasks: TaskBoardTask[];
  selectedId?: string;
  width: number;
  colorEnabled: boolean;
  projectSlug: string;
  doneExpanded: boolean;
}): string[] {
  const lines = [
    color(
      fit(
        `Ready · ${input.snapshot.columns.ready.length} · Tasks ${input.tasks.length}${input.doneExpanded ? "" : ` · Done ${input.snapshot.columns.done.length} hidden [d]`}`,
        input.width,
      ),
      "muted",
      input.colorEnabled,
    ),
    color("─".repeat(input.width), "muted", input.colorEnabled),
    ...(input.tasks.length === 0
      ? [color("  —", "muted", input.colorEnabled)]
      : input.tasks.flatMap((task, index) => [
          ...(index === 0 ? [] : [""]),
          ...renderCard({
            task,
            snapshot: input.snapshot,
            selected: task.id === input.selectedId,
            width: input.width,
            colorEnabled: input.colorEnabled,
            projectSlug: input.projectSlug,
          }),
        ])),
  ];
  if (input.snapshot.tasks.length === 0)
    lines.push("", ...emptyBoardGuidance(input.width));
  return lines;
}

/** Renders a stable responsive task list with selected-task progress details. */
export function renderTaskBoard(
  snapshot: TaskBoardSnapshot,
  options: TaskBoardRenderOptions = {},
): string {
  const width = Math.max(1, Math.floor(options.width ?? 100));
  const projectSlug = options.projectSlug ?? "project";
  const now = options.now ?? Date.now();
  const colorEnabled =
    options.color !== false && options.isTTY !== false && options.tty !== false;
  const doneExpanded =
    options.doneExpanded === true ||
    options.expandedDone === true ||
    snapshot.history === true;
  const selected = snapshot.tasks.find(
    (task) => task.id === (options.selectedTaskId ?? options.selectedId),
  );
  const detail = options.detailTaskId
    ? snapshot.tasks.find((task) => task.id === options.detailTaskId)
    : options.detailMode === "none"
      ? undefined
      : selected;
  const heading = color(
    summary(snapshot, snapshot.tasks.length, width),
    "active",
    colorEnabled,
  );
  if (detail && (options.detailMode === "full" || width < narrowWidth))
    return plainSnapshot(
      [
        ...renderDetails(detail, snapshot, width, colorEnabled, now),
        "",
        footer(width, colorEnabled),
      ].join("\n"),
      colorEnabled,
    );

  const tasks = listedTasks(snapshot, doneExpanded);
  if (width < narrowWidth)
    return plainSnapshot(
      [
        heading,
        "",
        ...renderListLines({
          snapshot,
          tasks,
          selectedId: selected?.id,
          width,
          colorEnabled,
          projectSlug,
          doneExpanded,
        }),
        "",
        footer(width, colorEnabled),
      ].join("\n"),
      colorEnabled,
    );

  const listWidth = Math.max(28, Math.floor((width - 3) * 0.38));
  const detailWidth = Math.max(1, width - listWidth - 3);
  const boundedList = renderListLines({
    snapshot,
    tasks,
    selectedId: selected?.id,
    width: listWidth,
    colorEnabled,
    projectSlug,
    doneExpanded,
  });
  const detailLines = selected
    ? renderDetails(selected, snapshot, detailWidth, colorEnabled, now)
    : [color("Select a task", "muted", colorEnabled)];
  const height = Math.max(boundedList.length, detailLines.length);
  return plainSnapshot(
    [
      heading,
      "",
      ...Array.from(
        { length: height },
        (_, index) =>
          `${padToVisibleWidth(boundedList[index] ?? "", listWidth)} │ ${detailLines[index] ?? ""}`,
      ),
      "",
      footer(width, colorEnabled),
    ].join("\n"),
    colorEnabled,
  );
}

/** Splits the wide board into independently scrollable list and pinned detail text. */
export function renderTaskBoardPanes(
  snapshot: TaskBoardSnapshot,
  options: TaskBoardRenderOptions = {},
): TaskBoardPanes | undefined {
  const width = Math.max(1, Math.floor(options.width ?? 100));
  if (width < narrowWidth || options.detailMode === "full") return undefined;
  const listWidth = Math.max(28, Math.floor((width - 3) * 0.38));
  const colorEnabled = options.color !== false && options.isTTY !== false;
  const doneExpanded =
    options.doneExpanded === true || snapshot.history === true;
  const selected = snapshot.tasks.find(
    (task) => task.id === options.selectedTaskId,
  );
  const detailWidth = Math.max(1, width - listWidth - 3);
  const list = renderListLines({
    snapshot,
    tasks: listedTasks(snapshot, doneExpanded),
    selectedId: selected?.id,
    width: listWidth,
    colorEnabled,
    projectSlug: options.projectSlug ?? "project",
    doneExpanded,
  });
  const detail = selected
    ? renderDetails(
        selected,
        snapshot,
        detailWidth,
        colorEnabled,
        options.now ?? Date.now(),
      )
    : [color("Select a task", "muted", colorEnabled)];
  return {
    list: [
      color(
        summary(snapshot, snapshot.tasks.length, listWidth),
        "active",
        colorEnabled,
      ),
      "",
      ...list,
      "",
      footer(listWidth, colorEnabled),
    ].join("\n"),
    detail: ["", "", ...detail].join("\n"),
    listWidth,
  };
}

/** Shares rendered list-card bounds between mouse input and keyboard scrolling. */
function taskBoardRegions(
  snapshot: TaskBoardSnapshot,
  options: TaskBoardRenderOptions,
) {
  const width = Math.max(1, Math.floor(options.width ?? 100));
  const doneExpanded =
    options.doneExpanded === true ||
    options.expandedDone === true ||
    snapshot.history === true;
  const selectedId = options.selectedTaskId ?? options.selectedId;
  if (
    options.detailMode === "full" ||
    (width < narrowWidth && options.detailMode !== "none" && selectedId)
  )
    return [];
  const listWidth =
    width < narrowWidth ? width : Math.max(28, Math.floor((width - 3) * 0.38));
  const regions: {
    hit: TaskBoardHit;
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];
  let row = 3; // summary and blank line precede the list heading.
  regions.push({
    hit: { kind: "done" },
    x: 1,
    y: row,
    width: listWidth,
    height: 1,
  });
  row += 2;
  for (const [index, task] of listedTasks(snapshot, doneExpanded).entries()) {
    if (index > 0) row += 1;
    const height = cardHeight(task, snapshot);
    regions.push({
      hit: { kind: "task", taskId: task.id },
      x: 1,
      y: row,
      width: listWidth,
      height,
    });
    row += height;
  }
  return regions;
}

/** Returns the selected list card's zero-based row range with an exclusive end. */
export function taskBoardSelectionRows(
  snapshot: TaskBoardSnapshot,
  options: TaskBoardRenderOptions,
): { start: number; end: number } | undefined {
  const selectedId = options.selectedTaskId ?? options.selectedId;
  const region = taskBoardRegions(snapshot, options).find(
    ({ hit }) => hit.kind === "task" && hit.taskId === selectedId,
  );
  return region === undefined
    ? undefined
    : { start: region.y - 1, end: region.y - 1 + region.height };
}

/** Maps a one-based terminal mouse position to a responsive task-list card. */
export function taskBoardHitTest(
  snapshot: TaskBoardSnapshot,
  point: { x: number; y: number },
  options: TaskBoardRenderOptions = {},
): TaskBoardHit | undefined {
  return taskBoardRegions(snapshot, options).find(
    (region) =>
      point.x >= region.x &&
      point.x < region.x + region.width &&
      point.y >= region.y &&
      point.y < region.y + region.height,
  )?.hit;
}
