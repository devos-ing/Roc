# Keep the code simple

- Use the smallest implementation that meets current requirements. Reuse existing code, and remove obsolete paths instead of retaining speculative abstractions or compatibility layers. Preserve validation, recovery, and safety checks.

# Development skills

- `.agents/skills/pr-review-to-closure/` is only for reviewing Roc's own pull requests. Keep it out of user onboarding, runtime skills, and the published npm package.
- For requested contributor instruction changes, use `.agents/skills/manage-agents-md/`. This development skill stays out of user onboarding, runtime skills, and the published npm package.

# Testing policy

- AI agents must not write, run, or delegate unit tests or end-to-end tests. Do not relabel either kind as an integration check to bypass this rule.
- Use the smallest permitted verification set that proves core behavior, including the critical happy path and load-bearing failure, recovery, and safety invariants.
- Prefer one focused integration check for the critical path. Use the Fake Harness for permitted deterministic integration checks of retry, rejection, restart, and event deduplication.
- A result near 90% test coverage is acceptable. Treat 90% as guidance, not a required minimum, and do not leave a known core failure unresolved to meet it. Full coverage is not required.
- Add broader permitted integration checks only for a demonstrated core regression or load-bearing risk.

## Pi execution and orchestration

- For changes to Pi execution or orchestration, focus verification on:
  - one accepted Scout → Implement → independent Review flow.
  - the confirmed provider and model, with `high` Scout and Review effort and `medium` Implement effort for new attempts.
  - preservation of recorded effort on recovery.
  - dedicated-checkout branch isolation and commit validation.
  - interaction cancellation to `needs_replan`.
  - sanitized `AgileError` logging.

## Function documentation

- Give every named production function, method, constructor, and function-valued local a concise one-sentence JSDoc description of its behavior. Recover that behavior from the implementation and call context instead of restating the function's name. Anonymous inline callbacks do not need JSDoc.

<!-- deliver-code:start -->
## Deliver Code navigation

- For domain terminology, read `CONTEXT.md`.
- For service boundaries and component interactions, read `docs/architecture.md`.
- When revisiting an architectural decision, consult the relevant record in `docs/adr/`.
- When implementing a bounded design, read its matching document in `docs/design/`.
- For acceptance requirements, read the matching approved specification in `docs/specs/`.
- When resuming delivery work, consult its ticket and resume state in `.scratch/deliver-code/` if present.
- For historical Codex harness research, consult `.worktrees/real-codex-harness.knowledge/` if present; this optional local material is not required for unrelated work.
<!-- deliver-code:end -->
