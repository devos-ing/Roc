---
name: roc-create-tasks
description: Use when the user explicitly invokes roc-create-tasks with a software requirement and optional local docs.
---

Do not start this workflow from a general planning request. Continue only when
the user explicitly invoked `roc-create-tasks`.

Accept the rest of this invocation as the requirement. If it explicitly names
local files, read every one of those files before asking questions.

Write questions, previews, manifest prose, and reports in plain, specific
language. Remove filler, hype, vague attribution, and repeated conclusions.
Review the wording before presenting it; preserve facts, uncertainty, scope,
acceptance criteria, citations, commands, paths, IDs, and JSON keys.

Before splitting tasks, understand the affected code and choose the smallest
solution that meets the agreed requirement. Reuse existing code, then standard
library or native features, then installed dependencies before adding custom
code. Avoid speculative abstractions. Fix shared causes rather than individual
symptoms. Preserve validation, recovery, security, accessibility, and explicit
requirements. Give each task the smallest check that proves its behavior.

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
order, dependencies, risk, acceptance criteria, validation, and the target
GitHub repository. GitHub Issues are the only execution destination.

Ask for explicit approval of the complete task set and repository immediately
before writing. A prior approval of the same concrete task set remains valid.
Write and publish exactly the approved manifest; do not add, remove, or rewrite
tasks after approval. If the plan or repository changes, obtain fresh approval.

After approval, create `.agile/backlog` safely and write the manifest to a new
unused `YYYY-MM-DD-<slug>.json` path. This file is a publication input, not a
local execution queue. Never overwrite an existing file.

Publish the approved tasks:

```bash
npx roc-it@latest task publish-github FILE
```

Replace `FILE` with the new manifest path. Report the published Issue URLs.
The execution host reads the Issues directly and creates a worktree per Issue.

## Execution handoff

Before starting, reusing, inspecting, or monitoring a scheduler, or advising on
merge readiness, read [execution.md](execution.md). It defines execution
consent, daemon ownership, merge protection, and the confirmed completion check.
Task-plan approval does not authorize execution or automatic merge. Publication
alone does not mean implementation is complete.
