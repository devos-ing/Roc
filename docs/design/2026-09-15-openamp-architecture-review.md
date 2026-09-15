# OpenAmp architecture review

Date: 2026-09-15. Status: architecture research complete; simplified plan reviewed. This preserves the audit of the [September 13 plan](2026-09-13-openamp-cli-plan.md). The [minimal plan](2026-09-15-openamp-minimal-plan.md) is the current implementation proposal.

## Audit scope correction

This audit examined the old local checkout at `0469ef7` and its dirty files. Before implementation, the remote was refreshed and `main` at `ff9861f` was found to contain a working OpenAmp runtime and optional ObservationPack. Statements below about absent runtime and legacy files are historical evidence, not the current baseline. Use the minimal plan's implementation-baseline section and current source for implementation.

## Confirmed direction

OpenAmp replaces Roc gradually after acceptance. It starts as an interactive CLI built on Pi and its plugins. Completed changes produce a GitHub PR. The user decides whether to merge.

The user confirmed today that the main Oracle plans and reviews. The implementer makes every code edit, including fixes requested during review. Oracle uses a strong model at high effort. The implementing session uses a cheaper model. Exact provider and model profiles remain to be selected and verified through Pi.

The user has deferred sandbox execution to a later milestone. The first release prioritizes Pi plugins for context management, a visible checklist and progress, and final review. This changes the September 13 proposal that allowed main-agent edits. Fresh final review is confirmed. The minimal plan contains the current workflow diagram; earlier HTML diagrams are historical.

## Architecture assessment

The current repository implements Roc's GitHub Issue workflow. It does not yet implement the proposed OpenAmp conversational runtime. The working checkout contains concurrent Pi ObservationPack, onboarding, documentation, and configuration changes. This review preserves them.

| Area | Evidence | Required direction |
| --- | --- | --- |
| Model selection | `src/agents/pi/backend.ts:39`, `:181`, and `:201` exclude non-reasoning models and require high-effort capability for mapped profiles. `src/scheduler/model-routing.ts:112` fixes implementation effort to medium. | Define separate Oracle and implementer profiles. Validate each against its actual provider capabilities. A cheaper model need not support Oracle's effort settings. |
| Conversation lifetime | `src/agents/pi/harness.ts:368`, `:620`, and `:675` describe role attempts and close children after completion. | Use Pi's conversational session lifecycle. Reuse transport and cleanup behavior without extending Issue-specific attempts into a second conversation framework. |
| Tool permissions | `src/agents/pi/harness.ts:527` checks review checkout state. This does not prevent writes elsewhere. | Oracle receives read/search and narrow coordination tools. Exclude arbitrary shell, editing, and write-capable integrations. Route every code correction to implementation. |
| Plugin loading | `src/cli/plugin-selector.ts:5` currently selects ObservationPack. Pi's extension API permits dynamic tool registration. | Package OpenAmp as curated Pi extensions. Do not build a second plugin API. Arbitrary host extensions cannot coexist with a claim of enforced confinement. |
| TUI and runtime | `src/agents/pi/client.ts:91` and `:106` use Bun to launch Node. `src/agents/pi/sdk.ts:1` exposes the SDK integration. | Verify the pinned Pi native TUI, public imports, session changes, and shutdown before choosing a replacement runtime. |
| Workspace | `src/workspace/task-branch.ts:21` provides Git identity and commit checks. The existing plan distinguishes worktrees from sandboxes. | Reuse ownership and commit validation. Start with one writer if the product needs only one implementer. Multiple writer worktrees require a demonstrated concurrency need. |
| Recovery and delivery | Existing plan sections 5 and 7 specify result identity, publication intent, cancellation, and remote readback. | Preserve these guarantees. Bind review to the requirements revision and final base/head. New edits invalidate old acceptance. |

Source positions describe the current dirty checkout, not a release snapshot. The initial Git status and HEAD are recorded in `.scratch/auto/openamp-architecture-2026-09-15/`.

## Pi and OpenAmp responsibilities

Pi owns the model loop, credentials, TUI, tools, transcript, and compaction. OpenAmp adds coordination, progress tracking, and review/delivery behavior through Pi extensions. Sandbox support is a later milestone.

| Component | Responsibility |
| --- | --- |
| Oracle Pi session | Discuss requirements, inspect code, make plans, delegate implementation, and review evidence. No code-editing tools. |
| Implementer Pi session | Apply every code change and run permitted checks in the local feature checkout. Return a validated change and evidence. |
| OpenAmp Pi extension | Expose delegation, progress, messaging, cancellation, and review controls through Pi's existing API. |
| Supervisor and execution environment | Track child identity, environment identity, effective model and effort, durable results, confirmed cancellation, and recovery. |
| Delivery code | Verify Git state and review acceptance, then create or update the PR. Git bookkeeping does not give Oracle an editing tool. |

These are responsibilities, not a requirement for five packages or services. Keep them in the smallest Pi extension package that preserves the boundaries. Reuse Pi session storage instead of copying transcripts. Store only coordination and publication metadata separately.

## Amp reference and deferred sandbox work

Amp exposes Oracle as a specialist for reasoning and review. Puck coordinates agents. OpenAmp's proposed main Oracle combines planning and coordination by our choice. Amp's public behavior is a reference, not evidence of its private implementation. See [Amp tools](https://ampcode.com/docs/tools) and [Puck](https://ampcode.com/docs/puck).

[Amp Orbs](https://ampcode.com/docs/orbs) provide remote isolated machines, continued work with the laptop closed, and sleep/wake behavior that preserves the workspace. Matching that behavior requires environment lifetime and reconnection in addition to command isolation.

Pi 0.82.1 includes a [Gondolin micro-VM extension example](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/examples/extensions/gondolin/index.ts). Its package declares `@earendil-works/gondolin` 0.12.0. The example routes built-in filesystem tools, shell execution, and user shell commands through the VM. It mounts the selected host working directory into the guest and closes the VM when the session shuts down.

The example requires QEMU and Node 23.6 or later. The current package advertises Node 22.19 or later, so the sandbox runtime requirements need reconciliation. This is a candidate for a local feasibility check, not a verified OpenAmp sandbox. Use a dedicated checkout rather than the user's original directory. The example leaves extension JavaScript on the host. Any custom tool that bypasses the VM remains outside confinement. Network policy, credentials, mounts, extension trust, and persistence therefore need explicit checks. A local VM does not provide remote execution when the laptop is closed.

## What to keep and remove

Keep model/effort readback from `harness.ts:563`, confirmed cleanup from `harness.ts:238`, trusted Git checks, sanitized errors, existing credential ownership, and PR readback patterns.

Remove Issue approval and checkpoint requirements from the interactive entry path. Retire mandatory Scout, role-ticket schemas, the single implementation commit restriction, and daemon admission from this path. Preserve old active work until migration acceptance permits retirement.

The smallest proposed workflow has one Oracle and one writer. This can eliminate concurrent writer integration from the first milestone. The user confirmed a fresh Oracle final-review session.

## Confirmed review design and Amp reference

Amp introduced Oracle as a read-only specialist invoked by the coding agent. Current docs describe a stronger second-opinion model for complex analysis and review, with optional invocation to control cost and latency. The original model names in the announcement are historical. See the [Oracle announcement](https://ampcode.com/news/oracle) and [current tools documentation](https://ampcode.com/docs/tools).

The public documentation does not establish whether each Oracle call starts fresh or reuses context. Fresh review context is an OpenAmp design decision, not a claimed Amp implementation detail.

Confirmed OpenAmp behavior: retain the main planning Oracle conversation and the implementing session. At final review, run a short-lived read-only call using the Oracle model, with the task requirements, final base/head, diff, relevant source, and observed verification evidence. Show its activity and findings under the same visible task. This adds a temporary backend review session, not a third permanent conversation for the user to manage.

The reviewer can retrieve additional relevant code. A compact review packet must not prevent deeper inspection. Record previous findings and their resolution across fix rounds so the reviewer does not repeatedly reopen settled issues. The implementer fixes findings. Review acceptance applies only to the reviewed requirements and code revision. Review failure or unavailability remains visible and cannot count as acceptance.

The user selected fresh review rather than review within the planning conversation.

## Current milestone sequence

The [minimal plan](2026-09-15-openamp-minimal-plan.md) replaces the preliminary sequence in this audit. M0 includes the complete local checklist/implementation/fresh-review loop; M1 covers observed resilience/context gaps; M2 adds PR delivery and release migration; M3 defers sandbox execution. Automatic PR/manual merge remains a delivery requirement. Roc retirement remains conditional on acceptance and preservation of unfinished work.

## Context and progress contract

Use Pi for transcripts, compaction, session events, and UI. Use a small OpenAmp extension for the shared task/checklist state and role handoff. Evaluate existing ObservationPack work for reducing bulky tool output without losing access to its source evidence. Do not assume a plugin improves quality or cost without observing both context size and task correctness.

Keep the Oracle's decisions and task state distinct from verbose implementation output. Give the implementer a scoped brief with relevant references, and return a concise summary with retrievable evidence. Checklist and review records must survive compaction. Tool activity records come from actual events. Checklist completion requires the result promised by the item, not merely an agent saying it is done.

Show completed-item counts rather than a fabricated percentage or ETA. Distinguish implementing, checking, reviewing, fixing findings, blocked, and complete. Users can inspect details, steer the task, or cancel. The checklist is a view of shared task state, not a second copy of the conversation.

## Concrete Pi reuse candidates

The pinned Pi 0.82.1 package already contains the following examples. Reuse the relevant behavior in one curated OpenAmp extension rather than installing several overlapping workflow controllers.

| Need | Existing source | Adaptation |
| --- | --- | --- |
| Large tool-output context | `src/third-party/sol-pi/extensions/observation-pack/index.ts:137` and `:65` | Preserve provenance and bounded recall. Keep the existing opt-in behavior until live archive/recall and cost evidence support wider use. |
| Persistent checklist | `node_modules/@earendil-works/pi-coding-agent/examples/extensions/todo.ts:114` | Reconstruct state for the current session branch. Add explicit running, blocked, and completed states tied to task/result IDs. |
| Checklist and progress display | `node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts:59`, `:70`, and `:116` | Reuse native status, widget, and persisted entries. Do not reuse the same-session switch to writable execution at `:307`. |
| Context monitoring | `node_modules/@earendil-works/pi-coding-agent/examples/extensions/trigger-compact.ts:27` | Use native context usage and compaction APIs. Keep progress metadata outside model context where possible, while preserving necessary task state across compaction. |
| Final review | `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/agents/reviewer.md` | Reuse a focused reviewer contract and delegation convention. Remove arbitrary shell access. Bind findings to the requirements and code revision. |

ObservationPack's [M2 evidence](../validation/2026-09-13-observationpack-m2.md) records accepted local integration. The [M3 smoke](../validation/2026-09-14-observationpack-m3-smoke.md) establishes one successful live read, not demonstrated live archive/recall or measured savings. The current feature remains off by default. A separate compaction model is unnecessary until native compaction and ObservationPack show a concrete shortfall.

## Open decisions

Fresh final review is settled. Exact model profiles and the proposed bounded retry default remain implementation-handoff decisions. The minimal plan identifies the curated plugin composition. Sandbox hosting and persistence are deferred to M3.

Suggested handoff evidence includes the task and requirements revision, allowed paths, fixed source revision, plan, permitted checks, known constraints, and a completion contract. Results include actual changes, observed checks, unresolved findings, and validated base/head. Avoid sending the full Oracle transcript to the implementer by default.

## Verification status

Completed: prior task recovery, current plan and source review, official Amp documentation review, and inspection of pinned Pi documentation and extension examples. The architecture audit used read-only fact-finding agents. No OpenAmp runtime code changed, and no implementation or runtime acceptance checks ran.

Repository policy prohibits unit and end-to-end tests. Future verification must use focused permitted integration checks and necessary static checks. Do not run the aggregate `check` script, which invokes the general test suite. A critical integration should establish Oracle delegation, a validated local implementer result, review bound to the resulting revision, and safe cancellation/recovery. Additional checks need a demonstrated core risk.

The minimal plan incorporates the source review and confirmed product decisions. Its first implementation milestone validates the complete two-role Pi workflow with fresh final review. Sandbox validation belongs to a later milestone.
