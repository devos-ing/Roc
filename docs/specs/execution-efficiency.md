# Execution visibility and measured speed

M4 completes the current stage. Superset is outside scope. GitHub remains the
task authority, native worktrees remain isolated and Pi keeps the configured
GPT-6 model and high-or-higher reasoning policy.

## Delivery order

1. Preserve actionable sanitized failures and expose safe recovery information.
   A worker failure must identify its Issue, attempt, phase and operational error
   code in daemon diagnostics. Unknown exceptions must not leak raw messages,
   command output or credentials. GitHub read/write boundaries supply distinct
   safe errors. Unknown checkpoint outcomes and cleanup failures still retain
   ownership. Recovery reuses the existing approved source-commit workflow;
   never rewrite a failed checkpoint as a successful attempt or blindly replay
   an interrupted merge/refresh.
2. Show task phase, recent action, elapsed execution time, attempt/model time,
   waiting reason and recorded token usage through existing inspection and board
   interfaces. Distinguish incomplete usage and unavailable historical timing
   from zero. Keep individual tool activity local to daemon output. Persist only
   compact action/timing summaries at existing checkpoint boundaries, without a
   competing local task database or per-tool GitHub writes.
3. Measure fixed tasks and starting commits with concurrency one and two, then
   apply one simplification at a time. Measure GitHub read latency before changing
   its request scheduling. An optional Scout omission must be explicitly included
   in an approved, sufficiently specified low-risk ticket, retain real independent
   Review and truthful attempt/usage history, and remain off by default. Keep an
   optimization only when measured work or latency decreases without failures of
   the same unchanged acceptance checks. Report small samples honestly.
4. Verify MacBook publication and Mac mini execution through GitHub, with one
   active executor. Confirm inspection, interruption/restart and isolation on the
   actual hosts. Host access is a prerequisite for this acceptance item; a local
   sandbox does not substitute for physical two-host evidence.

## Verification boundaries

Use the existing Fake Harness and GitHub transport seam for deterministic worker
failure, sibling isolation, checkpoint uncertainty and usage/timing checks. Use
CLI/board rendering tests for visible diagnostics and progress. Reuse the actual
sandboxed Pi runner for fixed-task comparisons with unchanged acceptance files,
model and reasoning settings. Record all attempts, retries, cached input tokens,
batch time and quality outcomes; do not present cached tokens as additional
tokens or missing usage as zero.

Do not infer the original cause of M3 Issue #47 from its generic failure message.
Reproduce the diagnostic loss with an injected boundary failure and prove that
future equivalent failures retain a safe code and location. Automated recovery
must not relax Issue approval, exact-head Review, branch protection, lease,
refresh-budget or ownership rules established in M1–M3.

No web UI, new daemon transport, SQLite, distributed locking, provider migration,
release publishing or global wall-clock watchdog is included. `docs/architecture.md`
will record implemented behavior and the validation report will separate software
verification, model benchmarks and physical two-host acceptance.
