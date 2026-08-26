# TOKEN-USAGE-REPORT — Show current-week token totals by workflow category

Week: 2026-W35
Risk: medium
Token ceiling: 100000

## Problem

Token usage is persisted but is only available inside the scheduler inspection JSON, so a user cannot quickly see which workflow categories consumed the current week's tokens.

## Desired outcome

Running `agile tokens` prints a ranked, one-shot current-week report grouped into Scout, Implement, Review, Advisor, Grilling, and Other, with exact token totals, percentages, and a grand total.

## Scope

- Read usage for the exact current local-calendar ISO week.
- Calculate each category as input tokens plus output tokens without double counting cached input or reasoning output.
- Combine weekly and ticket grilling, and preserve unknown categories as Other.
- Print a deterministic plain-text report sorted by usage descending.
- Handle missing-week and zero-usage states and existing CLI error conventions.

## Non-goals

- Horizontal bars or ANSI colors.
- Historical, per-task, per-attempt, per-model, or token-kind views.
- Token budget enforcement.
- Live refresh, keyboard interaction, or a persistent TUI.

## Acceptance criteria

- `agile tokens [--db PATH]` queries the exact current ISO week, prints once, and exits successfully.
- Totals use `input_tokens + output_tokens`; cached input and reasoning output are not added again.
- Stored categories map to Scout, Implement, Review, Advisor, Grilling, and Other, with both grilling categories combined.
- Non-zero categories sort by token count descending with a deterministic tie-break and show exact counts, integer percentages, and a grand total.
- A missing current week prints `No active week: <week-id>` and exits 0.
- A week without usage prints all five known categories with zero values and exits 0.
- Database failures use the existing typed error and JSONL logging path and exit 1; invalid arguments exit 2.
- Focused repository, formatting, CLI, and help tests pass.

## Validation

- `bun test test/store/orchestration-repository.test.ts`
- `bun test test/cli/token-chart.test.ts test/cli/run.test.ts test/cli/help.test.ts`
- `bun run check`

## Dependencies

- None

## Context candidates

- None
