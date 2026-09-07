# Cross-machine task delivery

Status: approved direction and autonomous implementation authorized by the user on 2026-09-06. This spec translates the reviewed plan at `.scratch/deliver-code/remote-task-workflow/plan.md` into acceptance requirements. GitHub Issues are shared tasks; one Roc daemon in a dedicated execution clone polls them. Pi is the sole public execution backend, using provider models directly. Existing local commands remain supported; native Codex and ZCode adapters are unregistered.

## Scope and authority

Machine A publishes approved tasks after chat/grilling. Machine B has its own clone, database, checkout, CLI installations and credentials. A may go offline after publication. B runs Scout → Implement → independent Review → PR and writes results back to the originating Issue. Shared SQLite files, concurrent daemons, automatic merge, automatic failover, and new model adapters are excluded.

The user authorized local implementation, tests, and diagrams without intermediate approvals. The initial implementation phase did not publish project Issues, commit/push changes, or start paid model jobs. Local deterministic GitHub fixtures prove orchestration; real provider/two-machine checks must remain explicitly unverified unless they are actually performed with an authorized test setup.

Validation update, 2026-09-06: the user requested starting on the same machine. Use separate publisher and execution clones and databases, one Roc daemon, a private disposable GitHub fixture, and Pi with a configured Codex provider model for the first live exercise. This supersedes the earlier native Codex CLI trial. Fixture commits, Issues and PRs are test artifacts; implementation changes remain uncommitted. Do not share an executable backlog or resolve a nested execution checkout to an outer project's `.agile` directory. Record this separately from Pi provider checks and the later physical two-machine check.

## Requirement IDs

### remote-publication

Add `roc-it task publish-github FILE` for the existing strict BacklogManifest. Explicit invocation is publication authorization. Update `skills/roc-create-tasks/SKILL.md` with an explicit remote mode that requests approval of the complete task set before invoking this command, so A's chat/grilling flow actually reaches remote publication. Retain the existing local import path. Verify the remote skill instruction names the new command and does not also import the tasks into A's executable backlog.

Each Issue includes a readable rendering and a versioned JSON envelope containing `planId`, `cycleId`, `goal` and the complete original task. Derive a stable plan identity deterministically from the approved manifest or persist it in the publication record. Preserve original task IDs, priority, dependencies, risk, acceptance criteria, validation, budget, and optional fields. Repository + planId + task.id identifies the remote task; collisions with existing local IDs must fail visibly rather than overwrite unrelated work.

Use existing `gh` subprocess patterns with an explicit repository/cwd, argv-only invocation, bounded commands and safe body-file/stdin handling. No new SDK or generic tracker framework. Mark managed Issues with a durable label such as `roc:task`; create all Issue bodies and dependency links before admitting tasks with `roc:ready`. Approval is a separate trusted-author comment tied to the canonical envelope hash. The daemon uses an explicit trusted publisher allowlist, e.g. `ROC_GITHUB_PUBLISHERS`, and never treats Issue prose or a ready label alone as execution authorization.

Repeated invocation reconciles the stable identity with existing open/closed Issues. Conflicting duplicate identities halt the affected publication. If a create request times out, read back before retrying; if its outcome remains ambiguous, return a recoverable error without blindly creating another Issue. Partially published plans can be resumed. Do not automatically import the remote backlog into A's executable local queue.

### remote-admission

Add `--source github` to the existing scheduler command, preserving local behavior when omitted. One daemon owns one project database under the existing lease. SQLite lease and Issue labels do not provide distributed mutual exclusion; operating two daemons for one repository is unsupported.

Poll GitHub about every 30 seconds and back off boundedly on network failures. Track managed active/completed Issues independently of the ready label. GitHub I/O must not run within SQLite transactions or prevent lease heartbeats. Validate the strict envelope, trusted approval author/hash, open/ready eligibility, task identity and the complete dependency graph before admitting ready work. Preserve the source cycle. Malformed, incomplete, cyclic or conflicting plans must not block other valid plans.

Freeze the approved payload locally. At later execution boundaries, verify its approval and payload remain valid without requiring a running Issue to retain ready. A changed payload or withdrawn approval moves unfinished work to needs_replan before the next role/publication; an active role may finish and retain results. Network inability to verify pauses further advancement, not successful local result persistence. Existing terminal results must not be erased or rerun.

Remote hook approval never grants local hook trust; use existing hash trust. Unavailable machine-local session/context references must result in needs_input rather than fabricated cross-machine context. Never silently substitute another task/model/workspace.

### remote-writeback

Persist local outcomes before remote side effects. Reuse existing task events/publication receipts plus only necessary synchronization metadata. Project current state onto the Issue using Roc-owned status labels and one stable, identifiable status comment. Preserve human comments, unrelated labels and the spec body.

Map draft→roc:draft, ready→roc:ready, active phases→roc:running, done→roc:done, needs_input/needs_replan→roc:attention, rejected/failed_infra→roc:failed, retired→roc:retired. Include the actual phase/outcome, task identity, last update time, blocker/failure summary, and PR/follow-up link when present. Sanitize operational diagnostics before publication just as for existing AgileError logging.

Status synchronization failure retries synchronization only. Restart or lost acknowledgements must not rerun completed agents, duplicate PRs, duplicate status comments, or replay stale progress over newer outcomes. Keep pending work durable. A halted/offline daemon may leave a timestamped running status; this is not permission for another daemon to take over.

### remote-followup

When Review rejects a task, retain its existing terminal rejected state and the single existing draft follow-up. Publish that child once as an unapproved remote draft with a link to its source; approval cannot be auto-granted. On an approved follow-up, Pi Implement must honor the retained sourceCommit through the existing approved-source restoration helper. The user returns to chat/grilling before publishing an approved replacement/follow-up. Preserve retirement/replacement history and recover partial publication without generating additional children. Existing retirement policy requires a replanned dependent spec to name its approved replacement; do not silently rewrite frozen dependencies.

### remote-dependencies

`done` retains its existing meaning: reviewed implementation with a published PR, possibly still open. Show "execution complete, awaiting merge" on the Issue; do not merge or close Issues merely because publication succeeded.

For remote tasks, done alone does not release a code dependency. All dependency PRs must be merged into the configured target branch, and the next task's fetched base must contain the confirmed merge results. Closed-unmerged or retired-unreplaced prerequisites require replanning. Support same repository and target branch only. Validate missing/cyclic dependencies before execution.

Fetch current target state for each new task, persist its full baseCommit and pass it through the existing TaskBranchManager. Recovery of an already started task reuses its pinned base. Handle squash merges using the actual GitHub merge result, not by requiring the original implementation SHA to be an ancestor. Retain the sole trusted implementation commit and exact-commit Review invariants.

### pi-provider-validation

Default to `--backend pi` and reject other public backend names. Reuse its RPC client, harness, model catalog and conformance tests. Each daemon session uses one explicitly resolved provider/model. Existing luna/terra/sol profiles currently map to that single default model. No automatic cross-provider fallback, per-ticket runtime switching, or per-role model routing is added.

Validate declared reasoning capabilities instead of guessing. The selected Pi default must support `high`; a model lacking it fails clearly without silently switching models. Persist accurate provider/model attribution and usage. Credentials remain on B. Pi lacks a built-in filesystem sandbox; require the explicit `ROC_ALLOW_UNSANDBOXED=1` acknowledgement and require documented OS/container confinement for unattended deployment. Do not present a working directory as a sandbox. Preserve independent Review and existing controlled restart/retry semantics.

### remote-operations

Document A/B setup with Roc, Bun, Pi and its Node.js requirement, Git, gh, project build tools, trusted publishers and credentials. Explain that only B runs the daemon. Give foreground startup and launchd/systemd service examples with a stable cwd/database location. Do not add a service manager. Retain local mode compatibility and document how to stop the old daemon before transferring its state.

### remote-verification

Use the existing Fake Harness and injected command runners. One vertical test should represent A and B with separate local state and a shared fake GitHub service, exercising publication → polling → roles → PR → result writeback. Include dependency merge/base propagation and the smallest boundary tests for ambiguous publication, invalid/revoked approval, network/restart recovery and one unapproved follow-up. Preserve existing lease, event deduplication, checkout, exact-commit review and publication tests. Run lint, typecheck and appropriate tests after implementation.

Real Pi Codex, Claude and GLM three-role runs and a two-machine exercise are required release evidence. Record them separately from deterministic checks; missing credentials/machines are an unverified release gate, not a passing test. No exhaustive provider/protocol/notification matrix or coverage target.

Run the same-host live exercise first: A publishes one small approved task; only B runs the daemon and completes the roles, PR and original-Issue writeback. Retain both database snapshots, actual model attribution, the implementation SHA, Issue and PR URLs, and shutdown evidence. A must have no executable task imported. Same-host success does not establish physical-host or credential isolation.

## Ticket dependencies and test seams

| Ticket | Requirements | Depends on | Public verification seam |
| --- | --- | --- | --- |
| REMOTE-01 | remote-publication | none | task publish-github + injected gh runner |
| REMOTE-02 | remote-admission | REMOTE-01 | scheduler --source github + isolated database |
| REMOTE-03 | remote-writeback, remote-followup | REMOTE-02 | scheduler completion/restart + fake Issue service |
| REMOTE-04 | remote-dependencies | REMOTE-03 | dependency PR receipt + real local Git checkout |
| REMOTE-05 | pi-provider-validation, remote-operations, remote-verification | REMOTE-04 | Pi conformance, two-machine recipe, project checks |

Review against commit `061c48902501a2967887c462713ea1f619906589`. Standards sources are AGENTS.md and CONTRIBUTING.md; this file is the behavior source. The scratch traceability graph and state record point here. docs/architecture.md must describe only implemented behavior.
