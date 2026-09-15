# Oracle tool-boundary implementation evidence

Date: 2026-09-15. Scope: first bounded M0 implementation step, not M0 acceptance.

## Delivered behavior

The main planning session starts without `bash`, `edit`, or `write`. Its extension blocks those tool calls if they are otherwise activated and blocks arbitrary user shell shortcuts. The main prompt preserves Pi instructions and directs all code edits and review fixes to a writer. Child writer tools and existing deterministic workspace integration and Delivery review remain available.

## Observed checks

- `bun run build`: passed.
- `bun run typecheck`: passed.
- `bunx --no-install biome check src/openamp/cli.ts src/openamp/extension.ts`: passed.
- `git diff --check`: passed.
- Direct Pi SDK provider smoke before the patch: `openai-codex/gpt-5.6-luna` at `medium` and `openai-codex/gpt-6-astra` at `high` each returned `READY` with an empty tool allowlist. This establishes provider connectivity, not full product acceptance.

No unit or end-to-end tests were written or run. No full orchestration integration or real terminal acceptance was performed for this boundary-only slice. Static checks and independent source review must not be described as complete M0 behavior verification.

## Fresh review

A fresh GPT-6 Astra agent at high effort reviewed the two-file diff against `773c121` and the installed Pi implementation. It found no actionable correctness or security regressions. The review confirmed explicit tool allowlisting, tool-call blocking before execution, replacement shell results before command execution, and prompt preservation without per-turn accumulation. This was source review, not a runtime test.

## Remaining M0 work

Explicit persisted Oracle/implementer profiles and pre-prompt effective-model checks; one-writer lifecycle with confirmed shutdown and owned session resume; persistent checklist and real tool activity; shared-checkout result validation; local fresh review and bounded fix loop. Reuse the existing runtime rather than rebuild its CLI or persistence.

## Execution record

The plan and diagrams were pushed as `773c1210bf4ff68e0265ba1b38795b45c695ca17` on `codex/openamp-oracle-workflow`. GPT-5.6 Luna at high effort authored this patch. Two earlier larger attempts each reached the configured 600-second timeout without a patch. The third attempt produced this bounded change. The host removed one redundant prompt addition and applied the model-authored diff with hunk recounting. Attempt receipts remain in the original task's `.scratch/auto/openamp-architecture-2026-09-15/` directory.

The development commit hook runs the prohibited general test suite. Commits use a per-command hook override after the allowed checks above; repository hook files and test policy remain unchanged.
