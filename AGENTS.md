# Testing Policy

- Optimize for confidence in core product behavior, not for 100% test coverage.
- Add the smallest test set that proves the critical happy path and load-bearing failure, recovery, and safety invariants.
- Prefer one vertical integration test plus focused boundary tests over exhaustive unit-test matrices.
- Reuse the Fake Harness for deterministic orchestration cases such as retry, rejection, restart, and event deduplication.
- For the Real Codex adapter, focus on one accepted Scout → Implement → detached Review flow, model fallback with no `low` effort, worktree isolation and commit validation, approval auto-decline to `needs_replan`, and sanitized `AgileError` logging.
- Do not build exhaustive notification fixtures, protocol-version matrices, logging edge-case suites, or coverage targets unless a real regression or load-bearing risk justifies them.
