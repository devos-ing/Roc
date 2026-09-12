# Onboard skill allowlist checklist

Status: Approved for implementation  
Date: 2026-08-29

## Problem

Roc needs a stable, visible allowlist of trusted installed skills. Users must be
able to narrow that list during onboarding, and a saved selection must never
grant trust after its source stops being supported.

## Outcome

`npx roc-it@latest onboard` presents a colored terminal checklist of trusted,
installed skills. Available defaults are selected on first onboarding. Users may
clear any selection, including every selection, and Roc saves the exact result
globally. Scheduler startup enables only the intersection of the saved selection
and the current trusted-source policy.

## Scope

- Add an interactive multi-select checklist to project and global onboarding.
- Trust installed Matt Pocock `grilling` and `tdd` skills only from their
  expected standalone lock source and path.
- Trust i-have-adhd skills only from their expected standalone lock source and
  verified plugin-cache paths.
- Persist selected identities in global Roc settings.
- Preserve dynamic default behavior for legacy settings with no allowlist.
- Ignore saved identities from former unsupported sources without surfacing,
  installing, or enabling them.

## Non-goals

- Installing, updating, or removing third-party skills.
- Allowing arbitrary skills outside Roc's trusted default policy.
- Adding project-specific allowlists.
- Reworking the Agile cycle prompt or the rest of onboarding.
- Persisting versioned filesystem paths.
- Changing how Codex discovers skills outside this onboarding choice.

## Default policy

Roc recognizes only these defaults:

- standalone `grilling` and `tdd` skills recorded in
  `~/.agents/.skill-lock.json` with source `mattpocock/skills` and the exact
  path `~/.agents/skills/<name>/SKILL.md`;
- standalone i-have-adhd skills recorded with source `ayghri/i-have-adhd` and
  the exact agents skill path;
- discovered i-have-adhd plugin skills whose names begin with
  `i-have-adhd:` and whose paths resolve within the verified plugin cache.

Matching a name alone never establishes trust. The scheduler intersects saved
identities with the current trusted-source policy. A saved identity from a
removed source therefore stays disabled.

## Interaction

Onboarding renders one item per discovered default skill. First onboarding
preselects every item. Repeat onboarding preselects only identities already
saved. A newly installed default remains unchecked until the user selects it in
another onboarding run.

The prompt uses `@clack/prompts` multi-select behavior:

```text
Use Roc's default skill allowlist?

  ◉ [✓] grilling        mattpocock/skills
    [✓] tdd             mattpocock/skills
    [✓] i-have-adhd:focus  ayghri/i-have-adhd

↑↓ move   space toggle   enter confirm
```

- Selected markers are green.
- The focused row is cyan.
- Secondary text is dim.
- `NO_COLOR` disables ANSI styling while preserving markers and labels.
- Pressing Enter accepts the current checklist state.
- Selecting no skills is valid and saves an empty allowlist.
- `Ctrl+C` cancels onboarding without replacing the saved allowlist.

## Data model

The global settings schema stores normalized `name` and `source` pairs:

```json
{
  "cycle": { "type": "weekly" },
  "skills": {
    "allowlist": [
      { "name": "grilling", "source": "mattpocock/skills" }
    ]
  }
}
```

An absent `skills.allowlist` means legacy behavior and uses the current dynamic
default policy. An empty array means the user explicitly disabled every skill.
Both project and global onboarding write this selection to
`~/.config/roc/settings.json` alongside the Agile cycle.

## Components and data flow

1. A catalog adapter obtains the current Codex skill catalog and enriches
   standalone entries with lock metadata.
2. A pure policy function filters the catalog to current trusted candidates.
3. A `SkillSelector` adapter renders candidates and returns stable identities
   or cancellation.
4. `runCli` saves selected identities with the Agile cycle.
5. Scheduler startup loads settings and current trusted-source policy.
6. `buildDefaultSkillConfig` enables only the trusted, selected intersection.

## Failure behavior

- Cancellation returns a nonzero result and does not replace saved settings.
- Catalog failure stops onboarding; Roc never enables every discovered skill.
- A malformed saved identity fails settings validation.
- A saved identity that is no longer installed or trusted remains disabled.
- Existing completed onboarding work is reported truthfully and is not described
  as rolled back.

## Acceptance criteria

1. First onboarding shows one row per installed default skill and preselects it.
2. Enter saves exact selected identities globally; an empty selection disables
   every agent skill.
3. Repeat onboarding starts from the saved exact selection.
4. Scheduler configuration enables only the saved trusted intersection.
5. Legacy settings without an allowlist retain current dynamic behavior.
6. Untrusted or formerly supported sources cannot be selected or enabled,
   including through stale settings or lock metadata.
7. Cancellation and catalog failure do not overwrite prior settings.
8. Interactive terminals use the approved colors and `NO_COLOR` output has no
   ANSI escapes.
9. Onboarding failure output preserves retry and partial-completion behavior.

## Test seams and evidence

- one vertical onboarding-to-scheduler test that saves a subset and observes
  only that subset in thread configuration;
- focused policy tests for trusted provenance and stale unsupported selections;
- one cancellation test preserving the prior settings file;
- one legacy-settings test for dynamic policy compatibility;
- one plain-output test preserving labels and markers without ANSI;
- package tests that compare the main skill and execution reference across all
  tracked mirrors and the npm archive.

Run focused CLI, settings, policy, and packaging checks, followed by lint and
typecheck.
