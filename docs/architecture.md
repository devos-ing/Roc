# Architecture

GitHub Issues own Roc's task specifications, approvals and execution checkpoints.
`GitHubTaskPool` admits up to two independent Issues. Each `GitHubTaskRunner`
executes Scout, Implement and independent
Review through `AgentHarness`. Pi is the only production backend; the Fake
Harness scripts deterministic tests. Roc does not invoke Codex CLI or Claude
Code CLI.

```text
CLI -> GitHubExecutionStore -> GitHub Issues
             ^
             |
GitHubTaskPool -> GitHubTaskRunner per Issue -> AgentHarness -> PiHarness -> Pi RPC
             |                  -> TaskBranchManager -> native Git worktrees
             -> BunTaskHookRunner -> argv subprocess
             -> GitHubPullRequestPublisher -> PR
             -> GitHubPullRequestMerger (opt-in, serialized) -> confirmed merge
Tests -> FakeHarness / recorded Pi client / fake GitHub transport
```

## Task authority and admission

`task publish-github` validates and publishes a complete manifest as managed
Issues. It reconciles task identities, writes approval comments for exact
envelope hashes, and then adds `roc:ready`. There is no local task import.
Because GitHub's label lists can lag new Issues, a missing identity is checked
against an unfiltered repository REST list before creation. Returned Issue
numbers are read directly against the fixed repository and their envelopes
are verified before approval.
`GitHubExecutionStore.list` validates complete plan identity and dependency DAGs
while isolating malformed Issues. Role boundaries recheck the task envelope,
trusted approval and open Issue state. Closing an Issue retires it unless its
PR merge has been confirmed.

A daemon-owned `roc:execution` comment contains the versioned checkpoint:
Issue/spec identity, revision, pinned base, phase, attempt descriptors, critical
event hashes/cursors, usage, validated outputs, hook receipts and PR identity.
At most two refresh receipts retain expected old head/base, fresh target,
remaining budget and an optional confirmed rewritten head. Review attempts record
their exact head/base target. Successful independent Review persists merge evidence
bound to the approved envelope hash, current task head, reviewed base and Review attempt ID.
Legacy records remain readable but missing evidence never authorizes automatic merge.
Only comments by `ROC_GITHUB_EXECUTOR` are execution records. Multiple owned
records fail closed. `ROC_GITHUB_PUBLISHERS` identifies approval authors.
Both default to the current GitHub login; the daemon must authenticate as its
configured executor.

Each write rereads the current revision and reads back exact content before
advancing. A failed response may follow a successful write, so readback also
runs after write errors. Unknown outcomes raise `GITHUB_CHECKPOINT_UNCONFIRMED`
and retain local ownership. GitHub labels are repairable projections, not locks
or authoritative execution state. There is no distributed compare-and-swap
claim protocol; only one host and daemon may execute the repository.

GitHub reads use complete paginated comment lists. Issue discovery has a
1,000-managed-Issue safety bound and fails visibly rather than treating a
truncated result as a complete plan. Idle polling waits 30 seconds. A read
outage stops the invocation; it cannot advance roles offline.

## Parallel admission

One pool owns an Issue-keyed map of live workers. The default capacity is two;
`--concurrency 1` serializes work and `--once` admits one task. Admission reserves
the Issue before starting its worker and captures existing worker IDs before
each remote read. Those IDs stay excluded for the entire snapshot, even if
their worker finishes while the read is pending. Completion wakes admission to
refill free slots; a completion during a read triggers a fresh read immediately.

Only disjoint literal repository-relative path scopes can overlap. Prefix paths
overlap and comparison ignores case. Ambiguous paths, prose/shared-resource
scopes and hooks are exclusive. This policy uses the approved specification;
it does not discover undeclared shared resources or sandbox tools.

Each worker owns an AbortController, runner and hook runner. Pi's harness retains
separate attempt/session state. Task-local exceptions and cancellation confirm
cleanup then checkpoint attention, leaving siblings running. Closing an Issue,
withdrawing approval or invalidating its plan requests cancellation at the next
remote poll. Unknown remote writes or child cleanup remain daemon-wide failures.

The pool keeps cancellation acknowledgements inside the slot lifetime. Pi saves
terminal child-close promises and confirms them before returning terminal
deliveries; failed close evidence remains available to cancellation and shutdown.
A first dispatch may still be registering its child, so cancellation waits for
that dispatch boundary before asking the harness to abort the attempt. Global
cleanup deadlines still retain ownership if that wait cannot finish.

Inspection reports all running task/attempt pairs. The board marks every running
Issue and derives its progress from its own attempts. Tool output is task-tagged.

## Worktrees and role recovery

Each Issue gets `<canonical-project>.agile-worktrees/issue-<number>` and
`agile/issue-<number>`. Worktrees share the repository's Git directory. Preparing
one task never stages or switches another task's files. Existing worktrees must
belong to that Git repository and match their expected branch and pinned base.

The runner saves an attempt descriptor before starting a role. Confirmed
outputs survive process replacement. Persisted running attempts always reconcile,
including when no first cursor was saved. Pi emits orphan recovery when it
cannot recover a settled output. Retrying is bounded at three attempts per
role; an Implement branch with history but no confirmed result requires
replanning rather than a blind replay.

Critical event IDs and content hashes prevent repeated usage from being counted
twice. Conflicting duplicates and non-monotonic new events fail. Tool activity
goes to the daemon terminal; it is not written to GitHub event by event.
The board and token command read remote checkpoints and mark incomplete usage.

Scout and Review inspect; Implement writes. The harness stages the final
implementation and requires one trusted commit. A separate Pi session reviews
that exact clean commit. Accepted work runs its posthook before publication.
Rejected work retains its branch and outcome for explicit replanning.

## Publication and dependencies

Publication reconciles the same task branch and PR target before creating a PR.
An open PR is `awaiting_merge`. The runner verifies the recorded head, branch
and target, fetches the target and checks its actual merge commit ancestry
before marking `done`. A changed or closed-unmerged publication needs replan.

A dependent task cannot start because its predecessor merely opened a PR.
Immediately before claiming, the runner requires every dependency's confirmed
`done` checkpoint, verifies its merged PR, recorded implementation head and merge
commit, fetches the target, checks merge ancestry, and pins that fresh base.

Manual merge remains the default. `scheduler run --auto-merge` opts into guarded
synchronous squash merge for managed Issues. Only the pool's single admission
selector reconciles merges; concurrent role workers never merge. Before each
request it refreshes exact Review evidence, trusted Issue approval/open state,
PR/repository/head/base identity, draft/mergeability, configured checks, human
review decisions and paginated active branch rules. Classic protection must
require at least one status check, strict up-to-date checks and enforcement for
administrators. Required checks must pass on the exact head, from the configured
app when specified; every additional reported check/status must also succeed.
Unreadable policy, unsupported rules (including merge queues), pending checks
or missing human approvals wait with a stable visible reason, without agent
replay or identical checkpoint writes on each poll.

The merge body contains `merge_method=squash` and the expected head SHA, never
an administrator bypass. GitHub cannot condition this API on the base SHA;
server-enforced strict checks protect that final race. Changed external heads,
closed-unmerged PRs or missing Review evidence require `needs_replan`. Every merge
response, including errors or lost responses, is followed by remote PR readback.
Only fetched target ancestry plus a confirmed `done` write releases dependencies.

When the target advances, the same selector permits at most two durable clean
rebase/re-review cycles. Before Git mutation it checkpoints the expected old
head/base, fresh target and remaining budget, invalidating old merge evidence.
Only a retained, clean Roc-owned worktree containing its single trusted commit
with the expected base as its sole parent can refresh. Git fetches and verifies
the target, checks the actual remote task head, retains the old commit under
`refs/agile-refresh/`, rebases the same patch and pushes only the task ref with
an explicit expected-old-head force-with-lease. Conflicts abort to the original
work; dirty files, unexpected history, external heads or ambiguous pushes are
preserved for replan, never reset or overwritten.

A confirmed result checkpoints the rewritten publication head/base before a new
independent Pi Review starts. Original approved specifications, Implement output,
historical attempts, usage and hook receipts remain unchanged; Git-only rebases
never manufacture Implement attempts. Fresh Review uses the actual routed model
and effort, records its own usage and exact target, and must run the approved
validation commands. Accepted evidence returns to `awaiting_merge` for new-head
CI and the full guarded-merge policy; rejection or exhausted refresh budget needs
replan. A confirmed result can resume only its Review after restart, including
normal bounded infrastructure retries; an intent without a confirmed result
requires explicit reconciliation, never blind Git replay.

Refresh, fresh Review and merge remain selector-owned and serialized, including
across restart recovery. Task cancellation drains its coordinator-owned role;
shutdown also waits for in-flight Git and merge readback as well as workers.
Unsettled cleanup or unknown checkpoint writes retain repository ownership.

## Hooks and process ownership

Hooks need a separate trusted comment for their exact phase/configuration hash.
The runner saves receipts before and after argv-only execution. Known failures
get at most three attempts. Interrupted hooks require explicit reconciliation
because their side effects may already have occurred. Pending terminal posthooks
remain eligible after restart; untrusted or interrupted ones preserve the
task's rejected or failed outcome and record the reason for attention.

Each session acquires `<canonical-project>.agile-checkout.lock` before branch
setup or backend startup. Its owner-verified metadata uses exclusive file
creation and 0600 permissions. An existing guard fails closed. This is
cooperative local ownership for the chosen project checkout; independent clones
and hosts do not share the guard and must not run concurrent daemons.

Signals stop admission. Cancellation/drain has a five-second deadline so in-flight
GitHub checkpoint acknowledgements can finish. Backend close has a 250ms deadline;
retained-owner diagnostics have a 100ms limit. Pending or rejected
backend startup, uncertain cancellation, unresolved close or unknown checkpoint
writes retain the guard. Late completion never unlocks it. The backend factory
has no AbortSignal, so startup can only be cleaned after its promise settles.

A retained guard quarantines further execution. Stop all Roc sessions, inspect
its metadata, confirm backend/hook children have exited, and inspect worktrees
and GitHub state before removing that exact lock. PID absence alone is not
proof of child cleanup. Pi process-close checks cover owned children, not hostile
detached descendants. Worktrees and role instructions are not OS sandboxes.

## CLI and migration

Commander validates public commands. Project discovery stays within the
containing Git checkout. Onboarding installs packaged skills and saves model,
cycle, skill allowlist and execution consent without creating a task database.
Inspection, boards and tokens read GitHub. Diagnostic logs and Pi sessions stay
local. The Fake Harness is internal, not a scheduler CLI backend.

Worker and coordinator failures write safe operational codes with run, Issue,
attempt and phase attribution to `.agile/runtime/agile.log`. GitHub read and
write failures have distinct codes; write failures still require remote readback
before retry. Unknown exception messages and raw CLI output are not logged.
Original errors are recorded before cleanup, and cleanup failures retain their
own task context while preserving execution ownership.

New execution checkpoints retain a phase timeline and each attempt's latest
activity. Activity stays local at full detail; at most one additional GitHub
checkpoint per 30 seconds of tool events refreshes its compact summary. Phase
boundaries and normal receipts also save that summary. The daemon prints
confirmed phase changes and wait reasons once. Inspection and task details
derive elapsed time, attempt time and merge waiting from recorded boundaries,
and mark incomplete usage explicitly. Missing historical timing or an Issue
status that no longer matches its checkpoint yields unavailable timing.

GitHub comment reads run in batches of at most four requests. The reader waits
for all requests in a failed batch and returns no partial snapshot. It preserves
the original order, request count, complete comment history and approval checks.

SQLite production modules, local queue commands and SQL-only tests were removed
after replacement boundaries were exercised. Existing databases and old
checkouts remain on disk. Legacy daemon-owned `roc:status` comments without new
execution records block admission. Finish old work with its prior runtime or
migrate it explicitly; there is no automatic SQLite execution conversion.

M1 provides GitHub execution and separate task worktrees; M2 adds bounded parallel admission.
M3 adds opt-in guarded automatic PR merge with at most two clean base refreshes
and independent re-reviews. [Later milestones](roadmap.md) add measured
performance/visibility and deferred Superset integration.
Deterministic checks are complemented by [live GitHub and sandboxed GPT-6 acceptance](validation/m1-m2-live-2026-09-09.md).
[M3 protected-branch acceptance](validation/m3-live-2026-09-09.md) also verified
two automatic merges with a real base refresh, new Review and fresh CI.
Physical two-host operation remains unverified. See the [current specification](specs/github-native-execution.md)
and [M2 specification](specs/parallel-execution.md), plus
[validation status](../README.details.md#validation-status).

## Pi backend

The Pi backend (`src/agents/pi/`) drives the documented Pi RPC mode
through the pinned `@earendil-works/pi-coding-agent` dependency. Roc launches
its exported `rpc-entry` with Node; `PI_BIN` remains an explicit override for
an operator-managed Pi binary. The transport uses strict JSONL with
one JSON object per line — commands are `{type, id?, ...params}` on stdin,
responses `{id?, type: "response", command, success, data|error}` and
unwrapped events on stdout. The working directory is process-level state in
Pi (there is no per-session workspace parameter), so every role attempt
spawns its own child rooted at the isolated task workspace with deterministic
startup flags (`--no-extensions --no-skills --no-prompt-templates
--no-context-files --no-approve`). Only approved installed skills are added through explicit
`--skill` paths; local discovery and trust selection live in `src/skills/policy.ts`
and do not start Codex. One `prompt` is sent per attempt; `agent_settled` is
the authoritative completion anchor, the last assistant `message_end` before
it is the turn's final answer, and per-message usage is accumulated so
session-level compaction stats never reach attempt totals. Extension UI
requests are the only server-initiated interaction: they are answered with
`cancelled: true`, the prompt is aborted, and the attempt blocks on policy.

**Safety limits (why the backend is gated).** Pi has no built-in sandbox:
tools execute with the full process user permissions, so a role turn can
write anywhere the user can. The task workspace is only the child's working
directory, not a confinement boundary, and the Review status comparison only
sees changes inside the task checkout. Until Pi runs inside a real OS sandbox
or container that exposes only the task checkout, the backend factory refuses
to start unless onboarding saved `execution.allowUnsandboxed: true` in the
user's Roc settings, or an explicit `ROC_ALLOW_UNSANDBOXED=1` override acknowledges
these limits. Project files cannot grant this execution permission.

**Codex onboarding.** `roc-it onboard` uses Pi's public `ModelRuntime` SDK for
OAuth, credential reuse, refresh, and one small connection test. Browser login
is the default. Model catalog refresh uses Pi's bounded network refresh. A new
Codex setup selects `gpt-6-astra`; an explicitly saved Codex model is preserved.
After a verified response, `SettingsManager` saves the Codex
provider/model and high reasoning in Pi's user settings. Roc stores the selected
cycle, skills, and execution consent separately. A failed or cancelled login
never reports completion or saves new Roc settings. Pi project configuration
is disabled during setup and RPC execution. Authentication does not launch
Codex CLI, and Roc does not copy its credentials. `src/agents/pi/sdk.ts` loads
only the model/settings modules of the pinned Pi version. The SDK barrel also
loads a native clipboard addon that stalls Bun/macOS shutdown; revisit these
internal module paths when upgrading Pi.

**Model attribution.** A short-lived probe process answers
`get_available_models` and `get_state`; the probe's effective default model
fills profiles omitted from the user's optional `models.luna`, `models.terra`,
and `models.sol` settings. Explicit mappings must exist in the catalog and
support `high`, or startup fails with `PI_MODEL_MAPPING_INVALID`. Onboarding
preserves these mappings. Catalog ids are `provider/modelId` pairs, and each
attempt re-asserts its routed pair with
`set_model` plus `set_thinking_level` (Roc efforts map one-to-one onto Pi
thinking levels). A probe with no resolvable default model fails startup
with `PI_MODEL_UNRESOLVED` instead of running an unobservable default. The
resolved default must advertise `high` reasoning; otherwise startup fails with
`PI_MODEL_UNSUPPORTED` rather than selecting a different model or provider.

Low- and medium-risk tasks start Scout on Luna, Implement on Terra, and Review
on Sol. High-risk roles use only Sol with `xhigh`; unsupported
effort routes the task to `needs_replan`. The operator chooses which actual
model each profile represents. Existing attempt descriptors remain authoritative
during recovery; new attempts use the mappings loaded at scheduler startup.

Pi Scout capsules use the existing structured output schema without a separate
byte limit or truncation. Usage delivery and historical role-input recovery
follow the shared harness flow. Prompts request concise source references,
tests, and risks, with current-source inspection by later roles.

**Recovery.** The Pi session file is an append-only entry tree on disk, and
the backend cursor persists `{sessionId, sessionFile, entryAnchor}`, where
the anchor is the `get_entries` leaf id captured when a turn settles. v1 has
no reattach path: the child process dies with the scheduler run, so
reconciliation replays from the last committed cursor, completes attempts
whose `outputDelivered` marker persisted, and retries in-flight turns from
their tickets. The anchors exist so a future resume can continue a session
via `get_entries since=entryAnchor`.
