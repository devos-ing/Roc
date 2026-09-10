# Native acceptance checklist

## Outcome

Roc shows each original Issue acceptance criterion with its recorded Review
status and evidence in the read-only task board, `task acceptance <issue>`, and
Roc-managed pull-request bodies.

## Scope

- Review may emit optional indexed `acceptanceResults`, each with `passed`,
  `failed`, or `unverified` plus non-empty evidence.
- Presentation always uses the original Issue criterion text and index. Duplicate
  text remains separate criteria.
- One pure projection only marks a criterion passed when results are complete,
  unique, in range, evidenced, and bound to the current specification, head,
  and base. Otherwise every item is unverified with no fabricated evidence.
- A current rejected Review can show failed evidence in the read-only views.
- PRs label the checklist as automated Review evidence for their exact head;
  human acceptance remains separate.
- A refreshed head receives fresh Review and reconciles the existing PR body.
  A changed publication SHA requires that exact accepted Review binding, while
  preserving the original Implement report.

## Non-goals

- No new merge or human-approval gate.
- No separate checklist database or mutation from `task acceptance`.
- No changes to retry, authority, cancellation, model routing, or deadline
  behavior.

## Verification seams

- Fake Harness persists an accepted indexed result into the native read model.
- Projection boundaries reject legacy, incomplete, duplicate, out-of-range,
  empty, and stale evidence as checked rows.
- Board and CLI render read-only per-item evidence, including current rejected
  Review failures.
- PR publishing renders only current complete passed rows and rejects an
  unbound Review as authorization for a changed publication SHA.
- The existing base-refresh integration path verifies PR reconciliation receives
  the fresh base and reviewed head.
