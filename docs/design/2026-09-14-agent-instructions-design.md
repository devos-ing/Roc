# Agent instruction design

Date: 2026-09-14. Status: Implemented in `AGENTS.md`. This change has no governing specification or ADR.

## Decision

Keep one short repository-level `AGENTS.md`. Preserve the project requirements that remain compatible with the user's testing boundary, and keep the Pi checks under one conditional trigger. AI agents must not write, run, or delegate unit tests or end-to-end tests. About 90% coverage is acceptable guidance rather than a required minimum.

Keep the existing conditional document pointers. Do not add another testing-policy file or a general completion rule.

## Source guidance

[OpenAI's GPT-6 Astra article](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) recommends short skill triggers, conditional document pointers, progressive disclosure, and fewer fixed tool recipes. It also says to consider models such as Sol and Luna before removing guidance, base safety boundaries on facts, and define completion where a task needs it. The article is an audit guide. It is not evidence that OpenAmp's project invariants are obsolete.

The existing `AGENTS.md` already had focused triggers for the contributor-only skills and conditional Deliver Code navigation. This implementation retains those instructions.

## Repository boundary

This design changes contributor guidance only. It does not change OpenAmp's runtime prompts or installed skills.

- `package.json:10-15` publishes built OpenAmp files, the two readmes, and the license. It does not publish `AGENTS.md`, `.agents/`, or `docs/`.
- `src/agents/pi/client.ts:35-42` disables ambient skills and context files. Lines 87-88 add only explicitly supplied skill paths.
- `.agents/skills/manage-agents-md/` and `.agents/skills/pr-review-to-closure/` remain contributor-only skills.
- `CONTEXT.md`, `docs/architecture.md`, `docs/adr/`, `docs/design/`, and `docs/specs/` remain conditional references.
- `.scratch/` is ignored local state and can be absent from a fresh checkout. The navigation pointer consults its resume state only when present.

The earlier audit was completed before the OpenAmp packaging change. Current package evidence above replaces the old claim that the npm package includes `src/` and `skills/`.

## Instruction choices

| Content | Action | Reason |
| --- | --- | --- |
| Keep the code simple | Keep and clarify | Split the dense sentence while preserving validation, recovery, and safety checks. |
| Contributor-only skill packaging | Keep | The package manifest confirms that contributor instructions and skills remain outside the published package. |
| Agent use of unit and end-to-end tests | Add a prohibition | Agents must not write, run, or delegate these tests. Relabeling one as an integration check does not change the boundary. |
| Confidence over coverage count | Clarify | About 90% is acceptable guidance, not a minimum. Full coverage is not required, and known core failures remain unacceptable. |
| Vertical integration and focused boundaries | Clarify | Keep one focused integration check for the critical path. Remove boundary-test wording because it can imply unit tests. |
| Fake Harness | Keep within the boundary | Use this repository-specific seam only for permitted deterministic integration checks. |
| Pi verification | Clarify in place | Put the existing flow, routing, recovery, workspace, cancellation, and logging checks under one Pi execution or orchestration trigger. |
| Function JSDoc | Keep and tighten | Describe behavior from implementation and call context. Keep anonymous inline callbacks exempt. |
| Deliver Code navigation | Keep | Preserve the markers and the existing conditional pointers. Mark ignored resume state as optional. |
| General completion instruction | Do not add | Specs, tickets, and delivery workflows define feature completion. |

The user testing boundary replaces the earlier focused-boundary-test wording where it could require unit tests. All compatible safety, recovery, routing, packaging, and documentation requirements remain in `AGENTS.md`.

## Implemented `AGENTS.md`

```md
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
```

## Safety and invariant mapping

| Required behavior | Location | Preservation check |
| --- | --- | --- |
| Small implementation and code reuse | `Keep the code simple` | Validation, recovery, and safety checks remain explicit. |
| Contributor skills stay out of runtime distribution | `Development skills` | The package manifest excludes `.agents/` and `AGENTS.md`. |
| Agent testing boundary | `Testing policy` | Agents cannot write, run, delegate, or relabel unit and end-to-end tests. |
| Core verification and coverage guidance | `Testing policy` | Permitted checks cover core behavior. About 90% remains guidance, and known core failures remain unacceptable. |
| Fake Harness | `Testing policy` | Deterministic scenarios remain available only as permitted integration checks. |
| Pi role flow and routing | `Pi execution and orchestration` | The list keeps the accepted flow, provider and model check, and effort levels. |
| Recovery and safety | `Pi execution and orchestration` | The list keeps recovery effort, cancellation, workspace isolation, commit validation, and safe logging. |
| Named production function JSDoc | `Function documentation` | Named functions remain covered and anonymous inline callbacks remain exempt. |
| Conditional document access | Managed navigation block | Every pointer names the work that should consult it. Local-only paths are conditional. |

The design does not infer that tests use disposable fixtures or lack production access. The Fake Harness is internal, but that fact does not establish a universal permission boundary for every test.

## Managed block ownership

The Deliver Code markers are active ownership markers. In each installed Deliver Code skill root, `assets/scaffold/AGENTS.section.md` owns the block and `scripts/scaffold.mjs` replaces the full marked section in `AGENTS.md`.

The installed templates were not changed because personal skill installations are outside this repository change. A future scaffold run can overwrite the conditional pointers until those templates are updated separately. OpenAmp must not depend on a contributor's installed skill path.

## Implementation and verification

The implementation changes only `AGENTS.md` and this design record. It preserves the pre-existing contributor-skill instructions and Deliver Code markers. It does not change tests, runtime source, or installed templates.

Static acceptance requires all of these conditions:

- The code block above matches `AGENTS.md` exactly.
- `AGENTS.md` contains one start marker and one end marker in the correct order.
- Every tracked repository-relative navigation target exists. Ignored local paths are marked conditional.
- `package.json` excludes contributor instructions and skills from the published files.
- No absolute filesystem path appears in either changed file.
- No unit or end-to-end test is written, run, or delegated for this change.
- `git diff --check` passes.

Static checks establish wording, path, marker, and packaging consistency. They do not measure agent behavior or performance.
