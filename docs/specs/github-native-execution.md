# GitHub-native execution

M1 implements the user's approved GitHub-first direction. Superset, parallel
admission and automatic merge remain later milestones. This specification
replaces the local SQLite task authority described in the previous runtime.

1. Normal onboarding, task inspection and scheduler execution never open or
   create SQLite. GitHub Issues hold approved task envelopes and Roc-owned
   execution checkpoints. Local configuration, worktrees, process locks and
   diagnostic/session files remain local. Existing databases are not deleted.
2. Validate each complete plan, task identity, dependency graph and trusted
   approval before admission. Recheck the exact envelope and approval at role
   boundaries. Invalid or withdrawn approval blocks work; a label alone never
   authorizes execution.
3. One active host and daemon own a repository. M1 executes one Issue at a time.
   Every Issue gets a distinct native Git worktree and branch tied to its pinned
   base. Preparing another task never stages, checkpoints or switches away the
   first task's dirty files.
4. GitHub execution checkpoints include task/spec identity, base commit,
   attempts, actual model/effort, usage, validated role output and PR receipt.
   Only the configured daemon account owns these records. Read back ambiguous
   writes before retrying. Unconfirmed writes never advance the next role.
5. Preserve Scout, Implement and independent Review through Pi. Roc creates
   and validates the exact implementation commit. A saved role result can be
   reused on restart; an interrupted role without a saved result is retried or
   requires replan when Git evidence makes replay unsafe. Do not pretend to
   reattach a dead Pi process.
6. Dependencies must have PRs merged into the configured target branch; fetch
   that branch and verify the actual merge commits before pinning the base.
   Publication reconciles an existing matching PR before creating another one.
   An open PR is awaiting merge. Only a confirmed merge means done.
7. Retain bounded retries, explicit hook trust, cancellation and sanitized
   diagnostics. Stop admission on shutdown and retain ownership if child exit
   cannot be confirmed. GitHub outages block new work and role advancement.
8. Inspection and the task board read GitHub checkpoints. Daemon output shows
   current tool activity without writing every tool event to GitHub. Report
   unknown usage as unknown when a crash left no confirmed receipt.

Validation uses a real temporary Git repository, an in-memory fake GitHub
transport and the existing Fake/Pi harnesses. Prove one accepted vertical flow,
distinct worktrees, approval withdrawal, dependency merge gating, ambiguous
checkpoint publication, restart after a saved result, and cleanup uncertainty.
Delete obsolete SQLite-only production paths after their replacements pass.
