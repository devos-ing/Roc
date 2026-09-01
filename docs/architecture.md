# Architecture

Roc is a sequential CLI scheduler. SQLite owns the durable task state,
the Scheduler chooses the next ready task, and an `AgentHarness` executes Scout,
Implement, and Review attempts. `FakeHarness` provides deterministic tests;
`CodexHarness` talks to one Codex app-server process.

The global Agile Cycle setting selects the active calendar window used by task
manifests and token reporting. It supports Daily, Weekly, and custom-day cycles.

Onboarding installs every repository-owned package below `skills/` into both
`.agents/skills` and `.claude/skills`. It copies regular files only, rejects
symbolic-link path components, and refuses to overwrite a file whose contents
differ from the packaged source.

Commander owns the public CLI command tree and command-scoped argument
validation. Project commands find the nearest `.agile` ancestor and otherwise
use the Git checkout root. SQLite and runtime logs stay beneath the resolved
project at `.agile/runtime/`; the CLI does not accept path overrides. The Fake
Harness remains an internal deterministic test backend and is not exposed by
the public scheduler command.

```text
CLI -> Scheduler -> AgentHarness -> FakeHarness
                 \-> CodexHarness -> CodexClient -> codex app-server
                 \-> ZcodeHarness -> ZcodeClient -> zcode app-server
                              \-> TaskBranchManager -> simple-git -> system Git
                 \-> TaskHookService -> Bun argv subprocess
```

Backends register in `src/agents/registry.ts` behind a `BackendFactory`
seam; adding one means a factory plus a registry entry, and the shared run
loop owns branch-manager setup, the database, model advising, the daemon,
logging, and cleanup.

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

## ZCode backend

The ZCode backend (`src/agents/zcode/`) drives the undocumented ZCode
app-server protocol: one child `zcode app-server` process per scheduler run,
one yolo session per role attempt, rooted at the isolated task workspace.

**Safety limits (why the backend is gated).** ZCode has no protocol-level
filesystem sandbox: `session/create` accepts a workspace path and a mode, but
the workspace is only a working directory, not a confinement boundary.
Unattended yolo sessions auto-approve every permission prompt, including
requests to run a command with the sandbox override, so a ZCode turn can write
outside the task checkout with absolute paths or parent traversal. Measured on
the protocol: a default-mode command in a yolo session wrote a file in the
user's home directory, and a `dangerouslyDisableSandbox` call was approved
without any prompt. The Review status comparison covers only the task checkout,
so out-of-checkout mutations are invisible to it. Until ZCode runs inside a
real OS sandbox or container that exposes only the task checkout, the backend
factory refuses to start unless `ROC_ZCODE_EXPERIMENTAL=1` acknowledges these
limits; source and outside-workspace sentinel checks belong to that future
confinement work.

**Model attribution.** After every environment priority merges (an explicit
`ZCODE_MODEL` override, else the enabled desktop provider's first model), the
client resolves one immutable `{providerId, modelId}` pair, and the child
environment, the published catalog, and every session `create` use exactly
that pair. ZCode exposes one effective model and no catalog RPC, so the
backend maps all three advisor profiles (luna, terra, sol) onto it
explicitly. A model that cannot be attributed to an enabled provider fails
startup with `ZCODE_MODEL_UNRESOLVED` instead of running an unobservable
server-side default. Reasoning effort maps to the protocol's `thoughtLevel`
on every session create; the catalog advertises exactly the efforts the
protocol can select.

**Recovery.** ZCode has no durable turn-resume RPC. The app-server process is
owned by the scheduler run, so a mid-attempt crash loses the in-flight turn:
the repository replays from the last committed cursor and the harness
reconciles by retrying the attempt from its recorded state rather than
resuming a dead session.
