# Automatic Issue closure live validation, 2026-09-09

Roc implemented the repair, published two PRs, and merged them after independent Review and required CI. The updated runtime closed Issues #82 and #84 as completed on a non-default target branch. A denied close request preserved `done`, and a separate runtime invocation recovered without calling a model or repeating the merge.

The operator supplied the specifications, investigated interruptions, identified a label-repair regression after the first Review, and integrated the resulting commits. Production changes in both PRs were written by Roc's Pi Implement sessions.

## Verified results

| Task | PR | Reviewed head | Merge commit | Result |
| --- | --- | --- | --- | --- |
| [#82: automatic closure](https://github.com/devos-ing/Roc/issues/82) | [#83](https://github.com/devos-ing/Roc/pull/83) | `49f54e26704537a9ec2c983ebda7e6677b0d970a` | `96c039f56496bcc7d5f66209e6e8299e9d2e26b2` | Merged automatically. Updated runtime closed the Issue during restart recovery. |
| [#84: preserve label repair and admission](https://github.com/devos-ing/Roc/issues/84) | [#85](https://github.com/devos-ing/Roc/pull/85) | `4084742fa1e1dc513d872a955b9642a46760bfa1` | `efd85023bad06f86a04661afb9fae658da34e630` | New PR included `Related issue: #84`. Runtime verified the merge, saved `done`, then closed the Issue. |

Both PRs targeted `codex/issue-closure-proof-1788965038968`. The repository default branch was `main`. Each recorded merge commit was verified as an ancestor of the fetched target. Both Issues had GitHub state `CLOSED` and reason `COMPLETED`. No operator command manually closed either Issue.

The target required strict, up-to-date `Lint and format` checks from GitHub Actions app `15368`, with admin enforcement. [PR #83 CI](https://github.com/devos-ing/Roc/actions/runs/34368820568) and [PR #85 CI](https://github.com/devos-ing/Roc/actions/runs/34370322834) passed.

Independent Review ran `bun run check` on each exact head. The first passed 299 tests. The final code passed lint, typecheck, and 301 tests with zero test failures. Lint still reported 86 warnings and 6 informational diagnostics. The final Review also confirmed clean whitespace and changes limited to the four approved follow-up files.

## Closure failure and restart

The implementation daemon ran the old source, so Issue #82 remained open after PR #83 merged. The isolated checkout was then fast-forwarded to the repaired source. Three separate production runtime invocations used real GitHub reads and writes, the scheduler, and Git merge-evidence checks. The backend threw on any role call, making unintended model replay a test failure.

| Invocation | Remote result | Close requests | Role calls | Execution checkpoint |
| --- | --- | --- | --- | --- |
| Deny close before the remote write | OPEN, with a safe pending-closure diagnostic | 1 | 0 | Unchanged, `done` |
| Restart with the real close transport | CLOSED as COMPLETED at 15:20:04 UTC | 1 | 0 | Unchanged, `done` |
| Restart after closure | CLOSED, with no further close request | 0 | 0 | Unchanged, `done` |

None of these invocations created or merged another PR, pushed, committed, or rebased. This proves recovery from a failed close against real GitHub state. Lost-response reconciliation is covered by focused tests.

Issue #84 then exercised the new-publication path. It closed at 15:28:10 UTC after the confirmed `done` checkpoint. Its PR used a plain Issue reference, so GitHub closing keywords did not perform the closure.

## Runtime and isolation

The source began at `43b40aa3c68d76c81b592de2f99a095142c5c3f3`. Roc ran in `/private/tmp/roc-close-proof-3j9VYo/repo`, with a separate native worktree for every Issue. The controller restricted admission to the selected task after normal manifest validation. It used the production GitHub store, Pi backend, publisher, and guarded merger.

Actual Pi RPC readbacks confirmed `openai-codex/gpt-6-astra` for every successful role. Scout and independent Review used high effort. Implement used medium effort. Issue #84 used approved Scout omission for its small, explicit file scope and retained independent Review. Role session IDs were distinct.

macOS Seatbelt confined Pi writes to its worktree and isolated provider state. Probes denied reads of the original credential file and writes outside allowed directories. After client closure was confirmed, isolated credentials, provider sessions, and the temporary home were removed. All task worktrees were retained, and no checkout lock remained.

## Preserved failures and limits

[Issue #80](https://github.com/devos-ing/Roc/issues/80) completed Scout but was cancelled during Implement after a GitHub Issue-list request failed with `connect: no route to host`. No PR was created. The partial work and `needs_replan` checkpoint remain preserved.

[Issue #81](https://github.com/devos-ing/Roc/issues/81) was also cancelled during Implement. Its recorder contains no failed GitHub subprocess. The reason remains unresolved and is not attributed to the network failure in #80. Neither failed checkpoint was reset or marked successful.

Both interruptions retained checkout ownership. Before archiving each lock, the operator confirmed that its owner process had exited and all Pi clients had closed. One replacement startup was rejected by the retained lock before starting a role.

Successful tasks used the supported `once: true` runtime option, followed by separate merge-reconciliation invocations. This proves the single-run workflow. It does not establish reliable continuous polling. The older cancellation investigation in [Issue #79](https://github.com/devos-ing/Roc/issues/79) remains unresolved.

The replacement controller allowed one retry after two seconds for recognized transport failures on GitHub read commands. Neither successful task needed that retry. Writes and merges were not retried by this controller adjustment, which is not part of the production repair.

A local review after PR #83 found that its new done branch skipped existing label repair and bypassed admission. Roc fixed both in #84. The first independent Review did not catch this regression. GitHub authority reads and closure also remain separate operations, so concurrent remote edits cannot be excluded atomically.

## Time, usage, and local receipts

| Successful task | UTC interval | Input tokens | Cached input subset | Output tokens |
| --- | --- | --- | --- | --- |
| #82 | 15:00:19.503 to 15:14:37.974 | 1,413,216 | 1,262,336 | 10,638 |
| #84 | 15:21:44.947 to 15:28:17.625 | 921,436 | 765,312 | 3,107 |

These are aggregate provider counters across role requests. Cached input is not added again. Interrupted attempts consumed additional work, and their interrupted Implement usage is incomplete. This run proves behavior, not token savings or faster delivery.

`.scratch/issue-closure-live/` contains setup scripts, the first failed execution, transport error receipt, sandbox probes, archived locks, and cleanup receipt. Its `retry/`, `once/`, and `docs/` directories preserve the subsequent execution records. `recovery-deny.json`, `recovery-recover.json`, and `recovery-idempotent.json` contain the restart assertions. `summary.json` records the final GitHub states, exact heads, merge ancestry, scope checks, and independent Review results. Credential files and full provider sessions are excluded from this report.
