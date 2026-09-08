# PR review ledger contract

Set `SKILL_DIR` to the absolute directory containing the loaded `SKILL.md`. Invoke the ledger CLI as `python -B "$SKILL_DIR/scripts/ledger.py" <subcommand> ...`.

## Commands

`path` validates every identity component, resolves the result below `--state-root`, and prints the raw filesystem path without JSON quoting:

```sh
python -B "$SKILL_DIR/scripts/ledger.py" path --state-root "$CODEX_HOME/state/pr-review-to-closure" --host <host> --owner <owner> --repo <repo> --pr <number>
```

Host, owner, and repository components accept only ASCII letters, digits, `.`, `_`, and `-`. Empty values, `.`, `..`, separators, absolute paths, whitespace, and other characters are invalid. The PR number must be a positive integer. Resolution fails if a symlink or another path feature would escape the state root.

Other commands are:

```text
init     --file F --host H --owner O --repo R --pr N --base-sha B --head-sha H
validate --file F [--require-complete]
write    --file F --input JSON [--expected-revision N]
recover  --file F --input JSON
summary  --file F
```

`init` creates only an incomplete bootstrap. `write` accepts only a complete ledger. Omit `--expected-revision` only when no canonical file and no invalid backup exists. Replacing or upgrading an existing ledger requires the exact saved revision. `summary` and `validate --require-complete` reject incomplete state.

## Exact top-level shape

The validator rejects missing and additional fields. An initialized ledger is exactly:

```json
{
  "version": 1,
  "revision": 0,
  "review_state": "incomplete",
  "pull_request": {
    "host": "github.com",
    "owner": "OWNER",
    "repo": "REPO",
    "number": 123
  },
  "base_sha": "BASE_SHA",
  "last_reviewed_head_sha": "HEAD_SHA",
  "lineage_resets": [],
  "findings": [],
  "review_evidence": null,
  "verification": null,
  "recommendation": null
}
```

An incomplete ledger must remain revision `0` with empty lineage and findings arrays plus null review evidence, verification, and recommendation. It is a reservation, not evidence of a completed review.

A completed ledger uses the same exact fields with `review_state: "complete"`, canonical review evidence, verification, and recommendation objects, and zero or more canonical findings. `version` is the integer `1`; `revision` is a non-negative integer; booleans do not count as integers. The pull request object has exactly `host`, `owner`, `repo`, and positive integer `number`.

## Revisions and replacement

A first complete write to an absent path uses revision `0`. Upgrading an initialized ledger uses revision `1` with expected revision `0`. Every later replacement must set:

```text
replacement.revision = canonical.revision + 1
--expected-revision = canonical.revision
```

The script holds an exclusive sidecar lock while it reads, compares, validates, and replaces the canonical file. A stale writer fails without changing canonical bytes. The replacement uses a same-directory temporary file, flushes it, atomically replaces the canonical name, and flushes the directory.

Across a replacement:

- `pull_request` identity is unchanged.
- Existing finding IDs remain present.
- Each existing finding keeps its `axis` and `first_seen_sha`.
- Existing history and lineage arrays remain exact prefixes of their replacements.
- A disposition change has appended history that starts at the prior disposition and ends at the replacement disposition.
- New transition records cite the replacement head SHA.
- A new finding cites the replacement head and uses a number above the prior maximum for its axis.
- A base SHA change has a newly appended `base_drift` record matching the prior and replacement base and head SHAs.

If the compare fails, reload the new canonical revision and reconcile it. Never retry stale JSON unchanged.

## Finding shape and identity

Every finding has exactly these fields:

```json
{
  "id": "STD-001",
  "axis": "standards",
  "severity": "P1",
  "blocking": true,
  "summary": "A concise problem statement",
  "location": "path/to/file.ts:42",
  "evidence": "Concrete observed evidence and its source",
  "first_seen_sha": "HEAD_SHA",
  "acceptance": "Observable condition that closes the finding",
  "disposition": "open",
  "history": []
}
```

Use `STD-001`, `STD-002`, and so on for `standards`; use `SPEC-001`, `SPEC-002`, and so on for `spec`. Numeric suffixes have at least three digits and are positive. Prefix and axis must match. IDs are unique, permanent, never deleted, and never reused.

Severity is `P0`, `P1`, `P2`, or `P3`. `blocking` is a JSON boolean. Summary, location, evidence, first-seen SHA, and acceptance are non-empty strings. Disposition is `open`, `fixed`, `deferred`, or `accepted`.

History is an append-only array. Each entry has exactly:

```json
{
  "from": "deferred",
  "to": "open",
  "reason": "Relevant validation code changed",
  "head_sha": "NEW_HEAD_SHA"
}
```

A finding starts at `open`; its ordered history must end at its current disposition. Allowed transitions are:

```text
open -> fixed | deferred | accepted
fixed -> open only when later relevant code changes or verification regresses
deferred | accepted -> open only with changed relevant code or materially new evidence
```

Every transition needs a specific reason and head SHA. A finding may transition more than once in a review, such as `deferred -> open -> deferred`, but each step remains recorded. An unchanged deferred or accepted finding stays out of the active problem count.

## Lineage records

Each `lineage_resets` entry has exactly:

```json
{
  "kind": "base_drift",
  "previous_base_sha": "OLD_BASE",
  "current_base_sha": "NEW_BASE",
  "previous_head_sha": "OLD_HEAD",
  "current_head_sha": "NEW_HEAD",
  "reason": "The base changed, so the full current-base three-dot diff was reviewed"
}
```

`kind` is `base_drift` or `force_push`. A base-drift entry must change the base SHA. A force-push entry must change the head SHA. New records on a replacement must match the prior ledger's saved base and head plus the replacement base and head. If both events occurred, append both kinds. Keep the full lineage array forever.

## Review evidence and verification

Before verification, a complete ledger records every required review source:

```json
{
  "review_evidence": {
    "head_sha": "HEAD_SHA",
    "sources": {
      "pr_metadata": { "status": "read", "detail": "Resolved with gh pr view." },
      "pr_description": { "status": "read", "detail": "Read from gh pr view." },
      "reviews": { "status": "read", "detail": "Read from gh pr view." },
      "inline_comments": { "status": "read", "detail": "Read from the pull-request review-comment API." },
      "issue_comments": { "status": "read", "detail": "Read from gh pr view." },
      "repository_standards": { "status": "read", "detail": "Read the repository instruction files." }
    }
  }
}
```

`head_sha` must equal `last_reviewed_head_sha`, so evidence from an earlier PR snapshot cannot be reused after the head changes. Each source object has exactly `status` and `detail`. Status is `read` or `missing`; detail is a non-empty retrieval note or failure reason. The six source names are exact and required. Any `missing` source prevents a positive merge recommendation.

A complete ledger has a verification object with exactly:

```json
{
  "command": "pnpm test",
  "head_sha": "HEAD_SHA",
  "status": "passed",
  "output": "Concise command output"
}
```

The head must equal `last_reviewed_head_sha`. Status is `passed`, `failed`, `environment_error`, or `not_run`. `failed` means the command ran and failed. `environment_error` means the environment prevented a meaningful run. `not_run` records a known required command that was not run.

## Recommendation

A merge decision has exactly:

```json
{
  "kind": "merge_decision",
  "outcome": "do_not_merge",
  "head_sha": "HEAD_SHA",
  "reasons": ["Open blocking finding STD-001 has concrete evidence"]
}
```

Outcome is `do_not_merge`, `merge_ready_with_follow_ups`, or `merge_ready`. An indeterminate status has exactly:

```json
{
  "kind": "indeterminate",
  "status": "merge_readiness_not_established",
  "head_sha": "HEAD_SHA",
  "reasons": ["Required verification did not pass"]
}
```

The recommendation head equals `last_reviewed_head_sha`, and reasons is a non-empty list of non-empty strings. The validator applies these total predicates in order:

1. Any concrete-evidence open blocker requires `do_not_merge`.
2. With no blocker, any non-blocking open finding requires `merge_readiness_not_established`.
3. With no open finding, missing required review evidence requires `merge_readiness_not_established`.
4. With complete evidence and no open finding, verification other than `passed` requires `merge_readiness_not_established`.
5. Complete evidence and passed verification with no open finding and at least one deferred or accepted item requires `merge_ready_with_follow_ups`.
6. Complete evidence and passed verification with no open, deferred, or accepted item requires `merge_ready`.

`do_not_merge` is invalid without an open blocker. A positive recommendation is invalid while any finding remains open or verification has not passed.

## Invalid recovery

`recover` accepts a complete validated replacement. When the canonical file exists and is invalid, the script reads its exact bytes, writes and flushes a unique `<pr>.invalid-<timestamp>-<suffix>.json` copy, then atomically replaces the canonical file. It never renames the canonical file away first. A failure before replacement leaves both the original canonical bytes and the durable backup intact.

When the canonical path is absent, `recover` requires an existing matching invalid backup and rebuilds from that recovery state. Without a canonical file or backup it fails. `init` and ordinary first-write paths also fail when orphaned backups exist, preventing silent loss of review history.
