# README milestone checklists design

## Goal

Make Roc’s roadmap easier to scan and show clearly which agent backend works
today versus which backends are planned.

## Structure

Keep one `## Milestones` section after `## How it works`. Split it into two
checklists:

- `### Product` for planned product capabilities;
- `### Agent support` for current and planned agent backends.

Remove the separate “Supported agent: OpenAI Codex only” sentence near the
README introduction because the agent checklist becomes the single source of
support status.

## Product checklist

All product items remain unchecked because they are planned, not available:

- [ ] **GitHub Issues backlog** — Bring approved GitHub Issues into Roc’s ready
  backlog.
- [ ] **Visible task board** — See task progress in a terminal UI.
- [ ] **Parallel task runs** — Run independent tasks at the same time.
- [ ] **Remote approvals** — Review and approve waiting work remotely.
- [ ] **Notifications** — Get updates when work finishes, fails, or needs
  approval.

## Agent support checklist

Codex is checked because it is available today. Other agents are unchecked and
described as planned:

- [x] **OpenAI Codex** — Available today.
- [ ] **Pi agents** — Run Roc tasks with Pi.
- [ ] **Claude Code** — Run Roc tasks with Claude Code.
- [ ] **Cursor** — Run Roc tasks with Cursor agents.

## Constraints

- Use GitHub-flavored Markdown task-list syntax.
- Do not imply that Pi, Claude Code, or Cursor support already exists.
- Keep current Quick Start and Codex commands unchanged.
- Do not add dates, target versions, or implementation details.
- Use short, simple descriptions.

## Verification

- Confirm there is exactly one checked item: OpenAI Codex.
- Confirm all five product milestones and three planned agent backends are
  unchecked.
- Confirm the older Codex-only sentence is removed.
- Run the existing README-focused test and the full project check.
