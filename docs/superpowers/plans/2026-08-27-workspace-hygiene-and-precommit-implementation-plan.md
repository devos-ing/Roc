# Workspace Hygiene and Pre-Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove generated agent state from the repository and enforce Biome formatting/linting, TypeScript validation, and tests through Husky before every commit.

**Architecture:** Git ignores `.superpowers/` and `.scratch/` wholesale while durable workflow documents stay under `docs/superpowers/`. Husky invokes lint-staged for safe partially-staged-file handling; lint-staged invokes Biome, then the hook runs the existing typecheck and test scripts. Existing unstaged README, Apache license, package license field, and `output/` image changes are protected from both implementation commits.

**Tech Stack:** Bun, Husky 9.1.7, lint-staged 17.0.5, Biome 2.5.6, TypeScript, Git

---

**Execution constraint:** The current SDD ledger lives at
`.superpowers/sdd/2026-08-27-workspace-hygiene-and-precommit-implementation-plan/`
and must survive until all implementation and reviews finish. Task 1 deletes
legacy `.superpowers` contents; the controller deletes the current ledger and
empty parent directories after final review.

### Task 1: Remove generated agent-state directories

**Files:**
- Modify: `.gitignore`
- Delete: `.superpowers/sdd/2026-08-26-real-codex-harness-implementation-plan/final-fix-report.md`
- Delete: `.scratch/deliver-code/README.md`
- Preserve: `docs/superpowers/`
- Preserve: `README.md`, `package.json`, `LICENSE`, `output/`

- [ ] **Step 1: Record the protected working-tree state**

Run:

```bash
git status --short
git diff -- README.md package.json
git ls-files LICENSE output
```

Expected: README and package metadata changes remain outside the index; `LICENSE`
and `output/imagegen/roc-avatar.png` are not staged by this task.

- [ ] **Step 2: Replace the narrow scratch ignores with whole-directory ignores**

Edit `.gitignore` to contain these leading entries:

```gitignore
.superpowers/
.scratch/
.worktrees/
.agile/runtime/
```

Remove these now-redundant entries:

```gitignore
.scratch/deliver-code/*/
.scratch/agile-codex-harness-*
```

Keep every other existing ignore rule unchanged.

- [ ] **Step 3: Delete the approved legacy generated state**

Resolve the exact targets first:

```bash
realpath /Users/roy/Documents/ChatGPT/agile-agents/.superpowers/brainstorm
realpath /Users/roy/Documents/ChatGPT/agile-agents/.superpowers/sdd/2026-08-26-real-codex-harness-implementation-plan
realpath /Users/roy/Documents/ChatGPT/agile-agents/.scratch
```

Expected: the outputs exactly match the three absolute paths above. Then run:

```bash
rm -rf /Users/roy/Documents/ChatGPT/agile-agents/.superpowers/brainstorm
rm -rf /Users/roy/Documents/ChatGPT/agile-agents/.superpowers/sdd/2026-08-26-real-codex-harness-implementation-plan
rm -rf /Users/roy/Documents/ChatGPT/agile-agents/.scratch
```

Do not delete `docs/superpowers/`, `output/`, or this plan's current SDD
workspace.

- [ ] **Step 4: Verify cleanup and ignore behavior**

Run:

```bash
test ! -e .superpowers/brainstorm
test ! -e .superpowers/sdd/2026-08-26-real-codex-harness-implementation-plan
test -d .superpowers/sdd/2026-08-27-workspace-hygiene-and-precommit-implementation-plan
test ! -e .scratch
test -d docs/superpowers
git check-ignore -q .superpowers/probe
git check-ignore -q .scratch/probe
git diff --check
```

Expected: every command exits successfully.

- [ ] **Step 5: Commit only workspace cleanup**

Run:

```bash
git add .gitignore
git add -u -- .superpowers .scratch
git diff --cached --name-status
```

Expected staged paths: `.gitignore`, the tracked `.superpowers/.../final-fix-report.md`
deletion, and `.scratch/deliver-code/README.md` deletion. Commit:

```bash
git commit -m "chore: remove generated agent state"
```

### Task 2: Install and configure Husky, lint-staged, and Biome

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `biome.json`
- Create: `.lintstagedrc.json`
- Create: `.husky/pre-commit`
- Modify as formatted: `src/**/*.ts`, `test/**/*.ts`
- Preserve unstaged: `README.md`, `LICENSE`, `output/`

- [ ] **Step 1: Install the approved exact dependency versions**

Run:

```bash
bun add --dev husky@9.1.7 lint-staged@17.0.5
bun add --dev --exact @biomejs/biome@2.5.6
```

Expected: `package.json` and `bun.lock` contain all three packages; Prettier is
absent.

- [ ] **Step 2: Initialize Husky**

Run:

```bash
bunx husky init
```

Expected: `package.json` contains `"prepare": "husky"` and
`.husky/pre-commit` exists.

- [ ] **Step 3: Configure package scripts**

Keep the existing `test` and `typecheck` scripts. Set the relevant scripts to:

```json
{
  "prepare": "husky",
  "format": "biome check --write .",
  "lint": "biome ci .",
  "check": "bun run lint && bun run typecheck && bun run test"
}
```

Do not remove or stage the existing unstaged `"license": "Apache-2.0"` hunk.

- [ ] **Step 4: Create `biome.json`**

Use this exact configuration:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.6/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true,
    "defaultBranch": "main"
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 80
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always",
      "trailingCommas": "all"
    }
  },
  "assist": {
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  }
}
```

- [ ] **Step 5: Create `.lintstagedrc.json`**

Use this exact configuration:

```json
{
  "*.{js,jsx,ts,tsx,json,jsonc,css,graphql}": "biome check --write --no-errors-on-unmatched"
}
```

- [ ] **Step 6: Replace `.husky/pre-commit`**

The complete executable file must be:

```sh
bunx lint-staged
bun run typecheck
bun run test
```

Run:

```bash
chmod +x .husky/pre-commit
```

- [ ] **Step 7: Establish a clean Biome baseline**

Run:

```bash
bunx biome check --write .
bunx biome ci .
```

Expected: the first command applies safe formatting, lint, and import fixes to
supported project files; the second exits successfully. Fix any remaining
recommended-rule errors with the smallest behavior-preserving edits.

- [ ] **Step 8: Verify the complete project check**

Run:

```bash
bun run check
```

Expected: Biome CI, TypeScript, and 146 existing tests pass; the real-Codex
integration test remains skipped.

### Task 3: Prove partial staging and commit the tooling

**Files:**
- Stage: `.husky/pre-commit`
- Stage: `.lintstagedrc.json`
- Stage: `biome.json`
- Stage: `bun.lock`
- Partially stage: `package.json`
- Stage if Biome changed them: `src/**/*.ts`, `test/**/*.ts`
- Do not stage: `README.md`, `LICENSE`, `output/`

- [ ] **Step 1: Stage all unambiguous tooling paths**

Run:

```bash
git add .husky/pre-commit .lintstagedrc.json biome.json bun.lock src test
git add -p package.json
```

In the interactive package staging, stage the Husky/Biome scripts and
devDependencies, and decline the standalone `"license": "Apache-2.0"` hunk.
Split the hunk with `s` if Git groups it with tooling changes.

- [ ] **Step 2: Verify protected changes are outside the index**

Run:

```bash
git diff --cached --name-only
git diff --cached --check
git diff -- README.md package.json
git status --short
```

Expected: the staged name list excludes `README.md`, `LICENSE`, and `output/`.
The unstaged package diff still contains the Apache-2.0 license field.

- [ ] **Step 3: Commit through the new hook**

Run:

```bash
git commit -m "chore: add Biome pre-commit checks"
```

Expected: lint-staged runs Biome, then typecheck and the full test suite pass;
the commit succeeds without absorbing the protected unstaged changes.

- [ ] **Step 4: Verify final state**

Run:

```bash
bun run check
git log -2 --oneline
git status --short
```

Expected: the full check passes; the two new commits are workspace cleanup and
Biome pre-commit tooling; README, LICENSE, the package license hunk, and the
untracked output image remain uncommitted. The controller then removes this
plan's SDD workspace, removes empty `.superpowers/sdd` and `.superpowers`
directories, and verifies `.superpowers/` and `.scratch/` no longer exist.
