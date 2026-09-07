---
name: roc-create-tasks
description: Use when the user explicitly invokes roc-create-tasks with a software requirement and optional local docs.
---

Do not start this workflow from a general planning request. Continue only when
the user explicitly invoked `roc-create-tasks`.

Accept the rest of this invocation as the requirement. If it explicitly names
local files, read every one of those files before asking questions.

**REQUIRED SUB-SKILL:** Use the installed `unslop` skill for every user-facing
question, preview, manifest prose value, and final report. Run its self-audit
before showing or writing text. Keep commands, paths, IDs, and JSON keys exact.

Use the installed `grilling` skill for requirement discovery. Do not replace it
with your own interview. If `grilling` is unavailable, stop and tell the user to
install it with:

```bash
npx skills add mattpocock/skills --skill grilling --global --agent pi
```

Continue grilling until the design-tree frontier is empty and the user confirms
shared understanding. Then split the work into small, independently reviewable
Roc tasks for the Scout -> Implement -> Review loop. Give every task explicit
dependencies by task ID.

Use the Roc entrypoint supplied by the user for every command below. When
`ROC_CLI_ENTRY` is set, replace `npx roc-it@latest` with
`bun "$ROC_CLI_ENTRY"`. This keeps source-checkout workflows on the same version
as the daemon. Only use the npm command when no source entrypoint was supplied.

Before creating the manifest, run:

```bash
npx roc-it@latest cycle current
```

Use its output as `cycleId`. If Roc says settings are missing or invalid, stop
and ask the user to run `npx roc-it@latest onboard`.

Create one strict JSON manifest with this shape:

```json
{
  "cycleId": "2026-08-28-P14D",
  "goal": "Deliver the agreed outcome",
  "tasks": [
    {
      "id": "feature-01",
      "title": "Implement one reviewable outcome",
      "priority": 1,
      "spec": {
        "problem": "What is missing now.",
        "desiredOutcome": "What will be true when the task is done.",
        "scope": ["Included work"],
        "nonGoals": ["Excluded work"],
        "acceptanceCriteria": ["Observable success"],
        "validation": ["Command or check"],
        "dependencies": [],
        "risk": "medium",
        "contextCandidates": [],
        "tokenCeiling": 12000
      }
    }
  ]
}
```

Before writing anything, show the complete preview: cycle goal, every task in
order, dependencies, risk, acceptance criteria, validation, and one destination:

- **Local queue** imports the manifest into this project's Roc database.
- **Roc daemon via GitHub Issues** publishes approved tasks for a daemon in a separate clone on this host or another machine.

If the invocation did not choose a destination, ask the user to choose one as
part of the preview. Ask for explicit approval of the complete task set and its
destination immediately before writing. Do not create a backlog file, import it,
or publish Issues without that approval.

After approval, create `.agile/backlog` safely and write the manifest to a new
unused `YYYY-MM-DD-<slug>.json` path. Never overwrite an existing file.

For the local queue destination, run:

```bash
npx roc-it@latest task import FILE
```

For the Roc daemon via GitHub Issues destination, run:

```bash
npx roc-it@latest task publish-github FILE
```

Replace `FILE` with the new manifest path. Remote publication is the complete
machine-A action: never also run `task import` on machine A. Report the local
import counts or the published Issue URLs, according to the selected destination.
