# Pied Piper architecture

Pied Piper is a local, interactive Node.js CLI built on Pi's native TUI, model
runtime, tools, and session manager. It has no daemon, task backlog, database,
web service, or merge worker.

```diagram
┌──────────────┐       ┌────────────────────┐
│ Pi native TUI│──────▶│ Main Pi session    │
└──────────────┘       │ feature worktree   │
                       └──────┬─────────────┘
                              │ Pied Piper tools
                  ┌───────────┼─────────────┐
                  ▼           ▼             ▼
           ┌──────────┐ ┌───────────┐ ┌────────────┐
           │Supervisor│ │ Workspace │ │ Delivery   │
           └────┬─────┘ └─────┬─────┘ └─────┬──────┘
                │             │             │
        ┌───────┴────────┐    │       verify + review
        ▼                ▼    │             │
┌──────────────┐  ┌───────────┴──┐          ▼
│read-only Pi  │  │writer Pi +   │     ┌──────────┐
│RPC process   │  │own worktree  │     │GitHub PR │
└──────────────┘  └──────────────┘     └──────────┘
```

## Ownership boundaries

- `src/openamp/cli.ts` starts or resumes the Pi runtime in the durable feature
  workspace. Pi remains the source of truth for the chat transcript and model
  lifecycle.
- The main Pi session is the coding agent: it plans, edits, runs checks, and
  applies corrections. Independent work can be delegated. A separate optional
  Oracle adviser uses a persisted exact Pi model at high effort.
- `src/openamp/extension.ts` supplies delegation, status, integration, and
  delivery operations to the main session. It also owns native progress widgets,
  `/plan`, and main tool activity events. Result messages retain stable IDs.
- `src/openamp/supervisor.ts` owns at most two Pi RPC child processes, targeted
  steering/cancellation, durable run states, and result-first delivery.
- `src/openamp/workspace.ts` creates feature and writer worktrees, validates Git
  identity, commits checkpoints, and integrates one result at a time.
- `src/openamp/delivery.ts` owns validation, optional independent read-only
  review, publication intent, command ledger, remote reconciliation, and PR
  creation/update. It has no merge operation.
- `src/openamp/progress.ts` validates revisioned checklists, reconciles terminal
  child activity, and formats bounded UI and current-plan context.
- `src/openamp/state.ts` atomically stores only coordination evidence under the
  Git common directory. It does not copy the Pi transcript or credentials.

## Safety invariants

The source checkout is never used as the feature workspace, so its dirty files
are neither moved nor committed. Writer agents receive separate Git worktrees.
Research and Review agents receive only Pi read/search tools. Main and writer
bash calls pass a boundary that rejects ordinary remote mutation commands.
While agents run, their shell environment uses an isolated temporary home,
ignores normal Git configuration, and omits GitHub, npm, askpass, and SSH-agent
credentials; Delivery retains a separate captured publication environment.

These controls prevent accidental publication through supported product paths;
they are not an OS sandbox against malicious same-user code. Delivery is the
only component that runs `git push` or PR mutation commands. It records intent,
gives requested Review an immutable complete diff bundle with validation commands,
exit codes, and bounded output, checks the exact head and remote
base before publication, and reconciles remote state after uncertain responses.
It never calls merge or enables auto-merge.

## Recovery

Each change has a stable ID, branch, workspace, Pi session file, run/result map,
input generation, integration record, Review binding, publication record, and
command ledger. New user input invalidates an in-flight ready/review binding. The interactive
delivery tool defaults to no independent review; skipped review is never recorded
as acceptance. Explicitly requested review must accept the exact revision.
Startup verifies repository/workspace identity. Unconfirmed live child states
become `interrupted` and are not blindly replayed. A result is persisted before
its stable ID is inserted into the parent Pi session; recovery scans session
entries before insertion to avoid duplicate delivery. Conflicts and unknown Git
outcomes retain worktrees and require attention instead of reset.

The retired Roc daemon architecture and operator guide remain in
[`docs/legacy`](legacy/) for migration and historical recovery only.

## Optional ObservationPack

Pied Piper offers ObservationPack as an opt-in plugin during a new interactive
change and through `--plugins` for an existing change. The checkbox is clear by
default. Its saved choice belongs to that change; resuming without a new choice
preserves it, and cancelling the selector leaves the previous choice untouched.

When enabled, both the main Pi session and every supervised child load the
same package-owned ObservationPack extension and explicitly allow `obs_recall`.
The plugin remains subject to the parent and child tool boundaries: reviewers
and researchers remain read-only and writers retain their dedicated worktree.
Pied Piper stores the accepted upstream snapshot under `src/third-party/sol-pi/`.
The build records hashes for the compiled extension artifacts and binds them to
the raw provenance manifest; startup checks that binding before loading either
session. Observation archives stay with Pi sessions and have no background
cleanup process.

## Optional Oracle consultation

`ask_oracle` creates a read-only Oracle run with the current change's explicit model selection, requested high effort, and parent-session identity. Requested routes are immutable per run and effective settings are checked before the prompt. Children inherit Pi's config directory even when the main process uses an isolated home. A configured Oracle also serves requested final review; its ordinary advice never satisfies the Delivery gate.

`agent_wait` returns status for the same run on expiry and does not stop or replace it. The supervisor subscribes before prompting, follows Pi's settled event, and uses bounded state requests to detect a dead process or rejected prompt preflight. Quiet but active inference continues. Results are saved after the Pi client stops and delivered through the existing parent-message deduplication path. Failed cleanup retains ownership and reports attention rather than claiming shutdown success.

## Persistent progress

The existing change state stores an optional revisioned plan and the latest tool
activity. `update_plan` rejects stale revisions, more than 12 items, multiple
current steps, completed items without evidence notes, and blocked items without
reasons. These notes record what the agent reports; they do not approve delivery.

A store observer refreshes native Pi widgets after persisted changes, including
asynchronous child events. Session replacement transfers observer ownership.
The widget defaults to three unfinished steps and expands through `/plan`.
Each main-agent turn receives the current bounded plan as data. Pi continues to
own transcripts and compaction; Pied Piper does not append a second activity log.

Tool events persist owner, run ID, tool name, status, and time. Arguments and
outputs stay out of this record. Main settlement interrupts a dangling main
tool. Terminal child states reconcile only activity owned by that child, so an
older result cannot overwrite newer main or child activity.
