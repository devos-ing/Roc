# README Agent Milestones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change Roc’s README milestones into grouped checklists that show current Codex support and planned Pi, Claude Code, and Cursor support.

**Architecture:** Keep one `## Milestones` section and split it into `### Product` and `### Agent support`. Use GitHub task-list markers as the status source: Codex is checked, while five product items and three planned agent backends are unchecked.

**Tech Stack:** Markdown, Bun test

---

## File structure

- Modify `README.md`: remove the duplicate Codex-only sentence and replace the numbered milestone list with two task lists.

### Task 1: Show product and agent milestones as checklists

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Confirm the current README state**

Run:

```bash
rtk zsh -lc 'set -euo pipefail
grep -q "Supported agent:.*OpenAI Codex.*only" README.md
grep -q "^1\. \*\*GitHub Issues backlog\*\*" README.md
! grep -q "^### Agent support$" README.md'
```

Expected: exit code 0, proving the old sentence and numbered list are present and the grouped agent checklist is not.

- [ ] **Step 2: Remove the duplicate supported-agent sentence**

Delete this line from the introduction:

```markdown
**Supported agent:** [OpenAI Codex](https://github.com/openai/codex) only.
```

- [ ] **Step 3: Replace the milestone content**

Replace the content below `## Milestones` and above `## Commands` with this
exact block:

```markdown
Roc is growing in small steps.

### Product

- [ ] **GitHub Issues backlog** — Bring approved GitHub Issues into Roc's ready
  backlog.
- [ ] **Visible task board** — See task progress in a terminal UI.
- [ ] **Parallel task runs** — Run independent tasks at the same time.
- [ ] **Remote approvals** — Review and approve waiting work remotely.
- [ ] **Notifications** — Get updates when work finishes, fails, or needs
  approval.

### Agent support

- [x] **OpenAI Codex** — Available today.
- [ ] **Pi agents** — Run Roc tasks with Pi.
- [ ] **Claude Code** — Run Roc tasks with Claude Code.
- [ ] **Cursor** — Run Roc tasks with Cursor agents.
```

- [ ] **Step 4: Verify checklist status and content**

Run:

```bash
rtk zsh -lc 'set -euo pipefail
milestones=$(sed -n "/^## Milestones$/,/^## Commands$/p" README.md)
test "$(printf "%s" "$milestones" | grep -c "^- \[x\]")" -eq 1
test "$(printf "%s" "$milestones" | grep -c "^- \[ \]")" -eq 8
printf "%s" "$milestones" | grep -q "^- \[x\] \*\*OpenAI Codex\*\*"
printf "%s" "$milestones" | grep -q "^- \[ \] \*\*Pi agents\*\*"
printf "%s" "$milestones" | grep -q "^- \[ \] \*\*Claude Code\*\*"
printf "%s" "$milestones" | grep -q "^- \[ \] \*\*Cursor\*\*"
! grep -q "Supported agent:.*OpenAI Codex.*only" README.md'
```

Expected: exit code 0 with exactly one checked and eight unchecked milestones.

- [ ] **Step 5: Run the existing README-focused tests**

Run:

```bash
rtk bun test test/release-workflow.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 6: Run the full project check**

Run:

```bash
rtk bun run check
```

Expected: lint, typecheck, and tests pass; the existing intentional detached Review test may remain skipped.

- [ ] **Step 7: Commit the README update**

Run:

```bash
rtk git add README.md
rtk env HUSKY=0 git commit -m "docs: show planned agent support"
```

Expected: one commit containing only the README checklist change.
