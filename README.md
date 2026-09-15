<p align="center">
  <img src="output/imagegen/pied-piper-avatar-cute.png" alt="Pied Piper project avatar" width="220" />
</p>

# Pied Piper

[English](README.md) · [繁體中文](README.zh-HK.md)

Pied Piper is an interactive CLI built on Pi. The main coding agent plans, edits,
runs checks, and can delegate independent research or implementation. It can
automatically open a pull request when the change is ready. Independent review
is optional: request it before delivery when useful. Requested review must pass,
and unreviewed PRs are explicitly labeled. Only the user decides whether to merge.

## Requirements

- Node.js 22.19 or newer
- Git and GitHub CLI
- A model/provider configured through Pi
- The target project's own build and test tools

## Start

```bash
npm install --global piedpiper
piedpiper
```

Pied Piper creates a dedicated `piedpiper/<change-id>` feature worktree, leaving the
checkout where it was launched—including uncommitted files—unchanged. The TUI
shows the resolved workspace, branch, Pi model, and Pied Piper status.

```bash
piedpiper --base main
piedpiper --resume change-abc123def456
```

Useful interactive commands:

- `/plan` expands or collapses the saved checklist and its evidence notes.
- `/agents` shows researcher and writer state.
- `/agent-send <run-id> <message>` steers one active child.
- `/agent-cancel <run-id>` cancels one child without restarting it.
- Pi's native model, login, session, cancellation, and compaction commands remain available.

Research children are read-only. Writer children use independent worktrees and
return verified commits for explicit integration. Pied Piper's normal agent command
boundary rejects remote Git/GitHub mutations. Delivery alone may push and create
or update a PR; it never calls merge or enables auto-merge.

Outside a Git repository, Pied Piper still provides a durable Pi conversation but
disables writer delegation and PR delivery. If GitHub is unavailable, local work
and state remain available for a later retry.

## Checklist and progress

For multi-step work, the main agent maintains a checklist with `update_plan`.
The native Pi widget shows completed counts, current and blocked steps, active
children, recent tool activity, and delivery status. `/plan` shows all steps.

The checklist supports up to 12 items and one current step. Completed items
require an evidence note; blocked items require a reason. Notes are agent reports,
not independent verification. The saved checklist returns when you resume and
is included in each new main-agent turn after compaction. Tool activity stores
names and status only, without duplicating arguments or outputs in task state.
Checklist completion never counts as PR review approval.

## Optional Oracle advice

Keep choosing the main coding model with Pi's native model controls. Configure a separate Oracle for a change:

```bash
piedpiper --oracle-model openai-codex/gpt-6-astra
piedpiper --resume change-abc123def456 --oracle-model openai-codex/gpt-6-astra
```

Use an exact authenticated `provider/model` from Pi. The selection persists with the change; resuming without the flag keeps it. Explicitly changing it affects new consultations, while existing runs keep their recorded selection. The Oracle must confirm that model and `high` effort before receiving a prompt. No silent fallback is used. A configured Oracle is also used for requested final reviews; without one, existing review model defaults remain.

Ask the main agent to consult Oracle for a specific planning, debugging, or review question. `ask_oracle` returns a run ID and brief status. Its read-only advice arrives once in the main conversation. `agent_wait` observes that same run for up to 60 seconds; expiry keeps it running. Use `/agent-cancel <run-id>` to cancel explicitly. Advice does not count as independent publication approval.

## Development

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
```

Pied Piper is implemented in TypeScript. npm packages contain the compiled
`dist/piedpiper` Node.js runtime rather than executable TypeScript source.
`openamp` has no executable alias.

The design and milestone evidence are in
[`docs/design/openamp-cli`](docs/design/openamp-cli/README.md). OpenAmp remains the
working name for this interactive architecture. The previous Roc Issue backlog
and daemon sources remain in repository history, but are not part of the Pied
Piper package or executable surface.

Existing `.openamp` change state is retained. On resume, Pied Piper validates
the legacy record and copies active session data into the new state and session
paths. It leaves legacy files unchanged.

Product history: [CHANGELOG.md](CHANGELOG.md).
License: [Apache 2.0](LICENSE).
