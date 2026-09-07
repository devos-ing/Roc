# Architecture

Roc is a sequential CLI scheduler. SQLite owns the durable task state,
the Scheduler chooses the next ready task, and an `AgentHarness` executes Scout,
Implement, and Review attempts. `FakeHarness` provides deterministic tests;
`PiHarness` runs Pi RPC children and uses provider models directly.
Pi is the only registered production backend. Codex CLI and Claude Code CLI
are not invoked.

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
CLI -> Scheduler -> AgentHarness -> PiHarness -> PiClient -> pi --mode rpc
                 |                                        -> provider model
                 |              -> TaskBranchManager -> Git
                 -> TaskHookService -> Bun argv subprocess
GitHub Issues -> RemoteSchedulerSource -> SQLite -> Scheduler
SQLite -> GitHubRemoteTaskWriter -> GitHub Issues
Tests -> FakeHarness
```

The sole factory in `src/agents/registry.ts` is Pi. The shared run loop owns
branch setup, the database, model advising, daemon, logging, and cleanup.
Provider support comes from Pi; Roc does not add a CLI adapter per model vendor.

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

Roc prepares a sibling checkout instead of editing the resolved project checkout. A
`TaskBranchManager` creates or reuses one sibling checkout at
`<repo>.agile-checkout`. It runs one task at a time and switches that checkout
between retained `agile/<taskId>` branches. Every task branch is tied to its
persisted base commit and contains exactly one trusted final implementation
commit. An interrupted dirty branch receives one amendable WIP checkpoint before
the manager switches tasks.

Scout and Review are instructed to inspect; Implement writes in the task
checkout. Pi tools have the process user's permissions: these role instructions
are not filesystem isolation. The trusted harness stages and commits the final
changes, then Review checks that exact clean commit in a separate Pi session.
Roc compares checkout state around Review; this does not detect external writes.
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

## Remote GitHub task source

`task publish-github` turns one strict backlog manifest into managed GitHub
Issues without importing it locally. The embedded v1 task envelope contains the
complete plan and a repository-stable plan identity. Publication reconciles all
task identities before adding dependency links, an approval comment containing
the exact envelope hash, and `roc:ready`. Commands use argv and bounded wall
clock execution; ambiguous creates are resolved by reading the stable identity
back before another create is allowed.

`scheduler run --source github` makes GitHub the admission authority for one
daemon. `GitHubRemoteTaskSource` polls every managed Issue, groups complete
plans, validates their dependency graph and trusted publisher approval, and
atomically imports a plan with its frozen remote bindings. The ready label is an
initial claim signal. Later boundaries revalidate the immutable envelope hash
and approval author/hash without requiring the label after Roc changes it to
running. A changed or withdrawn approval pauses the task at the next safe role
boundary. Missing approved context becomes `needs_input`; invalid plans remain
isolated from valid plans.

The daemon performs GitHub and Git I/O outside SQLite transactions while
renewing its scheduler lease. A poll outage blocks idle advancement and new
claims, but lets an already-running harness delivery persist locally. Polling
uses bounded exponential retry and returns to the 30-second interval after a
successful read. Validation and network diagnostics pass through the existing
structured logger with controlled, sanitized messages.

The `remote_tasks` table holds the immutable remote identity, approval snapshot,
status-comment receipt, and pending synchronization state. Local SQLite updates
are authoritative. `GitHubRemoteTaskWriter` retries Roc-owned status labels and
one comment owned by the authenticated daemon account, preserving human labels and
comments. It acknowledges the exact projected local revision, so a concurrent
newer transition remains pending. Rejected tasks keep their outcome and their
one existing local draft child; the writer publishes that child once without
approval, and a later matching trusted approval promotes the same child.

Remote dependency release is stricter than local `done`. Immediately before a
claim, `GitHubRemoteDependencyGate` requires each named dependency's pull request
to be merged into the configured target branch, fetches that branch, verifies it
contains GitHub's actual merge commit, and pins the fetched target commit. The
pin survives claim and recovery. Open pull requests wait; closed-unmerged pull
requests, target mismatches, and retired dependencies require explicit replan.
The gate does not infer a replacement dependency from retirement metadata.

Publisher and execution clones may share a physical host while retaining separate
databases and task checkouts. CLI project discovery checks for `.agile` only
within the containing Git checkout; an outer Roc project cannot capture a nested
execution clone that has not initialized its own database.

One Roc daemon runs per project. There is no multi-daemon claim protocol, hot
failover, automatic merge, or automatic provider switching. Issue discovery has
a 1,000-managed-Issue safety bound and fails visibly at that bound rather than
assuming an absent identity. Comment recovery uses complete paginated REST
reads. Live GitHub, real-provider, and two-machine behavior is operator release
evidence; deterministic local tests exercise the same publication, admission,
scheduler, writeback, and dependency seams.

## Legacy adapter source

`src/agents/codex/` and `src/agents/zcode/` remain for historical tests. They are
unregistered and cannot be selected by the public scheduler. Their protocol and
sandbox behavior does not describe Pi. Finish active native-adapter work using
the prior version before upgrading; native session cursors cannot resume in Pi.
Keep existing databases, task branches and checkouts intact.

## Pi backend

The Pi backend (`src/agents/pi/`) drives the documented Pi RPC mode
(`pi --mode rpc`, npm `@earendil-works/pi-coding-agent`): strict JSONL with
one JSON object per line — commands are `{type, id?, ...params}` on stdin,
responses `{id?, type: "response", command, success, data|error}` and
unwrapped events on stdout. The working directory is process-level state in
Pi (there is no per-session workspace parameter), so every role attempt
spawns its own child rooted at the isolated task workspace with deterministic
startup flags (`--no-extensions --no-skills --no-prompt-templates
--no-context-files`). Only approved installed skills are added through explicit
`--skill` paths; local discovery and trust selection live in `src/skills/policy.ts`
and do not start Codex. One `prompt` is sent per attempt; `agent_settled` is
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
to start unless `ROC_ALLOW_UNSANDBOXED=1` acknowledges these limits.

**Model attribution.** A short-lived probe process answers
`get_available_models` and `get_state`; the probe's effective default model
becomes the single attributed session model, catalog ids are
`provider/modelId` pairs, and each attempt re-asserts its routed pair with
`set_model` plus `set_thinking_level` (Roc efforts map one-to-one onto Pi
thinking levels). A probe with no resolvable default model fails startup
with `PI_MODEL_UNRESOLVED` instead of running an unobservable default. The
resolved default must advertise `high` reasoning; otherwise startup fails with
`PI_MODEL_UNSUPPORTED` rather than selecting a different model or provider.

**Recovery.** The Pi session file is an append-only entry tree on disk, and
the backend cursor persists `{sessionId, sessionFile, entryAnchor}`, where
the anchor is the `get_entries` leaf id captured when a turn settles. v1 has
no reattach path: the child process dies with the scheduler run, so
reconciliation replays from the last committed cursor, completes attempts
whose `outputDelivered` marker persisted, and retries in-flight turns from
their tickets. The anchors exist so a future resume can continue a session
via `get_entries since=entryAnchor`.
