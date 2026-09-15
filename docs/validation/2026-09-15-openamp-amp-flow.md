# Amp-style main-thread coding and optional review

Date: 2026-09-15. User direction: copy Amp's main-coding flow and make final review optional too.

## Implemented policy

The main Pi session can plan, edit, run checks, and apply fixes. The earlier main-session read-only boundary is removed. The main prompt preserves Pi's assembled instructions and delegates independent work only when useful.

The interactive `deliver_change` tool defaults its optional `review` parameter to false. Delivery still requires successful validation and current repository/branch/base/head/input-generation checks. A skipped review stores no accepted review and the PR explicitly says review was not requested. Setting review=true requests a fresh independent reviewer; rejection or invalid approval prevents that publication.

The lower-level Delivery API retains its existing omission behavior for existing callers; the interactive product entry explicitly passes its new false default. No general publication, merge, or credential boundary is removed.

## Observed checks

- `bun run build`: passed.
- `bun run typecheck`: passed.
- Focused Biome check on changed runtime and integration source: passed.
- `bun test test/integration/openamp-optional-review.test.ts`: one component integration passed with 12 assertions, real Git/workspace/state and controlled external reviewer/GitHub boundaries. It covers skipped review, requested acceptance, and requested rejection with no further publication.
- Independent read-only Astra source review: no actionable regressions in the policy diff.

No unit or end-to-end suites were run. The native UI and live external publication were not exercised by this check.

## Remaining work

The optional Oracle consultation tool, explicit main/Oracle model profiles, persistent checklist/progress, and non-cancelling wait expiry remain planned. This policy change is not complete M0 or a full Amp clone. Sandbox remains deferred.
