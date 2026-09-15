# OpenAmp minimal implementation plan

Status: revised after the user's decision to copy Amp's flow, 2026-09-15. Main-thread coding, optional Oracle advice, and optional final review replace the earlier Oracle-led mandatory-delegation workflow. Sandbox remains deferred.

## Confirmed flow

You work with one main coding thread. It understands the request, plans, edits code, runs checks, and applies fixes. It can consult a stronger read-only Oracle when a second opinion would help. It can delegate independent work to a separate thread. Neither consultation nor delegation is a required stage for every change.

Final review is optional too. When the user or main agent requests a final review, create a fresh read-only review session with the actual requirements, fixed diff and validation evidence. Return findings to the main coding thread. If review is requested as part of delivery, it must pass before that delivery proceeds. If review is skipped, record that honestly; do not manufacture accepted review evidence.

Continue to create/update the feature PR when modifying work is ready. Merge remains the user's decision. These are OpenAmp's chosen delivery defaults; copying Amp's conversational flow does not authorize direct pushes to the base branch or automatic merging.

## Current source and smallest implementation

Work on `codex/openamp-oracle-workflow`, based on upstream OpenAmp runtime at `ff9861f`. The runtime already provides native Pi UI, dedicated feature workspaces, supervised children, durable coordination state, optional ObservationPack, and verified PR delivery. Reuse these modules.

The temporary read-only main-thread restriction in `5c8a980` is being reversed. The current policy patch restores main-thread code tools and makes review optional in `deliver_change`. It does not complete Oracle consultation, model-profile routing, checklist UI, or non-cancelling wait expiry.

One curated Pi extension adds only missing product behavior. Pi owns provider/authentication integration, model execution, tools, conversation storage, and compaction. OpenAmp's existing atomic store owns coordination and delivery metadata. Do not migrate that metadata into a second store or duplicate transcripts.

## Threads and model profiles

- Main thread: configurable coding model, such as a selected Codex, GLM, or DeepSeek model, with supported reasoning effort. This is the everyday planner and writer.
- Oracle consultation: a bounded read-only child using the configured stronger Oracle profile at high effort. It returns advice to the main thread and does not approve publication merely by giving advice.
- Optional delegated threads: focused assignments with explicit context and result ownership. Reuse existing worktree separation for delegated writers; do not share concurrent write access.
- Optional final review: a fresh read-only child using the Oracle profile. Its findings and acceptance, if requested, apply only to the reviewed requirements and code revision.

Configure two profiles, `main` and `oracle`. They select actual Pi provider/model IDs and supported effort. Delegated writer defaults can reuse the main profile, and requested reviewer defaults reuse the Oracle profile. Exact IDs remain configurable; no model-family guessing, new provider framework, or duplicate credentials store. Persist requested/effective settings and verify them before work. Do not silently change an active run's model.

## Context and progress

Keep the task checklist, current role, recent real tool activity, blockers, and optional-review state visible in Pi's native widgets/status. Persist task/checklist state through the existing store and retain evidence references across compaction. A checked checklist item does not manufacture review acceptance.

Use Pi native compaction first and retain opt-in ObservationPack. Give an Oracle or delegated worker only the relevant question, constraints, source pointers, and evidence. The main thread keeps its working conversation. Do not promise measured savings until live archive/recall and correctness are observed.

## Wait expiry is not cancellation

An expired wait returns the existing run ID and current status. The same child continues; do not mark it failed, consume a retry, release its slot, or create a duplicate. The caller can wait again or receive the result through normal parent-session delivery.

Explicit cancellation, CLI shutdown, an unrecoverable process failure, or an explicitly configured execution budget ends execution. Keep confirmed cleanup, owned sessions, result deduplication, and preserved work. Quiet model reasoning alone does not prove a hang. A local CLI that shuts down must still reap its owned children; no daemon is required by this design.

## Milestones

| Milestone | Complete behavior |
| --- | --- |
| M0: main coding thread + optional Oracle | Main agent plans/edits/checks, calls Oracle on demand, and shows checklist/progress. Model/effort and returned advice are attributable. Wait expiry retains the same run. |
| M1: reliable context and recovery | Validate cancellation, session recovery, result ownership/deduplication, and source recall. Adapt the existing runtime only where a demonstrated gap remains. |
| M2: optional review and PR delivery | Requested fresh review is enforced; skipped review is clearly recorded. Validation, revision identity, remote readback, one feature PR, and manual merge remain. Reuse the existing delivery implementation. |
| M3: sandbox if needed | Evaluate isolated execution and remote-host needs as a separate milestone. |

The policy patch implements part of the desired flow; M0 is not yet complete. Do not redo already completed packaging or Roc migration. Preserve unfinished old work and historical evidence.

## Verification

Use focused component integrations with a real Git fixture and controlled Pi/GitHub boundaries. Do not write or run unit or end-to-end tests under repository policy. Keep build/typecheck and focused lint. Validate a requested-review rejection prevents publication and skipped review produces no claimed approval. Later verify one main-thread coding task with an optional Oracle consultation, and an expired wait followed by one result from the same child.

The earlier architecture and Oracle-boundary evidence describe superseded behavior. Current diagrams: [architecture](openamp-cli/current/architecture.html) and [flow](openamp-cli/current/workflow.html). Both are design views, not proof that all capabilities have shipped.

## Amp references

Amp's main agent can edit and consult Oracle optionally: [tools](https://ampcode.com/docs/tools). Independent threads exchange results explicitly: [agent to agent](https://ampcode.com/docs/orbs/agent-to-agent). Its plugin run timeout leaves the child running: [plugin API](https://ampcode.com/docs/plugin-api). We copy these public concepts, without claiming knowledge of Amp's private implementation or automatically copying its shipping defaults.
