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

## Compatibility

The migration does not rename the `openamp` npm package or command, the
`openamp/<change-id>` branch prefix, `src/openamp`, `dist/openamp`, saved change
state, or repository URLs. Those identifiers remain stable until a separately
approved breaking migration.

## Non-goals

- Renaming or publishing the npm package.
- Renaming the GitHub repository.
- Rewriting historical plans, validation evidence, or release tags.
- Changing runtime behavior.
