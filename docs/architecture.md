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
                 \-> PiHarness -> PiClient -> pi --mode rpc
                              \-> TaskBranchManager -> simple-git -> system Git
                 \-> TaskHookService -> Bun argv subprocess
```

Backends register in `src/agents/registry.ts` behind a `BackendFactory`
seam; adding one means a factory plus a registry entry, and the shared run
loop owns branch-manager setup, the database, model advising, the daemon,
logging, and cleanup.

The session runtime uses Effect scopes for checkout, backend and database ownership.
The daemon owns its lease, heartbeat and tick worker in a nested scope.
Signals close admission immediately; pending work has a bounded grace period
before a separate continuation signal prevents late scheduler, hook and
publication callbacks from accessing the database. SQLite lease fencing
remains authoritative. Backend close is requested once before database close;
a close timeout reports incomplete cleanup rather than confirmed process exit.
Backend startup remains uncancellable while a `BackendFactory` Promise is
pending because that interface has no `AbortSignal`; a late startup may only be
cleaned once its Promise returns.

Every backend session first acquires an exclusive persistent ownership file at
`<canonical-repo>.agile-checkout.lock`, before checkout setup, backend startup
or SQLite acquisition. Repository aliases and different database paths share
the same guard. Its 0600 metadata records the run ID, owning process PID and
acquisition time; existing or malformed locks fail closed with
`SCHEDULER_CHECKOUT_IN_USE`. The pure Fake runtime does not use a dedicated
checkout and does not acquire this guard.

Cleanup order is drain, seal, worker interruption, lease release, backend close,
database close, then owner-verified guard release. Idle polling wakes on any
drain reason without interrupting an active tick's grace period. Existing 250ms
drain and backend-close waits, 100ms diagnostic wait, 3s heartbeat and 10s lease
remain unchanged. Guard release requires confirmed backend close inside the
deadline and no cancellation rejection or drain timeout. A failed or pending
backend factory, failed or timed-out close, or uncertain work retains ownership;
late successful completion never unlocks it. Bounded safe diagnostics use
`SCHEDULER_CHECKOUT_RETAINED`. Ownership verification failure preserves the
lock and reports `SCHEDULER_CHECKOUT_OWNERSHIP_LOST` without replacing an existing
primary error. No PID-, age- or lease-based automatic takeover is permitted.

Codex, Pi and ZCode client close reject with a sanitized
`*_PROCESS_EXIT_UNCONFIRMED` error when the final exit wait cannot confirm their
owned child's exit. Rejected exit observation is not success. Pi also preserves
earlier client-close failures and attempts all remaining clients and its probe
before propagating cleanup failure. These are direct-child lifecycle contracts,
not a guarantee against hostile detached descendants or out-of-sandbox writers.

A retained guard intentionally quarantines the checkout. Before upgrading,
stop all pre-guard Roc sessions for the repository; older versions do not obey
this ownership boundary. For manual recovery, stop every Roc session, inspect
the exact lock's metadata, verify and terminate remaining owned backend/hook
and checkout-mutating child work, and inspect the dedicated checkout. Only then
manually remove the exact `<canonical-repo>.agile-checkout.lock` file. PID absence
alone is insufficient because descendants can survive. Never remove a live
owner's lock, the checkout, database or task branches as a recovery shortcut.
This is cooperative local ownership, not a hostile-user or distributed-filesystem
security boundary. A crash can require the same manual recovery.

Deterministic validation includes an actual CodexClient with a controlled
non-agent child writing after session return: a successor is refused before
checkout validation, and the lock remains after eventual child exit. Real Codex
smoke has not been run; independent integration review and final user review
remain separate from these local checks.

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

## Pi backend

The Pi backend (`src/agents/pi/`) drives the documented Pi RPC mode
(`pi --mode rpc`, npm `@earendil-works/pi-coding-agent`): strict JSONL with
one JSON object per line — commands are `{type, id?, ...params}` on stdin,
responses `{id?, type: "response", command, success, data|error}` and
unwrapped events on stdout. The working directory is process-level state in
Pi (there is no per-session workspace parameter), so every role attempt
spawns its own child rooted at the isolated task workspace with deterministic
startup flags (`--no-extensions --no-skills --no-prompt-templates
--no-context-files`). One `prompt` is sent per attempt; `agent_settled` is
the authoritative completion anchor, the last assistant `message_end` before
it is the turn's final answer, and per-message usage is accumulated so
session-level compaction stats never reach attempt totals. Extension UI
requests are the only server-initiated interaction: they are answered with
`cancelled: true`, the prompt is aborted, and the attempt blocks on policy.

**Safety limits (why the backend is gated).** Pi has no built-in sandbox:
tools execute with the full process user permissions, so a role turn can
write anywhere the user can. The task workspace is only the child's working
directory, not a confinement boundary, and the Review status comparison only
sees changes inside the task checkout. Until Pi runs inside a real OS sandbox
or container that exposes only the task checkout, the backend factory refuses
to start unless `ROC_PI_EXPERIMENTAL=1` acknowledges these limits.

**Model attribution.** A short-lived probe process answers
`get_available_models` and `get_state`; the probe's effective default model
becomes the single attributed session model, catalog ids are
`provider/modelId` pairs, and each attempt re-asserts its routed pair with
`set_model` plus `set_thinking_level` (Roc efforts map one-to-one onto Pi
thinking levels). A probe with no resolvable default model fails startup
with `PI_MODEL_UNRESOLVED` instead of running an unobservable default.

**Recovery.** The Pi session file is an append-only entry tree on disk, and
the backend cursor persists `{sessionId, sessionFile, entryAnchor}`, where
the anchor is the `get_entries` leaf id captured when a turn settles. v1 has
no reattach path: the child process dies with the scheduler run, so
reconciliation replays from the last committed cursor, completes attempts
whose `outputDelivered` marker persisted, and retries in-flight turns from
their tickets. The anchors exist so a future resume can continue a session
via `get_entries since=entryAnchor`.
