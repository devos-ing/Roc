# Configurable Agile Cycles

## Goal

Let a user choose a Daily, Weekly, or Custom Agile cycle during onboarding.
Roc stores that choice globally and uses it consistently when creating tasks
and reporting token usage.

## Decisions

- Replace Week terminology with Agile Cycle throughout the domain, public JSON,
  persistence, CLI output, tests, skills, and documentation.
- Store the global setting at `~/.config/roc/settings.json`.
- Collect the setting interactively in `roc-it onboard`; no duration flag is
  added.
- Daily cycles are one local calendar day.
- Weekly cycles run Monday through Sunday and use ISO week numbering.
- Custom cycles contain a positive whole number of days and are anchored to the
  local calendar date on which onboarding saves the setting.
- Do not add a date library or a general configuration framework.

## Non-goals

- Per-project or per-manifest cycle settings.
- Multiple simultaneous cycle schedules.
- Editing settings through a separate command.
- Time-of-day cycles or sub-day durations.
- Automatically moving existing tasks between cycles.
- Backward compatibility for new manifests that still use `weekId`.

## Global settings

The settings file is a strict discriminated union:

```json
{ "cycle": { "type": "daily" } }
```

```json
{ "cycle": { "type": "weekly" } }
```

```json
{
  "cycle": {
    "type": "custom",
    "days": 14,
    "anchorDate": "2026-08-28"
  }
}
```

`days` must be a positive integer. `anchorDate` uses the local calendar date in
`YYYY-MM-DD` form. Daily and Weekly settings reject those extra fields.

Missing or invalid settings produce an actionable error that tells the user to
run `npx roc-it@latest onboard`. Roc does not silently choose Weekly.

## Cycle calculation

One domain module owns the setting schema and a pure active-cycle calculation.
The calculation accepts validated settings and an injectable `Date` so calendar
boundaries are deterministic in tests.

Cycle identifiers are readable and deterministic:

- Daily: `2026-08-28`
- Weekly: `2026-W35`
- Custom: `2026-08-28-P14D`, using the active window's start date and duration

Daily uses the current local calendar date. Weekly uses the ISO week containing
the current local date. Custom finds the complete number of local calendar days
between its anchor and the current date, divides by its duration, and derives
the active window's start date. Dates before the custom anchor are rejected.

Calendar arithmetic uses the JavaScript standard library. It converts local
calendar dates to UTC day numbers before subtraction so daylight-saving changes
cannot create partial-day errors.

## Module boundaries

`src/domain/agile-cycle.ts` contains:

- the cycle setting schema and inferred types;
- the active cycle result type;
- the pure active-cycle calculation and identifier formatting.

`src/settings.ts` contains plain functions that:

- resolve `~/.config/roc/settings.json` from an injectable home directory;
- load and validate settings;
- safely write settings using the project's existing safe-path protection.

There is no provider interface, strategy hierarchy, factory, or settings class.
Consumers call these functions directly.

## Onboarding flow

`roc-it onboard` keeps its existing skill installation and database behavior,
then asks the user to select Daily, Weekly, or Custom. Custom asks for its number
of days. Roc validates the answer before writing the global settings file.

The CLI I/O boundary gains one asynchronous prompt function. The production
entry point implements it with the standard readline API; tests provide a small
deterministic function. If interactive input is unavailable, onboarding fails
with a clear message and does not write settings.

Running onboarding again replaces the global cycle setting with the newly
confirmed choice. It does not change existing task or usage records.

## Public task manifest

The backlog manifest replaces its top-level `weekId` field with
`"cycleId": "2026-W35"`; its goal and non-empty task list keep their existing
shape.

`cycleId` is a non-empty validated string because migrated weekly identifiers
and all three new identifier formats are legitimate cycle identifiers. The task
creation skill reads the global setting, calculates the active cycle, previews
it, and writes `cycleId` only after the user approves the backlog.

Strict validation rejects a manifest containing `weekId`. The CLI reports that
the manifest must use `cycleId`.

## Persistence migration

A new SQLite migration performs the full terminology rename while preserving
data:

- `weeks` becomes `cycles`;
- every `week_id` column becomes `cycle_id`;
- repository methods, row types, inspection output, usage aggregation, and
  foreign-key references use Cycle names.

The migration relies on SQLite's native table and column rename operations.
Migration tests open a database at the previous schema version, add related
cycle, task, and usage rows, migrate it, and verify both the data and foreign
keys. Existing identifiers such as `2026-W35` remain unchanged.

The database does not duplicate the global duration setting. Persisted records
need only their cycle identifier; the global setting is used to choose the
current cycle.

## Token reporting

`roc-it tokens` loads the global setting, calculates the active cycle, and asks
the repository for that cycle's usage. Output uses Cycle terminology. A missing
cycle remains an empty state, while missing or invalid settings are reported as
configuration errors.

## Error handling

- Reject malformed settings at the file boundary.
- Reject non-positive or non-integer custom durations before writing.
- Reject a current date earlier than a custom anchor.
- Preserve safe-path checks and reject symbolic-link settings paths.
- Do not open or change the task database when manifest validation fails.
- Preserve existing structured error handling for token-report failures.

## Documentation

The English and Traditional Chinese READMEs will:

- explain Daily, Weekly, and Custom cycles in simple language;
- list `~/.config/roc/settings.json`;
- show one short settings example;
- state that onboarding saves the global default;
- use `cycleId` in production examples.

The installed `roc-create-tasks` skill will use Agile Cycle terminology and read
the global setting before creating a manifest.

## Verification

The smallest confidence-bearing test set is:

1. A focused domain test covering a Daily date change, a Weekly Monday
   boundary, and a Custom duration boundary.
2. An onboarding test proving the selected setting is safely saved and can be
   loaded again.
3. A migration test proving existing cycle, task, usage, and foreign-key data
   survive the rename.
4. Updated task-import tests proving `cycleId` succeeds and `weekId` fails before
   database creation.
5. Updated token-report tests proving the configured active cycle is queried.
6. The full `bun run check` suite.

No exhaustive date matrix or configuration abstraction tests are required.
