# Onboard skill allowlist checklist

Status: Approved for implementation  
Date: 2026-08-29

## Problem

Roc currently builds its agent skill allowlist automatically from trusted installed sources. Users cannot see or narrow that list during onboarding, and the allowlist changes implicitly when another matching skill is installed. The default policy also does not include the `unslop` skill from pstack.

## Outcome

`npx roc-it@latest onboard` presents a colored terminal checklist of the installed skills permitted by Roc's default policy. Available defaults are selected on first onboarding. Users may clear any selection, including every selection, and Roc saves the exact result globally. The policy retains its existing trusted sources and adds only `unslop` from `backnotprop/pstack`.

## Scope

- Add an interactive multi-select checklist to both project and global onboarding.
- Keep the current default policy for installed Matt Pocock, Ponytail, and i-have-adhd skills.
- Add the exact standalone identity `unslop` from `backnotprop/pstack`.
- Persist the selected identities in the global Roc settings file.
- Apply the persisted selection when the scheduler creates role threads.
- Preserve the current dynamic default policy for settings written before this feature.
- Show missing `unslop` as unavailable without installing it.
- Add color, cancellation, plain-output, compatibility, and policy tests at public seams.

## Non-goals

- Installing, updating, or removing third-party skills.
- Allowing arbitrary skills outside Roc's trusted default policy.
- Adding project-specific allowlists.
- Reworking the Agile cycle prompt or the rest of the onboarding UI.
- Persisting versioned filesystem paths.
- Changing how Codex discovers skills outside this onboarding choice.

## Default policy

Roc continues to recognize these existing defaults:

- standalone skills recorded in `~/.agents/.skill-lock.json` with source `mattpocock/skills` and the exact path `~/.agents/skills/<name>/SKILL.md`;
- discovered plugin skills whose names begin with `ponytail:`;
- discovered plugin skills whose names begin with `i-have-adhd:`.

The policy adds one default:

- the standalone skill named `unslop`, only when `~/.agents/.skill-lock.json` records its source as `backnotprop/pstack` and its path is `~/.agents/skills/unslop/SKILL.md`.

Matching a skill name alone never establishes trust. The scheduler intersects the saved selection with the current trusted-source policy before enabling a skill.

## Interaction

Onboarding renders one item per discovered default skill. First onboarding preselects every installed item. Repeat onboarding preselects only the identities already saved. A newly installed default remains unchecked until the user selects it during another onboarding run.

`unslop` always appears. When it is not installed from the approved source, it is dimmed, marked `Not installed`, cannot be selected, and is not saved. Other source-based defaults appear only when discovered because Roc does not maintain a fixed list of their skill names.

The prompt uses `@clack/prompts` multi-select behavior:

```text
Use Roc's default skill allowlist?

  ◉ [✓] grilling        mattpocock/skills
    [✓] tdd             mattpocock/skills
    [✓] ponytail        Ponytail
    [✓] unslop          backnotprop/pstack

↑↓ move   space toggle   enter confirm
```

When `unslop` is missing, its installed row becomes an unavailable row:

```text
    [–] unslop          pstack · Not installed
```

- Selected markers are green.
- The focused row is cyan.
- Unavailable rows and secondary text are dim.
- `NO_COLOR` disables ANSI styling while preserving markers and labels.
- Pressing Enter accepts the current checklist state.
- Selecting no skills is valid and saves an empty allowlist.
- `Ctrl+C` cancels onboarding without saving a new allowlist.

The checklist itself asks whether to use the default allowlist. Roc does not add a redundant yes-or-no prompt before it.

## Data model

The global settings schema gains an optional exact selection:

```json
{
  "cycle": { "type": "weekly" },
  "skills": {
    "allowlist": [
      { "name": "grilling", "source": "mattpocock/skills" },
      { "name": "unslop", "source": "backnotprop/pstack" }
    ]
  }
}
```

The selection stores normalized `name` and `source` pairs. Ponytail identities use `dietrichgebert/ponytail`, and i-have-adhd identities use `ayghri/i-have-adhd`. It does not store a path or plugin version. An absent `skills.allowlist` means legacy behavior and uses the current dynamic default policy. An empty array means the user explicitly disabled every skill.

Both project and global onboarding write this selection to `~/.config/roc/settings.json`, alongside the Agile cycle. One validated settings write saves both values together.

## Components and data flow

1. A skill catalog adapter obtains the current Codex skill catalog for the onboarding workspace and enriches standalone entries with source metadata from `.skill-lock.json`.
2. A pure policy function filters that catalog to the default trusted candidates and adds the unavailable `unslop` candidate when needed.
3. A `SkillSelector` adapter renders the candidates with `@clack/prompts` and returns stable selected identities or cancellation.
4. `runCli` passes the selected identities to the settings writer together with the selected Agile cycle.
5. Scheduler startup loads the settings and current trusted-source policy.
6. `buildDefaultSkillConfig` enables only discovered skills that satisfy both the trusted policy and the saved exact selection.

`SkillSelector` and the catalog adapter are injectable runtime seams. CLI orchestration does not parse terminal keystrokes, and tests do not emulate raw terminal input.

## Ordering and output

The checklist runs after the current database and packaged task-skill steps and before the Agile cycle prompt. If selection or a later step fails, the existing partial-completion report continues to list durable work already completed.

Successful onboarding adds a numbered allowlist step with the selected count. When `unslop` is unavailable, the completion output includes a copyable pstack installation command and tells the user to rerun onboarding. Roc does not execute that command.

## Failure behavior

- Cancellation returns a nonzero command result and does not replace the saved allowlist.
- Skill catalog failure stops onboarding. Roc never falls back to enabling every discovered skill.
- A malformed saved identity fails settings validation instead of weakening the policy.
- A saved identity that is no longer installed remains disabled.
- A saved standalone identity whose lock source or path no longer matches remains disabled.
- Existing completed onboarding work is reported truthfully and is not described as rolled back.

## Acceptance criteria

1. First onboarding shows one row per installed default skill and preselects every available row.
2. `unslop` is trusted only as the standalone `backnotprop/pstack` skill at the expected agents path.
3. Missing `unslop` is visible, unavailable, and never installed automatically.
4. Enter saves the exact selected `name` and `source` identities globally.
5. An empty confirmed selection disables every agent skill.
6. A later matching installation remains disabled until another onboarding run selects it.
7. Repeat onboarding starts from the saved exact selection.
8. Scheduler thread configuration enables only the intersection of saved identities and the current trusted policy.
9. Legacy settings without `skills.allowlist` retain the current dynamic default behavior.
10. Cancellation and catalog failure do not overwrite the previously saved allowlist.
11. Interactive terminals use the approved colors, and `NO_COLOR` output contains no ANSI escape sequences.
12. Onboarding failure output preserves the existing retry and partial-completion contract.

## Test seams and evidence

The smallest confidence-building test set is:

- one vertical onboarding-to-scheduler test that saves a subset and observes only that subset in the Codex thread configuration;
- one policy boundary test for the exact `unslop` source and expected standalone path;
- one missing-`unslop` selector test that proves the row is disabled and no install occurs;
- one cancellation test that proves the prior settings file is unchanged;
- one legacy-settings test for dynamic-policy compatibility;
- one plain-output test that proves `NO_COLOR` removes ANSI sequences without changing labels or markers.

Native verification runs the focused CLI, settings, policy, and Codex harness tests, followed by the repository's lint, typecheck, and test commands.

## Risks

- Skill discovery currently combines standalone lock metadata with Codex-discovered plugin identities. The catalog adapter must keep that provenance explicit so display names cannot grant trust.
- `@clack/prompts` writes an interactive terminal frame rather than ordinary line output. Keeping it behind `SkillSelector` prevents terminal behavior from leaking into orchestration tests.
- The distinction between an absent allowlist and an empty allowlist is load-bearing. Schema defaults must not collapse the two states.
