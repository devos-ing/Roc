# Checkout handoff safety implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute and independently review each task.

**Goal:** Close the Effect integration's P1 checkout handoff gap before user review.

**Architecture:** An exclusive persistent checkout guard wraps the real-backend session. Clean teardown releases it; incomplete teardown leaves it in place. Client close reports unconfirmed process exit instead of silently succeeding.

**Tech Stack:** Existing Bun, TypeScript, Effect 3.22.1, node:fs/promises and SQLite. No new dependencies.

**Spec:** `docs/design/checkout-handoff-safety.md`

## Global constraints

- Work only in `/Users/roy/Documents/ChatGPT/agile-agents/.worktrees/effect-session-lifecycle`, branch `codex/effect-session-lifecycle`, starting at `6d6911b`.
- User has delegated local design/implementation approvals until user review. No merge, push, PR publication or real external agent execution.
- Preserve 250ms daemon drain, 250ms backend-close wait, 100ms diagnostic wait, 3s heartbeat, 10s SQLite lease and SQLite fencing.
- Guard path is `${canonicalRepo}.agile-checkout.lock`, exclusive 0600 file, acquired before checkout preparation. It has no expiry or automatic stale recovery.
- All backend sessions, including different DB paths for the same repository, share this guard. Pure Fake runtime has no dedicated-checkout guard.
- Uncertain cleanup retains the guard permanently for operator recovery; late completion never releases it.
- No schema, model-routing, durable retry, provider gate, sandbox or protocol changes. Preserve original error identity and sanitized diagnostics.
- All commands use rtk; edits use apply_patch. Named production functions have behavioral JSDoc. No nested subagents or unrelated fixes.
- Honor pre-commit hooks with `AGILE_REAL_CODEX=0`; do not bypass them. Existing lint baseline is 30 warnings and 9 infos.

## Task 1: Exclusive checkout ownership file

**Files:** create `src/workspace/checkout-ownership.ts`, `test/workspace/checkout-ownership.test.ts`; include this plan and its spec in the same local commit.

**Produces:**

```ts
export type CheckoutOwnership = {
  repoPath: string;
  lockPath: string;
  release(): Promise<void>;
};
export async function acquireCheckoutOwnership(
  repoPath: string,
  runId: string,
): Promise<CheckoutOwnership>;
```

- [ ] Write focused failing tests first. The canonical-path test shape is:

```ts
const root = await mkdtemp(join(tmpdir(), "roc-checkout-owner-"));
const repo = join(root, "repo");
const alias = join(root, "alias");
await mkdir(repo);
await symlink(repo, alias);
const owner = await acquireCheckoutOwnership(repo, "owner-a");
await expect(acquireCheckoutOwnership(alias, "owner-b")).rejects.toMatchObject({
  code: "SCHEDULER_CHECKOUT_IN_USE",
});
await owner.release();
const next = await acquireCheckoutOwnership(alias, "owner-b");
await next.release();
```

  Add the minimum independent cases for an existing stale/malformed lock, a
  symlink at the lock path without touching its target, and a replaced owner
  file that the old release must not delete. Use test-owned temporary roots and
  finally cleanup. A separate controlled Bun process must prove exclusion does
  not rely on an in-memory map and its exit does not automatically steal a lock.
- [ ] Run `rtk bun test test/workspace/checkout-ownership.test.ts` and record actual RED.
- [ ] Implement atomic `open(lockPath, "wx", 0o600)`, immutable owner metadata
  (including the owning process PID), realpath canonicalization and
  owner-checked unlink. Existing paths fail with
  `SCHEDULER_CHECKOUT_IN_USE`, category startup, retryable false, component
  workspace, supplied runId, fixed message. Release verification failures use
  `SCHEDULER_CHECKOUT_OWNERSHIP_LOST`, category infra, retryable false,
  component workspace, supplied runId and a fixed message. Do not inspect or
  expose arbitrary existing lock contents in error text. Creation/release errors
  must not delete another file. Always close handles, including failed writes;
  partial creation may safely retain a guard. `release` is idempotent for its
  own completed release and shares one retained release attempt across concurrent
  calls, including a settled failure.
- [ ] Run focused tests, typecheck, changed-file Biome and diff check; self-review.
- [ ] Commit only the new module/test and spec/plan with the normal hook. Write
  `task-1-report.md` under this plan's SDD directory, with RED/GREEN evidence.

## Task 2: Carry checkout ownership through bounded cleanup

**Files:** modify `src/cli/runtime.ts`, `src/cli/session-lifecycle.ts`,
`src/scheduler/daemon.ts`, `src/agents/codex/client.ts`,
`src/agents/pi/client.ts`, `src/agents/zcode/client.ts`,
`src/agents/pi/backend.ts`, `src/agents/types.ts` documentation only;
tests `test/cli/backend-session.test.ts`, `test/cli/session-lifecycle.test.ts`,
`test/scheduler/daemon.test.ts`, focused existing client/backend tests as needed,
and a narrowly scoped controlled-child fixture in `test/fixtures/`;
docs `docs/architecture.md`, `docs/superpowers/plans/2026-09-04-effect-session-integration.md`
and this plan's execution receipt.

**Consumes:** `acquireCheckoutOwnership(repoPath, runId)` from Task 1.
**Produces:** same public CLI, BackendFactory and BackendRuntime signatures;
optional internal lifecycle notifications:

```ts
// Daemon runEffect input gains:
onDrainTimeout?: () => void;
// closeBackendEffect gains an optional fifth argument:
onIncomplete?: () => void;
```

Callbacks run synchronously when uncertainty is known, before any logging or
other await. They never throw in production callers. Existing callers/tests
remain valid. The backend close helper still preserves primary errors.

- [ ] Add regression tests against current behavior before production edits.
  Reuse `createRepository`, `seedReadyTask`, `fakeBackend`, `sessionInput` and
  `compatibleCatalog` in backend-session tests. A normal clean restart asserts:

```ts
const first = fakeBackend(compatibleCatalog);
const running = runBackendSession(first.factory, sessionInput(root, dbPath), "first");
await first.firstStep;
process.emit("SIGINT");
await running;
await expect(Bun.file(`${root}.agile-checkout.lock`).exists()).resolves.toBe(false);
const second = fakeBackend(compatibleCatalog);
const restarted = runBackendSession(second.factory, sessionInput(root, dbPath), "second");
await second.firstStep;
process.emit("SIGINT");
await restarted;
```

  Extend existing stuck cancellation/late delivery test to assert retained lock
  and rejected successor before factory invocation, also with a different DB
  path. Prove failed factory startup retains the lock and startup failure before
  factory invocation can release it. Close failure and timeout must retain even
  if logger fails and even after late successful close. Focused helper tests
  verify `onIncomplete` only fires on failure/timeout; daemon tests distinguish
  idle stop from genuinely stuck work and retain grace error precedence.
- [ ] Implement outer ownership acquisition before branch setup. Finalizer
  release runs last. Use local monotonic uncertainty state, not a registry:

```ts
let backendStarted = false;
let backendClosed = false;
let incompleteWork = false;
/** Retains ownership because old work can still mutate the checkout. */
const retainCheckout = (): void => { incompleteWork = true; };
// Immediately before startBackend: backendStarted = true.
// Successful close inside deadline: backendClosed = true.
// onIncomplete, onDrainTimeout and either cancellation rejection: retainCheckout().
// Release only if !incompleteWork && (!backendStarted || backendClosed).
```

  Adapt helper result or a success callback only if needed to distinguish a
  timed-out close from success without inspecting the underlying Promise later.
  Record any changed internal signature in the report. Retention diagnostics use
  fixed `SCHEDULER_CHECKOUT_RETAINED` fields and bounded `reportCleanup`.
- [ ] Wake idle Effect sleep on stop while leaving active ticks intact for grace.
  Use existing Effect mechanisms, no native shutdown timer. At drain timeout
  invoke the uncertainty callback before sealing/interruption. Maintain the
  existing captured worker Exit and primary-error precedence.
- [ ] In all three clients, make `waitForExit` rejection return false, and throw
  a sanitized provider-specific `*_PROCESS_EXIT_UNCONFIRMED` AgileError if the
  final wait after SIGKILL has not confirmed exit. Keep existing timing and
  force-kill policy. Do not equate bounded I/O waiting with a new process-tree
  security guarantee. Pi tracks failed client closes and propagates any cleanup
  rejection after attempting all clients and the probe. Never clear failure
  evidence solely because close was attempted. Add focused boundary tests for
  that failure behavior, not protocol matrices.
- [ ] Add one actual CodexClient controlled-child regression. Reuse the scripted
  app-server initializer or a small dedicated fixture. It ignores graceful EOF,
  acknowledges a request that arms a late write inside its test-owned checkout,
  and remains alive until its existing close path kills it. Use a fake scheduler
  harness for task steps; no Codex executable/model request. Observe session
  return and child late write with latches/fixture signals, then assert:

```ts
let successorStarted = false;
const successor: BackendFactory = async (context) => {
  successorStarted = true;
  return fakeBackend(compatibleCatalog).factory(context);
};
await expect(runBackendSession(successor, sessionInput(root, anotherDb), "next"))
  .rejects.toMatchObject({ code: "SCHEDULER_CHECKOUT_IN_USE" });
expect(successorStarted).toBe(false);
expect(await Bun.file(`${root}.agile-checkout.lock`).exists()).toBe(true);
// After the original close Promise finishes, the retained lock must still exist.
```

  Reap the exact controlled child before test cleanup. Test cleanup must remove
  only explicit owned root, checkout and lock paths. Do not leave sibling lock
  files behind in existing temporary-repository tests.
- [ ] Run affected workspace/daemon/CLI/client/backend suites, typecheck and
  changed-file Biome. Run `rtk proxy env AGILE_REAL_CODEX=0 bun run check` and
  `rtk proxy git diff --check`. Fix in-scope failures without increasing timeouts.
- [ ] Update architecture, the original plan's current receipt and this plan to
  describe guard ownership, fail-closed quarantine, exact manual recovery, no
  automatic takeover and Real Codex smoke not run. Preserve the historical P1
  record; do not claim final approval before independent review.
- [ ] Self-review and commit only assigned files with the normal hook. Write
  `task-2-report.md` with actual proof, audits, limits and commit SHA.

## Final review and handoff

Task reviews cover spec and quality. Then review the whole integration branch
from `061c489` through final HEAD, including the old P1 and this resolution.
Controller runs fresh final-tree checks. Leave branch/worktree and review
receipts intact for user review; do not merge, push or remove any user's files.

## Task 2 execution receipt — 2026-09-04

Implemented locally from `7f32dde`; independent task/branch review and final
user review remain pending. No merge, push or real external agent execution.

- Outer checkout ownership is acquired before branch setup. Guard release is
  the last resource finalizer; uncertain startup, cancellation rejection, drain
  timeout and incomplete backend close retain it permanently for manual recovery.
- `closeBackendEffect` now returns a boolean confirmation and accepts optional
  `onIncomplete`; the daemon accepts optional `onDrainTimeout`. Uncertainty is
  recorded synchronously before diagnostics. Late Promise resolution cannot
  grant release permission. Public CLI and backend signatures are unchanged.
- An Effect Deferred wakes idle polling on any drain reason, including heartbeat
  failure, without interrupting an active tick before grace expires. Original
  worker failure and primary-heartbeat precedence are retained.
- All three clients reject unconfirmed exit; Pi preserves earlier close failures
  and attempts every tracked client plus its probe before reporting failure.
- The actual CodexClient controlled non-agent child writes only after the session
  has returned. A different-DB successor with an invalid base ref is refused by
  ownership before checkout validation; the lock remains after eventual child
  exit. This proves cooperative exclusion, not containment of hostile descendants.

Actual validation:

```text
rtk proxy env AGILE_REAL_CODEX=0 bun test test/cli/backend-session.test.ts test/cli/session-lifecycle.test.ts test/scheduler/daemon.test.ts
# initial corrected RED: 13 pass, 8 fail, 0 errors, 65 assertions
# initial lifecycle GREEN: 21 pass, 0 fail, 106 assertions

rtk proxy env AGILE_REAL_CODEX=0 bun test test/agents/codex/client.test.ts test/agents/pi/backend.test.ts --test-name-pattern 'exit observation|client close failure'
# corrected provider RED: 0 pass, 5 fail, 0 errors; GREEN: 5 pass, 0 fail

rtk proxy env AGILE_REAL_CODEX=0 bun test test/cli/backend-session.test.ts --test-name-pattern 'real client child|backend close .*retains'
# counterfactual guard bypass: 0 pass, 3 fail, 0 errors
# exact guard restoration in finally: 3 pass, 0 fail, 14 assertions

rtk proxy env AGILE_REAL_CODEX=0 bun test test/workspace test/cli test/scheduler/daemon.test.ts test/agents/codex test/agents/pi test/agents/zcode
# 295 pass, 0 fail, 1,137 assertions, 34 files

rtk proxy env AGILE_REAL_CODEX=0 bun run check
# exit 0; 448 pass, 1 opt-in Real Codex skip, 0 fail, 1,746 assertions, 58 files
# lint unchanged: 30 warnings / 9 infos; typecheck passed

rtk bun run typecheck
# exit 0
rtk proxy git diff --check
# exit 0
```

Changed-file Biome checked all 14 changed/new TypeScript files without diagnostics.
No timeout was increased. The detailed SDD task report records fixture corrections
and cleanup audit; only explicitly identified test-owned paths were removed after
their controlled children were reaped.

Recovery is intentionally conservative even after eventual child exit: stop all
Roc sessions, inspect lock metadata, verify and terminate remaining owned
backend/hook/checkout-mutating children, inspect the dedicated checkout, then
remove only the exact `<canonical-repo>.agile-checkout.lock` file. Never remove
a live owner's lock or infer takeover permission from PID absence, age or SQLite
lease expiry. Stop every pre-guard Roc session before upgrading. Preserve the
checkout, database and task branches. Real Codex smoke remains unrun.
