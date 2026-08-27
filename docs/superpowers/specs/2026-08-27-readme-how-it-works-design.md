# README “How it works” design

## Goal

Make Roc’s agile mechanism easy to understand without using one large diagram
to explain every part of the system.

## Scope

Update only the README’s “How it works” section. The release process stays in
the separate “Releases” section and does not appear in this diagram.

## Content design

Use one small Mermaid diagram for the task loop:

```text
Ready backlog → Scout → Implement → Review
                                  ├─ Accepted → Done
                                  └─ Changes needed → Follow-up task → Ready backlog
```

Follow the diagram with three short descriptions:

- **Scout:** understands the task, checks the code, and prepares a plan.
- **Implement:** writes the code in a separate work folder and creates a commit.
- **Review:** independently checks that exact commit, then accepts it or creates
  a follow-up task.

End with a short explanation of the agile behavior: Roc moves one small task at
a time, sends feedback back to the backlog, and saves progress so work can
continue after a restart.

## Constraints

- Use plain English and short sentences.
- Keep Scout → Implement → Review visually central.
- Do not add release, token-ledger, model-routing, or command details to the
  diagram.
- Keep the existing README structure and Mermaid support.

## Verification

- Confirm the README contract still passes.
- Add focused assertions only if they protect the simplified agile explanation.
- Run the full project check before delivery.
