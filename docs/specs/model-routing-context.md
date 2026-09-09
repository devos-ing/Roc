# Model routing and Scout handoffs

Approved by the user's request to implement the model-routing-context plan on
2026-09-08. Updated on the user's subsequent request to remove the Scout byte
limit. This specification covers Pi profile configuration and concise Scout
handoffs. Cost improvements require separate live evidence.

1. Global Roc settings accept optional `models.luna`, `models.terra`, and
   `models.sol`, each an exact `provider/modelId`. Omitted profiles use the Pi
   probe default. Onboarding preserves these mappings.
2. Explicit mappings must resolve in the catalog and support `high`. Invalid
   mappings fail startup with a sanitized error before any role prompt. An
   explicit mapping cannot fall back to a similarly named catalog entry.
3. Low- and medium-risk tasks retain Scout/Luna, Implement/Terra, Review/Sol
   baselines and existing retry escalation. High-risk roles and retries use
   Sol with `xhigh`. No compatible Sol means `needs_replan`, not lower effort.
4. Each attempt persists and confirms its actual provider/model and effort.
   Existing attempts recover using their persisted descriptor. Review remains
   an independent session checking the trusted implementation commit.
5. New Pi Scout outputs retain the existing capsule fields and structural
   validation. There is no capsule byte limit or truncation. Valid large
   capsules follow the normal usage, output, and completion delivery sequence.
6. Historical capsules remain readable by role-input and event recovery paths.
   Persisted `outputDelivered` cursors still complete without regenerating a
   capsule. Interrupted turns without persisted output retain existing retry
   behavior.
7. Prompts keep handoffs focused on source locations, tests, and unresolved
   risks. Implement and Review inspect current source rather than trusting
   summaries or line numbers as proof.

Validation uses the existing Pi vertical fixture, backend and advisor tests,
settings/onboarding integration, large-capsule delivery and recovery tests, and
the full repository check. Live comparisons use fixed fixture commits and
independent acceptance tests with stubbed PR publication. Record all failures,
retries, model identities, usage, elapsed time, and capsule sizes. Subscription
token counts or Pi catalog estimates are not actual billed cost.

The initial experiment compared unchanged routing, a cheaper Scout alone,
and that same routing with bounded handoffs. Those results remain historical
evidence; the byte limit was subsequently removed. A separate user request
selected GPT-6 Astra for new Codex setups and the user's Roc profiles. Existing
explicit model selections remain supported. No worker agents, bulk-read hooks,
new database schema, public benchmark CLI, automatic model selection, or price
service.
