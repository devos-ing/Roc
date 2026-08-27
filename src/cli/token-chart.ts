import type { CategoryTokenUsage } from "../store/orchestration-repository";

type DisplayCategory =
  | "Scout"
  | "Implement"
  | "Review"
  | "Advisor"
  | "Grilling"
  | "Other";

type TokenUsageRow = {
  category: DisplayCategory;
  tokens: number;
  percent: number;
};

export type TokenUsageChartOptions = {
  color?: boolean;
  width?: number;
};

const knownOrder: DisplayCategory[] = [
  "Scout",
  "Implement",
  "Review",
  "Advisor",
  "Grilling",
];

/** Maps a stored token category to its user-facing chart category. */
function displayCategory(category: string): DisplayCategory {
  if (category === "scout") return "Scout";
  if (category === "implement") return "Implement";
  if (category === "review") return "Review";
  if (category === "advisor") return "Advisor";
  if (category === "cycle_grilling" || category === "ticket_grilling")
    return "Grilling";
  return "Other";
}

/** Compares two strings with deterministic ascending lexical ordering. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Formats an integer token count with thousands separators. */
function formatTokens(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Aggregates raw category usage into sorted chart rows and a total. */
function summarizeTokenUsage(categories: CategoryTokenUsage[]): {
  totalTokens: number;
  rows: TokenUsageRow[];
} {
  const totals = new Map<DisplayCategory, number>(
    knownOrder.map((category) => [category, 0]),
  );
  for (const item of categories) {
    const category = displayCategory(item.category);
    totals.set(
      category,
      (totals.get(category) ?? 0) + item.inputTokens + item.outputTokens,
    );
  }

  const totalTokens = [...totals.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  const categoriesToShow =
    totalTokens === 0
      ? knownOrder
      : [...totals.entries()]
          .filter(([, tokens]) => tokens > 0)
          .sort(
            ([leftCategory, leftTokens], [rightCategory, rightTokens]) =>
              rightTokens - leftTokens ||
              compareText(leftCategory, rightCategory),
          )
          .map(([category]) => category);

  return {
    totalTokens,
    rows: categoriesToShow.map((category) => {
      const tokens = totals.get(category) ?? 0;
      return {
        category,
        tokens,
        percent:
          totalTokens === 0 ? 0 : Math.round((tokens / totalTokens) * 100),
      };
    }),
  };
}

const categoryColors: Record<DisplayCategory, string> = {
  Scout: "\u001B[36m",
  Implement: "\u001B[32m",
  Review: "\u001B[35m",
  Advisor: "\u001B[33m",
  Grilling: "\u001B[34m",
  Other: "\u001B[90m",
};

const resetColor = "\u001B[0m";
const minimumWidth = 40;
const fallbackWidth = 80;

/** Renders the current cycle's token usage as a width-aware text chart. */
export function renderTokenUsageChart(
  cycleId: string,
  categories: CategoryTokenUsage[],
  options: TokenUsageChartOptions = {},
): string {
  const summary = summarizeTokenUsage(categories);
  const labelWidth = Math.max(
    ...summary.rows.map((row) => row.category.length),
  );
  const countWidth = Math.max(
    ...summary.rows.map((row) => formatTokens(row.tokens).length),
  );
  const width = Math.max(minimumWidth, options.width ?? fallbackWidth);
  const largestUsage = Math.max(...summary.rows.map((row) => row.tokens));
  /** Renders the fixed label, token count, and percentage prefix for a chart row. */
  const linePrefix = (row: TokenUsageRow) =>
    `${row.category.padEnd(labelWidth)}  ${formatTokens(row.tokens).padStart(countWidth)} tokens  ${`${row.percent}%`.padStart(4)}`;
  const barWidth = Math.max(1, width - linePrefix(summary.rows[0]!).length - 2);
  const lines = summary.rows.map((row) => {
    if (row.tokens === 0) return linePrefix(row);
    const blocks = Math.max(
      1,
      Math.round((row.tokens / largestUsage) * barWidth),
    );
    const bar = "█".repeat(blocks);
    const renderedBar =
      options.color === false
        ? bar
        : `${categoryColors[row.category]}${bar}${resetColor}`;
    return `${linePrefix(row)}  ${renderedBar}`;
  });

  return [
    `Token usage · ${cycleId}`,
    "",
    ...lines,
    "",
    `Total: ${formatTokens(summary.totalTokens)} tokens`,
  ].join("\n");
}

/** Returns the ISO cycle identifier for a date in UTC. */
export function currentIsoWeekId(date = new Date()): string {
  const target = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const mondayBasedDay = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - mondayBasedDay + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const cycle =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / 604_800_000);
  return `${isoYear}-W${String(cycle).padStart(2, "0")}`;
}
