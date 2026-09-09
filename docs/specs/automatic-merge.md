# Automatic PR merge

M3 follows the approved roadmap. Roc executes the implementation as two dependent
GitHub Issues against `codex/github-native-parallel`, using the existing Pi flow.
The first slice adds guarded automatic merge. The second completes bounded base
refresh and independent re-review. Both slices are required for M3 completion.

## Merge policy

1. Keep manual publication as the default. `scheduler run --auto-merge` opts the
   daemon into automatic squash merge for its managed Issues only.
2. Persist merge review evidence bound to the exact approved envelope hash,
   implementation head, reviewed base and successful independent Review attempt.
   Missing, rejected or mismatched evidence never authorizes merge. Do not invent
   new model attempts when only Git rebases an existing patch.
3. Immediately before merging, refresh the Issue approval/open state, PR state,
   repository/head/base identities, draft flag, checks, required reviews and active
   branch rules. Head changes outside Roc require explicit replan. Unknown or
   unreadable policy/check data fails closed with an actionable recorded reason.
4. Require classic branch protection with strict required status checks and
   enforcement for administrators. Require at least one configured required check,
   and verify its result for the current PR head, including configured app identity
   when present. Additional reported failing/pending checks also prevent merge.
   Respect required human GitHub reviews and active repository/organization rules.
   A merge-queue rule is a visible blocker until queue support is implemented.
5. GitHub's synchronous merge API accepts a head SHA but no base SHA condition.
   Strict up-to-date checks enforced server-side protect the final base race.
   Never use an administrator bypass, disable protection or push directly to the
   target as a substitute for a permitted PR merge. Roc does not change protection
   settings automatically. Explain required repository configuration in the guide.
6. Serialize merge/refresh decisions per repository through the existing single
   admission coordinator. Recheck the approved head/base before the merge request.
   Send the expected head SHA in the merge body. Read actual PR state after both
   successful and ambiguous responses, and verify the merge commit in the fetched
   target before setting done or releasing a dependent Issue.
7. Pending checks or unmet protection/review requirements stay awaiting_merge with
   a stable readable reason. They must not spin, re-run model roles, or write the
   same checkpoint on every poll. A changed external head, closed-unmerged PR,
   exhausted refresh budget or unrecoverable conflict requires replan.

## Base refresh and re-review

8. When the target advances, allow at most two automatic clean rebase/re-review
   cycles for a task. Preserve the original approved specification, all historical
   attempts, usage and original Implement output. Persist an operation intent
   before changing Git state, and a confirmed result before advancing.
9. Refresh only a clean Roc-owned worktree whose branch equals the recorded PR
   head and has its single trusted implementation commit. Rebase the same patch
   onto a freshly fetched target. Abort conflicts and preserve the original work
   for needs_replan. Never overwrite dirty files or an externally changed head.
   Interrupted or ambiguous refresh intents require reconciliation rather than
   blind replay after restart.
10. Push a rewritten task branch only with an explicit expected-old-head lease.
    Run a new independent Pi Review against the new exact clean commit and base,
    including the approved validation commands. Invalidate previous merge evidence
    and wait for CI on the new head. A rejected review never merges. Keep model
    routing and recorded usage attributable to the actual review attempt.
11. Shared Git mutations and coordinator shutdown must finish or retain ownership
    before a successor can work. Approval withdrawal, cancellation and unknown
    GitHub checkpoint writes keep M1/M2's existing boundaries.

## Delivery and acceptance

Issue A implements items 1–7 with changed bases requiring replan until Issue B
lands. Issue B implements items 8–11 and completes M3. Avoid unrelated UI changes,
new storage, Superset, notifications, provider switches or unbounded repair loops.

Use focused transport tests plus a Fake Harness vertical test. Prove accepted
exact-head merge, pending/failed/missing checks, missing protection, unreadable
policy, merge queue, approval withdrawal, changed head, lost merge response,
serialization, clean base refresh and fresh review, conflict/dirty protection,
refresh budget, interrupted intent and rejected re-review. Reuse existing tests
where they already establish an invariant. Give named production functions JSDoc.

After both implementation PRs pass independent review and CI, verify the new
merger against isolated acceptance branches with real GitHub protection and CI.
Private repositories without the required rules API are expected to block.

Sources: [merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request),
[branch protection](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection),
[active branch rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch),
[GitHub CLI checks](https://cli.github.com/manual/gh_pr_checks).
