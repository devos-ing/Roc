# Parallel execution

M2 follows the approved roadmap and the user's instruction to proceed.
M1's GitHub checkpoints, exact approvals, merge dependencies and retained
ownership remain authoritative. Superset and automatic PR merge are outside M2.

1. One daemon admits at most two Issues by default. `--concurrency 1` runs
   sequentially; values other than 1 or 2 are rejected. `--once` continues to
   process one eligible task and return.
2. Reserve an Issue before starting its worker. Repeated polling cannot launch
   the same Issue twice. Refill a free slot after completion without waiting for
   an unrelated slow task. Each task keeps its worktree, attempt IDs, Pi sessions,
   event receipts and usage.
3. Parallel admission requires non-overlapping, literal repository-relative path
   scopes. Parent/child paths overlap, compared without case to match macOS.
   Globs, prose, root scopes, unsafe paths and hooks require exclusive execution.
   A shared-resource description in scope also makes a task exclusive. This is
   admission based on approved scope, not a filesystem or network sandbox.
4. Dependencies still wait for confirmed merged PRs. Scope independence never
   overrides dependencies, approval, pinned-base or commit validation.
5. Task cancellation or a task-local failure stops only that worker. Confirm
   cleanup before releasing its slot, and checkpoint interrupted work for
   explicit replanning. Closing or withdrawing approval from an active Issue
   requests its cancellation at the next poll. No direct individual-cancel CLI
   or distributed claim protocol is added.
6. Global shutdown cancels all active workers. Unknown checkpoint writes, failed
   cancellation or uncertain cleanup stop new admission and retain ownership.
   A late worker must never mutate checkpoints after ownership is released.
7. Task inspection and the board identify every running Issue. Daemon tool
   output remains tagged by task. No token-saving or throughput claim is made
   without a measured comparison.

Verification uses controlled asynchronous gates rather than timing guesses:
prove two real-worktree Pi flows overlap, a freed slot admits a third task while
another remains blocked, overlapping/unclear scopes serialize, duplicate polling
does not duplicate work, cancellation and failure leave siblings running, and
unconfirmed cleanup keeps ownership. Reuse M1 dependency and recovery tests.
