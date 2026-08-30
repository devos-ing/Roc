# Contributing to Roc

Thanks for helping improve Roc. Keep changes small, explain the behavior they
change, and add only the tests needed to protect important paths.

## Setup

You need:

- [Bun](https://bun.sh/) 1.3.0 or later
- Git
- [Codex CLI](https://github.com/openai/codex) when testing Codex mode

Install the locked dependencies from a source checkout:

```bash
bun install --frozen-lockfile
```

## Development checks

Use the one-shot `dev` source launcher (it does not watch files):

```bash
bun dev -- help
bun dev -- onboard
```

Direct entry with `bun src/cli/main.ts ...` remains supported.

To check the packaged task-creation skill, run:

```bash
python3 /Users/roy/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/roc-create-tasks
```

You can test an import with a temporary strict JSON manifest, then inspect its
ready tasks locally:

```bash
bun dev -- task import /absolute/path/to/backlog.json --db .agile/runtime/agile.db
bun dev -- task list --db .agile/runtime/agile.db
```

Run the checks that match your change:

```bash
bun run typecheck
bun run test
bun run check
```

Always run `bun run check` before submitting a change. It runs linting, type
checks, and the test suite.

## Development-only commands

Roc keeps a fake scheduler for deterministic tests and an inspection command
for debugging saved scheduler state. They work from source but are intentionally
hidden from production help and the public READMEs.

Run a prepared fake scenario:

```bash
bun dev -- scheduler run --backend fake --fake-script /absolute/path/to/scenario.json
```

Inspect the scheduler database:

```bash
bun dev -- scheduler inspect
```

Both commands accept `--db PATH` when you need a specific database.

## Project documents

Start with:

- [Architecture](docs/architecture.md)
- [Domain language](CONTEXT.md)
- [Approved specifications](docs/specs/)
- [Durable decisions](docs/adr/)
- [Research](docs/research/)
- [Testing policy](AGENTS.md)

## Safety and testing

Follow these rules:

- never change the source work folder;
- Review must check the exact clean commit from Implement;
- receiving the same update twice must not repeat the change;
- a rejected task must stay closed and create only one draft follow-up.

Tests should prove the most important behavior. Full test coverage is not the
goal. Use the Fake Harness for deterministic retry, rejection, restart, and
repeated-event cases.

## Releases

See published versions and notes on
[GitHub Releases](https://github.com/devos-ing/Roc/releases).

Only maintainers publish releases. Bump the version in `package.json`, run the
locked Bun install and full check, and commit `bun.lock` only if Bun changes it:

```bash
bun install --frozen-lockfile
bun run check
```

Merge the version change, then tag that exact commit:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag must match the version in `package.json`. GitHub Actions checks the tag,
installs locked dependencies, runs the full check, publishes the package to npm,
and creates the GitHub Release.
