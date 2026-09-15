# Pied Piper brand migration

Status: approved on 2026-09-15.

## Purpose

Present the interactive Pi coding system as Pied Piper. The Piper coordinates
implementation threads and can ask a separate Oracle for advice.

## Requirements

- Current user-facing product copy uses `Pied Piper`.
- The primary avatar is a square, friendly Pi character playing a small flute
  with three thread ribbons.
- English and Traditional Chinese entry documentation explains the relationship
  between Pi, the Piper, and work threads.
- The changelog records the Roc origin, OpenAmp working name, and Pied Piper
  public identity.
- Current runtime messages use the Pied Piper name.
- Historical design and validation records retain their original terminology.

## Compatibility superseded by the technical rename

The technical rename supersedes the earlier compatibility decision. New
installations use the `piedpiper` npm package and executable, with no `openamp`
executable alias. New production sources and compiled output use
`src/piedpiper` and `dist/piedpiper`. New branches, worktrees, state paths,
session paths, and runtime identifiers use Pied Piper names.

Resume reads existing `.openamp` state only when new state is absent. It
validates the requested ID and workspace identity, copies active session data
before writing new state, preserves recorded branches and worktrees, and never
removes legacy files.

## Non-goals

- Publishing an unverified npm package.
- Renaming the GitHub repository.
- Rewriting historical plans, validation evidence, or release tags.
- Changing runtime behavior.
