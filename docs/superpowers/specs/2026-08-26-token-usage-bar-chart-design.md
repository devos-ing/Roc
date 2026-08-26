# Token Usage Bar Chart — Design

Date: 2026-08-26

Status: approved

## 1. Goal

Add the smallest useful token dashboard to the CLI. Running
`agile tokens [--db PATH]` prints a one-shot horizontal bar chart for the
current ISO week and exits.

The chart answers one question: which workflow categories consumed this
week's tokens? It does not enforce a budget, stay open as an interactive TUI,
or add a charting dependency.

## 2. Approved product decisions

- Use workflow categories, not token kinds: Scout, Implement, Review,
  Advisor, Grilling, and Other.
- Show only the current ISO week.
- Render horizontal bars once and exit.
- Measure each category as `input_tokens + output_tokens`.
- Sort categories by token count descending.
- Print exact token counts, percentages, and a grand total.
- Render ANSI colors by default even when stdout is redirected or piped.
- Provide `--no-color` as the explicit plain-text escape hatch.
- Add no TUI, React, or charting package.

`cached_input_tokens` is already part of `input_tokens`, and
`reasoning_output_tokens` is already part of `output_tokens`; adding either
again would double count usage.

## 3. User-facing contract

```text
$ agile tokens
Token usage · 2026-W35

Implement  ████████████████████  28,420  48%
Review     ████████████          16,200  27%
Scout      ███████                9,100  15%
Grilling   ████                   4,500   8%
Advisor    █                      1,200   2%

Total: 59,420 tokens
```

The real default output wraps each category's bar in a fixed ANSI color:

| Display category | Stored categories | Color |
|---|---|---|
| Scout | `scout` | cyan |
| Implement | `implement` | green |
| Review | `review` | magenta |
| Advisor | `advisor` | yellow |
| Grilling | `weekly_grilling`, `ticket_grilling` | blue |
| Other | every unknown category | gray |

Unknown categories are never discarded. They are combined into Other so the
displayed grand total still equals the week's measured usage.

The current week ID is computed from the machine's local calendar as an ISO
week ID such as `2026-W35`. The command queries that exact week. The current
schema does not yet have an active-week lifecycle, so it must not guess by
selecting the newest database row.

### Empty states

- If the current week does not exist, print `No active week: <week-id>` and
  exit successfully.
- If the week exists but has no usage, print the five known categories with
  empty bars, zero values, and `Total: 0 tokens`.
- Do not print Other when it has no usage.

### Ordering and sizing

- Non-zero rows sort by token count descending, then by display name for a
  deterministic tie-break.
- The zero-usage view uses the stable order Scout, Implement, Review, Advisor,
  Grilling.
- The largest value receives the full available bar width; other bars scale
  proportionally. A positive value always receives at least one block.
- Use `process.stdout.columns` when present, otherwise 80 columns, and retain a
  readable compact layout at widths down to 40 columns.
- Values use locale-independent comma grouping so tests and output do not vary
  by machine locale.

Color is enabled unless `--no-color` is supplied. TTY detection and the
`NO_COLOR` environment variable do not change the default in this version.

## 4. Implementation shape

Keep the slice inside the existing repository and CLI boundaries:

```text
agile tokens [--db PATH]
        |
        +-- resolve current ISO week ID
        |
        +-- OrchestrationRepository: group usage by stored category
        |
        +-- pure category normalization and total calculation
        |
        +-- pure terminal-width bar renderer
        |
        +-- stdout, then exit
```

`OrchestrationRepository` receives one read method that returns raw category
totals for a requested week ID. SQL filters by `usage.week_id`, groups by the
stored category, and sums input and output separately. The method also
distinguishes a missing week from a present week with no usage.

A small CLI-local module owns the pure display logic:

1. map raw categories to display categories;
2. sum `inputTokens + outputTokens`;
3. sort rows and compute percentages;
4. scale bars to the available width;
5. optionally wrap bars in ANSI color codes.

The renderer receives width and color settings as inputs. It does not inspect
global process state, open SQLite, or write output, which keeps the important
formatting behavior deterministic in tests.

The existing CLI parser gains `tokens` plus the `--no-color` boolean option.
The default database-path behavior remains the same as the other commands.

## 5. Errors and exit codes

- Missing current-week data is a normal empty state and exits `0`.
- A week with zero usage is a normal chart and exits `0`.
- Database open/query failures are normalized through the existing
  `AgileError` and JSONL logger, written concisely to stderr, and exit `1`.
- Invalid CLI arguments exit `2` through the existing CLI error path.

No new error hierarchy or logging framework is introduced.

## 6. Core verification

Test only the behavior that protects the feature:

1. Repository aggregation returns the requested week only, groups stored
   categories, and does not add cached-input or reasoning-output values twice.
2. Category normalization combines both grilling categories, preserves unknown
   usage as Other, and sorts by value descending with deterministic ties.
3. Rendering at a fixed width produces proportional bars, exact counts,
   percentages, totals, default ANSI colors, and plain output with
   `--no-color`.
4. CLI coverage verifies the happy path and the missing-current-week message.

Exhaustive terminal-width, ANSI-emulator, locale, and SQLite-failure matrices
are outside this slice.

## 7. Out of scope

- live refresh, keyboard input, or a persistent TUI;
- historical week selection or comparisons;
- per-task, per-attempt, per-model, or token-kind charts;
- token budget enforcement or warnings;
- custom themes, configurable colors, or alternative chart types;
- a new direct dependency.
