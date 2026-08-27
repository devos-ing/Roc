# Workspace Hygiene and Pre-Commit Design

## Goal

Keep generated agent state out of Git and make every commit pass staged-file
formatting/linting, TypeScript validation, and the core test suite.

## Workspace cleanup

- Preserve `docs/superpowers/` as durable, reviewed design and implementation
  history.
- Delete `.superpowers/` from disk and ignore the directory as a whole. This
  removes ignored brainstorm HTML/server state and the previously tracked SDD
  final-fix report.
- Delete `.scratch/` from disk and ignore the directory as a whole. This removes
  its tracked `deliver-code/README.md`; runtime resume state may recreate the
  ignored directory when needed.
- Do not modify, ignore, stage, or delete `output/` as part of this change.
- Preserve the pending Apache-2.0 `LICENSE`, `package.json`, and README changes,
  but keep them out of the cleanup/Husky implementation commit.

The tracked files removed from `.superpowers/` and `.scratch/` remain
recoverable from Git history. Ignored brainstorm state is permanently removed
from the working tree.

## Tooling

Use Bun and install these development dependencies:

- `husky` for Git hook registration;
- `lint-staged` only for partially-staged-file isolation and automatic
  restaging;
- exact-version `@biomejs/biome` for formatting, linting, and import sorting.

All three upstream repositories have more than 1,000 GitHub stars at adoption
time. Prettier is not installed.

`package.json` gains:

- `prepare`: install Husky hooks after dependency installation;
- `format`: run `biome check --write .`;
- `lint`: run `biome ci .`;
- `check`: run lint, typecheck, then tests.

Biome uses a committed `biome.json` with VCS integration enabled for Git and the
repository `.gitignore`. Defaults stay close to the current TypeScript style:
two-space indentation, 80-column lines, double quotes, semicolons, and
recommended lint rules.

## Pre-commit flow

`.husky/pre-commit` runs, in order:

```sh
bunx lint-staged
bun run typecheck
bun run test
```

`.lintstagedrc` sends staged JavaScript, TypeScript, JSON, CSS, and GraphQL files
to:

```sh
biome check --write --no-errors-on-unmatched
```

`lint-staged` owns temporary isolation and restaging so Biome does not corrupt
partially staged files. A formatting, lint, typecheck, or test failure rejects
the commit without bypassing the hook.

## Verification

- The cleaned directories do not exist and `git check-ignore` recognizes both
  directory names.
- `docs/superpowers/` remains tracked.
- Husky installs its hook and `.husky/pre-commit` is executable.
- A staged-formatting smoke test proves Biome runs through lint-staged and
  restages the formatted result.
- `bun run check` passes with Biome, TypeScript, and the existing core tests.
- The implementation commit contains only cleanup and pre-commit tooling; the
  pending license and `output/` changes remain outside it.
