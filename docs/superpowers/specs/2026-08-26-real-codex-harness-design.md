# Real Codex Harness — Slice 3A Design

Date: 2026-08-26

## 1. Goal

Add the smallest production Codex backend that can run one accepted ticket through Scout, Implement, and detached Review while preserving the deterministic Orchestrator built in Slice 2.

The Orchestrator remains real product code. `FakeHarness` remains the deterministic test backend. A new `CodexHarness` implements the same `AgentHarness` contract and is selected only when the CLI runs with `--backend codex`.

Slice 3A succeeds when a disposable Git repository completes one real accepted ticket and persists its model decisions, Codex thread and turn identities, worktree commit, normalized usage, events, and review result.

## 2. Approved product decisions

- Use Codex app-server, not Pi and not `codex exec --json`.
- Start one stdio app-server child process per `scheduler run` invocation.
- Keep `FakeHarness`; do not turn it into a fake app-server.
- Run a complete Scout → Implement → Review vertical slice.
- Use a deterministic Model Advisor. Do not call an LLM to select a model.
- Treat Luna, Terra, and Sol as logical profiles resolved against `model/list`.
- Default reasoning effort is `high`; `low` is invalid everywhere.
- Use one isolated Git worktree per task.
- Keep Scout, Implement, and Review conversations independent; Review receives no Implement thread history.
- Auto-decline every approval or permission request. Move the task to `needs_replan` and continue.
- Persist context metadata now; implement exact context fork in the next slice.
- Record and display token usage, but do not enforce a token budget.
- Use one typed error class and structured local logging.
- Test core product behavior, not 100% of the app-server protocol.

## 3. Scope

### Included

- stdio JSON-RPC client over `Bun.spawn`;
- initialization and model discovery;
- deterministic profile-to-model resolution;
- Scout and Implement turns with structured outputs;
- detached Codex review with strict local output validation;
- task-scoped Git worktree isolation;
- normalized attempt, output, usage, completion, failure, and policy-block events;
- minimal restart reconciliation using persisted thread and turn identities;
- cancellation and bounded app-server shutdown;
- sanitized stderr and JSONL logging;
- one opt-in real Codex acceptance test.

### Excluded

- Pi backend or Pi dependency;
- exact `thread/fork` context inheritance;
- cross-week context selection;
- Grilling;
- TUI;
- token reservation, refusal, or other budget enforcement;
- LLM-based Advisor decisions;
- interactive approvals;
- automatic merge, push, or worktree deletion;
- app-server daemon or socket discovery;
- exhaustive protocol/version compatibility tests;
- general logging framework, rotation, or remote log shipping.

## 4. Runtime architecture

```text
CLI scheduler run --backend codex
        |
        +-- CodexClient -------- stdio JSON-RPC -------- codex app-server
        |
        +-- ModelAdvisor ------- immutable model catalog
        |
        +-- CodexHarness ------- AgentHarness contract
        |
        +-- TaskWorktree ------- one isolated worktree per task
        |
        +-- Scheduler/Repository/SQLite from Slice 2
```

### 4.1 `CodexClient`

`CodexClient` owns one child process and one JSONL connection. It is responsible only for:

- spawning `codex app-server --stdio`;
- sending `initialize` followed by `initialized`;
- correlating requests and responses by request ID;
- delivering notifications and server-initiated requests;
- exposing the small method subset used by this slice;
- interrupting an active turn;
- rejecting pending requests when the process exits;
- bounded graceful shutdown followed by process termination.

The supported method subset is:

- `model/list`;
- `thread/start`;
- `thread/resume`;
- `thread/read`;
- `turn/start`;
- `turn/interrupt`;
- `review/start`.

External protocol schemas validate required fields with Zod but allow unknown additive fields. Domain schemas remain strict. Unknown notification methods are ignored and logged at debug level; malformed messages for a method the client uses fail closed as protocol errors.

### 4.2 `CodexHarness`

`CodexHarness` implements the existing `AgentHarness` interface:

```ts
interface AgentHarness {
  step(input: HarnessStepRequest): Promise<HarnessDelivery>;
  cancel(attemptId: string): Promise<void>;
}
```

It owns prompt construction, role-specific Codex operations, notification normalization, a small FIFO delivery queue per active attempt, and the opaque backend cursor format. It does not write SQLite or decide task transitions.

Each call to `step()` returns at most one normalized delivery. Scheduler, Daemon, lease fencing, rejection, retry, and accounting logic remain provider-neutral.

### 4.3 `ModelAdvisor`

The existing pure routing rules become a deterministic `ModelAdvisor`. It receives an immutable catalog loaded before the Scheduler may claim work.

Baseline profiles remain:

| Role | Profile | Default effort |
|---|---|---|
| Scout | Luna | `high` |
| Implement | Terra | `high` |
| Review | Sol | `high` |

High-risk tickets require `xhigh`. Retry 1 retains the selected profile. Retry 2 upgrades one profile tier. `model_unavailable` upgrades immediately.

Resolution rules:

1. Query visible entries from `model/list`.
2. Filter out every entry that does not support the required effort.
3. Resolve a profile from an explicit project mapping when configured.
4. Otherwise select the first server-ordered visible model whose ID ends in `-luna`, `-terra`, or `-sol` for the requested profile.
5. Follow the existing Luna → Terra → Sol fallback chain.
6. If no compatible model exists, move the task to `needs_replan`; never downgrade effort to `low`.

Every decision persists the logical profile, actual model ID, effort, fallback IDs, decision source, and rationale.

### 4.4 `TaskWorktree`

The CLI accepts `--repo PATH` and optional `--base REF`; `--base` defaults to `HEAD`. The base ref is resolved to a commit before the task worktree is created.

For task `T1`:

```text
worktree: <repo>/.agile/worktrees/T1
branch:   agile/T1
```

Task IDs pass the same canonical path validation used for artifacts. Git commands use argument arrays, never shell interpolation. A pre-existing worktree is reused only when Git reports the expected repository, branch, and task base. Conflicts fail closed.

Scout and Review receive read-only sandbox policies. Implement receives workspace-write access limited to its task worktree. Network access is disabled in Slice 3A. Accepted and rejected worktrees are retained for human inspection; the system does not merge, push, or delete them.

## 5. Persistence changes

Migration v3 adds only the state needed for audit and restart:

- `tasks.base_commit TEXT`;
- `attempts.model_profile TEXT` constrained to `luna | terra | sol`;
- `attempts.turn_id TEXT`;
- `model_decisions.model_profile TEXT` constrained to `luna | terra | sol`;
- `blocked_policy` as an allowed attempt status.

Migration v3 rebuilds `attempts` atomically to extend its status constraint, and rebuilds `model_decisions` only as required to add the constrained profile. Existing Slice 2 rows backfill `model_profile` from their current `luna`, `terra`, or `sol` model value. `tasks.base_commit` remains null until the task first receives a worktree. Any legacy row whose model cannot be mapped fails migration rather than receiving a guessed profile.

Existing columns retain these meanings:

- `attempts.model`: actual Codex model ID;
- `attempts.thread_id`: role thread ID, including the detached review thread;
- `attempts.git_commit`: verified Implement commit where applicable;
- `attempts.backend_cursor`: provider-owned versioned cursor;
- `contexts.thread_id` and `contexts.anchor_id`: future thread and turn fork source;
- `contexts.git_commit`: exact source commit.

The existing Review role input already supplies the successful Implement output and its commit SHA. It does not expose the Implement thread ID because Review must not inherit that conversation.

`HarnessEventSchema` adds:

```ts
{
  type: "attempt.blocked_policy";
  eventId: string;
  attemptId: string;
  sequence: number;
  occurredAt: string;
  code: string;
  message: string;
}
```

Applying this event atomically ends the attempt as `blocked_policy`, moves its task to `needs_replan`, releases the active work, appends the audit event, and lets the next tick select another ready task. It is never retried.

## 6. Role execution flow

### 6.1 Startup

Before acquiring the Scheduler lease or claiming a task:

1. validate the repository and resolve the base commit;
2. start app-server;
3. complete the initialization handshake;
4. call `model/list`;
5. build the immutable Model Advisor catalog;
6. open SQLite and start the existing Scheduler Daemon.

Authentication, initialization, and catalog failures therefore stop the CLI without changing backlog state.

### 6.2 Scout

- Create or reuse the task worktree.
- Start a fresh thread in the task worktree with read-only sandboxing.
- Start a turn with the ticket, acceptance criteria, known context metadata, and `ScoutOutputSchema` as `outputSchema`.
- Persist thread ID, turn ID, selected profile, actual model, and effort.
- Normalize the valid final output to `ScoutOutput`.

Scout cannot modify files.

### 6.3 Implement

- Start a fresh thread in the same task worktree with workspace-write sandboxing.
- Pass the ticket and validated Scout output explicitly; do not inherit the Scout conversation.
- Require validation and exactly one Git commit for the attempted change.
- Use `ImplementOutputSchema` as `outputSchema`.
- Verify that the returned commit exists, belongs to the task worktree branch, and contains the reported work.

A missing or invalid commit produces retryable `invalid_implementation_commit` rather than a guessed success.

### 6.4 Review

- Start a fresh read-only anchor thread in the task worktree using the Review model. Do not start a normal turn and do not resume or fork the Implement thread.
- Call `review/start` on that empty anchor with `delivery: "detached"` and a custom target naming the exact commit.
- Instruct the reviewer to return only JSON matching `ReviewOutputSchema`.
- Save the distinct review thread ID and review turn ID.
- Parse the final `exitedReviewMode.review` text as strict JSON and then through Zod.

Invalid review JSON produces retryable `invalid_structured_output`. The adapter never infers acceptance from prose.

The Harness records Git status before and after Review. Any Review-side worktree mutation fails closed as `review_mutated_workspace`; Review output is not applied.

An accepted review completes the original task. A rejected review uses the existing transactional no-loop behavior: terminalize the original, create one linked draft follow-up, and schedule the next unrelated ready task.

## 7. Normalized events and cursor

The app-server protocol is not the product event log. `CodexHarness` converts only load-bearing protocol state into the existing normalized events.

The versioned backend cursor contains:

- cursor schema version;
- next normalized sequence;
- last observed cumulative usage totals;
- current thread and turn IDs.

Event IDs are derived from stable source identity:

- attempt start: attempt ID plus turn ID;
- output: attempt ID plus authoritative item ID;
- usage: attempt ID, turn ID, and canonical cumulative-total hash;
- completion/failure: attempt ID plus turn ID and terminal status;
- policy block: attempt ID plus server request ID.

Identical replay produces the same event ID and payload. SQLite remains authoritative for idempotency and advances `backend_cursor` in the same transaction that applies an event.

`thread/tokenUsage/updated` values are cumulative. The Harness subtracts the cursor's last totals and emits only positive deltas. Negative or internally inconsistent totals fail as protocol errors rather than corrupting accounting. Token values are recorded and displayed but never block dispatch.

## 8. Error model and logging

All external boundaries normalize unknown failures into one class:

```ts
class AgileError extends Error {
  code: string;
  category: "startup" | "protocol" | "infra" | "policy" | "domain";
  retryable: boolean;
  component: string;
  taskId?: string;
  attemptId?: string;
  threadId?: string;
  cause?: unknown;
}
```

Logging does not count as handling. The Scheduler or CLI must still map the typed error to one action:

| Category | Action |
|---|---|
| Startup/auth/catalog | Stop CLI before claim |
| Retryable protocol/infra | Existing capped retry |
| Non-retryable protocol/infra | Task `failed_infra`, continue |
| Policy | Task `needs_replan`, continue |
| Domain invariant | Fail closed; do not partially commit |

The default logger emits:

- a short human-readable line to stderr;
- one Zod-validated JSON object per line to `.agile/runtime/agile.log`.

Log records contain timestamp, level, error code, category, component, safe message, retryability, and available task/attempt/thread/request identifiers. They never contain credentials, authentication headers, complete prompts, environment variables, raw unvalidated app-server payloads, or arbitrary `cause` objects.

Slice 3A does not implement rotation, remote shipping, or a third-party logging dependency.

## 9. Failure and recovery policy

- App-server exits before an attempt starts: reject pending calls and emit a retryable infrastructure failure when task-scoped; startup exits remain CLI-fatal.
- Stream disconnect or failed turn: map documented transient failures to retryable infrastructure codes.
- Invalid Scout, Implement, or Review structured output: retryable `invalid_structured_output`.
- Unavailable selected model: use the next compatible Advisor fallback; if none exists, task `needs_replan`.
- Approval, permission, or user-input request: decline, interrupt the turn, apply `attempt.blocked_policy`, and continue.
- Review rejection: use the existing no-loop transaction and do not retry the original task.

For `mode: reconcile`, the Harness resumes and reads the persisted thread:

- if authoritative history contains the completed structured output, usage, and terminal turn, reconstruct missing normalized events with stable IDs;
- if the turn is failed or interrupted, emit the matching retryable failure;
- if the prior app-server disappeared and the turn cannot be proven complete, classify it as retryable `orphaned_turn`;
- if an Implement commit exists without valid structured output, do not infer success.

This is minimal safety reconciliation. Exact interrupted-turn conformance and exact context fork remain later Slice 3 work.

## 10. CLI

The command surface becomes:

```text
agile scheduler run --backend fake --fake-script PATH [--db PATH]
agile scheduler run --backend codex --repo PATH [--base REF] [--db PATH]
agile scheduler inspect [--db PATH]
```

`--backend` is required for `scheduler run`; the CLI never silently switches from Codex to Fake or vice versa. Configuration errors return exit code 2. Startup/runtime failures return exit code 1. Signal shutdown interrupts the active turn, closes app-server within a bounded timeout, releases the Scheduler lease, and closes SQLite.

## 11. Core-focused testing

The repository-level rule in `AGENTS.md` applies: optimize for confidence in core product behavior, not 100% coverage.

Slice 3A adds only these test groups:

1. One scripted JSONL client test covering initialize, request correlation, notification delivery, and process exit.
2. Advisor tests proving profile resolution, fallback, required effort, and rejection of `low`.
3. One recorded CodexHarness happy path covering Scout, Implement, detached Review, normalized events, and usage deltas.
4. Focused safety tests proving task worktree isolation, Review conversation/file isolation, commit verification, approval auto-decline to `needs_replan`, and sanitized `AgileError` logging.
5. One opt-in real Codex smoke test in a disposable Git repository.

The test suite does not create an exhaustive notification fixture library, protocol-version matrix, logging edge-case suite, or coverage target. Existing Fake Harness tests continue to own deterministic retry, rejection, restart, crash, and event-deduplication coverage.

## 12. Acceptance gate

The normal release gate remains offline and deterministic:

```text
bun run typecheck
bun test
```

The explicit real-backend gate is:

```text
AGILE_REAL_CODEX=1 bun test test/integration/real-codex.test.ts
```

It creates a disposable Git repository and proves:

1. one app-server child process completes Scout → Implement → detached Review;
2. Implement changes only the task worktree and creates a real commit;
3. a fresh detached Review with no Implement conversation accepts that exact commit, does not mutate the worktree, and the task reaches `done`;
4. inspection shows logical profiles, actual model IDs, efforts, threads, turns, commit, rationales, and usage;
5. every selected effort is `high` or `xhigh`;
6. JSONL logs contain the run identifiers and no configured sentinel secret;
7. all existing Fake Harness and Orchestrator tests remain green.

## 13. Primary references

- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex app-server model catalog](https://developers.openai.com/codex/app-server#models)
- [Codex app-server review flow](https://developers.openai.com/codex/app-server#review)
- [Existing deterministic Orchestrator design](./2026-08-25-deterministic-orchestrator-design.md)
- [Agent orchestration landscape](../../research/agent-agile-orchestration-landscape.md)
