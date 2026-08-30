# Architecture

Roc is a sequential CLI scheduler. SQLite owns the durable task state,
the Scheduler chooses the next ready task, and an `AgentHarness` executes Scout,
Implement, and Review attempts. `FakeHarness` provides deterministic tests;
`CodexHarness` talks to one Codex app-server process.

The global Agile Cycle setting selects the active calendar window used by task
manifests and token reporting. It supports Daily, Weekly, and custom-day cycles.

Commander owns the public CLI command tree and command-scoped argument
validation. Project commands find the nearest `.agile` ancestor and otherwise
use the Git checkout root. SQLite and runtime logs stay beneath the resolved
project at `.agile/runtime/`; the CLI does not accept path overrides. The Fake
Harness remains an internal deterministic test backend and is not exposed by
the public scheduler command.

```text
CLI -> Scheduler -> AgentHarness -> FakeHarness
                 \-> CodexHarness -> CodexClient -> codex app-server
                              \-> TaskBranchManager -> simple-git -> system Git
                 \-> TaskHookService -> Bun argv subprocess
```

The Codex backend never changes the resolved project checkout. A
`TaskBranchManager` creates or reuses one sibling checkout at
`<repo>.agile-checkout`. It runs one task at a time and switches that checkout
between retained `agile/<taskId>` branches. Every task branch is tied to its
persisted base commit and contains exactly one trusted final implementation
commit. An interrupted dirty branch receives one amendable WIP checkpoint before
the manager switches tasks.

Scout and Review use read-only Codex sandboxes. Implement receives write access
only to the scheduler checkout. The trusted Harness stages and commits the final
changes, then Review checks that exact clean commit in a detached conversation.
Accepted and rejected branches are retained. After an accepted Review, Roc runs
the trusted posthook, pushes the task branch, and creates or reconciles one
pull request before marking the task done; v1 does not merge or delete branches,
execute tasks concurrently, or enforce token budgets.

Tasks may optionally carry one `prehook` and one `posthook`. SQLite's
`task_hooks` table stores the task-scoped configuration hash, explicit trust,
attempt receipt, bounded output, and final status. Scheduler runs a trusted
prehook in the prepared task workspace before Scout and a posthook before
publishing accepted work or after `rejected` and `failed_infra`. A prehook
exhausts three attempts before failing the task; a failed publishing posthook
returns the task to `needs_replan` while a terminal posthook failure preserves
the task outcome and fails the scheduler invocation. Hooks use direct argv
execution rather than a shell and are cancelled with the scheduler on shutdown.
