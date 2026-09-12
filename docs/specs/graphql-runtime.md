# GraphQL runtime reads

Approved scope: GQL-M2 steps 1–5 of [the integration plan](../design/graphql-runtime-e2e-plan.md), plus the reduced checkpoint write/read smoke approved on 2026-09-11. Approval records are in `.scratch/startup-goal/graphql-runtime/implementation-approval.md` and `smoke-approval.md`. The user replaced the full workflow requirement with this smaller final check.

## Required behavior

- R1: Production `read`, `get` and `getMany` return complete Issue comments and labels. Discovery uses 25-item OPEN/CLOSED managed pages and rejects counts at or above 1000. Partial results, null required fields, duplicated identities, stalled cursors, count drift and GraphQL errors return no snapshot.
- R2: A new claim rereads the complete known plan, validates candidate authority and dependencies, verifies exact PR and ancestry evidence, and rereads the same complete plan version before checkpoint write/readback. Closed done dependencies are valid; closed candidates cannot start. Known numbers are locators, never authority.
- R3: The production reader, store, pool and runner preserve Scout, Implement, independent Review, checkpoint recovery, PR publication, guarded merge, done and fresh dependent release. Confirmed operations do not replay on restart.
- R4: Explicit query-read intent permits shared quota waiting, including HTTP 200 GraphQL errors. Permission failures and writes never replay. Worker cancellation does not cancel siblings; daemon shutdown drains active reads, roles and write reconciliation. Unknown checkpoints retain ownership and sanitized diagnostics.
- R5: Real local CLI subprocesses use the production connection and reader for inspection/task views. Temp gh protocol shims prove partial/403/quota handling and SIGINT cleanup without external mutations.
- R6: Focused tests, two-axis review, complete `bun run check` and package file checks produce fresh evidence from the actual workspace contents.
- R7: Three paired production read-only samples compare against frozen M1 REST on equivalent live data. HTTP must decrease at least 50%, median latency must remain within 120% of REST, and hourly idle cost must stay within 20% of the reported limit. This evidence belongs to the coordinator after local QA.
- R8: On one isolated, unmanaged test Issue, write a schema-valid checkpoint through the existing REST write path, then update the same comment from revision 0 to revision 1. After each write, the first production GraphQL read must return the exact body, record, author and comment ID without retry. Full real GitHub PR/protected-merge workflow E2E is optional and remains untested; it is not a release gate for this change.
- R9: Independent QA and outcome acceptance remain with the coordinator.

## Boundaries

No provider/model changes, webhook, cache, database, permanent dual reader or REST fallback. Existing writes, PR and merge policy remain in place. Final fresh-read-to-write TOCTOU cannot be atomic across GitHub requests. Local tests do not constitute real network or model E2E.

The reduced R8 result is recorded in [checkpoint write/read validation](../validation/graphql-checkpoint-smoke-2026-09-11.md). Passing it does not authorize commits, pushes, deployment, or starting the existing scheduler.
