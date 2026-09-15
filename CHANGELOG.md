# Changelog

This file records Pied Piper's user-visible changes and the reason for major
product decisions. Release tags remain the source of truth for shipped code.

## Unreleased: Pied Piper

### Story

The project started as Roc, a daemon that moved approved GitHub Issues through
Scout, Implement, independent Review, and merge verification. OpenAmp became the
working name for its interactive replacement. That version moved the main work
into a durable Pi conversation and added optional Oracle advice, child agents,
a visible checklist, and pull-request delivery.

Pied Piper is the public name for that system. Pi runs the agent loop. The Piper
keeps implementation threads visible and guides them toward the result the user
chose. The name now matches the product better than either earlier name.

The first logo draft looked too mechanical. The active logo is a rounded Pi
character playing a small flute, with three thread ribbons following behind it.

### Changed

- Renamed the public product and technical runtime from OpenAmp to Pied Piper.
- Added the cute Pi piper avatar to the English and Traditional Chinese READMEs.
- Updated current CLI messages, progress displays, errors, documentation, and
  contributor guidance to use the Pied Piper name.

### Compatibility

The technical rename changes the npm package and command to `piedpiper`, the
`piedpiper/<change-id>` branch prefix, the `src/piedpiper` and `dist/piedpiper`
paths, new state and session directories, and new result and widget identifiers.
`openamp` has no executable alias.

Existing `.openamp` state is retained and consulted only when the matching Pied
Piper state is absent. Pied Piper validates the legacy record, preserves its
recorded branches and worktrees, copies active session data before writing the
new state path, and leaves legacy files unchanged. Historical Roc and OpenAmp
plans keep the names that were accurate when maintainers wrote them.

## Earlier releases

- `v0.1.1` on 2026-09-10
- `v0.1.0` on 2026-09-08
- `v0.0.4` on 2026-09-03
- `v0.0.3` on 2026-08-29
- `v0.0.2` on 2026-08-28
- `v0.0.1` on 2026-08-27
