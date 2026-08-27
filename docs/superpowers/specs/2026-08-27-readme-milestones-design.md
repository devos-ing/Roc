# README milestones design

## Goal

Show Roc’s planned product direction in a short, ordered roadmap that is easy
to scan and does not promise release dates.

## Placement

Add a `## Milestones` section after `## How it works` and before
`## Commands`. Remove the older generic sentence about ticket import, weekly
planning, and an interactive screen so the README has one clear roadmap.

## Content

Introduce the section with:

> Roc is growing in small steps. These features are planned:

List these milestones in order:

1. **GitHub Issues backlog** — Bring approved GitHub Issues into Roc’s ready
   backlog and keep their status linked.
2. **Visible task board** — Use a terminal UI to see queued, active, blocked,
   reviewing, and completed tasks.
3. **Parallel task runs** — Run independent tasks at the same time in separate
   work folders.
4. **Remote approvals** — Review and approve waiting work without staying at
   the local terminal.
5. **Notifications** — Get an update when work finishes, fails, or needs
   approval.

## Constraints

- Use plain English and short descriptions.
- Keep the five milestones in the approved order.
- Present every item as planned, not available today.
- Do not add dates, version numbers, implementation details, or new product
  commitments.
- Keep current limitations accurate: Roc still runs one task at a time today.

## Verification

- Read the finished section in context to confirm it does not contradict the
  current feature and limitation lists.
- Run the existing README-focused test and the full project check.
