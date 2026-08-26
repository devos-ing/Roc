# TOKEN-USAGE-BARS — Render token totals as colored horizontal bars

Week: 2026-W35
Risk: low
Token ceiling: 60000

## Problem

The current-week category report exposes correct totals, but ranked text alone is slower to scan and does not make the relative consumption of each category visually obvious.

## Desired outcome

`agile tokens` renders the existing category totals as a terminal-width horizontal bar chart with stable category colors while preserving exact counts, percentages, totals, and one-shot execution.

## Scope

- Scale horizontal bars relative to the largest non-zero category.
- Render fixed ANSI colors for Scout, Implement, Review, Advisor, Grilling, and Other.
- Enable color by default even through pipe or redirect.
- Add `--no-color` for explicit plain-text output.
- Fit the visible chart to terminal width with an 80-column fallback and a readable 40-column minimum.

## Non-goals

- A new TUI, React, or charting dependency.
- Live refresh or keyboard interaction.
- Custom themes, configurable colors, or alternative chart types.
- Historical comparisons or additional grouping dimensions.

## Acceptance criteria

- `agile tokens` displays a horizontal bar for every reported non-zero category, sorted by token count descending.
- The largest category uses the full available bar width, other bars scale proportionally, and every positive value receives at least one block.
- Bars use the approved fixed category colors and color remains enabled for TTY, pipe, and redirect output by default.
- `--no-color` produces the same visible chart without ANSI escape codes.
- Exact counts, integer percentages, and the grand total remain visible and unchanged by coloring.
- Width uses the terminal column count when available, otherwise 80, and remains readable down to 40 columns.
- Focused rendering and CLI tests pass, followed by the complete project check.

## Validation

- `bun test test/cli/token-chart.test.ts test/cli/run.test.ts test/cli/help.test.ts`
- `bun run check`

## Dependencies

- TOKEN-USAGE-REPORT

## Context candidates

- None
