# Real Codex Harness — Final Fix Report

Date: 2026-08-26  
Fix base: `3d513e4cc075321d9981e5fc1ab48a950bfbe12e`  
Implementation commit: `9bedaff7cf0033f1aa2d1b46b4b537f217c8d1ac` (`fix: harden real codex orchestration`)

## Outcome

All two Critical and seven Important findings in the consolidated brief are fixed. Minor 11 is fixed. Minors 10, 12, and 13 are deliberately deferred because they do not affect the v1 correctness/safety path and would broaden reconciliation, startup catalog, or logging behavior.

The full non-live gate is green: TypeScript passed; 131 tests passed, the explicitly excluded live Codex test was skipped, and no test failed. The CLI help smoke passed.

## Finding disposition

### 1. Critical — task errors killed the daemon

Disposition: fixed.

- `src/codex/harness.ts` now owns a task-scoped terminal boundary around dispatch, delivery, and reconciliation. Protocol/infra failures become durable `attempt.failed_infra` deliveries with a valid next cursor; policy failures become `attempt.blocked_policy`. Startup/domain failures remain process-wide.
- Existing `AgileError` code/category/retryability is preserved, including app-server exit/read and thread-start failures. Unknown task exceptions receive the safe `unexpected_task_failure` fallback.
- `failedDelivery` now preserves non-retryable classification.
- `test/codex/harness.test.ts` proves invalid structured output and trusted commit failures return terminal deliveries instead of rejecting.
- `test/scheduler/scheduler.test.ts` proves retryable capped behavior, non-retryable terminalization, `model_unavailable` fallback, and continuation to a later task.

RED: `rtk bun test test/codex/harness.test.ts --test-name-pattern "normalizes invalid structured"` — 0 pass, 1 fail; `invalid_structured_output` escaped `step()`.  
GREEN: same command — 1 pass, 0 fail. Scheduler focused continuation test — 1 pass, 0 fail.

### 2. Critical — repository hooks/hostile Git state

Disposition: fixed.

- `src/workspace/task-worktree.ts` routes every trusted Git invocation through one hardened runner.
- The runner supplies `core.hooksPath=/dev/null`, disables fsmonitor, disables system/global config, does not inherit arbitrary environment entries, disables prompts, fixes locale, and pins both config and environment author/committer identity.
- Worktree creation and Harness-owned commit creation use the hardened runner.
- `test/workspace/task-worktree.test.ts` proves a hostile executable `post-checkout` hook cannot create its sentinel; existing pre-commit and hostile identity coverage remains green.

RED: focused worktree command below — hostile checkout sentinel existed.  
GREEN: `rtk bun test test/workspace/task-worktree.test.ts --test-name-pattern "hostile checkout|different base identity|requires Review|commits dirty|worktree-controlled"` — 5 pass, 0 fail.

### 3. Important — persisted task base ignored

Disposition: fixed.

- `StoredTaskSchema`, orchestration reads, and planning reads now expose optional persisted `baseCommit` from `tasks.base_commit`.
- Every Harness worktree operation supplies the ticket's persisted task base. The manager's run base is used only when the task has not recorded a base.
- `TaskWorktreeManager` accepts a per-operation persisted base and verifies it is a full existing commit.
- Restart coverage advances repository HEAD, creates a manager with the new run base, reuses the old task with its stored base, and still rejects reuse against the new conflicting default.
- Repository coverage proves the persisted base returns in the next running-attempt input.

RED: repository metadata test showed `input.ticket.baseCommit` missing; restart test rejected the persisted old base.  
GREEN: repository metadata test — 1 pass; focused worktree test — green as above.

### 4. Important — Review could inspect dirty/diverged state

Disposition: fixed.

- `TaskWorktreeManager.assertReviewReady` proves worktree registration/ancestry, exactly one commit over the persisted base, clean porcelain status, and branch HEAD equality with `implementation.commitSha`.
- `src/codex/harness.ts` calls the invariant before Review dispatch, before reconciliation reads, and again before accepting live or recovered Review output.
- `test/workspace/task-worktree.test.ts` covers dirty state, a forbidden second commit, mismatched implementation SHA, and the valid exact commit.
- `test/codex/harness.test.ts` proves both dispatch and reconciliation fail before contacting Codex when the invariant is invalid.

RED: `assertReviewReady` did not exist; dirty/extra/mismatch focused test failed.  
GREEN: focused worktree command — 5 pass, 0 fail; Harness dispatch/reconcile invariant test passed.

### 5. Important — unbounded signal shutdown

Disposition: fixed.

- `src/cli/run.ts` starts signal shutdown immediately, gives Harness cancellation a 250 ms default deadline, then closes the Codex client before waiting for the daemon.
- `runCodex` supplies `client.close()` as the backend close hook; its existing outer `finally` still closes the client and database.
- `CodexClient.close()` immediately rejects pending requests/message waiters, closes stdin, and kills a child that misses its bounded exit deadline.
- Existing `SchedulerDaemon.run()` lease cleanup remains in `finally`.
- `test/cli/scheduler.test.ts` deterministically models a permanently blocked cancellation/read and proves the deadline calls backend close and releases the daemon.
- `test/codex/client.test.ts` proves a blocked `nextServerMessage()` rejects with `CODEX_CLIENT_CLOSED` and close completes within the bound.

RED: signal test could not import a shutdown seam; the prior signal path waited for the daemon before client close.  
GREEN: signal shutdown test — 1 pass in 28 ms; blocked client read test — 1 pass in 18 ms.

### 6. Important — missing Codex failure classification

Disposition: fixed.

- `src/codex/protocol.ts` explicitly maps authentication, bad request, model unavailable, policy, sandbox, context, usage/rate, transport/server, rollback, non-steerable, and interrupted failures to safe code/category/retryability values.
- Live completion and reconciliation use the same classifier.
- `src/codex/client.ts` classifies structured `TurnError` data attached to RPC errors, preserving `model_unavailable` for scheduler fallback while retaining the safe generic RPC error when structured data is absent.
- Provider text is used only to recognize model availability and is never returned/logged.
- `test/codex/protocol.test.ts` covers representative retryable/non-retryable cases; `test/codex/client.test.ts` covers structured RPC model fallback.

RED: protocol test failed because the classifier did not exist; RPC test received generic `CODEX_APP_SERVER_RPC_ERROR`.  
GREEN: protocol test — 1 pass with 6 representative assertions; RPC classifier test — 1 pass.

### 7. Important — stale server request poisoned next task

Disposition: fixed.

- Known server requests are still answered fail-closed, then their thread/turn identity is compared with the active turn.
- Stale known requests are drained without interrupting, blocking, or failing the current attempt.
- Unknown/malformed requests retain the fail-closed blocking behavior.
- `test/codex/harness.test.ts` proves a stale approval request is declined, no active-turn interrupt is issued, and the current Scout output proceeds.

RED: stale request test observed an active-turn interrupt and policy block.  
GREEN: stale request regression passed.

### 8. Important — Review effort not delivered

Disposition: fixed at the supported thread boundary.

Local generated schema investigation (Codex installed on 2026-08-26):

1. `rtk codex app-server generate-json-schema --experimental --out /tmp/agile-codex-schema.t2Amjb` — exit 0.
2. `v2/ReviewStartParams.json` exposes only `threadId`, `target`, and `delivery`; it has no `effort`, `model`, or direct review-config property.
3. `v2/TurnStartParams.json` exposes direct `effort` (already used for Scout/Implement).
4. `v2/ThreadStartParams.json` exposes `model` and additive `config` overrides.
5. `v2/ConfigReadResponse.json` and the aggregate v2 schema explicitly contain the supported `model_reasoning_effort` config key.

Accordingly, the detached Review anchor's `thread/start` now sends `config: { model_reasoning_effort: selectedEffort }`; no field was invented on `review/start`, and sandbox/approval settings are unchanged. The accepted vertical Harness test asserts the exact request (`xhigh`).

### 9. Important — runtime symlink traversal

Disposition: fixed.

- New `src/runtime/safe-file.ts` is the shared path primitive for log/database files. It creates missing parents one component at a time, rejects symlink/non-directory parent components, canonicalizes the validated parent, and rejects symlink/non-regular targets.
- JSONL logging additionally opens with `O_NOFOLLOW` and fixed `0600` creation mode.
- SQLite validates the same safe path before opening.
- Focused tests cover symlinked `.agile/runtime`, symlinked log target, symlinked database target, and prove external sentinels/referents remain unchanged.

RED: logger symlink test resolved and wrote through the symlink.  
GREEN: runtime/database focused run — 18 pass, 0 fail.

### 10. Minor — reconciliation usage/timestamps

Disposition: deferred for adjudication.

The generated `thread/read` turn used by v1 reconciliation has `completedAt` but does not provide the authoritative cumulative token totals required to emit a correct missing `attempt.usage_delta`. Synthesizing usage or rewriting event timestamps would be inaccurate and expands the reconciliation contract. Existing persisted cursor usage remains replay-safe. This does not affect accepted output/commit correctness.

### 11. Minor — policy event identity lacks request ID

Disposition: fixed.

Approval-required policy event IDs now include the server request ID, and the Harness test asserts the exact identity.

### 12. Minor — model-list pagination

Disposition: deferred for adjudication.

Startup requests 100 visible models and v1 selects only three named profiles. Adding page accumulation, duplicate-cursor protection, and startup tests is independent of the reviewed core safety failures; the residual edge case is a compatible configured model appearing only after the first 100 visible catalog entries.

### 13. Minor — debug-log additive notifications

Disposition: deferred for adjudication.

The Harness intentionally ignores additive notifications for forward compatibility and currently has no logger dependency. Injecting a debug logger and defining payload redaction/volume policy would broaden the adapter and logging contract. There is no product-state or safety impact; malformed recognized notifications still fail closed.

## Verification evidence

### Focused RED/GREEN commands

- `rtk bun test test/codex/harness.test.ts --test-name-pattern "normalizes invalid structured"`
  - RED: 0 pass, 1 fail; thrown `AgileError`.
  - GREEN: 1 pass, 0 fail.
- `rtk bun test test/codex/protocol.test.ts`
  - RED: missing export.
  - GREEN: 1 pass, 0 fail.
- `rtk bun test test/codex/harness.test.ts --test-name-pattern "stale known server request"`
  - RED: stale request interrupted the active turn.
  - GREEN: passed in the consolidated Harness run.
- `rtk bun test test/workspace/task-worktree.test.ts --test-name-pattern "hostile checkout|different base identity|requires Review"`
  - RED: 0 pass, 3 fail (hook executed, stored base rejected, invariant absent).
  - GREEN (expanded focused pattern): 5 pass, 0 fail.
- `rtk bun test test/store/orchestration-repository.test.ts --test-name-pattern "persists started attempt metadata"`
  - RED: persisted base absent from running input.
  - GREEN: 1 pass, 0 fail.
- `rtk bun test test/cli/scheduler.test.ts --test-name-pattern "signal shutdown"`
  - RED: shutdown seam absent.
  - GREEN: 1 pass, 0 fail.
- `rtk bun test test/codex/client.test.ts --test-name-pattern "blocked server-message"`
  - GREEN: 1 pass, 0 fail (existing close primitive validated).
- `rtk bun test test/codex/client.test.ts --test-name-pattern "structured RPC failure"`
  - RED: generic non-retryable RPC error.
  - GREEN: 1 pass, 0 fail with `model_unavailable`.
- `rtk bun test test/runtime/errors-and-logging.test.ts --test-name-pattern "symlinked runtime"`
  - RED: logger followed the runtime symlink.
  - GREEN: passed after the shared guard.

### Consolidated focused run

Command:

`rtk bun test test/runtime/errors-and-logging.test.ts test/store/database.test.ts test/cli/scheduler.test.ts test/codex/harness.test.ts test/codex/client.test.ts test/codex/protocol.test.ts test/scheduler/scheduler.test.ts test/store/orchestration-repository.test.ts test/workspace/task-worktree.test.ts`

Result: 89 pass, 0 fail, 399 assertions.

### Full required gate

Command: `rtk bun run check`

Result:

- `tsc --noEmit`: pass.
- Bun tests: 131 pass, 1 skip, 0 fail, 557 assertions across 20 files.
- The only skip is `test/integration/real-codex.test.ts`, intentionally not run live per the brief.

### Smoke

Command: `rtk bun run src/cli/main.ts help`

Result: exit 0; printed the expected `agile` command list including fake/Codex scheduler run and inspect commands.

### Hygiene/self-review

- `rtk git diff --check`: pass, no whitespace errors.
- Changed files are limited to the owned Codex adapter/client/protocol, CLI shutdown, task worktree, persisted task schema/read path, shared runtime path guard, and focused tests/fixture.
- No CodeGraph initialization, permission widening, `low` effort, token-budget enforcement, or live Codex gate.
- No unrelated user changes were reverted.

## Files changed

- Production: `src/cli/run.ts`, `src/codex/{client,harness,protocol}.ts`, `src/domain/schemas.ts`, `src/runtime/{logger,safe-file}.ts`, `src/store/{database,orchestration-repository,planning-repository}.ts`, `src/workspace/task-worktree.ts`.
- Tests/fixture: `test/cli/scheduler.test.ts`, `test/codex/{client,harness,protocol}.test.ts`, `test/fixtures/scripted-app-server.ts`, `test/runtime/errors-and-logging.test.ts`, `test/scheduler/scheduler.test.ts`, `test/store/{database,orchestration-repository}.test.ts`, `test/workspace/task-worktree.test.ts`.

## Residual concerns

No known Critical or Important concern remains. The three deferred Minors and their precise edge scope are recorded above. The expensive live Codex acceptance gate remains for the controller/re-review stage as explicitly required.
