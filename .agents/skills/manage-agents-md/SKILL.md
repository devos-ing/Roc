---
name: manage-agents-md
description: Create, audit, or maintain AGENTS.md instructions for Roc contributors when requested.
---

# Maintain contributor instructions

Keep Roc's contributor instructions accurate, concise, and usable from a fresh checkout. An audit returns findings; a request to create or update instructions includes applying and verifying the changes.

This is a repository development skill. Keep it out of Roc user onboarding, runtime skill installation, and the published npm package. It is self-contained and requires no contributor's personal skills or machine paths.

## Establish scope

Locate the requested AGENTS.md files, applicable inherited guidance and overrides, and referenced documents. Distinguish files found on disk from instructions confirmed as loaded by the target agent. Consult the agent's discovery documentation when precedence is uncertain.

Read the existing diff before editing and preserve unrelated work. Repository maintenance does not imply changes to a contributor's global instructions. Treat personal guidance as context unless the user includes it in the requested scope.

For a new file, derive instructions from repository evidence and the user's requirements. Capture non-obvious conventions and constraints; leave easily discoverable commands and configuration in their existing sources. Put specialized guidance where the intended agent will load it for that work.

## Review and edit

Classify audited instructions as keep, clarify, relocate, or remove, with a concrete reason. For a narrow edit, explain only the affected decisions.

- Preserve the requirements in the root AGENTS.md, including contributor-only skill packaging, focused testing, Pi recovery and isolation invariants, and function documentation. Model upgrades alone do not make these requirements obsolete.
- Make references conditional: explain which task needs each document. Use repository-relative paths and identify optional local material so its absence does not block unrelated work.
- Retain concrete correctness and safety boundaries. Clarify completion and authorization using established facts; do not invent permission requirements or claims about disposable tests or production access.
- Replace rigid tool recipes with decision criteria where exact steps are unnecessary. Give a usable fallback when a preferred tool or index is unavailable.
- Remove duplication and stale rules. Move substantial task-specific detail behind a clear pointer only when the extra file earns its maintenance cost.

Preserve managed-block markers such as `deliver-code:start` and `deliver-code:end`. Find the owning template or generator before changing generated content. When its source is available within the authorized scope, keep it consistent with the output. Otherwise report that regeneration may overwrite the edit. Do not assume a maintainer's locally installed generator exists on every contributor's machine.

## Verify and report

Review the diff for lost requirements, conflicting scope, unintended authorization changes, and invalid paths. Verify moved references remain reachable. For skill changes, validate frontmatter and links with an available validator or direct inspection. Confirm contributor skills remain outside the package file allowlist and runtime installation paths if those boundaries change.

Use verification proportional to the change. Instruction-only edits normally need document and diff checks; executable generator changes need focused behavior checks. Compare representative tasks before and after removing an instruction when claiming improved agent behavior, using the same model and settings and changing one instruction at a time. Keep experiments isolated from contributor work. Report static review separately from behavioral evidence.

Finish an authorized update with the changed files, key preservation or removal decisions, checks performed, and any regeneration or validation limitations. Revisit instructions after demonstrated failures or workflow changes rather than adding a permanent rule for every isolated incident.

## References

- [OpenAI guidance on skills and prompts](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) explains contextual references and reducing overprescription.
- [Codex AGENTS.md discovery](https://developers.openai.com/codex/guides/agents-md) describes instruction loading and overrides; consult it when resolving precedence.
