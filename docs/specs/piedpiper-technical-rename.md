# Piedpiper technical rename

Status: approved on 2026-09-15.

## Requirements

- The npm package and only executable are named `piedpiper`.
- Production source and compiled output live under `src/piedpiper` and
  `dist/piedpiper`.
- New state, sessions, branches, worktrees, result entries, widgets, extension
  identifiers, environment variables, and commit subjects use `piedpiper`.
- `piedpiper --resume` prefers current state. When current state is absent, it
  may read matching `.openamp` state as a migration source.
- Legacy migration validates the requested ID, workspace, repository, branch,
  session path, and destination before writing current state.
- Legacy migration copies active transcripts and ObservationPack archives with
  private permissions. It retains the legacy files and recorded Git objects.
- Current release automation publishes and verifies `piedpiper`.
- Current documentation uses the `piedpiper` installation and command examples.
- The `openamp` executable has no alias.

## Verification

- Production build and production-only TypeScript checking pass.
- Focused Biome and Git whitespace checks pass.
- Built `piedpiper --help` uses the new command.
- Package inspection contains only the new executable and compiled runtime.
- A disposable smoke check covers new state creation and legacy state migration
  without provider, GitHub, or npm mutation.
- A static scan classifies every remaining `openamp` reference as legacy
  migration, protected test or probe code, or historical evidence.

## Constraints

Repository policy prohibits agents from editing or running unit and end-to-end
tests. Existing protected tests and the historical M0 probe may retain OpenAmp
identifiers. They do not ship in the npm package.

## Publication

Publish `piedpiper@0.1.0` only after the required production and package checks
pass, npm authentication succeeds, and the registry still reports the name as
unregistered. Publishing reserves the name and creates a public release.
