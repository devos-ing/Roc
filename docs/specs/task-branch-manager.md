# Task Branch Manager

Status: approved and implemented for sequential v1.

## Goal

Keep task changes and context reopenable without implementing a Git worktree
lifecycle or switching the user's active checkout.

## Required behavior

- Use `simple-git` and system Git. Every directly selected third-party runtime
  dependency must have at least 1,000 GitHub stars at adoption time.
- Create one scheduler-owned sibling checkout at `<repo>.agile-checkout`.
- Create and retain `agile/<taskId>` from the task's persisted base commit.
- Execute only one task at a time; `prepare()` switches the dedicated checkout
  to the requested task branch.
- Never switch, reset, stage, or commit in the source checkout passed by the
  user.
- If an interrupted task is dirty when another task is selected, create or
  amend one fixed-identity WIP checkpoint. When the task resumes, fold that WIP
  into the single final implementation commit.
- The trusted Harness creates a fixed-message final commit and reuses it
  idempotently on replay.
- Review must inspect the exact sole clean final commit. Accepted and rejected
  task branches remain available for later inspection or context inheritance.
- A branch/base mismatch, dirty completed branch, invalid commit, or checkout
  ownership conflict fails closed.

## Public test seams

- `TaskBranchManager.prepare()` proves branch switching, restart reuse, base
  identity, and source-checkout isolation.
- `commitChanges()` proves WIP recovery and the single final commit invariant.
- `assertCommit()`, `assertReviewReady()`, and `status()` prove exact Review
  identity and a clean checkout.
- The recorded CodexHarness test proves Scout → Implement → detached Review on
  the same task branch.

## Non-goals

- parallel task execution;
- Git worktree management;
- automatic merge, push, branch deletion, or external network synchronization;
- changing the existing retry/rejection scheduler semantics;
- token-budget enforcement.
