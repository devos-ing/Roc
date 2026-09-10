# Parallel task execution

Authorized by the request to enable parallel execution in the current local CLI.

- `parallel-progress`: `scheduler run` defaults to two independent active tasks. `--concurrency` accepts whole numbers from 1 through 8. One slow task does not stop another task from completing.
- `task-isolation`: Each parallel task owns a retained checkout, branch, base commit, and independent Scout, Implement, and Review attempts. Existing single-checkout execution remains available for legacy recovery with concurrency 1. A task never switches another active task's branch.
- `dependencies`: Approval, task dependencies, remote merge requirements, and the concurrency cap still gate claims. Publishing occupies a task slot. A remote outage allows existing attempts to settle but cannot start new attempts or claims.
- `recovery`: Every running attempt is reconciled after restart. A new invocation respects its limit even if more tasks were active previously. Unconfirmed old work retains the repository ownership guard.
- `shutdown`: Stop, lease loss, and failure close admission, cancel every active agent and hook, drain all pending task work, and seal late database callbacks before releasing resources.
- `board`: All active tasks appear in progress and the header shows their count. Publishing is in progress. Details show the selected task's own role and attempt.

Tests use the Fake Harness for deterministic overlapping progress, dependencies, recovery, and failure. Git tests verify separate checkouts and commit/review isolation. CLI and board tests cover configuration and display. Existing lifecycle and remote-workflow checks remain required.

Auto-merge, distributed workers, parallel roles within a task, and automatic conflict resolution are out of scope. No additional live provider task is launched by this implementation request.
