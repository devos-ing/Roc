# Testing Policy

- Optimize for confidence in core product behavior, not for 100% test coverage.
- Add the smallest test set that proves the critical happy path and load-bearing failure, recovery, and safety invariants.
- Prefer one vertical integration test plus focused boundary tests over exhaustive unit-test matrices.
- Reuse the Fake Harness for deterministic orchestration cases such as retry, rejection, restart, and event deduplication.
- For the Real Codex adapter, focus on one accepted Scout → Implement → detached Review flow, model fallback with no `low` effort, dedicated-checkout branch isolation and commit validation, approval auto-decline to `needs_replan`, and sanitized `AgileError` logging.
- Do not build exhaustive notification fixtures, protocol-version matrices, logging edge-case suites, or coverage targets unless a real regression or load-bearing risk justifies them.

## Function Documentation

- Give every named production function, method, constructor, and function-valued local a concise one-sentence JSDoc description of its behavior, recovered from its implementation and call context rather than merely restating its name.
- Anonymous inline callbacks do not require descriptions.

<!-- deliver-code:start -->
## Deliver Code navigation

- Domain language: `CONTEXT.md`
- Current architecture: `docs/architecture.md`
- Durable decisions: `docs/adr/`
- Bounded designs: `docs/design/`
- Approved specifications: `docs/specs/`
- Local tickets and resume state: `.scratch/deliver-code/`
- Heavy research and source material: `/Users/roy/Documents/ChatGPT/agile-agents/.worktrees/real-codex-harness.knowledge`
<!-- deliver-code:end -->
