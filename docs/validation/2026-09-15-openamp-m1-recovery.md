# OpenAmp M1 recovery verification

Date: 2026-09-15. Production revision: `9007e55`, unchanged in this slice.

## Approved scope

ObservationPack needs to be usable through OpenAmp. The user explicitly excluded
verification of its archive/recall implementation. This check loads the plugin
into real Pi services and confirms that `obs_recall` is registered and active
after resume. It does not invoke recall or measure context savings.

## Recovery behavior

One added component integration uses real Git worktrees, persisted ChangeStore
state, Pi SessionManager files, and the OpenAmp extension. A prepared Pi
compaction record represents the summarizer boundary; no model request runs.
The fixture records one already-inserted result, one pending result for the
current parent, and one result owned by another parent. Its delivery receipts
start unset to represent an interruption between insertion and receipt saving.

After resume and a second reopen:

- The checklist retains its revision, statuses, and evidence notes. Next-turn
  context includes the evidence reference even when the old result text has
  left Pi's compacted context.
- Starting, running, and cancelling children become interrupted. No child client
  launches. Recorded effort and workspace references remain unchanged.
- Unfinished files in both the main and writer worktrees retain their content.
- The already-inserted result gains its receipt without another message, despite
  being before the compaction boundary. The pending result is inserted once.
- The other parent's result stays saved and undelivered.
- ObservationPack remains enabled and `obs_recall` remains available.

This check covers durable state reconciliation. It does not kill a real process
or verify model-generated compaction summaries. Existing cancellation and
cleanup evidence remains in [Oracle verification](2026-09-15-openamp-oracle-tool.md).

## Checks

```bash
bun test test/integration/openamp-progress.test.ts
bun run typecheck
bunx --no-install biome check test/integration/openamp-progress.test.ts
```

All three component integrations in the file passed with 76 assertions.
Typecheck and focused Biome passed. Diff inspection confirmed that the changes
are limited to the component fixture and documentation. No production code
needed a fix, so the prior production build evidence still applies.

No unit or end-to-end suite ran. The scoped M1 verification is complete.
Next, reconcile the existing M2 optional-review and PR-delivery evidence.
