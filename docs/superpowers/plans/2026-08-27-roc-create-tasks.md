# Roc Create Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user onboard Roc's `roc-create-tasks` skill, turn a grilled requirement into a reviewed JSON backlog, and atomically import that backlog as approved ready tasks.

**Architecture:** Add strict backlog schemas and one transactional repository method for import semantics. Add one standard-library installer for project/global skill copies. Keep the CLI as a thin adapter over those two pieces, package one canonical self-contained `SKILL.md`, and document the same production flow in English and Traditional Chinese.

**Tech Stack:** Bun, TypeScript, Zod, `bun:sqlite`, Node filesystem APIs, Bun test.

---

## Working rules

- Work in `/Users/roy/Documents/ChatGPT/agile-agents/.worktrees/roc-create-tasks`.
- Prefix every shell command with `rtk`.
- Use `apply_patch` for edits.
- Follow the approved design in `docs/superpowers/specs/2026-08-27-roc-create-tasks-design.md`.
- Do not add a dependency, general installer framework, Markdown parser, or skill script.
- Run each stated test after its edit and commit after each green task. Use `HUSKY=0` because the repository's current hook is unsafe.

## Task 1: Add strict, atomic backlog import

**Files:**

- Modify: `src/domain/schemas.ts`
- Modify: `src/store/planning-repository.ts`
- Modify: `test/store/planning-repository.test.ts`

- [ ] **Step 1: Write repository import tests first**

Add a `manifest` fixture that contains two tasks, with the second depending on the first. Add tests that prove:

1. `importBacklog(manifest)` creates the missing week, creates both tasks as `ready`, stores the second task's `blocks` edge in `task_deps`, sets both approval flags to `true`, uses the summed token ceilings for the week budget, and returns `{ created: 2, skipped: 0, total: 2 }`.
2. Replaying the exact manifest returns `{ created: 0, skipped: 2, total: 2 }` without changing a task that has advanced past `ready`.
3. A same-ID/different-content conflict rejects the whole batch and creates neither the other task nor week data.
4. A missing dependency rejects the whole batch.
5. An unsafe or duplicate task ID fails schema validation before any write.

Use database row counts and `repo.listTasks()` to prove rollback, not internal mocks.

- [ ] **Step 2: Run the focused test and see the expected failure**

```bash
rtk bun test test/store/planning-repository.test.ts
```

Expected: FAIL because `BacklogManifestSchema` and `importBacklog` do not exist.

- [ ] **Step 3: Add the manifest schemas**

In `src/domain/schemas.ts`, add these shapes beside the existing task schemas:

```ts
export const BacklogTaskSchema = z
  .object({
    id: NonEmpty,
    title: NonEmpty,
    priority: z.number().int().min(0),
    spec: TicketSpecSchema,
  })
  .strict();

export const BacklogManifestSchema = z
  .object({
    weekId: WeeklyPlanSchema.shape.id,
    goal: NonEmpty,
    tasks: z.array(BacklogTaskSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const task of manifest.tasks) {
      if (seen.has(task.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate task ID: ${task.id}`,
          path: ["tasks"],
        });
      }
      seen.add(task.id);
    }
  });

export type BacklogManifest = z.infer<typeof BacklogManifestSchema>;
```

The repository must also call `safeTaskPathComponent` for every task ID so the manifest cannot create unsafe branch or artifact names.

- [ ] **Step 4: Implement one transactional repository method**

Add this public boundary:

```ts
export type BacklogImportResult = {
  created: number;
  skipped: number;
  total: number;
};

importBacklog(input: BacklogManifest): BacklogImportResult
```

Implementation order inside one `this.db.transaction` callback:

1. Parse with `BacklogManifestSchema` and validate every ID with `safeTaskPathComponent` before starting the transaction.
2. Build trusted `TaskCreate` values using the manifest week, `approvalRequired: true`, and `approved: true`.
3. Read all existing task IDs needed for conflict and dependency checks.
4. Reject any dependency that is neither in the batch nor already stored.
5. For an existing ID, compare the parsed immutable fields `weekId`, `title`, `spec`, `priority`, `approvalRequired`, and `approved`. Exact matches are replay skips; any difference throws `Task conflict: <id>`.
6. Only after preflight passes, insert the week when absent using the manifest goal and summed token ceilings.
7. Create every absent task, then insert its declared dependencies into `task_deps` with kind `blocks` so all referenced rows already exist.
8. Transition each new task from `draft` to `ready` using `task-import:<id>:ready`.
9. Return stable counts.

Reuse `TaskCreateSchema`, `createWeek`, `createTask`, and `transitionTask`. Do not duplicate their validation or status-event SQL. A nested Bun SQLite transaction is acceptable and keeps the existing transition invariant authoritative.

- [ ] **Step 5: Run focused tests**

```bash
rtk bun test test/store/planning-repository.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/domain/schemas.ts src/store/planning-repository.ts test/store/planning-repository.test.ts
HUSKY=0 rtk git commit -m "feat: import approved Roc backlogs"
```

## Task 2: Install the canonical skill safely during onboarding

**Files:**

- Create: `src/skills/install.ts`
- Modify: `src/cli/run.ts`
- Modify: `test/cli/run.test.ts`

- [ ] **Step 1: Replace the old init test with onboarding tests**

Add one project test that runs `onboard` with a temporary current directory and explicit database path, then proves:

- the database exists;
- identical skill content exists at both `.agents/skills/roc-create-tasks/SKILL.md` and `.claude/skills/roc-create-tasks/SKILL.md`;
- a second run succeeds without changing the files; and
- changed destination content makes a later run fail without overwrite.

Add one global test against a temporary home root that proves both user-level copies are written and no project database is opened. Inject the project and home roots through a small `CliRuntime` hook rather than mutating the real home directory.

Add a symlink test for one destination path component and prove onboarding refuses to write through it.

- [ ] **Step 2: Run the CLI test and see the expected failure**

```bash
rtk bun test test/cli/run.test.ts
```

Expected: FAIL because `onboard` and skill installation do not exist.

- [ ] **Step 3: Implement the focused installer**

Create `src/skills/install.ts` with one exported operation:

```ts
export type SkillInstallResult = {
  created: string[];
  skipped: string[];
};

export async function installRocCreateTasksSkill(input: {
  sourcePath: string;
  root: string;
}): Promise<SkillInstallResult>
```

The function reads the canonical source once and installs it to these paths below `root`:

```text
.agents/skills/roc-create-tasks/SKILL.md
.claude/skills/roc-create-tasks/SKILL.md
```

Use only `node:fs/promises`, `node:fs` constants, and `node:path`. For each directory component: create it when missing, then verify with `lstat` that it is a real directory and not a symlink. For each target:

- missing: create with `O_CREAT | O_EXCL | O_NOFOLLOW`;
- regular file with byte-identical content: record as skipped;
- symlink, non-file, or different content: throw and preserve it.

This is a small dedicated security boundary; do not build a generic installer class.

- [ ] **Step 4: Route `onboard` in the CLI**

Extend `parseCliArgs` with `global: { type: "boolean" }`. Extend `CliRuntime` with optional test-only roots while keeping production defaults:

```ts
projectRoot?: string;
homeRoot?: string;
```

Use `process.cwd()` and `homedir()` when they are absent. Resolve the canonical source from the packaged repository root:

```ts
resolve(import.meta.dir, "..", "..", "skills", "roc-create-tasks", "SKILL.md")
```

For `onboard`:

- reject extra positionals and options other than `--db` and `--global`;
- project mode opens/closes the default or explicit database, then installs below the project root;
- global mode rejects `--db`, skips database creation, and installs below the home root;
- print created/skipped destinations followed by the documented `grilling` install command;
- remove the `init` branch entirely so `init` returns the normal unknown-command error.

- [ ] **Step 5: Run focused tests**

```bash
rtk bun test test/cli/run.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/skills/install.ts src/cli/run.ts test/cli/run.test.ts
HUSKY=0 rtk git commit -m "feat: onboard the Roc task skill"
```

## Task 3: Expose backlog import through the CLI

**Files:**

- Modify: `src/cli/run.ts`
- Modify: `src/cli/help.ts`
- Modify: `test/cli/run.test.ts`

- [ ] **Step 1: Add the vertical CLI import test**

Write a valid temporary JSON manifest, run:

```ts
await runCli(["task", "import", manifestPath, "--db", dbPath], io)
```

Assert exit code `0`, output exactly `Created 2, skipped 0, total 2.`, and both database tasks are `ready`. Replay and assert `Created 0, skipped 2, total 2.`.

Add focused failures for malformed JSON, a conflicting task, and invalid positional/options. Prove a conflict returns exit code `1` and leaves the database unchanged.

- [ ] **Step 2: Run the focused CLI test and see the expected failure**

```bash
rtk bun test test/cli/run.test.ts
```

Expected: FAIL because `task import` is not routed.

- [ ] **Step 3: Implement the thin CLI adapter**

For exactly `task import FILE [--db PATH]`:

1. require one file positional;
2. reject unrelated options;
3. resolve and parse the JSON with `Bun.file(path).json()`;
4. open the database;
5. call `new PlanningRepository(db).importBacklog(value)`;
6. close the database in `finally`; and
7. print `Created N, skipped N, total N.`.

Parse, validation, and conflict errors return `1` with their safe message. Command-shape errors return `2`.

Replace help text with:

```text
roc-it - run Codex agents through an agile software flow

Usage:
  roc-it onboard [--global] [--db PATH]
  roc-it task import FILE [--db PATH]
  roc-it task list [--db PATH]
  roc-it tokens [--db PATH] [--no-color]
  roc-it scheduler run --backend codex --repo PATH [--base REF] [--db PATH]
  roc-it help
```

- [ ] **Step 4: Run focused tests**

```bash
rtk bun test test/cli/run.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add src/cli/run.ts src/cli/help.ts test/cli/run.test.ts
HUSKY=0 rtk git commit -m "feat: expose task backlog import"
```

## Task 4: Package the self-contained `roc-create-tasks` skill

**Files:**

- Create: `skills/roc-create-tasks/SKILL.md`
- Modify: `package.json`
- Modify: `test/package.test.ts`

- [ ] **Step 1: Extend the package-boundary test first**

Change the expected `files` array to include `skills`, allow `skills/` in the archive filter, and require `skills/roc-create-tasks/SKILL.md` in `npm pack --dry-run` output.

- [ ] **Step 2: Run the package test and see the expected failure**

```bash
rtk bun test test/package.test.ts
```

Expected: FAIL because the canonical skill is absent.

- [ ] **Step 3: Create the smallest useful skill**

Create only `skills/roc-create-tasks/SKILL.md`; do not add scripts, references, examples, or UI metadata. Use this frontmatter:

```yaml
---
name: roc-create-tasks
description: Use only when the user explicitly invokes roc-create-tasks to turn a software requirement and optional local docs into a reviewed Roc backlog by using grilling, then import it only after approval.
---
```

Its first instruction must refuse automatic use from a general planning
request. The rest of its body must tell the agent to:

1. accept the rest of the invocation as the requirement;
2. read every explicitly referenced local file before questioning;
3. invoke the installed `grilling` skill, and if unavailable stop with the exact install command from the design;
4. continue until grilling reaches shared understanding;
5. split work into small Scout -> Implement -> Review tasks with explicit dependencies;
6. produce the exact strict manifest shape from the approved design, defaulting `weekId` to the current ISO week unless the user chose another;
7. show the full goal/task/dependency/risk/acceptance/validation preview;
8. ask for explicit approval immediately before writing;
9. create `.agile/backlog` safely, choose `YYYY-MM-DD-<slug>.json`, and never overwrite an existing path;
10. run `npx roc-it@latest task import FILE`; and
11. report the CLI counts.

Do not teach general product planning, duplicate grilling's interview, or imply permission to write before approval.

- [ ] **Step 4: Add `skills` to the npm package and validate**

Add `"skills"` to `package.json#files`, then run:

```bash
rtk python3 /Users/roy/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/roc-create-tasks
rtk bun test test/package.test.ts
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add skills/roc-create-tasks/SKILL.md package.json test/package.test.ts
HUSKY=0 rtk git commit -m "feat: package the Roc task creation skill"
```

## Task 5: Document the production flow and verify the slice

**Files:**

- Modify: `README.md`
- Modify: `README.zh-HK.md`
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Update the English production README**

Keep the existing simple tone. In Quick Start:

- list the exact `npx skills add mattpocock/skills --skill grilling --global --agent codex --agent claude-code --agent cursor` prerequisite;
- replace `npx roc-it@latest init` with `npx roc-it@latest onboard`;
- explain project and `--global` onboarding in one short paragraph;
- show `/roc-create-tasks Add team invitations` for Claude Code/Cursor and `$roc-create-tasks Add team invitations` for Codex;
- explain that the skill grills the requirement, previews tasks, waits for approval, saves the JSON under `.agile/backlog`, and imports it;
- remove the statement that Roc has no public command for adding tickets;
- add `onboard` and `task import` to Commands and remove `init`.

Every executable production Roc example must use `npx roc-it@latest` or `bunx roc-it@latest`; the compact Commands reference may keep the installed `roc-it` form.

- [ ] **Step 2: Mirror the same facts in Traditional Chinese**

Use plain Traditional Chinese, keep product/command names unchanged, and do not add claims absent from English.

- [ ] **Step 3: Update contribution guidance**

Explain that local contributors can use `bun src/cli/main.ts onboard`, validate the packaged skill with `quick_validate.py`, and test imports with a temporary JSON manifest. Keep release instructions out of both READMEs.

- [ ] **Step 4: Check documentation literals**

```bash
rtk rg -n "roc-it@latest init|roc-it init|no public command|沒有新增 ticket|暫時沒有新增" README.md README.zh-HK.md CONTRIBUTING.md
rtk rg -n "roc-create-tasks|task import|onboard|mattpocock/skills" README.md README.zh-HK.md CONTRIBUTING.md
```

Expected: the first command returns no matches; the second shows the new flow in both languages and contributor guidance.

- [ ] **Step 5: Run the full verification gate**

```bash
rtk bun run lint
rtk bun run typecheck
rtk bun run test
rtk npm pack --dry-run --json --ignore-scripts
```

Expected: all commands PASS; the archive contains `skills/roc-create-tasks/SKILL.md` and no project-installed `.agents` or `.claude` copies.

- [ ] **Step 6: Inspect the final diff and commit**

```bash
rtk git diff --check
rtk git status --short
rtk git add README.md README.zh-HK.md CONTRIBUTING.md
HUSKY=0 rtk git commit -m "docs: explain Roc task creation"
```

## Roc acceptance check

After all tasks are green, verify the feature through the user-visible path in a temporary project:

```bash
rtk bun src/cli/main.ts onboard --db .agile/runtime/agile.db
rtk bun src/cli/main.ts task import /absolute/path/to/sample-backlog.json --db .agile/runtime/agile.db
rtk bun src/cli/main.ts task list --db .agile/runtime/agile.db
```

Expected: onboarding installs both skill copies, import reports stable counts, and the list shows every imported task as `ready`.
