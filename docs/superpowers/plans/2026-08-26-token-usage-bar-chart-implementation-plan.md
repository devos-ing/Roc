# Token Usage Bar Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agile tokens [--db PATH] [--no-color]`, which prints a colored one-shot horizontal chart of current-week token usage grouped by workflow category.

**Architecture:** Add one read-only aggregation method to the existing orchestration repository, then pass its raw category totals through a pure CLI-local summarizer and renderer. The command computes the local ISO week, opens the existing SQLite database, renders once, and exits; no new runtime dependency or live TUI loop is introduced.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, Zod, Bun test, ANSI escape codes

---

## File map

- Modify `src/store/orchestration-repository.ts`: validate a week ID and return raw input/output totals grouped by stored usage category.
- Create `src/cli/token-chart.ts`: compute ISO week IDs, normalize display categories, scale horizontal bars, and render ANSI/plain output.
- Modify `src/cli/run.ts`: parse `tokens` and `--no-color`, execute the read-only command, and report operational errors through the existing logger.
- Modify `src/cli/help.ts`: advertise the command.
- Modify `test/store/orchestration-repository.test.ts`: protect week filtering and raw token aggregation.
- Create `test/cli/token-chart.test.ts`: protect category mapping, sorting, percentages, bar scaling, colors, and ISO week boundaries.
- Modify `test/cli/run.test.ts`: cover the command's chart and missing-week paths.
- Modify `test/cli/help.test.ts`: cover help output.

No migration or dependency change is required.

### Task 1: Read category usage for one week

**Files:**
- Modify: `src/store/orchestration-repository.ts`
- Test: `test/store/orchestration-repository.test.ts`

- [ ] **Step 1: Write the failing repository test**

Append this focused test to `test/store/orchestration-repository.test.ts`:

```ts
test("reads raw category usage for one requested week", () => {
  const { db, repo } = setup();
  try {
    db.query(`
      INSERT INTO usage(
        id, week_id, task_id, category,
        input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
      ) VALUES
        ('usage-scout', '2026-W35', 'T1', 'scout', 100, 80, 20, 10),
        ('usage-grill', '2026-W35', NULL, 'weekly_grilling', 40, 30, 5, 4)
    `).run();

    expect(repo.getWeekCategoryUsage("2026-W35")).toEqual({
      weekId: "2026-W35",
      categories: [
        { category: "scout", inputTokens: 100, outputTokens: 20 },
        { category: "weekly_grilling", inputTokens: 40, outputTokens: 5 },
      ],
    });
    expect(repo.getWeekCategoryUsage("2026-W34")).toBeUndefined();
  } finally {
    db.close();
  }
});
```

The expected values deliberately exclude cached-input and reasoning-output
columns because they are subdivisions of the two top-level totals.

- [ ] **Step 2: Run the test and verify the method is missing**

Run:

```bash
rtk bun test test/store/orchestration-repository.test.ts
```

Expected: FAIL with `repo.getWeekCategoryUsage is not a function` or the
equivalent TypeScript property error.

- [ ] **Step 3: Add the validated result type**

Near the existing token-total schemas in
`src/store/orchestration-repository.ts`, define and export:

```ts
const WeekIdSchema = z.string().regex(/^\d{4}-W\d{2}$/);
const CategoryTokenUsageSchema = z.object({
  category: NonEmpty,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
}).strict();
const WeekCategoryUsageSchema = z.object({
  weekId: WeekIdSchema,
  categories: z.array(CategoryTokenUsageSchema),
}).strict();

export type CategoryTokenUsage = z.infer<typeof CategoryTokenUsageSchema>;
export type WeekCategoryUsage = z.infer<typeof WeekCategoryUsageSchema>;
```

Replace the inline week-ID schema in `InspectionWeekSchema` with
`id: WeekIdSchema` so both read paths enforce the same format.

- [ ] **Step 4: Implement the smallest repository query**

Add this public method before `inspect()`:

```ts
getWeekCategoryUsage(weekId: string): WeekCategoryUsage | undefined {
  const id = WeekIdSchema.parse(weekId);
  const week = this.db.query<{ id: string }, [string]>(
    "SELECT id FROM weeks WHERE id = ?",
  ).get(id);
  if (week === null) return undefined;

  const categories = this.db.query<{
    category: string;
    input_tokens: number;
    output_tokens: number;
  }, [string]>(`
    SELECT
      category,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM usage
    WHERE week_id = ?
    GROUP BY category
    ORDER BY category ASC
  `).all(id).map((row) => CategoryTokenUsageSchema.parse({
    category: row.category,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  }));

  return WeekCategoryUsageSchema.parse({ weekId: week.id, categories });
}
```

Use `if (week == null)` instead if the local Bun SQLite type reports both
`null` and `undefined`; do not change the behavior.

- [ ] **Step 5: Run the repository tests**

Run:

```bash
rtk bun test test/store/orchestration-repository.test.ts
```

Expected: all repository tests PASS.

- [ ] **Step 6: Commit the repository read path**

```bash
rtk git add src/store/orchestration-repository.ts test/store/orchestration-repository.test.ts
rtk git commit -m "feat: read weekly token categories"
```

### Task 2: Normalize and render the bar chart

**Files:**
- Create: `src/cli/token-chart.ts`
- Create: `test/cli/token-chart.test.ts`

- [ ] **Step 1: Write the failing pure-function tests**

Create `test/cli/token-chart.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  currentIsoWeekId,
  renderTokenUsageChart,
  summarizeTokenUsage,
} from "../../src/cli/token-chart";

const raw = [
  { category: "review", inputTokens: 50, outputTokens: 10 },
  { category: "implement", inputTokens: 100, outputTokens: 20 },
  { category: "weekly_grilling", inputTokens: 5, outputTokens: 5 },
  { category: "ticket_grilling", inputTokens: 10, outputTokens: 0 },
  { category: "unrecognized", inputTokens: 3, outputTokens: 2 },
];

test("normalizes, combines, and ranks workflow categories", () => {
  expect(summarizeTokenUsage(raw)).toEqual({
    totalTokens: 205,
    rows: [
      { category: "Implement", tokens: 120, percent: 59 },
      { category: "Review", tokens: 60, percent: 29 },
      { category: "Grilling", tokens: 20, percent: 10 },
      { category: "Other", tokens: 5, percent: 2 },
    ],
  });
});

test("renders proportional bars with default color and optional plain text", () => {
  const colored = renderTokenUsageChart({
    weekId: "2026-W35",
    categories: raw,
    width: 60,
    color: true,
  });
  const plain = renderTokenUsageChart({
    weekId: "2026-W35",
    categories: raw,
    width: 60,
    color: false,
  });

  expect(colored).toContain("\u001b[32m");
  expect(colored).toContain("\u001b[35m");
  expect(plain).not.toContain("\u001b[");
  expect(plain).toContain("Implement");
  expect(plain).toContain("120");
  expect(plain).toContain("59%");
  expect(plain).toContain("Total: 205 tokens");
  expect(plain.indexOf("Implement")).toBeLessThan(plain.indexOf("Review"));
});

test("renders all known categories when usage is zero", () => {
  const output = renderTokenUsageChart({
    weekId: "2026-W35",
    categories: [],
    width: 40,
    color: false,
  });
  for (const category of ["Scout", "Implement", "Review", "Advisor", "Grilling"]) {
    expect(output).toContain(category);
  }
  expect(output).not.toContain("Other");
  expect(output).toContain("Total: 0 tokens");
});

test("computes local-calendar ISO week IDs across a year boundary", () => {
  expect(currentIsoWeekId(new Date(2026, 7, 26))).toBe("2026-W35");
  expect(currentIsoWeekId(new Date(2027, 0, 1))).toBe("2026-W53");
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

```bash
rtk bun test test/cli/token-chart.test.ts
```

Expected: FAIL because `src/cli/token-chart.ts` does not exist.

- [ ] **Step 3: Implement the pure chart module**

Create `src/cli/token-chart.ts` with this complete implementation:

```ts
import type { CategoryTokenUsage } from "../store/orchestration-repository";

type DisplayCategory = "Scout" | "Implement" | "Review" | "Advisor" | "Grilling" | "Other";

export type TokenUsageRow = {
  category: DisplayCategory;
  tokens: number;
  percent: number;
};

const knownOrder: DisplayCategory[] = ["Scout", "Implement", "Review", "Advisor", "Grilling"];
const colors: Record<DisplayCategory, string> = {
  Scout: "\u001b[36m",
  Implement: "\u001b[32m",
  Review: "\u001b[35m",
  Advisor: "\u001b[33m",
  Grilling: "\u001b[34m",
  Other: "\u001b[90m",
};
const reset = "\u001b[0m";

function displayCategory(category: string): DisplayCategory {
  if (category === "scout") return "Scout";
  if (category === "implement") return "Implement";
  if (category === "review") return "Review";
  if (category === "advisor") return "Advisor";
  if (category === "weekly_grilling" || category === "ticket_grilling") return "Grilling";
  return "Other";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatTokens(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function summarizeTokenUsage(categories: CategoryTokenUsage[]): {
  totalTokens: number;
  rows: TokenUsageRow[];
} {
  const totals = new Map<DisplayCategory, number>(knownOrder.map((category) => [category, 0]));
  for (const item of categories) {
    const category = displayCategory(item.category);
    totals.set(category, (totals.get(category) ?? 0) + item.inputTokens + item.outputTokens);
  }
  const totalTokens = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const categoriesToShow = totalTokens === 0
    ? knownOrder
    : [...totals.entries()]
      .filter(([, tokens]) => tokens > 0)
      .sort(([leftCategory, leftTokens], [rightCategory, rightTokens]) =>
        rightTokens - leftTokens || compareText(leftCategory, rightCategory))
      .map(([category]) => category);

  return {
    totalTokens,
    rows: categoriesToShow.map((category) => {
      const tokens = totals.get(category) ?? 0;
      return {
        category,
        tokens,
        percent: totalTokens === 0 ? 0 : Math.round(tokens / totalTokens * 100),
      };
    }),
  };
}

export function renderTokenUsageChart(input: {
  weekId: string;
  categories: CategoryTokenUsage[];
  width: number;
  color: boolean;
}): string {
  const summary = summarizeTokenUsage(input.categories);
  const labelWidth = Math.max(...summary.rows.map((row) => row.category.length));
  const countWidth = Math.max(...summary.rows.map((row) => formatTokens(row.tokens).length));
  const availableWidth = Math.max(40, input.width || 80);
  const barWidth = Math.max(1, availableWidth - labelWidth - countWidth - 10);
  const maximum = Math.max(...summary.rows.map((row) => row.tokens));
  const lines = summary.rows.map((row) => {
    const blocks = row.tokens === 0 || maximum === 0
      ? 0
      : Math.max(1, Math.round(row.tokens / maximum * barWidth));
    const bar = "█".repeat(blocks);
    const coloredBar = input.color && blocks > 0 ? `${colors[row.category]}${bar}${reset}` : bar;
    const padding = " ".repeat(barWidth - blocks);
    return `${row.category.padEnd(labelWidth)}  ${coloredBar}${padding}  ${formatTokens(row.tokens).padStart(countWidth)}  ${`${row.percent}%`.padStart(4)}`;
  });

  return [
    `Token usage · ${input.weekId}`,
    "",
    ...lines,
    "",
    `Total: ${formatTokens(summary.totalTokens)} tokens`,
  ].join("\n");
}

export function currentIsoWeekId(date = new Date()): string {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const mondayBasedDay = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - mondayBasedDay + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / 604_800_000);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run the pure-function tests**

```bash
rtk bun test test/cli/token-chart.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit the renderer**

```bash
rtk git add src/cli/token-chart.ts test/cli/token-chart.test.ts
rtk git commit -m "feat: render token usage bars"
```

### Task 3: Wire the one-shot CLI command

**Files:**
- Modify: `src/cli/run.ts`
- Modify: `src/cli/help.ts`
- Modify: `test/cli/run.test.ts`
- Modify: `test/cli/help.test.ts`

- [ ] **Step 1: Write failing help and CLI tests**

Add this assertion to the existing help test:

```ts
expect(helpText).toContain("agile tokens [--db PATH] [--no-color]");
```

Add imports to `test/cli/run.test.ts`:

```ts
import { currentIsoWeekId } from "../../src/cli/token-chart";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";
```

Then append:

```ts
test("tokens prints the current-week chart and supports plain output", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const weekId = currentIsoWeekId();
  const db = openDatabase(dbPath);
  new PlanningRepository(db).createWeek({
    id: weekId,
    goal: "See token usage",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: [],
  });
  db.query(`
    INSERT INTO usage(
      id, week_id, category,
      input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
    ) VALUES('cli-usage', ?, 'implement', 100, 80, 50, 30)
  `).run(weekId);
  db.close();
  const output: string[] = [];

  try {
    expect(await runCli(["tokens", "--db", dbPath, "--no-color"], {
      out: (text) => output.push(text),
      err: (text) => output.push(text),
    })).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain(`Token usage · ${weekId}`);
    expect(output[0]).toContain("Implement");
    expect(output[0]).toContain("Total: 150 tokens");
    expect(output[0]).not.toContain("\u001b[");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tokens reports a missing current week as an empty state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const db = openDatabase(dbPath);
  db.close();
  const output: string[] = [];

  try {
    expect(await runCli(["tokens", "--db", dbPath], {
      out: (text) => output.push(text),
      err: (text) => output.push(text),
    })).toBe(0);
    expect(output).toEqual([`No active week: ${currentIsoWeekId()}`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the CLI tests and verify the command is unknown**

```bash
rtk bun test test/cli/help.test.ts test/cli/run.test.ts
```

Expected: FAIL because help omits `agile tokens` and the CLI reports an unknown
command.

- [ ] **Step 3: Add the CLI option and help text**

Import the chart helpers in `src/cli/run.ts`:

```ts
import { currentIsoWeekId, renderTokenUsageChart } from "./token-chart";
```

Add the boolean option to `parseCliArgs`:

```ts
"no-color": { type: "boolean" },
```

Add this usage line to `src/cli/help.ts` after `task list`:

```text
  agile tokens [--db PATH] [--no-color]
```

- [ ] **Step 4: Make operational error reporting reusable**

Add this type above `reportOperationalError`:

```ts
type OperationalErrorFallback = {
  code: string;
  category: "startup" | "protocol" | "infra" | "policy" | "domain";
  retryable: boolean;
  component: string;
  message: string;
};
```

Change the function signature and its `normalizeError` call to:

```ts
async function reportOperationalError(
  error: unknown,
  io: CliIo,
  runtime: CliRuntime,
  input: { dbPath: string; repoPath?: string },
  fallback: OperationalErrorFallback = {
    code: "SCHEDULER_RUN_FAILED",
    category: "infra",
    retryable: false,
    component: "cli",
    message: "Scheduler run failed",
  },
): Promise<number> {
  const safe = normalizeError(error, fallback);
  try {
    await runtime.logError?.(safe, input);
  } catch {
    // The operational error remains authoritative if safe logging itself fails.
  }
  io.err(`${safe.code}: ${safe.message}`);
  return 1;
}
```

Existing scheduler calls require no change because the default preserves their
current behavior.

- [ ] **Step 5: Add the one-shot command branch**

Insert this branch after `task list` and before `scheduler run`:

```ts
if (command === "tokens" && subcommand === undefined) {
  try {
    const db = openDatabase(dbPath);
    try {
      const weekId = currentIsoWeekId();
      const usage = new OrchestrationRepository(db).getWeekCategoryUsage(weekId);
      if (usage === undefined) {
        io.out(`No active week: ${weekId}`);
        return 0;
      }
      io.out(renderTokenUsageChart({
        weekId,
        categories: usage.categories,
        width: process.stdout.columns ?? 80,
        color: parsed.values["no-color"] !== true,
      }));
      return 0;
    } finally {
      db.close();
    }
  } catch (error) {
    return reportOperationalError(error, io, runtime, { dbPath }, {
      code: "TOKEN_USAGE_READ_FAILED",
      category: "infra",
      retryable: false,
      component: "cli",
      message: "Could not read token usage",
    });
  }
}
```

This deliberately enables color without checking `process.stdout.isTTY`; only
`--no-color` disables it.

- [ ] **Step 6: Run focused tests**

```bash
rtk bun test test/cli/token-chart.test.ts test/cli/help.test.ts test/cli/run.test.ts test/store/orchestration-repository.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 7: Run the complete project gate**

```bash
rtk bun run check
```

Expected: TypeScript reports no errors; all core tests pass; the opt-in real
Codex integration test may remain skipped.

- [ ] **Step 8: Commit the CLI slice**

```bash
rtk git add src/cli/run.ts src/cli/help.ts test/cli/run.test.ts test/cli/help.test.ts
rtk git commit -m "feat: show weekly token usage chart"
```

