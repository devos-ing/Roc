# Architecture

Roc is a sequential CLI scheduler. SQLite owns the durable task state,
the Scheduler chooses the next ready task, and an `AgentHarness` executes Scout,
Implement, and Review attempts. `FakeHarness` provides deterministic tests;
`CodexHarness` talks to one Codex app-server process.

The global Agile Cycle setting selects the active calendar window used by task
manifests and token reporting. It supports Daily, Weekly, and custom-day cycles.

```text
CLI -> Scheduler -> AgentHarness -> FakeHarness
                 \-> CodexHarness -> CodexClient -> codex app-server
                              \-> TaskBranchManager -> simple-git -> system Git
```

The Codex backend never changes the checkout supplied through `--repo`. A
`TaskBranchManager` creates or reuses one sibling checkout at
`<repo>.agile-checkout`. It runs one task at a time and switches that checkout
between retained `agile/<taskId>` branches. Every task branch is tied to its
persisted base commit and contains exactly one trusted final implementation
commit. An interrupted dirty branch receives one amendable WIP checkpoint before
the manager switches tasks.

Scout and Review use read-only Codex sandboxes. Implement receives write access
only to the scheduler checkout. The trusted Harness stages and commits the final
changes, then Review checks that exact clean commit in a detached conversation.
Accepted and rejected branches are retained; v1 does not merge, push, delete
branches, execute tasks concurrently, or enforce token budgets.
