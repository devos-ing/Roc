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

## Hand off execution through confirmed merge

Respect the user's chosen merge mode and existing execution consent. Task-plan
approval is not permission to start execution or enable automatic merge. Reuse
prior consent for this execution; do not ask again for permission already given,
including coding-tool consent recorded by onboarding. If execution consent is
missing, ask before starting. If the merge mode is unspecified, explain that
manual merge is the default and ask whether the user wants automatic merge.
Never enable `--auto-merge` without that choice.

Select the target base branch with the user, retaining an explicit prior choice.
Before starting anything, check for an existing daemon on this or another host
and confirm its repository, base branch, and merge mode. Keep one daemon per
repository. Reuse an existing daemon when its configuration matches; publication
does not require another scheduler process on the planning machine. Base branch
and automatic merge are startup options, not settings changed by publication.
If the configuration differs or daemon status is uncertain, report the mismatch
and coordinate with the operator. Never implicitly start a duplicate daemon or
restart one to change its mode. Before an operator-approved replacement, stop
the old daemon, confirm its children have exited, and preserve unfinished
worktrees; there is no multi-host claim protocol or automatic worktree transfer.

Only when execution is authorized and no daemon is running, start a continuous
scheduler on the execution host in its project clone. For automatic merge, the
single-task example is:

```bash
npx roc-it@latest scheduler run --base-branch SELECTED_BASE --concurrency 1 --auto-merge
```

Replace `SELECTED_BASE` with the selected target branch; do not guess it. Apply
the `ROC_CLI_ENTRY` substitution above on the execution host too. For manual
merge, use the same continuous command without `--auto-merge`; the user merges
the PR and the scheduler confirms the result. Keep the daemon running through
merge reconciliation. `--once` processes one eligible task and exits; it does
not provide this persistent handoff or establish completion.

Automatic merge requires readable classic branch protection on the target,
at least one required status check, strict up-to-date checks (**Require branches
to be up to date before merging**), and administrator enforcement (**Do not allow
bypassing the above settings**). Squash merging must be enabled. The executor
needs publication/merge permissions plus read access to checks, statuses,
protection, and active repository/organization rules. All reported checks and
statuses must succeed on the exact independently reviewed head, including
required check app identities. Human reviews remain required when configured;
Pi Review does not replace them. Missing or unreadable protection, pending or
failed checks (including skipped or neutral results), outstanding reviews,
merge queues, and unsupported rules block automatic merge with a visible reason.
Never bypass or silently modify repository protection, use an administrator
bypass, or push directly to the target. Report policy blockers to the coordinator
for any separately approved repository policy change; this skill does not
authorize an agent to change protection.

PR creation does not establish completion. An open PR stays `awaiting_merge`.
Monitor the daemon output for visible wait reasons and use these read-only
commands to inspect persisted status and details without starting another daemon:

```bash
npx roc-it@latest task board
npx roc-it@latest scheduler inspect
```

Report Issue and PR URLs, the selected base and merge mode, and any current wait
reason or required operator action. A task is confirmed `done` only after its
intended PR is confirmed merged into the selected target branch and the scheduler
has verified the merge commit is present in the fetched target. Until that
checkpoint is confirmed, report the actual waiting or blocked state, not success.
