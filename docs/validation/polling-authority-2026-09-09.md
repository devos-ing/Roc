# Polling authority confirmation, 2026-09-09

The scheduler now confirms negative list observations before cancelling active work. A list that temporarily omits an Issue or a plan member no longer cancels a task whose fresh GitHub state still authorizes execution. Confirmed closure, withdrawn approval, changed specifications, and invalid plans still stop work.

## Change

The store remembers the Issue numbers of validated plans. These numbers locate subsequent reads. They do not provide cached approval or execution state. On a negative observation, the store first reads the affected Issue directly. A confirmed Issue-level denial stops there. Otherwise, it reads the known siblings in batches of at most four, then runs the existing plan and authority validation. Normal positive observations return without extra reads.

Both active workers and selector-owned refresh or Review use this confirmation. If confirmation fails, `GITHUB_AUTHORITY_UNCONFIRMED` stops the scheduler safely. Cancellation diagnostics and checkpoints distinguish the authority reason from task cancellation and daemon shutdown. The original stop reason survives subsequent cleanup requests.

## Reproduction and results

Before the repair, the public continuous pool loop reproduced two false cancellations in three consecutive runs. Each run passed the normal-list, withdrawn-approval, and closed-Issue controls, but failed both omission cases. All runs took less than 0.1 seconds with the poll timer shortened from 30 seconds to 2 milliseconds.

The regression suite uses the production pool, runner, and execution store with Fake Harness deliveries and an in-memory GitHub boundary:

| Observation | Result after repair |
| --- | --- |
| Complete list | Continue without confirmation reads |
| Active Issue omitted once | Confirm directly and continue |
| Sibling Issue omitted once | Confirm the complete plan and continue |
| Sibling specification actually changed | Cancel with the plan-validation reason |
| Confirmation read fails | Stop with `GITHUB_AUTHORITY_UNCONFIRMED` |
| Approval actually withdrawn | Cancel with the approval reason |
| Issue actually closed | Cancel with the closure reason |

A separate integration case holds a fresh Review after base refresh, omits its Issue from one list, and confirms that Review finishes without cancellation or premature merge. The existing approval-withdrawal case continues to cancel that Review. A store boundary test confirms that a failed direct read cannot authorize work from remembered plan membership.

Focused checks passed. The original scratch reproduction also passed without its test-only confirmation workaround. `bun run check` passed lint, typecheck, and all 310 tests with zero test failures.

A removal experiment omitted fresh complete-plan validation after direct reads. The changed-sibling regression then failed because work continued. The validation was retained, and the source was restored byte-for-byte before final checks.

## Evidence and limits

Run the focused cases from the repository root:

```sh
bun test test/scheduler/github-pool.test.ts --test-name-pattern 'authority confirmation'
bun test test/integration/automatic-merge.test.ts --test-name-pattern 'selector-owned Review'
bun test test/github/execution-store.test.ts
```

Local investigation receipts are under `.scratch/polling-inspection/`. They include the before-repair repeated results, the original reproduction, the removal experiment, and full verification output. The inspected baseline was `b2cda6b355eaf47143aad6edf095f8f8119b3b5a`.

This verifies the reproducible cancellation conditions with deterministic faults. It does not identify the original cause of Issues #72 or #81, whose negative snapshots and cancellation origins were not recorded. [Issue #79](https://github.com/devos-ing/Roc/issues/79) remains an unresolved historical investigation. Issue #80 had a separately confirmed network read failure. A live, long-running daemon acceptance run is not part of this evidence.
