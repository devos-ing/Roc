# Agent Agile Orchestrator Execution Roadmap

Date: 2026-08-24

## Goal evaluation

The approved product is an XL implementation goal rather than one safe weekly ticket. It combines five correctness-sensitive systems: durable workflow state, concurrency and recovery, a live Codex protocol client, LLM-assisted planning/routing, and a terminal interface. Treating it as one long agent run would recreate the exact failure loop the product is meant to prevent.

Deliver it as four independently runnable vertical slices. Each slice ends with a usable CLI behavior and an acceptance gate before the next slice starts.

Codex is the only execution backend in these slices. Pi remains a session/harness design reference and receives no package, adapter, configuration, or implementation ticket.

## Model routing policy for implementation

The routing follows the current OpenAI model positioning in the [model guide](https://developers.openai.com/api/docs/guides/latest-model): Luna for high-volume bounded work, Terra as the balanced implementation default, and Sol for the hardest work. Runtime availability and supported effort must still be confirmed through Codex `model/list` before every task.

No implementation task uses `low`. Every task defaults to `high`; only concurrency, recovery, accounting, context ancestry, and security-sensitive protocol work use `xhigh`.

| Profile | Use | Why |
|---|---|---|
| Luna + high | Bounded scaffolding, deterministic rendering, repetitive fixtures | Small surface, explicit expected output, cheap to retry |
| Terra + high | Normal TypeScript implementation, Zod schemas, services, CLI, TUI | Best balance of code quality, speed, and token cost |
| Sol + high | Protocol adapters, detached review, Advisor LLM, cross-module integration | Higher ambiguity and failure cost |
| Sol + xhigh | State invariants, atomic claims, idempotent recovery, rejection transaction, token budget, context forks | A subtle error can duplicate work, corrupt state, or violate the no-loop guarantee |

Every ticket uses Luna + high for Scout unless the ticket is already fully localized. Every ticket uses an independent Sol reviewer: `high` for Luna/Terra work and `xhigh` for Sol xhigh work.

The roadmap contains 31 implementation tickets: 2 Luna + high, 12 Terra + high, 6 Sol + high, and 11 Sol + xhigh. The Sol-heavy share is intentional: most hard tickets protect concurrency, recovery, budget, context, and security invariants. Mechanical work is kept away from Sol.

## Relative budget weights

Use weights rather than hardcoded token counts until the weekly budget is supplied:

- Luna + high implementation: 1 unit.
- Terra + high implementation: 2 units.
- Sol + high implementation: 3 units.
- Sol + xhigh implementation: 4 units.
- Scout: add 0.5 unit.
- Review: add 1 unit for `high`, 2 units for `xhigh`.

The Model Advisor later converts these weights into per-attempt ceilings from the actual weekly budget. A slice starts only when its implementation, Scout, and Review units are reserved.

Including Scout and Review overhead, the relative allocation is approximately 20% Foundation, 28% deterministic orchestration, 30% real Codex integration, and 22% Grilling/Advisor/TUI. These percentages guide weekly budgeting; they are not token estimates.

## Slice 1 — Foundation CLI

Outcome: a Bun project can create and migrate its SQLite database, validate weekly/task data, enforce pure state transitions, write human-readable artifacts, and initialize/list tasks through the CLI.

Detailed plan: [Foundation Slice Implementation Plan](./2026-08-24-foundation-slice-implementation-plan.md)

| Ticket | Implement | Review | Weight | Reason |
|---|---|---|---:|---|
| F1 Project scaffold and help | Luna + high | Sol + high | 1 | Mechanical, tiny surface |
| F2 Domain and Zod schemas | Terra + high | Sol + high | 2 | Cross-cutting type contract |
| F3 Task transition function | Sol + xhigh | Sol + xhigh | 4 | Terminal-state and no-loop invariants |
| F4 SQLite migration | Sol + xhigh | Sol + xhigh | 4 | Durable schema and foreign-key correctness |
| F5 Planning repository | Terra + high | Sol + high | 2 | Normal transactional TypeScript |
| F6 Markdown artifact writer | Luna + high | Sol + high | 1 | Deterministic rendering and hashing |
| F7 CLI init/list vertical slice | Terra + high | Sol + high | 2 | Integrates boundaries without agent protocol complexity |

Acceptance gate:

```text
bun run typecheck
bun test
bun src/cli/main.ts init --db /tmp/agile-foundation.db
bun src/cli/main.ts task list --db /tmp/agile-foundation.db
```

All commands must exit zero; the final command prints `No tasks.`.

## Slice 2 — Deterministic Orchestrator

Outcome: a Fake Codex Harness can drive a task through Scout, Implement, Review, rejection follow-up, retry caps, token accounting, and restart reconciliation without invoking a real model.

| Ticket | Implement | Review | Weight | Reason |
|---|---|---|---:|---|
| O1 Fake Codex Harness and normalized events | Terra + high | Sol + high | 2 | Bounded protocol fixture work |
| O2 Dependency readiness and atomic claim | Sol + xhigh | Sol + xhigh | 4 | Concurrency invariant |
| O3 Role pipeline and evidence capsules | Terra + high | Sol + high | 2 | Mostly explicit state coordination |
| O4 Infrastructure retry cap | Sol + high | Sol + high | 3 | Failure classification and attempt identity |
| O5 Review rejection transaction | Sol + xhigh | Sol + xhigh | 4 | Core no-loop product guarantee |
| O6 Idempotent restart reconciliation | Sol + xhigh | Sol + xhigh | 4 | Duplicate work and event prevention |
| O7 Token ledger and weekly reservation | Sol + xhigh | Sol + xhigh | 4 | Accounting and hard dispatch limit |
| O8 Scheduler CLI run/inspect | Terra + high | Sol + high | 2 | Integrates tested services |

Acceptance gate: a deterministic integration test runs three tickets, rejects the first, proves that its follow-up remains draft, completes the next two, reconciles after a simulated restart, and matches exact token totals.

## Slice 3 — Real Codex Harness

Outcome: the scheduler can run the same acceptance scenario through Codex app-server with model capability discovery, exact context forks, detached review, usage events, worktree isolation, and approval handling.

| Ticket | Implement | Review | Weight | Reason |
|---|---|---|---:|---|
| C1 JSON-RPC stdio transport | Terra + high | Sol + high | 2 | Well-defined framing and correlation |
| C2 Initialize, model catalog, and event normalization | Sol + high | Sol + high | 3 | External protocol and capability drift |
| C3 Thread lifecycle and cancellation | Sol + high | Sol + high | 3 | Long-running process lifecycle |
| C4 Exact context fork and ancestry | Sol + xhigh | Sol + xhigh | 4 | Cross-week context correctness |
| C5 Detached review adapter | Sol + high | Sol + high | 3 | Independent reviewer contract |
| C6 Usage ingestion and deduplication | Sol + xhigh | Sol + xhigh | 4 | Token ledger correctness |
| C7 Worktree and approval boundary | Sol + xhigh | Sol + xhigh | 4 | Filesystem and execution security |
| C8 Codex conformance test | Sol + xhigh | Sol + xhigh | 4 | Proves Fake and real harness semantics match |

Acceptance gate: a disposable repository completes one accepted ticket, one rejected ticket, one inherited-context ticket, and one interrupted/reconciled attempt while preserving exact task lineage and usage.

## Slice 4 — Grilling, Advisor, and Control Room

Outcome: the user can plan a week, grill tickets, approve high-risk work, explain model decisions, run the scheduler, and inspect the complete flow in OpenTUI.

| Ticket | Implement | Review | Weight | Reason |
|---|---|---|---:|---|
| U1 Weekly Grilling state machine | Terra + high | Sol + high | 2 | Structured conversational flow |
| U2 Ticket Grilling and risk escalation | Terra + high | Sol + high | 2 | Schema completion and approval gate |
| U3 Deterministic Advisor rules | Terra + high | Sol + high | 2 | Auditable policy tables |
| U4 Advisor LLM escalation | Sol + high | Sol + high | 3 | Structured LLM judgment and fallback |
| U5 Context recommendation | Sol + high | Sol + high | 3 | Similarity plus lineage evidence |
| U6 Full CLI surface | Terra + high | Sol + high | 2 | Bounded command integration |
| U7 OpenTUI Control Room | Terra + high | Sol + high | 2 | UI composition over existing queries |
| U8 End-to-end recovery and budget suite | Sol + xhigh | Sol + xhigh | 4 | Cross-system release gate |

Acceptance gate: a user can create a weekly plan, approve its tickets, run Scout/Implement/Review, see live model/context/token explanations, reject a task into a new draft, stop/restart the process, and finish the remaining ready work without duplicate attempts.

## Recommended first execution

Start with Slice 1 only. It is deliberately small enough to validate Bun, Zod, SQLite, repository conventions, TDD commands, and model routing before spending Sol tokens on the scheduler and Codex protocol.
