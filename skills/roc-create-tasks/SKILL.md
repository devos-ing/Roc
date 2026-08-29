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
npx skills add mattpocock/skills --skill grilling --global --agent codex --agent claude-code --agent cursor
```

Continue grilling until the design-tree frontier is empty and the user confirms
shared understanding. Then split the work into small, independently reviewable
Roc tasks for the Scout -> Implement -> Review loop. Give every task explicit
dependencies by task ID.

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
order, dependencies, risk, acceptance criteria, and validation. Ask for explicit
approval immediately before writing. Do not create a backlog file or import it
without that approval.

After approval, create `.agile/backlog` safely and write the manifest to a new
unused `YYYY-MM-DD-<slug>.json` path. Never overwrite an existing file. Then run:

```bash
npx roc-it@latest task import FILE
```

Replace `FILE` with the new manifest path. Report the command's created,
skipped, and total counts to the user.
