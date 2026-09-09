# Mixed-effort live validation, 2026-09-09

The requested GPT-6 Astra routing worked in real Pi sessions: Scout and Review
used `high`, and Implement used `medium`. A complete repeat also passed protected
automatic merge and base refresh. An unexplained cancellation in the first run
remains open in [Issue #79](https://github.com/devos-ing/Roc/issues/79). This is
evidence of working paths, not a claim that every run is reliable.

## Tasks and results

Both runs used source `e2a9de4494d444379bfd61884af2e89b4165fee8` and fixture seed
`61394ef68de7f8a75c316be83a20c60915a095da` on isolated acceptance branches.
The duration task handled missing/nonfinite input, negative values, milliseconds,
minutes and unbounded hours. The usage task summed input/output without counting
cached input twice, retained incomplete-usage information and preserved frozen inputs.

| Run | Task | Outcome |
| --- | --- | --- |
| First | [#71 duration](https://github.com/devos-ing/Roc/issues/71) | [PR #74](https://github.com/devos-ing/Roc/pull/74) auto-merged; `done` |
| First | [#72 usage](https://github.com/devos-ing/Roc/issues/72) | Implement, Review and CI passed; [PR #73](https://github.com/devos-ing/Roc/pull/73) remains open, with `needs_replan` |
| Traced repeat | [#75 duration](https://github.com/devos-ing/Roc/issues/75) | Rebased, passed fresh Review and CI; [PR #78](https://github.com/devos-ing/Roc/pull/78) auto-merged |
| Traced repeat | [#76 usage](https://github.com/devos-ing/Roc/issues/76) | [PR #77](https://github.com/devos-ing/Roc/pull/77) auto-merged; `done` |

## What was verified

- The acceptance scripts were committed before execution and failed against the
  unimplemented fixtures. Agents could change only the named implementation files.
- The controller used Roc's production GitHub store, task pool, branch manager,
  Pi backend and merger. Its admission view was restricted to the two fixture
  Issues. Other repository tasks were not eligible for the test.
- All 13 real role attempts across both runs used `openai-codex/gpt-6-astra`.
  Pi's `set_thinking_level` and subsequent `get_state` responses confirmed four
  medium Implement attempts and nine high Scout/Review attempts. Each attempt
  had a distinct Pi session; usage was recorded without fabricated attempts.
- The repeat's two tasks overlapped in separate worktrees. A base refresh retained
  the original Implement result and dispatched a new high Review of the rewritten head.
- Both `Lint and format` and `Routing acceptance` were required checks from GitHub
  Actions app ID 15368, with strict up-to-date checks and administrator enforcement.
  The functional CI job ran the prewritten checks for the changed implementation.
- Verification read the actual PR heads and merge commits, checked ancestry in
  the fetched target, and reran the unchanged acceptance scripts. The repeat's
  total diff contained only the two implementation files; checks and workflows
  were unchanged. Main and the product feature branch were not merge targets.

The first run recorded 74,315 input-plus-output tokens before stopping. The
successful repeat recorded 84,472 across seven attempts, including fresh Review.
These are different tasks from the M4 benchmark, so they do not establish a
before/after saving from lowering Implement effort.

## Unresolved first-run cancellation

Issue #72 saved a refresh intent but no result. A local `TASK_EXECUTION_FAILED`
diagnostic was followed by a cancellation reason in the checkpoint. Its clean
worktree retained the original implementation head; no refresh backup ref existed.
The original exception was not retained, so its cause could not be established.

The repeat added a test-only exception recorder around `refreshBase` and used new
Issues. It succeeded and recorded no exception. This does not explain the first
failure or prove a fix. The first checkpoint and open PR were preserved for #79;
they were not rewritten as successful completion.

## Isolation and evidence

Pi processes ran under macOS Seatbelt with separate worktree access and isolated
provider state. Probes denied reads of the original credential file and writes
outside allowed directories. All 15 clients across the two runs closed, no
ownership lock remained, and copied Pi/home/temporary directories were removed.
Worktrees, remote checkpoints and local proof files were retained. Network access
remained enabled; this was a single-Mac filesystem sandbox, not physical two-host acceptance.

Local evidence is in `.scratch/role-routing-live/`: `execution-first.json`,
`first-routing-proof.json`, `execution.json`, `summary.json`, `red-baseline.json`
and `sandbox-probes.json`. The execution files include safe Pi RPC model/effort
readbacks alongside the actual attempt and publication records.
