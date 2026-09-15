# OpenAmp

[English](README.md) · [繁體中文](README.zh-HK.md)

OpenAmp is an interactive CLI built on Pi. The main coding agent plans, edits,
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
npm install --global openamp
openamp
```

OpenAmp creates a dedicated `openamp/<change-id>` feature worktree, leaving the
checkout where it was launched—including uncommitted files—unchanged. The TUI
shows the resolved workspace, branch, Pi model, and OpenAmp status.

```bash
openamp --base main
openamp --resume change-abc123def456
```

Useful interactive commands:

- `/agents` shows researcher and writer state.
- `/agent-send <run-id> <message>` steers one active child.
- `/agent-cancel <run-id>` cancels one child without restarting it.
- Pi's native model, login, session, cancellation, and compaction commands remain available.

Research children are read-only. Writer children use independent worktrees and
return verified commits for explicit integration. OpenAmp's normal agent command
boundary rejects remote Git/GitHub mutations. Delivery alone may push and create
or update a PR; it never calls merge or enables auto-merge.

Outside a Git repository, OpenAmp still provides a durable Pi conversation but
disables writer delegation and PR delivery. If GitHub is unavailable, local work
and state remain available for a later retry.

## Development

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun test
```

OpenAmp is implemented in TypeScript. npm packages contain the compiled
`dist/openamp` Node.js runtime rather than executable TypeScript source.

The design and milestone evidence are in
[`docs/design/openamp-cli`](docs/design/openamp-cli/README.md). The previous Roc
Issue backlog and daemon sources remain in repository history, but are not part
of the OpenAmp package or executable surface.

License: [Apache 2.0](LICENSE).
