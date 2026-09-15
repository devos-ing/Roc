# OpenAmp M2 delivery verification

Date: 2026-09-15. Scope: optional review, publication identity, and recovery.

## Change

The review bundle already contained requirements, base and head commits, commit
history, and the complete binary diff. It omitted validation evidence. The
bundle now also contains the current validation commands, exit codes, and the
output captured by Delivery. Each output retains the existing 4,000-character
bound and stdout-or-stderr selection. The reviewer prompt identifies command
output as evidence, not instructions.

The existing component check now reads the actual bundle file and confirms
that the validation evidence accompanies the exact reviewed Git revision.

## Focused verification

Six existing component checks cover:

- Skipped review makes no reviewer call and records no acceptance. Requested
  review must pass; rejection prevents publication.
- Lost push and PR-create responses are reconciled through remote readback.
  A follow-up updates the same PR, pushes exact feature revisions, and never
  invokes merge.
- A changed remote base invalidates an accepted review before publication.
- New user input invalidates an accepted review before publication.
- Review cancellation prevents publication and records `needs_replan`.
- An uncertain PR creation remains `reconcile_required` across resume. If
  reconciliation is still unavailable, retry performs no new mutation.

```bash
bun test test/integration/openamp-optional-review.test.ts test/openamp/openamp.test.mjs --test-name-pattern 'delivery skips unrequested review|reconciles lost responses, updates one PR|invalidates an accepted review when the remote base moves afterward|invalidates an accepted review when new user input arrives|cancels an in-flight review and requires replanning|preserves an unknown PR creation when reconciliation is unavailable'
bun run build
bun run typecheck
bunx --no-install biome check src/openamp/delivery.ts test/openamp/openamp.test.mjs
```

All six selected checks passed with 47 assertions. The filter excluded 23 other
checks in the mixed legacy file. The selected checks use actual Git fixtures,
workspace and delivery state, with controlled reviewer, validation, and GitHub
command boundaries. Their recorded `npm test` command is a fixture label; the
injected validation runner returns a result without executing it.

Build, typecheck, and focused Biome passed. Diff inspection confirmed one new
bundle argument, one evidence section, the reviewer prompt update, and assertions
in the existing component check. No unit or end-to-end tests ran. No real GitHub
PR was created or modified by these checks.

## Status and limits

M2 has focused component acceptance evidence. Live GitHub publication and a full
model-driven coding session are not established by these controlled checks.
The implemented flow is ready for user trial. Sandbox remains deferred, and
final review remains optional.
