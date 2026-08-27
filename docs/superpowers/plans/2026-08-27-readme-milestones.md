# README Milestones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a simple, ordered README roadmap for Roc’s five planned product milestones.

**Architecture:** Keep roadmap content in one `## Milestones` section between “How it works” and “Commands.” Remove the older generic roadmap sentence so current capabilities, current limitations, and future plans each have one clear place.

**Tech Stack:** Markdown, Bun test

---

## File structure

- Modify `README.md`: remove the duplicate roadmap sentence and add the ordered milestones section.

### Task 1: Add the ordered Roc milestones

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Confirm the milestone section is not already present**

Run:

```bash
rtk rg -n '^## Milestones$' README.md
```

Expected: no match and exit code 1.

- [ ] **Step 2: Remove the older duplicate roadmap sentence**

Delete this paragraph from the introduction:

```markdown
Ticket import, weekly planning, and an interactive screen are planned but are
not available yet.
```

- [ ] **Step 3: Add the milestone section**

Insert this exact block after the final “How it works” paragraph and before
`## Commands`:

```markdown
## Milestones

Roc is growing in small steps. These features are planned:

1. **GitHub Issues backlog** — Bring approved GitHub Issues into Roc's ready
   backlog and keep their status linked.
2. **Visible task board** — Use a terminal UI to see queued, active, blocked,
   reviewing, and completed tasks.
3. **Parallel task runs** — Run independent tasks at the same time in separate
   work folders.
4. **Remote approvals** — Review and approve waiting work without staying at
   the local terminal.
5. **Notifications** — Get an update when work finishes, fails, or needs
   approval.
```

- [ ] **Step 4: Verify the section content, order, and old-text removal**

Run:

```bash
rtk zsh -lc 'set -euo pipefail
readme=$(cat README.md)
milestones=$(printf "%s" "$readme" | sed -n "/^## Milestones$/,/^## Commands$/p")
test -n "$milestones"
test "$(printf "%s" "$milestones" | grep -c "^[1-5]\. \*\*")" -eq 5
github_line=$(printf "%s" "$milestones" | grep -n "GitHub Issues backlog" | cut -d: -f1)
board_line=$(printf "%s" "$milestones" | grep -n "Visible task board" | cut -d: -f1)
parallel_line=$(printf "%s" "$milestones" | grep -n "Parallel task runs" | cut -d: -f1)
approval_line=$(printf "%s" "$milestones" | grep -n "Remote approvals" | cut -d: -f1)
notification_line=$(printf "%s" "$milestones" | grep -n "Notifications" | cut -d: -f1)
test "$github_line" -lt "$board_line"
test "$board_line" -lt "$parallel_line"
test "$parallel_line" -lt "$approval_line"
test "$approval_line" -lt "$notification_line"
! printf "%s" "$readme" | grep -q "Ticket import, weekly planning"'
```

Expected: exit code 0 with no output.

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
rtk env HUSKY=0 git commit -m "docs: add Roc product milestones"
```

Expected: one commit containing only the README milestone update.
