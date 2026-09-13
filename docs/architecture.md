# OpenAmp architecture

OpenAmp is a local, interactive Node.js CLI built on Pi's native TUI, model
runtime, tools, and session manager. It has no daemon, task backlog, database,
web service, or merge worker.

```diagram
┌──────────────┐       ┌────────────────────┐
│ Pi native TUI│──────▶│ Main Pi session    │
└──────────────┘       │ feature worktree   │
                       └──────┬─────────────┘
                              │ OpenAmp tools
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

- `src/openamp/cli.mjs` starts or resumes the Pi runtime in the durable feature
  workspace. Pi remains the source of truth for the chat transcript and model
  lifecycle.
- `src/openamp/extension.mjs` supplies delegation, status, integration, and
  delivery operations to the main session. Result messages retain stable IDs.
- `src/openamp/supervisor.mjs` owns at most two Pi RPC child processes, targeted
  steering/cancellation, durable run states, and result-first delivery.
- `src/openamp/workspace.mjs` creates feature and writer worktrees, validates Git
  identity, commits checkpoints, and integrates one result at a time.
- `src/openamp/delivery.mjs` owns validation, mandatory independent read-only
  review, publication intent, command ledger, remote reconciliation, and PR
  creation/update. It has no merge operation.
- `src/openamp/state.mjs` atomically stores only coordination evidence under the
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
gives Review an immutable complete diff bundle, checks the exact head and remote
base before publication, and reconciles remote state after uncertain responses.
It never calls merge or enables auto-merge.

## Recovery

Each change has a stable ID, branch, workspace, Pi session file, run/result map,
input generation, integration record, Review binding, publication record, and
command ledger. New user input invalidates an in-flight ready/review binding.
Startup verifies repository/workspace identity. Unconfirmed live child states
become `interrupted` and are not blindly replayed. A result is persisted before
its stable ID is inserted into the parent Pi session; recovery scans session
entries before insertion to avoid duplicate delivery. Conflicts and unknown Git
outcomes retain worktrees and require attention instead of reset.

The retired Roc daemon architecture and operator guide remain in
[`docs/legacy`](legacy/) for migration and historical recovery only.
