# Checkout handoff safety

## Authority and goal

The user authorized design, implementation, local validation and independent
review until a reviewable result on 2026-09-04. Keep the existing isolated
`codex/effect-session-lifecycle` branch. Do not merge, push, publish a PR or run
real external agents. The previous P1 review identified a session returning
after its 250ms backend-close deadline while an old child may still write the
stable dedicated checkout.

Prevent a successor scheduler session from using that checkout while previous
session work may remain. Preserve bounded shutdown and SQLite fencing.

## Alternatives and decision

Increasing close timeouts does not establish ownership when work never settles.
Changing all providers to process-group supervision is a larger platform and
sandbox change and still needs successor exclusion during startup.

Use a persistent exclusive checkout guard acquired before checkout preparation.
Clean teardown releases it. Uncertain teardown retains it, even if a late
Promise subsequently resolves. This deliberately trades automatic recovery for
fail-closed restart behavior. There is no age-based or PID-based lock takeover.

## Ownership contract

- Canonicalize the requested repository using realpath. Atomically create
  `${canonicalRepo}.agile-checkout.lock` with exclusive creation and mode 0600.
  The lock is outside the Git checkout, so task commits cannot include it.
- Record version, runId, owning process PID and acquisition time for inspection. Treat
  existing files, directories and symlinks at that path as occupied. A second
  session fails with a sanitized non-retryable `SCHEDULER_CHECKOUT_IN_USE`
  AgileError before branch setup, backend startup or database acquisition.
- Release only the file this owner created. Check filesystem identity and its
  owner token before unlinking. Replaced or malformed ownership evidence fails
  closed with a sanitized non-retryable `SCHEDULER_CHECKOUT_OWNERSHIP_LOST`
  infrastructure error. Concurrent release callers share one retained release
  attempt and its settled result, so an older caller cannot unlink a successor
  after clean release. Do not recursively delete a path. Never automatically
  recover locks using PID liveness, elapsed time or SQLite lease expiry.
- All `runBackendSession` calls use the guard, independent of backend and DB
  path. Fake runtime without a dedicated checkout remains unchanged. Direct
  low-level branch-manager APIs are not a new concurrency entry point: runtime
  session ownership is the protected boundary.
- Register ownership release outside branch/backend/database/daemon resources.
  Normal cleanup order remains drain, seal, interrupt, lease release, backend
  close, database close, then ownership release.

## Clean versus uncertain teardown

An acquired guard starts releasable before backend startup. Mark startup
uncertain immediately before invoking the backend factory. A successful handle
does not by itself restore releasability; its close must complete successfully
inside the existing 250ms wait. A factory that rejects or never returns cannot
prove that it left no process behind, so retain the guard.

Independently and monotonically retain the guard when:

1. daemon work or cancellation exceeds its 250ms drain deadline;
2. harness cancellation or hook shutdown rejects, including synchronous throws;
3. backend close rejects or exceeds its 250ms wait;
4. guard ownership cannot be verified at release.

No late callback can reset the uncertain flag. Report fixed safe diagnostics
with the existing bounded diagnostic helper. Preserve an existing primary
error; a cleanup-only error retains its original identity. The guard must
remain even when logging fails or hangs.

Idle polling is not outstanding work. Wake the worker's idle sleep when stop
arrives, so an ordinary idle stop can drain and release ownership. Do not
interrupt an in-flight tick before the grace deadline. Retain existing genuine
tick-failure and primary-heartbeat precedence semantics.

## Client and backend close contract

Codex, Pi and ZCode clients retain their existing graceful/force-kill timings.
They must reject with a fixed sanitized error if actual child exit cannot be
confirmed after the final wait. A rejected `process.exited` Promise is not exit
confirmation. The exit wait must not report success solely because its timeout
fired. This concerns owned direct children, not proof that hostile detached
descendants outside provider containment cannot exist.

Pi backend must attempt cleanup of all tracked clients and its probe and report
any close failure rather than clear failed clients or swallow rejections.
Previously failed tracked closes remain evidence of incomplete cleanup.
Provider gates, task/model policy, protocol behavior and interfaces stay intact.

## Validation

Use real temporary Git repositories, SQLite, Fake Harness and controlled local
processes only. Prove exclusive acquisition across repository aliases and
processes, clean release/reacquisition, stale-lock refusal and owner-safe release.
Prove a clean idle session can restart. Prove backend-close timeout/failure,
late tick/cancellation and failed factory startup keep the guard, including a
different DB path and rejection before backend startup.

One vertical regression uses the actual Codex client with a scripted non-agent
child that ignores graceful shutdown and attempts a late checkout write.
After the session returns, a successor must be refused before touching the
checkout, and the guard must remain after the child eventually exits. Explicitly
reap test children before deleting only test-owned files. Do not use sleep as
the assertion oracle; coordinate starts and writes with observable latches or
bounded fixture signals. Keep the test set focused on these invariants.

Run affected suites, typecheck, changed-file lint and the full repository check
with `AGILE_REAL_CODEX=0`. Existing lint baseline is 30 warnings and 9 infos.

## Recovery and limits

A retained lock is an intentional quarantine. Stop every Roc session for the
repository, inspect its lock metadata, verify and terminate any remaining owned
backend/hook/checkout-mutating child work, and inspect the dedicated checkout
before manually removing the exact lock file. PID absence alone is insufficient
because descendants may survive a parent. Never suggest deleting the checkout,
database or task branches to recover. No automatic unlock command is added.

A process crash can leave a lock requiring this procedure. A pending backend
factory remains uncancellable, but another session cannot enter its checkout.
This is local cooperative ownership, not a hostile-user security boundary or
distributed filesystem locking guarantee. Operators must not remove a live
owner's lock. Real Codex smoke remains separate from deterministic validation.
