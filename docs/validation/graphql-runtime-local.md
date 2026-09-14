# GraphQL runtime local verification

GQL-M2 changes the production Issue reader and fresh admission checks. The approved boundary is local implementation, local isolated processes, and coordinator-owned read-only comparison. Real GitHub workflow writes remain pending. Source acceptance is [the integration plan](../design/graphql-runtime-e2e-plan.md) and [runtime specification](../specs/graphql-runtime.md).

## Production behavior

`read`, `get` and `getMany` share `GitHubGraphQLReader`. Managed discovery covers OPEN and CLOSED Issues in pages of 25. Known Issue batches use at most 25 fixed aliases and validated number variables. Issue pages and every label/comment connection reject partial schema, errors, duplicate identities, unusable cursors and count drift. Counts at or above 1000 reject managed discovery. The runtime has no legacy REST reader fallback.

`freshPlan` rebuilds the complete known plan. A candidate must still be OPEN, approved and ready. A dependency can be CLOSED with an approved, exact done checkpoint. The runner checks PR identity and fetched Git ancestry, then compares a second complete plan version before saving the initial checkpoint. A version change stops that claim and restarts admission. Existing role, hook, publication and final merge policy checks remain in place.

Normal GraphQL and PR reads carry a caller cancellation signal into the shared rate limiter and Bun subprocess. Worker cancellation leaves sibling waits intact. Submitted writes still drain and read back during shutdown. An unconfirmed checkpoint retains ownership. HTTP 200 GraphQL errors never return partial authority; permission errors have no retry. Quota errors use the existing shared wait.

GitHub does not provide a transaction across these requests. A race remains between the final fresh read and a write. The implementation does not claim atomic admission.

## Local evidence

Fresh evidence, command output, complete workspace hashes and review receipts are stored in `.scratch/deliver-code/graphql-runtime/`. The final handoff names the exact JSON evidence and fingerprint. The following commands are the local verification entry points:

```sh
rtk bun test test/github/graphql-reader.test.ts test/github/production-read-probe.test.ts test/cli/graphql-process.test.ts test/github/pr-merger.test.ts test/integration/automatic-merge.test.ts --timeout 30000
rtk bun run check
rtk npm pack --dry-run --ignore-scripts --json
```

The production contract fixture has 26 Issues, 103 comments and 101 labels, with a second Issue independently overflowing both connections. Trusted approval and executor checkpoint occur at comments 102 and 103. Failure fixtures prove that incomplete reads return no snapshot.

The main vertical test uses the production reader, store, pool, runner, PR publisher and guarded merger. Fake Harness supplies deterministic Scout, Implement and independent Review outputs. Temporary bare Git and native task worktrees provide actual trusted commits, pushes, fetches and ancestry. T1 reaches confirmed done and CLOSED, a replacement store resumes without replay, and T2 starts from fresh T1 merge evidence. The GitHub protocol and merge response remain local fixtures. This is local workflow integration, not real GitHub or model E2E.

The main trace writes a safe staged operation ledger to `.scratch/deliver-code/graphql-runtime/local-workflow-ledger.json`. Every fixture GitHub dispatch passes through the test observer, including checkpoint and PR/policy paths. Store scopes separate complete-plan reads, checkpoint authority reads and exact post-write readbacks. All stage counters and fixture costs sum back to the recorded operation entries. Local stage elapsed times sum to the complete measured interval.

| Boundary | Operation entries in interval | Fixture GraphQL cost |
| --- | ---: | ---: |
| Before T1 publication | 55 | 32 |
| After restart, T1 done and T2 published | 117 | 52 |
| T2 done | 31 | 11 |
| Final idempotent run | 1 | 1 |
| Total | 204 | 96 |

The totals contain 169 fixture GitHub dispatches, 15 scheduler/publisher Git command dispatches, 14 logical worktree calls and six role starts. The 96 GraphQL dispatches comprise six managed lists, four complete-plan reads, 26 checkpoint authority reads, 26 checkpoint readbacks, six confirmed-checkpoint label reads and 28 other boundary or verification reads. Nested comment and label pages are zero in this short-history workflow; the separate contract test exercises overflow. Non-GraphQL fixture operations include 15 PR reads, 12 policy reads, two repository reads, 26 checkpoint writes, 12 label writes, two Issue closes, two publications and two merges. Five of the 15 Git commands check ancestry.

Every fixture response contributes its explicit GraphQL cost, which is one in this fixture. Failed dispatches, rate-header responses, transport retries, role retries and worktree refreshes are zero for this accepted path. The test records every dispatch before execution and asserts the response/failure totals; it does not infer unseen HTTP requests or retries. The final interval adds one managed list and zero roles, checkpoint writes, publications or merges. Elapsed milliseconds are local measurements recorded per interval in the artifact. Internal SimpleGit subprocesses and fixture setup, simulated implementation/merge, and verification helper commands are outside the reported Git command boundary; logical worktree calls remain listed separately.

Focused cases withdraw approval, change specs or membership, close candidates, delete or duplicate dependency checkpoints, cancel a blocked PR read and preserve unknown-write ownership. Existing automatic-merge tests now pass through the production GraphQL reader. The CLI process test launches the real CLI with a temporary executable gh shim and checks inspection/task lists, partial responses, HTTP 403, HTTP 200 quota, SIGINT, safe diagnostics and child drain. Production shutdown tests retain the existing needs_replan/ownership behavior.

M1 historical measurement tests are preserved in the frozen snapshot. The current tool retains core parser and observed-stream fixtures, but the old REST measured leg and `--pair` now fail with `GQL_HISTORICAL_ONLY`. Removing the duplicated private query catch preserved malformed-response and cancellation behavior in the focused suite.

## Coordinator read-only handoff

After independent local QA, run exactly this comparison from the implementation workspace:

```sh
rtk bun tools/github-production-read-probe.ts --live --repo devos-ing/Roc --baseline .scratch/startup-goal/graphql-runtime/m1-baseline/workspace --cwd /Users/roy/.codex/worktrees/b065/agile-agents --max-http 199
```

The probe verifies the frozen REST reader SHA-256 `eda5702963035790b3675cee20cf58c81e780b77cce6d36ff665ddf0289c354a` before import. It alternates three REST/production-GraphQL pairs against the same repository. The production reader uses real argv-only gh commands through a tool-local observed transport and the production rate-limit wrapper; Bun's production subprocess behavior is tested separately by the real CLI shim. Only digests, counts, timing, safe quota fields and command shapes leave the probe.

Each leg has a 30-second deadline. The entire run stops at 199 observed HTTP responses, on quota/permission failure, incomplete data, cancellation or any digest change. Observed-stream cancellation can drain additional responses; the report records that overshoot and fails the gates. This is an observed stop threshold, not a promised pre-dispatch HTTP cap for gh internals. No daemon, lock, GitHub mutation or model starts.

A passing report requires six complete observations with one stable digest, at least 50% lower HTTP count for discovery, GraphQL median latency within 120% of REST, and hourly idle query cost within 20% of the reported limit. The baseline is rerun on current data; historical M1 timings are not used as an SLA. R7 live results belong in a separate coordinator evidence file.

The local ledger above covers the approved staged workflow accounting with explicit fixture dispatches, simulated query cost and local elapsed time. These measurements do not establish actual HTTP usage or live full-workflow latency. Real full-workflow HTTP/cost/latency remain part of the separately authorized R8 workflow run; no 50% reduction is promised for that trace.

## Pending acceptance

Production read-only pairs have not been run by the implementation owner. Coordinator QA recheck of the local ledger, R7 live evidence and outcome assessment are upstream. R8 real GitHub writes, PR, protected merge and restart require a separately approved isolated run packet. No commit, push, publication, deployment, real scheduler control or ownership-lock intervention is part of this handoff.
