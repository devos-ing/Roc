import { z } from "zod";
import type { GitHubCommandRunner } from "./pr-publisher";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Name = z.string().min(1);
const Id = z.number().int().positive();
const RefSchema = z.object({ ref: Name, sha: Sha, repository: Name }).strict();
const PrSchema = z
  .object({
    number: Id,
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    merge_commit_sha: Sha.nullable(),
    draft: z.boolean(),
    mergeable: z.boolean().nullable(),
    mergeable_state: Name,
    head: RefSchema,
    base: RefSchema,
  })
  .strict();
const RequiredCheckSchema = z
  .object({
    context: Name,
    app_id: z.number().int().min(-1).nullable(),
  })
  .strict();
const RequiredReviewsSchema = z
  .object({
    required_approving_review_count: z.number().int().min(0).max(6),
    require_code_owner_reviews: z.boolean(),
    require_last_push_approval: z.boolean(),
  })
  .strict();
const ProtectionSchema = z
  .object({
    strict: z.boolean(),
    enforceAdmins: z.boolean(),
    contexts: z.array(Name),
    checks: z.array(RequiredCheckSchema),
    requiredReviews: RequiredReviewsSchema.nullable(),
  })
  .strict();
const RuleSchema = z
  .object({ ruleset_id: Id, type: Name, parameters: z.unknown() })
  .strict();
const RuleReviewsSchema = z
  .object({
    dismiss_stale_reviews_on_push: z.boolean(),
    require_code_owner_review: z.boolean(),
    require_last_push_approval: z.boolean(),
    required_approving_review_count: z.number().int().min(0).max(6),
    required_review_thread_resolution: z.boolean(),
    allowed_merge_methods: z
      .array(z.enum(["merge", "squash", "rebase"]))
      .optional(),
  })
  .strict();
const RuleChecksSchema = z
  .object({
    strict_required_status_checks_policy: z.boolean(),
    required_status_checks: z.array(
      z
        .object({
          context: Name,
          integration_id: Id.nullable().optional(),
        })
        .strict(),
    ),
    do_not_enforce_on_create: z.boolean().optional(),
  })
  .strict();
const CheckSchema = z
  .object({
    id: Id,
    name: Name,
    head_sha: Sha,
    app_id: Id,
    status: z.enum([
      "queued",
      "in_progress",
      "completed",
      "waiting",
      "requested",
      "pending",
    ]),
    conclusion: z
      .enum([
        "success",
        "failure",
        "neutral",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
        "stale",
        "startup_failure",
      ])
      .nullable(),
  })
  .strict();
const StatusSchema = z
  .object({
    id: Id,
    context: Name,
    state: z.enum(["error", "failure", "pending", "success"]),
  })
  .strict();
const ReviewSchema = z
  .object({
    number: Id,
    headRefOid: Sha,
    reviewDecision: z
      .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", ""])
      .nullable(),
  })
  .strict();

export type MergeCandidate = {
  number: number;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
};
export type MergeResult =
  | { kind: "waiting" | "replan"; reason: string }
  | { kind: "refresh"; targetBase: string }
  | { kind: "merged"; mergeCommit: string };

/** Carries only stable, operator-readable failures across the transport boundary. */
class MergeReadError extends Error {}

/** Submits exact-head squash merges only after readable server-enforced protection and fresh authority. */
export class GitHubPullRequestMerger {
  /** Binds all reads and the synchronous merge request to one explicitly named repository. */
  constructor(
    private readonly repository: string,
    private readonly cwd: string,
    private readonly command: GitHubCommandRunner,
  ) {}

  /** Reconciles remote truth before and after a guarded merge without trusting the write response. */
  async reconcile(
    candidate: MergeCandidate,
    authorize: () => Promise<string | undefined>,
    signal: AbortSignal,
  ): Promise<MergeResult> {
    try {
      signal.throwIfAborted();
      const pr = await this.readPr(candidate.number);
      const existing = this.classify(pr, candidate);
      if (existing) return existing;
      const refresh = await this.changedBase(pr, candidate, authorize, signal);
      if (refresh) return refresh;
      const reason = await this.policy(candidate, pr, signal);
      if (reason) return { kind: "waiting", reason };
      const final = await this.readPr(candidate.number);
      const changed = this.classify(final, candidate);
      if (changed) return changed;
      const finalRefresh = await this.changedBase(
        final,
        candidate,
        authorize,
        signal,
      );
      if (finalRefresh) return finalRefresh;
      if (
        final.draft ||
        final.mergeable !== true ||
        final.mergeable_state !== "clean"
      )
        return {
          kind: "waiting",
          reason:
            "GitHub requires a non-draft, clean, mergeable PR with all branch requirements satisfied",
        };
      // Refresh Issue authority last, after all potentially slow PR and policy reads.
      const denied = await authorize();
      if (denied) return { kind: "waiting", reason: denied };
      signal.throwIfAborted();
      try {
        await this.command.run({
          cwd: this.cwd,
          command: [
            "gh",
            "api",
            `repos/${this.repository}/pulls/${candidate.number}/merge`,
            "--method",
            "PUT",
            "-f",
            "merge_method=squash",
            "-f",
            `sha=${candidate.headSha}`,
          ],
        });
      } catch {
        // A lost response may follow a successful merge; never infer the outcome locally.
      }
      // Always read back, even on cancellation, HTTP errors or a malformed success response.
      const confirmed = this.classify(
        await this.readPr(candidate.number),
        candidate,
      );
      return (
        confirmed ?? {
          kind: "waiting",
          reason:
            "GitHub has not confirmed the squash merge; inspect PR requirements before the next poll",
        }
      );
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof MergeReadError)) throw error;
      return { kind: "waiting", reason: error.message };
    }
  }

  /** Offers a fresh target only after unchanged PR identity and current Issue authority have been checked. */
  private async changedBase(
    pr: z.infer<typeof PrSchema>,
    candidate: MergeCandidate,
    authorize: () => Promise<string | undefined>,
    signal: AbortSignal,
  ): Promise<MergeResult | undefined> {
    const targetBase = await this.baseSha(candidate.baseBranch);
    if (targetBase !== candidate.baseSha) {
      const denied = await authorize();
      signal.throwIfAborted();
      return denied
        ? { kind: "waiting", reason: denied }
        : { kind: "refresh", targetBase };
    }
    if (pr.base.sha !== candidate.baseSha)
      return {
        kind: "waiting",
        reason:
          "PR base snapshot and target ref disagree; waiting for consistent GitHub state",
      };
    return undefined;
  }

  /** Rejects changed PR identity and recognizes only a remotely confirmed merge of the exact head. */
  private classify(
    pr: z.infer<typeof PrSchema>,
    candidate: MergeCandidate,
  ): MergeResult | undefined {
    if (
      pr.number !== candidate.number ||
      pr.head.repository !== this.repository ||
      pr.base.repository !== this.repository ||
      pr.head.ref !== candidate.headBranch ||
      pr.base.ref !== candidate.baseBranch ||
      pr.head.sha !== candidate.headSha
    )
      return {
        kind: "replan",
        reason:
          "Published PR repository, head or target identity changed; explicit replan required",
      };
    if (pr.merged && pr.state === "closed" && pr.merge_commit_sha)
      return { kind: "merged", mergeCommit: pr.merge_commit_sha };
    if (pr.state === "closed")
      return {
        kind: "replan",
        reason: "Published PR closed without a confirmed merge",
      };
    if (pr.merged)
      throw new MergeReadError(
        "PR merge state is inconsistent; inspect GitHub before retrying",
      );
    return undefined;
  }

  /** Requires strict classic protection, supported active rules, passing exact-head checks and human review decisions. */
  private async policy(
    candidate: MergeCandidate,
    pr: z.infer<typeof PrSchema>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const branch = encodeURIComponent(candidate.baseBranch);
    const protection = await this.api(
      `branches/${branch}/protection`,
      "{strict: .required_status_checks.strict, enforceAdmins: .enforce_admins.enabled, contexts: .required_status_checks.contexts, checks: [.required_status_checks.checks[] | {context, app_id}], requiredReviews: (if .required_pull_request_reviews == null then null else .required_pull_request_reviews | {required_approving_review_count, require_code_owner_reviews, require_last_push_approval} end)}",
      ProtectionSchema,
      "Classic branch protection is missing or unreadable; grant policy read access and configure strict required checks enforced for administrators",
    );
    if (!protection.strict || !protection.enforceAdmins)
      return "Enable strict required status checks and enforcement for administrators in classic branch protection";
    const required = [...protection.checks];
    for (const context of protection.contexts)
      if (!required.some((check) => check.context === context))
        required.push({ context, app_id: null });
    if (required.length === 0)
      return "Configure at least one required check in classic branch protection";
    const rules = await this.pages(
      `rules/branches/${branch}`,
      "{total_count: null, items: [.[] | {ruleset_id, type, parameters}]}",
      RuleSchema,
      "Active branch rules are unreadable; grant repository/organization rules read access (private repositories may not support this API)",
      signal,
    );
    const reviews = protection.requiredReviews;
    let requiredReviews =
      !!reviews &&
      (reviews.required_approving_review_count > 0 ||
        reviews.require_code_owner_reviews ||
        reviews.require_last_push_approval);
    for (const rule of rules) {
      if (rule.type === "merge_queue")
        return "Active merge queue rule requires queue support; automatic merge is waiting";
      if (rule.type === "pull_request") {
        const parsed = RuleReviewsSchema.safeParse(rule.parameters);
        if (!parsed.success)
          return "Active pull request rule is unreadable; inspect its review parameters";
        const policy = parsed.data;
        if (
          policy.allowed_merge_methods &&
          !policy.allowed_merge_methods.includes("squash")
        )
          return "Active pull request rule does not allow squash merge";
        requiredReviews ||=
          policy.required_approving_review_count > 0 ||
          policy.require_code_owner_review ||
          policy.require_last_push_approval;
      } else if (rule.type === "required_status_checks") {
        const parsed = RuleChecksSchema.safeParse(rule.parameters);
        if (!parsed.success)
          return "Active required status check rule is unreadable; inspect its parameters";
        for (const check of parsed.data.required_status_checks)
          required.push({
            context: check.context,
            app_id: check.integration_id ?? null,
          });
      } else if (
        !["deletion", "non_fast_forward", "required_linear_history"].includes(
          rule.type,
        )
      )
        return `Active branch rule '${rule.type}' is not supported; automatic merge is waiting`;
      else if (rule.parameters !== null)
        return `Active branch rule '${rule.type}' has unknown parameters; inspect repository rules`;
    }
    const checks = await this.pages(
      `commits/${candidate.headSha}/check-runs?filter=latest`,
      "{total_count, items: [.check_runs[] | {id, name, head_sha, app_id: .app.id, status, conclusion}]}",
      CheckSchema,
      "Head check runs are unreadable; grant checks read access and retry",
      signal,
    );
    const statuses = await this.pages(
      `commits/${candidate.headSha}/statuses`,
      "{total_count: null, items: [.[] | {id, context, state}]}",
      StatusSchema,
      "Head commit statuses are unreadable; grant commit status read access and retry",
      signal,
    );
    // Status history is newest-first; retain only the newest result for each context.
    const latest = new Map<string, z.infer<typeof StatusSchema>>();
    for (const status of statuses) {
      const old = latest.get(status.context);
      if (!old || status.id > old.id) latest.set(status.context, status);
    }
    if (checks.some((check) => check.head_sha !== candidate.headSha))
      return "Reported check head does not match the reviewed head";
    if (
      checks.some(
        (check) =>
          check.status !== "completed" || check.conclusion !== "success",
      ) ||
      [...latest.values()].some((status) => status.state !== "success")
    )
      return "All reported head checks and statuses must pass; failing, pending, skipped or neutral results are waiting";
    for (const check of required) {
      const app = check.app_id !== null && check.app_id !== -1;
      if (
        !checks.some(
          (run) =>
            run.name === check.context && (!app || run.app_id === check.app_id),
        ) &&
        (app || latest.get(check.context)?.state !== "success")
      )
        return `Required check '${check.context}' is missing on the reviewed head${app ? ` from app ${check.app_id}` : ""}`;
    }
    const review = await this.read(
      [
        "gh",
        "pr",
        "view",
        String(candidate.number),
        "--repo",
        this.repository,
        "--json",
        "number,headRefOid,reviewDecision",
      ],
      ReviewSchema,
      "Required human review decision is unreadable; inspect PR reviews",
    );
    if (
      review.number !== candidate.number ||
      review.headRefOid !== candidate.headSha
    )
      return "Human review decision does not match the reviewed PR head";
    if (
      review.reviewDecision === "CHANGES_REQUESTED" ||
      review.reviewDecision === "REVIEW_REQUIRED" ||
      (requiredReviews && review.reviewDecision !== "APPROVED")
    )
      return "Required human GitHub reviews are not approved";
    if (pr.draft || pr.mergeable !== true || pr.mergeable_state !== "clean")
      return "GitHub requires a non-draft, clean, mergeable PR with all branch requirements satisfied";
    return undefined;
  }

  /** Reads projected PR fields through a strict schema without accepting fork or ref substitutions. */
  private readPr(number: number) {
    return this.api(
      `pulls/${number}`,
      "{number, state, merged, merge_commit_sha, draft, mergeable, mergeable_state, head: {ref: .head.ref, sha: .head.sha, repository: .head.repo.full_name}, base: {ref: .base.ref, sha: .base.sha, repository: .base.repo.full_name}}",
      PrSchema,
      "PR state is unreadable; reconcile remote merge state before retrying",
    );
  }

  /** Reads the current target ref independently of the PR's base snapshot. */
  private async baseSha(branch: string): Promise<string> {
    return (
      await this.api(
        `git/ref/heads/${encodeURIComponent(branch)}`,
        "{ref, sha: .object.sha, type: .object.type}",
        z
          .object({
            ref: z.literal(`refs/heads/${branch}`),
            sha: Sha,
            type: z.literal("commit"),
          })
          .strict(),
        "Target branch identity is unreadable; inspect the configured base branch",
      )
    ).sha;
  }

  /** Reads every bounded REST page, rejecting duplicate records or a potentially truncated result. */
  private async pages<T>(
    path: string,
    projection: string,
    schema: z.ZodType<T>,
    reason: string,
    signal: AbortSignal,
  ): Promise<T[]> {
    const all: T[] = [];
    const seen = new Set<string>();
    let total: number | null | undefined;
    for (let page = 1; page <= 100; page++) {
      signal.throwIfAborted();
      const result = await this.api(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        projection,
        z
          .object({
            items: z.array(schema).max(100),
            total_count: z.number().int().nonnegative().nullable(),
          })
          .strict(),
        reason,
      );
      if (total === undefined) total = result.total_count;
      if (result.total_count !== total)
        throw new MergeReadError(`${reason}; pagination changed while reading`);
      for (const item of result.items) {
        const key = JSON.stringify(item);
        if (seen.has(key))
          throw new MergeReadError(
            `${reason}; pagination returned duplicate records`,
          );
        seen.add(key);
        all.push(item);
      }
      if (result.items.length < 100) {
        if (total !== null && all.length !== total)
          throw new MergeReadError(`${reason}; pagination is incomplete`);
        return all;
      }
    }
    throw new MergeReadError(
      `${reason}; pagination exceeded the 100-page safety bound`,
    );
  }

  /** Projects only consumed REST fields so missing, mistyped or unknown policy values fail validation. */
  private api<T>(
    path: string,
    projection: string,
    schema: z.ZodType<T>,
    reason: string,
  ): Promise<T> {
    return this.read(
      [
        "gh",
        "api",
        `repos/${this.repository}/${path}`,
        "--method",
        "GET",
        "--jq",
        projection,
      ],
      schema,
      reason,
    );
  }

  /** Sanitizes command and schema failures without swallowing caller authority or checkpoint errors. */
  private async read<T>(
    command: string[],
    schema: z.ZodType<T>,
    reason: string,
  ): Promise<T> {
    try {
      const result = await this.command.run({ command, cwd: this.cwd });
      if (result.exitCode !== 0) throw Error("GitHub read failed");
      return schema.parse(JSON.parse(result.stdout));
    } catch {
      throw new MergeReadError(reason);
    }
  }
}
