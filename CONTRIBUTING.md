# Contributing to Roc

Thanks for helping improve Roc. Keep changes small, explain the behavior they
change, and add only the tests needed to protect important paths.

## Setup

You need:

- [Bun](https://bun.sh/) 1.3.0 or later
- Python 3.9 or later for the development PR review tests
- Git
- Node.js 22.19+, [Pi](https://github.com/earendil-works/pi), and provider credentials for live execution
- GitHub CLI and repository access for live PR publication

Deterministic tests use Pi RPC fixtures and the Fake Harness without provider
credentials. Pi is the only production harness; new model vendors use Pi providers.

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
Resolve it once from the skill-creator scripts directory, failing fast when
it is missing:

```bash
set -e
QUICK_VALIDATE="$(find ~/.codex/skills -path '*/skill-creator/scripts/quick_validate.py' -print -quit)"
[ -n "$QUICK_VALIDATE" ] || { echo 'quick_validate.py not found' >&2; exit 1; }

python3 "$QUICK_VALIDATE" skills/roc-create-tasks
python3 "$QUICK_VALIDATE" .agents/skills/pr-review-to-closure
python3 -B .agents/skills/pr-review-to-closure/scripts/test_evidence.py -v
python3 -B .agents/skills/pr-review-to-closure/scripts/test_ledger.py -v
```

Use the fake GitHub transport in tests for deterministic task publication and
execution. To exercise a real repository, explicitly approve a manifest, then:

```bash
bun dev -- task publish-github /absolute/path/to/backlog.json
bun dev -- task list
```

Run these inside the target project. Publication writes GitHub Issues;
inspection reads their execution checkpoints without opening SQLite.

Run the checks that match your change:

```bash
bun run typecheck
bun run test
bun run check
```

Always run `bun run check` before submitting a change. It runs linting, type
checks, and the test suite.

## Reviewing Roc pull requests

Use the repository's [pr-review-to-closure skill](.agents/skills/pr-review-to-closure/SKILL.md)
when reviewing Roc pull requests across revisions. It tracks finding IDs and
checks the current head against earlier findings. The skill is for developing
Roc; onboarding does not install it and the npm package does not include it.
It does not comment, approve, push, or merge without an explicit request.

## Fake harness and debugging

Roc keeps a fake scheduler harness for deterministic tests. It is intentionally
not exposed on the public CLI: `scheduler run` only accepts the Pi backend
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

## Live Pi Codex check

Run `bun install`, then `bun dev -- onboard` to authorize ChatGPT and verify
the Codex model through the bundled Pi SDK. Then run this test separately from
the deterministic suite:

```bash
ROC_LIVE_CODEX=1 bun test test/integration/pi-codex.test.ts
```

This opt-in spends model tokens and acknowledges Pi's unsandboxed tool execution.
It runs the production Pi backend in a temporary Git project through Scout,
Implement and independent Review. Only PR publication is stubbed; no GitHub PR
is created. It verifies model attribution, usage, tests, one trusted commit and
clean checkouts, and retains the printed evidence directory. The normal suite
skips this test; a skip is not live-provider verification.
