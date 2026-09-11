# Pi model routing and recovery

Roc uses Pi for every agent role. M1 lets an operator select exact Pi models
without adding another runtime, a learned router, automatic provider switching,
price lookup, billing storage, or provider qualification.

`models` is optional and preserves legacy behavior when omitted. Its profile
fields (`luna`, `terra`, `sol`) and `allowlist` entries are exact
`provider/modelId` strings. `allowlist`, when present, is nonempty and unique;
it governs every effective mapping, new route, and resumed turn. The optional
`implementPrimaryEffort` is `medium` or `high`, defaulting to `medium`.
The optional top-level `efforts` object sets `medium`, `high`, or `xhigh` per
role and keeps the established role defaults when omitted. Onboarding preserves
both objects.

The scheduler snapshots policy when it starts. Scout always uses Luna at high;
primary Implement uses Terra at the configured primary effort; a retained Terra
retry keeps that effort. High-risk and escalated Implement use Sol at medium.
Independent Review uses Sol at high. A selected Terra that cannot meet its
configured effort stops before a prompt; it does not silently become Sol.

`models.implementPrimaryEffort` has precedence over `efforts.implement` only
for primary Terra work and a retained Terra retry. High-risk and escalated Sol
Implement applies `efforts.implement` when configured, otherwise medium. When
the new model policy is absent, configured role efforts retain their upstream
fallback and normal profile-advancement behavior.

Pi startup admits each effective mapping against the discovered catalog and the
allowlist. Luna requires high; Terra requires the primary effort; Sol requires
both medium and high. A default fills only an omitted mapping, so an unrelated
default does not reject a fully explicit configuration. Pi reasserts and reads
back exact model and thinking level before sending a role prompt.

Attempts retain their recorded exact model, effort, cursor, and work. A new or
unfinished recovered attempt whose recorded model is no longer allowed emits a
policy block and reaches `needs_replan`; it is never substituted with today’s
Terra mapping. Reconciliation that only delivers an already-recorded result or
cleans up remains available. Review remains a separate session against the sole
trusted implementation commit.

Repository tests use scripted catalogs and clients only. Pi catalog metadata
and `get_state` prove the requested/read-back identifier and configured
thinking level, not provider account access, immutable server-side identity, or
actual provider compute. Live qualification and cost measurement require a
separate approved activation step.
