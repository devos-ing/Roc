# OpenAmp M0 component acceptance

Date: 2026-09-15. Implementation under verification: `9007e55`.

## Scope

The missing check connected the main session's registered coding and checklist
tools to Oracle supervision and Pi result insertion. The integration uses actual
Pi services, tools, extension registration, session storage, ChangeStore, and
Git worktrees. It controls the Oracle RPC response and captures the next model
request boundary. It does not launch the CLI, run a model-driven coding task,
publish a PR, or test the complete application from end to end.

The controlled route is `openamp-fixture/oracle` with reported high effort.
It is not evidence for a commercial provider's model quality or availability.
Earlier [live Oracle evidence](2026-09-15-openamp-oracle-tool.md) separately
records a real Astra/high consultation. Earlier [native UI evidence](2026-09-15-openamp-progress.md)
records restoration and checklist expansion in a terminal.

## Observed behavior

1. The main session's registered `update_plan` tool saves the current step.
2. `ask_oracle` starts one read-only child. Its initial wait and a subsequent
   `agent_wait` expire without stopping the child or creating another run.
3. The supervisor inserts the saved advice into the actual Pi session once,
   including its result ID and the statement that advice does not approve publication.
4. Receiving advice leaves the checklist step in progress. An explicit update
   marks it complete and retains the advice's result ID as an evidence note.
5. Pi's registered `edit` and `read` tools change and read a file in the feature
   worktree. The source checkout's file remains unchanged.
6. The completed checklist reaches revision 3 and appears in the native widget.
   The next-turn context contains the saved advice reference. Review and
   publication records remain empty.

The parent message uses real Pi insertion with `triggerTurn` suppressed at the
captured dispatch boundary. The check does not prove that a live main model
will read the advice or choose the next tool correctly.

## Verification

```bash
bun test test/integration/openamp-progress.test.ts
bun run typecheck
bunx --no-install biome check test/integration/openamp-progress.test.ts
```

Both component integrations in the file passed with 46 assertions. Typecheck and
focused Biome passed. No production code changed, so the prior build evidence
still applies. No unit or end-to-end suite ran.

Diff inspection confirmed that the only implementation change is the additional
component check and its optional controlled supervisor setup. Initial check
failures came from fixture typing and using the legacy edit argument shape.
The final check uses Pi 0.82.1's `edits` array and passes.

## Milestone status

M0's component wiring now has focused acceptance evidence. A model-driven
interactive coding session remains unverified by this check. Repository policy
prohibits AI agents from running an end-to-end test, so this report does not
claim one or turn that missing result into a component-test claim.

The next implementation focus is M1: verify that opt-in ObservationPack can
archive and recall source content while the current checklist survives session
recovery. Measure context savings only after observing archive and recall.
