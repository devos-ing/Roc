# Contributing to Roc

Thanks for helping improve Roc. Keep changes small, explain the behavior they
change, and add only the tests needed to protect important paths.

## Setup

You need:

- [Bun](https://bun.sh/) 1.3.0 or later
- Python 3.9 or later for the packaged PR review tests
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

To check the packaged skills and the PR review helpers, run:

`quick_validate.py` is provided by the `skill-creator` tooling and is not part
of this repository, so its path depends on where that tooling is installed.
Resolve it once from your agent's skills directory and keep it quoted:

```bash
QUICK_VALIDATE="$(find ~/.codex/skills -name quick_validate.py -print -quit)"
python3 "$QUICK_VALIDATE" skills/roc-create-tasks
python3 "$QUICK_VALIDATE" skills/pr-review-to-closure
python3 -B skills/pr-review-to-closure/scripts/test_evidence.py -v
python3 -B skills/pr-review-to-closure/scripts/test_ledger.py -v
```

You can test an import with a temporary strict JSON manifest, then inspect its
ready tasks locally:

```bash
bun dev -- task import /absolute/path/to/backlog.json
bun dev -- task list
```

Run them inside the target project. Roc resolves the project's `.agile`
database from the current directory; the public CLI has no `--db` flag.

Run the checks that match your change:

```bash
bun run typecheck
bun run test
bun run check
```

Always run `bun run check` before submitting a change. It runs linting, type
checks, and the test suite.

## Fake harness and debugging

Roc keeps a fake scheduler harness for deterministic tests. It is intentionally
not exposed on the public CLI: `scheduler run` only accepts registered backends
and rejects `--db`, `--repo`, and `--fake-script` before invoking the runtime.
The fake harness runs through internal test seams instead:

```bash
bun test test/cli/scheduler.test.ts
```

That suite drives authored fake scenarios through the scheduler runtime and
pins the rejection of the removed internal flags.

To debug saved scheduler state, use the public inspection command from source:

```bash
bun dev -- scheduler inspect
```

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
