# Deterministic Orchestrator — Slice 2 Design

Date: 2026-08-25  
Status: Approved in design review

## 1. Outcome

Build the smallest local deterministic scheduler that proves the product's core orchestration rules without invoking a real model.

A Zod-validated JSON scenario drives a thin in-process Fake Agent Harness through Scout, Implement, and independent Review. The scheduler runs as one daemon, advances one durable action per `tick()`, persists every effect in SQLite, survives a simulated restart, creates exactly one draft follow-up after semantic rejection, and reports exact token usage.

Slice 2 succeeds when one deterministic integration scenario:

1. rejects the first of three tasks and creates one linked draft follow-up;
2. crashes and restarts while processing the second task without duplicating effects;
3. completes the second and third tasks;
4. produces exact task, role, attempt, and week token totals.

## 2. Scope

### Included

- Thin provider-neutral `AgentHarness` contract.
- In-process Fake Harness driven by a strict JSON scenario.
- One active task and one active role attempt at a time.
- Dependency readiness and atomic `ready -> claimed` transition.
- Scout -> Implement -> Review role pipeline.
- Infrastructure retry cap and minimal deterministic model escalation.
- Semantic rejection transaction with one linked draft follow-up.
- Immutable token-delta accounting without dispatch limits.
- Persisted delivery cursor and idempotent restart reconciliation.
- Singleton SQLite daemon lease and graceful signal shutdown.
- CLI commands to run and inspect the scheduler.

### Excluded

- Real Codex app-server or Pi backend.
- Real model calls, conversations, streaming transport, or generated text.
- Git worktree creation or real commits; Fake Implement returns a synthetic commit SHA.
- TUI.
- LLM Model Advisor, context recommendation, or dynamic success optimization.
- Token reservation, hard/soft budget enforcement, or overage approval.
- Interactive runtime approvals. The product policy is fixed for later adapters: auto-deny, move the task to `needs_replan`, release the claim, and continue. Slice 2 has no approval event because the Fake Harness does not need one.
- Multiple workers, parallel tasks, distributed scheduling, or external workflow engines.

Existing weekly and task token targets remain required planning metadata. Slice 2 displays planned-versus-actual usage but never blocks dispatch because of those values.

## 3. Why a Thin Custom Fake

The Fake is not a fake Codex server. It implements only the product-owned normalized boundary.

OpenAI Agents SDK's `ScriptedModel` and Pi's faux provider both demonstrate useful queue, fail-fast, usage, and unconsumed-step patterns. Neither implements this product's task claims, review follow-ups, SQLite transactions, or restart cursor. Temporal, Apache Airflow, and Make.com solve a larger workflow-runtime problem and would duplicate or replace the approved SQLite state machine.

Therefore Slice 2 owns a small Fake and borrows patterns only. It adds no runtime dependency. Full comparison and primary sources are in [`docs/research/fake-codex-harness-options.md`](../../research/fake-codex-harness-options.md).

## 4. Architecture

```text
Zod JSON scenario
        |
        v
in-process Fake AgentHarness
        |
        | one normalized delivery
        v
Scheduler.tick()
        |
        | one SQLite transaction
        v
tasks / attempts / model_decisions / usage / reviews / events
        |
        v
scheduler run daemon + scheduler inspect CLI
```

Five bounded units are sufficient:

1. **Harness contracts** — strict Zod request, delivery, event, and scenario schemas.
2. **Fake Harness** — returns the next scripted delivery and verifies expectations.
3. **Scheduler core** — one durable decision per `tick()` and a `runUntilIdle()` test helper.
4. **Orchestration store** — the small set of SQLite transactions used by the scheduler.
5. **Daemon/CLI** — lease, polling, signals, run, and inspect.

No generic plugin system, event bus, DI container, or workflow DSL is introduced.

## 5. Harness Contract

```ts
interface AgentHarness {
  step(input: HarnessStepRequest): Promise<HarnessDelivery>;
  cancel(attemptId: string): Promise<void>;
}

type HarnessStepRequest = {
  mode: "dispatch" | "reconcile";
  attempt: {
    attemptId: string;
    taskId: string;
    role: "scout" | "implement" | "review";
    retryIndex: 0 | 1 | 2;
    model: string;
    effort: "medium" | "high" | "xhigh";
    contextRef?: ContextRef;
  };
  backendCursor?: string;
};

type HarnessDelivery =
  | { kind: "event"; nextCursor: string; event: HarnessEvent }
  | { kind: "idle"; nextCursor?: string }
  | { kind: "closed"; nextCursor?: string };
```

`HarnessEvent` is a strict discriminated union with five event types:

- `attempt.started` — optional synthetic thread ID.
- `attempt.output` — Scout capsule, implementation evidence, or structured Review result.
- `attempt.usage_delta` — immutable input, cached-input, output, and reasoning-output deltas.
- `attempt.completed` — the role completed successfully. Review acceptance or rejection is a semantic result, not an infrastructure failure.
- `attempt.failed_infra` — stable error code, safe message, and retryability.

Every event contains a stable `eventId`, `attemptId`, monotonically increasing per-attempt `sequence`, and `occurredAt`.

`eventId` and `backendCursor` are deliberately different. A scenario may deliver the same event again under a later cursor. SQLite applies its effect once by `eventId` but still advances the cursor so the scheduler cannot replay forever.

## 6. Fake Scenario

The CLI loads a strict JSON file:

```text
scheduler run --fake-script scenario.json
```

Each scripted attempt is matched by `taskId + role + retryIndex`. It declares:

- expected model and effort;
- expected immutable `threadId + anchorId + gitCommit` context reference, if any;
- ordered deliveries;
- stable event IDs, timestamps, outputs, usage deltas, and failures.

The Fake provides `assertComplete()` for tests. Invalid JSON, a missing scripted attempt, an unexpected extra call, mismatched model/context, or unconsumed deliveries is a configuration error. It stops the run with a nonzero result and does not consume a task retry or silently invent success.

Fake Implement outputs a deterministic synthetic commit SHA. It does not touch Git.

## 7. Scheduler Tick

`tick()` completes no more than one durable action:

1. If a running attempt exists, request one delivery using its persisted cursor.
2. Apply the delivery in one transaction:
   - insert its normalized event idempotently;
   - apply output, usage, attempt, task, or review effects;
   - advance `attempts.backend_cursor`, including after a duplicate delivery.
3. If no attempt is active, continue the current task's next role or atomically claim the next ready task.
4. If no task is claimable, return `idle`.

`runUntilIdle()` repeatedly calls `tick()` and exists for tests. The production CLI uses the same `tick()` in a daemon loop.

Task selection is deterministic:

```text
priority ASC -> created_at ASC -> id ASC
```

A task is claimable only when it is `ready`, approved, all dependencies are `done`, and no active attempt exists. Token targets do not participate in readiness.

Atomic claim uses the existing task status as the claim: one transaction conditionally changes `ready -> claimed` and creates the Scout attempt. No separate claims table is needed.

## 8. Role Pipeline and Evidence

The fixed pipeline is:

```text
Scout -> Implement -> Review
```

- Scout receives the ticket and optional immutable context reference. Its structured output records relevant files, tests, risks, and a compact capsule.
- Implement receives the ticket, Scout capsule, and context reference. Its structured output records the synthetic commit, validation commands, risks, and limitations.
- Review receives the ticket, synthetic commit/diff evidence, and compact evidence capsules. It never receives the Implement conversation or thread.

SQLite event payloads and current-state tables are the source of truth. Deterministic Markdown evidence is a human-readable projection that can be rebuilt and hashed; recovery never parses Markdown.

## 9. Model Routing and Infrastructure Retry

All roles default to `high`; `low` remains invalid everywhere.

Baseline routing is deliberately small:

- Scout: Luna/high.
- Implement: Terra/high.
- Review: Sol/high.
- High-risk work may use `xhigh`.

An infrastructure failure retries only the failed role with a new attempt:

- `retry_index = 0`: initial attempt.
- First retry: same model and effort.
- Final retry: move one step on `Luna -> Terra -> Sol`; retain at least `high`.
- A known unsupported or unavailable model may immediately use the next compatible fallback.
- Failure at `retry_index = 2` marks the task `failed_infra` and continues to the next ready task.

Each attempt receives a persisted model decision and rationale. Slice 2 does not implement LLM Advisor decisions, budget routing, or mid-attempt model changes.

## 10. Semantic Rejection

Review rejection never retries the original task. One transaction:

1. stores the structured review;
2. completes the Review attempt;
3. marks the original task `rejected`;
4. creates exactly one linked follow-up task in `draft`;
5. copies the original week, root lineage, priority, informational token target, context reference, and acceptance criteria;
6. adds Review findings and remaining gaps;
7. sets `approved = false`;
8. appends audit events and releases active work.

`discovered_from_review_id` is unique for follow-ups, so reconciliation returns the existing child instead of creating another one.

The follow-up remains draft until a future Grilling and approval cycle. The scheduler immediately considers the next ready task.

If a dependency becomes `rejected` or `failed_infra`, its dependent tasks move to `needs_replan`. Dependencies are never silently rewired to a follow-up.

## 11. Token Accounting

The Fake emits immutable usage deltas with stable event IDs. The scheduler records every unique delta against week, task, role, and attempt. Duplicate deliveries do not change totals.

Task totals are the sum of task-scoped usage. Week totals are the sum of all task totals plus any week-scoped usage when later slices add Grilling.

Slice 2 reports:

- planned weekly target versus actual usage;
- planned task target versus actual usage;
- totals by task, role, and attempt.

No reservation, refusal, pause, retry restriction, or approval is based on token values in Slice 2.

## 12. Daemon Lease and Shutdown

`scheduler run` is a long-running daemon:

- poll SQLite every 1 second when idle;
- heartbeat every 3 seconds;
- singleton lease TTL of 10 seconds;
- only the lease owner may call `tick()`;
- `SIGINT` or `SIGTERM` sets a stop flag, allows the current durable tick to finish, releases the lease, and exits.

The lease is one singleton SQLite row containing owner ID, heartbeat time, and expiry. An expired lease can be atomically taken over. Clock, sleep, and owner-ID generation are injected in tests; there is no background timer abstraction beyond the daemon loop.

## 13. Restart Reconciliation

`attempts.backend_cursor` is nullable and persisted. Event effects and cursor advancement happen in the same transaction.

On daemon restart:

1. acquire or take over the expired scheduler lease;
2. find any running attempt;
3. call the Harness with `mode: "reconcile"` and its persisted cursor;
4. ingest the next delivery idempotently;
5. continue normal ticks.

Scheduler/SQLite crashes are injected through test-only hooks at named durable boundaries. They are not Fake Harness events. Tests close the old database instance, reopen the same database, construct a new Scheduler, and resume.

Backend faults belong in the Fake scenario. Scheduler crash points belong in the Scheduler test hook. This keeps the failure source unambiguous.

## 14. Persistence Changes

Use existing tables and constraints wherever possible:

- add nullable `attempts.backend_cursor`;
- add a singleton scheduler lease table;
- add uniqueness for `tasks.discovered_from_review_id` when non-null;
- continue using `events.idempotency_key` for normalized event IDs;
- continue using `usage.id` as the usage event identity;
- use existing reviews, attempts, model decisions, task lineage, dependencies, and state checks.

Schema changes use a new migration version. Do not rewrite the existing migration after it has landed on `main`.

No claims table, delivery-history table, workflow table, message transcript table, or generic job queue is added.

## 15. Error Handling

- Invalid scenario or missing script: configuration error; no task mutation.
- Duplicate event: skip the already-applied effect and advance the cursor transactionally.
- Invalid event sequence or attempt ID: stop with an integrity error; do not guess.
- Semantic rejection: create one draft follow-up and move on.
- Retryable infrastructure failure: create the next attempt for the same role.
- Exhausted infrastructure retries: task `failed_infra`; move on.
- Terminal task: never dispatch again.
- Runtime approval from a future real adapter: auto-deny, task `needs_replan`, release active work, and move on. No interactive approval subsystem is added in Slice 2.
- Signal during a tick: finish or roll back the current transaction before shutdown.

## 16. Verification

Focused tests cover:

1. strict scenario and event parsing;
2. scripted delivery, duplicate replay, cursor advancement, and `assertComplete()`;
3. dependency readiness and concurrent atomic claim attempts;
4. role progression and Reviewer isolation;
5. retry cap, model retention, and final-retry upgrade;
6. one-transaction Review rejection and exactly one follow-up;
7. duplicate usage delta accounting;
8. singleton lease acquisition, heartbeat, graceful release, and expired takeover;
9. crash before and after each material event effect followed by restart reconciliation;
10. deterministic inspect queries for task flow, attempts, model decisions, context reference, and token totals.

The release-gate integration test uses three tasks:

```text
T1: Scout -> Implement -> Review rejected -> exactly one draft follow-up
T2: Scout -> crash/restart -> Implement -> Review accepted -> done
T3: Scout -> Implement -> Review accepted -> done
```

It proves:

- the rejected original is terminal and never runs again;
- its follow-up stays draft;
- the scheduler moves to T2 and T3;
- restart duplicates no attempt, event, usage, review, or follow-up;
- final task/role/attempt/week usage totals exactly match the scenario;
- the Fake has no unexpected or unconsumed steps.

## 17. Delivery Order

Keep the roadmap order and implement only what the acceptance test demands:

1. O1 Harness contracts, Fake, and normalized events.
2. O2 readiness and atomic claim.
3. O3 role pipeline and structured evidence.
4. O4 infrastructure retry cap and minimal model escalation.
5. O5 semantic rejection transaction.
6. O6 cursor-based restart reconciliation and daemon lease.
7. O7 usage ledger and inspect totals, without budget enforcement.
8. O8 daemon CLI and the three-task integration gate.

Each ticket is independently reviewed before the next begins. Real Codex conformance starts only after this Slice 2 gate is green.
