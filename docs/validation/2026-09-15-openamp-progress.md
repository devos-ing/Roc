# OpenAmp checklist and progress verification

Date: 2026-09-15. Scope: persistent checklist, native Pi widget, and main/child tool activity.

## Behavior verified

- Real Pi extension registration exposes `update_plan` and restores saved steps.
- Stale revisions and completed steps without evidence notes are rejected. Concurrent updates using the same revision produce one success.
- Main settlement and child cancellation clear dangling activity. An older child cannot overwrite newer main activity.
- Session replacement preserves the new UI observer after the old session shuts down.
- Checklist changes leave delivery phase, review acceptance, and publication state unchanged.
- Tool arguments and output markers are absent from the persisted activity record.

## Commands and results

Run from the implementation worktree:

```bash
bun run build
bun run typecheck
bunx --no-install biome check src/openamp/cli.ts src/openamp/extension.ts src/openamp/progress.ts src/openamp/state.ts src/openamp/supervisor.ts test/integration/openamp-progress.test.ts test/integration/openamp-oracle.test.ts
bun test test/integration/openamp-progress.test.ts test/integration/openamp-oracle.test.ts test/integration/openamp-optional-review.test.ts
```

Build and typecheck passed. Biome checked seven files with no fixes. The three
component integrations passed with 70 assertions and no failures. They use real
Git and durable state, plus actual Pi extension registration or controlled
Pi/GitHub boundaries. No unit or end-to-end suite was run.

## Native terminal inspection

A disposable Git fixture contained four saved steps with one completed, one
current, one blocked, and one pending. The compiled OpenAmp CLI resumed that
change in a PTY using native Pi 0.82.1. The widget showed `Plan 1/4 done`, the
current step, and the blocker reason. `/plan` expanded all four steps and the
completed item's evidence note. A second `/plan` collapsed the widget.
Ctrl-D closed the CLI with exit code 0. No model prompt was sent.

## Review and limits

A focused Astra/high source review found that a cancelled child could leave its
last tool activity marked running. The fix reconciles terminal state only for
the recorded activity's own run. The cancellation integration covers both
clearing that activity and preserving newer main activity. Re-review found no
remaining findings in that fix.

Evidence notes are agent reports, not independent proof or review approval.
This slice does not establish full M0 acceptance or measured context savings.
A main coding task with checklist updates and optional Oracle consultation
remains the next acceptance exercise. Context recall belongs to M1.
