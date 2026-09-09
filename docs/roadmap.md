# Roc milestones

Direction updated on 2026-09-08 from the user's request. This roadmap describes
the target behavior. M1 uses GitHub checkpoints and per-Issue worktrees.
M2 now adds up to two independent workers, task-local cancellation and all-task
inspection. [Live GitHub and sandboxed GPT-6 acceptance passed](validation/m1-m2-live-2026-09-09.md)
on one Mac. Physical two-host acceptance remains outstanding.
M3 now adds guarded automatic merge and bounded base refresh with fresh Review.
[Live protected-branch acceptance passed](validation/m3-live-2026-09-09.md)
for two parallel tasks, including a rebase, new Review and fresh CI before the
second merge. The implementation exercise still needed coordinator recovery;
the report distinguishes it from the successful automatic fixture run.
M4 software now provides failure diagnostics, timing/activity inspection, bounded
GitHub reads and opt-in Scout omission. [Local fixed-task comparisons](validation/m4-live-2026-09-09.md)
are complete. M4 remains open for physical MacBook/Mac mini acceptance in Issue #56.
The current stage ends at M4. M5 Superset integration is outside this stage and
will only be reconsidered after a new scope decision, not automatically after M4.

| Milestone | Outcome | Depends on |
| --- | --- | --- |
| [M1: GitHub-native tasks and per-issue worktrees](https://github.com/devos-ing/Roc/milestone/1) | One approved GitHub Issue runs in its own native Git worktree through Pi, independent review and a reconciled PR. Production task state no longer uses local SQLite. | None |
| [M2: Parallel task execution](https://github.com/devos-ing/Roc/milestone/2) | Up to two independent Issues execute concurrently with separate worktrees, sessions and cancellation scopes. | M1 |
| [M3: AI-reviewed automatic PR merge](https://github.com/devos-ing/Roc/milestone/3) | Roc merges the exact reviewed head after required checks and repository rules pass, then releases dependencies. | M1, M2 |
| [M4: Execution visibility and measured speed](https://github.com/devos-ing/Roc/milestone/4) | Visible progress, two-Mac operation and measured token/time improvements without lost quality. | M1; parallel and merge comparisons follow M2/M3 |
| [M5: Superset integration](https://github.com/devos-ing/Roc/milestone/5) | Future option for a remote UI for Roc-managed worktrees, terminal activity and diffs. | Outside this stage; requires a new scope decision |

GitHub Issues retain requirements, priorities, dependencies and approved spec
identity. Roc-owned GitHub records retain execution checkpoints, attempt
identity, review evidence, model usage summaries and PR links. PR state and
commits establish what was published and merged. Labels provide a readable
projection; they are not a distributed claim lock.

M1 must remove the SQLite import/writeback design from normal onboarding,
scheduling, inspection and recovery. It must not replace SQLite with a local
JSON task database. Local configuration, credentials, worktrees, process locks,
Pi session files and diagnostic artifacts remain local. Existing databases stay
intact for explicit migration or archival; code removal must not delete user data.

Keep one active execution host and one Roc daemon per repository initially.
The local ownership guard protects that daemon and its children; issue-keyed
in-memory admission prevents duplicate launches inside it. Multiple active
hosts, hot failover and distributed locking are outside the first release.
Reconcile existing GitHub records and Git evidence before retrying any operation
whose outcome is unknown. A network outage stops new claims and role advancement
until required remote checkpoints can be confirmed. Never turn a local session
file into a competing task authority or report unconfirmed remote writes as saved.

Each Issue gets one task branch and one retained worktree, pinned to a verified
base commit. M2 admits only independent work; dependencies wait for upstream
merges into the configured target branch. Overlapping or unclear scopes and
exclusive shared resources stay serialized. One task's cancellation or failure
must not interrupt another task or mix their events and commits.

M3 separates the AI review decision from the merge operation. Review evidence
must identify the approved spec and exact PR head. Roc checks required CI,
branch/base state and GitHub merge rules, then submits a merge bound to that
head SHA. A changed head requires fresh review and validation. GitHub supports
a `sha` guard on merge requests and rejects a mismatched head; branch protection
continues to apply. No administrator bypass or direct push substitutes for a
permitted merge. [Merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request),
[protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

Serialize merge operations per repository. If the base changes or conflicts
appear, revalidate through a bounded repair/review flow. Required merge-queue
behavior needs explicit support; until then it remains a visible blocker.
After an ambiguous merge response, read GitHub's actual PR state before retrying.
`done` means the PR was confirmed merged; an open PR is awaiting merge, and a
closed-unmerged PR or Issue is not successful completion.

Preserve Pi and the user's GPT-6 reasoning policy. Keep progress observable
without posting every tool event to GitHub. Measure total tokens across all
attempts, single-task time, batch completion time, retries and escaped defects
separately. Apply one ablation at a time, such as omitting redundant Scout work
on a sufficiently specified low-risk task. Retain a removal only when required
behavior and quality are preserved.

M4 must also preserve useful sanitized failure diagnostics. During M3 development,
one worker stopped after creating a tested commit but before saving its Implement
result. Its generic failure message did not establish the original exception.

Superset research, diagrams, login helpers and the unexecuted setup wizard remain
reference material. The earlier Superset-owned workspace and SQLite plan is
superseded. Any future integration must fit GitHub-native state and Roc-owned
worktrees rather than reintroducing those dependencies.
