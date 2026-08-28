# Roc Create Tasks Design

## Summary

Roc will add a user-invoked `roc-create-tasks` Agent Skill. A user gives the
skill a requirement or a requirement plus local document references. The skill
invokes the separately installed `grilling` skill, turns the agreed scope into
small Roc tasks, previews the complete backlog, and imports it only after the
user confirms.

Two CLI commands support the flow:

```text
roc-it onboard [--global]
roc-it task import FILE [--db PATH]
```

`onboard` replaces `init`; there is no compatibility alias.

## Goals

- Let users create a Roc backlog from Codex, Claude Code, or Cursor chat.
- Use the existing `grilling` skill for requirement discovery.
- Keep the generated backlog reviewable before it changes SQLite.
- Make imports strict, atomic, and safe to retry.
- Install the Roc skill at project or user scope with one command.

## Non-goals

- Installing or copying `grilling` for the user.
- Using `grill-with-docs` or `domain-modeling`.
- Parsing Markdown tickets, PDFs, or Word documents inside Roc.
- Adding task edit, delete, update, or approval commands.
- Building a general skill installer or marketplace.
- Keeping `setup` or `init` as aliases.

## User flow

The user installs `grilling` from `mattpocock/skills` for the agents they use:

```bash
npx skills add mattpocock/skills \
  --skill grilling \
  --global \
  --agent codex \
  --agent claude-code \
  --agent cursor
```

They onboard either one project or their user account:

```bash
npx roc-it@latest onboard
npx roc-it@latest onboard --global
```

They then start the skill with a natural-language requirement. Claude Code and
Cursor use slash invocation:

```text
/roc-create-tasks Add team invitations
```

Codex uses its native skill mention:

```text
$roc-create-tasks Add team invitations
```

The requirement may reference local files:

```text
/roc-create-tasks Build the login flow described in docs/requirements.md
```

The skill reads the supplied material, invokes `grilling`, and waits until the
design-tree frontier is empty and the user confirms shared understanding. It
then creates tasks sized for Roc's Scout -> Implement -> Review loop.

Before any write, the skill shows the week goal, ordered tasks, dependencies,
risk, acceptance criteria, and validation. Only explicit user confirmation may
continue. The skill writes `.agile/backlog/YYYY-MM-DD-<slug>.json` without
overwriting an existing file, then runs:

```bash
npx roc-it@latest task import .agile/backlog/YYYY-MM-DD-<slug>.json
```

## Agent Skill

The npm package contains one canonical skill at:

```text
skills/roc-create-tasks/SKILL.md
```

The skill follows the open Agent Skills `SKILL.md` format and is explicitly
user-invoked because it can write files and import tasks. Its discovery
description and first instruction limit it to an explicit `roc-create-tasks`
invocation; explicit approval remains required before any write. Its
instructions must:

1. accept a natural-language requirement and optional local file references;
2. read referenced files before asking questions;
3. invoke `grilling` and never replace it with an improvised interview;
4. stop with the documented install command when `grilling` is unavailable;
5. create small, independently reviewable tasks with explicit dependencies;
6. show the full preview and wait for explicit confirmation;
7. write a new backlog JSON file without overwriting another file;
8. call `npx roc-it@latest task import FILE`; and
9. report the CLI's created, skipped, and total counts.

No skill-specific script is needed. Codex, Claude Code, and Cursor already have
file and shell tools.

## `roc-it onboard`

Running `roc-it onboard` in a project:

- opens the default `.agile/runtime/agile.db`, creating it when absent;
- installs the packaged `SKILL.md` at
  `.agents/skills/roc-create-tasks/SKILL.md`;
- installs the same file at
  `.claude/skills/roc-create-tasks/SKILL.md`; and
- prints the command for installing `grilling`.

Cursor reads `.agents/skills`, so it needs no third copy.

Running `roc-it onboard --global` does not open a project database. It installs
the skill at:

- `~/.agents/skills/roc-create-tasks/SKILL.md`; and
- `~/.claude/skills/roc-create-tasks/SKILL.md`.

Installation is idempotent. An absent file is created, and an identical file is
skipped. A different existing file causes an error and remains unchanged. The
installer rejects symbolic-link path components so a project cannot redirect a
write outside the requested skill directory.

No installer framework or new dependency is introduced. Node's filesystem and
OS standard-library functions are sufficient.

## Backlog manifest

The manifest is strict JSON:

```json
{
  "weekId": "2026-W35",
  "goal": "Deliver user login",
  "tasks": [
    {
      "id": "login-01",
      "title": "Add the login API",
      "priority": 1,
      "spec": {
        "problem": "Users cannot sign in.",
        "desiredOutcome": "Users can sign in with valid credentials.",
        "scope": ["Add the login endpoint"],
        "nonGoals": ["Password reset"],
        "acceptanceCriteria": ["Valid credentials create a session"],
        "validation": ["Run the login integration test"],
        "dependencies": [],
        "risk": "medium",
        "contextCandidates": [],
        "tokenCeiling": 12000
      }
    }
  ]
}
```

`weekId` defaults to the current ISO week in the skill. A user may choose
another week during grilling. `goal` and `tasks` are required. A task reuses the
existing ticket specification shape but omits `weekId`, `approvalRequired`, and
`approved`; the importer supplies those trusted values.

## Import validation

`roc-it task import FILE [--db PATH]` resolves and reads the supplied JSON
file, then validates the complete manifest before writing. Without `--db`, it
uses `.agile/runtime/agile.db`. Validation requires:

- a strict manifest and strict task specifications;
- at least one task;
- unique task IDs;
- task IDs safe for Roc's branch and artifact names;
- every dependency to name a task in the same manifest or an existing task; and
- no conflicting existing task.

The importer converts every manifest task to a `TaskCreate` with the manifest's
week ID and with both `approvalRequired` and `approved` set to `true`.

## Atomic and idempotent import

All database reads and writes for one manifest run in one SQLite transaction.

- If the week is absent, Roc creates it with the manifest goal and a token
  budget equal to the sum of task token ceilings.
- If the week exists, Roc reuses it.
- If a task ID is absent, Roc creates the task in `draft` and transitions it to
  `ready` with a deterministic import idempotency key.
- If an existing task has the same immutable task content, Roc skips it without
  changing its current workflow status.
- If an existing task with the same ID has different immutable content, Roc
  rejects the complete import.

For each newly created task, Roc also stores every declared dependency in
`task_deps` with kind `blocks`. This makes the scheduler wait until dependency
tasks are done instead of treating the dependency list as display-only data.

Any parse, validation, dependency, conflict, or database error leaves the
database unchanged. Success prints stable counts for created, skipped, and
total tasks.

## CLI and documentation

Production help and both READMEs replace `init` with `onboard`, add
`task import FILE`, explain `roc-create-tasks`, and list `grilling` as a
user-installed prerequisite. All production examples continue to use
`npx roc-it@latest` or `bunx roc-it@latest`.

`CONTRIBUTING.md` documents local equivalents without adding development
commands to production help.

The npm `files` boundary includes the canonical skill directory. Installed
copies created by `onboard` are project artifacts, not additional package
sources.

## Verification

The smallest load-bearing test set is:

- one project-onboard test covering database creation, both skill targets,
  repeat safety, and refusal to overwrite changed content;
- one global-onboard test using a temporary home directory;
- one vertical import test covering a valid ready backlog, stored dependency
  edges, and exact replay;
- focused import failure checks for conflicts, invalid dependencies, and full
  rollback;
- the existing package archive test extended to require the canonical skill;
  and
- the existing full lint, typecheck, and test command.

Prose is reviewed directly rather than locked down with brittle string tests.

## Dogfood delivery

The implementation will be run through Roc itself. Because the public import
command does not exist before this change, the delivery process may seed one
approved implementation task through the existing repository API, run Roc's
Codex scheduler, and integrate the accepted implementation commit. The normal
new user path remains `onboard` followed by `roc-create-tasks`.

## References

- [OpenAI: Build skills](https://developers.openai.com/codex/skills)
- [Anthropic: Extend Claude with skills](https://docs.anthropic.com/en/docs/claude-code/skills)
- [Cursor: Agent Skills](https://cursor.com/docs/skills)
- [mattpocock/skills](https://github.com/mattpocock/skills)
- [vercel-labs/skills CLI](https://github.com/vercel-labs/skills)
