import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type AttemptReceipt,
  type ExecutionRecord,
  type GitHubExecutionStore,
  initialExecution,
  type NativeTask,
} from "../github/execution-store";
import { GitHubPullRequestMerger, type MergeResult } from "../github/pr-merger";
import type {
  GitHubCommandRunner,
  TaskPublisher,
} from "../github/pr-publisher";
import { jsonHash } from "../github/remote-tasks";
import {
  type AgentHarness,
  type HarnessDelivery,
  HarnessDeliverySchema,
  type HarnessEvent,
  type HarnessRoleInput,
  type HarnessStepRequest,
} from "../harness/contracts";
import { AgileError, normalizeError } from "../runtime/errors";
import {
  type TaskBranchManager,
  taskBranchName,
} from "../workspace/task-branch";
import type { ModelAdvisor } from "./model-routing";
import { BunTaskHookRunner, type TaskHookRunner } from "./task-hooks";

const zeroUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};
const PrSchema = z.object({
  number: z.number().int().positive().optional(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  mergeCommit: z.object({ oid: z.string().regex(/^[0-9a-f]{40}$/) }).nullable(),
});

export type GitHubRunnerInput = {
  store: GitHubExecutionStore;
  harness: AgentHarness;
  branches: TaskBranchManager;
  advisor: ModelAdvisor;
  publisher: TaskPublisher;
  command: GitHubCommandRunner;
  cwd: string;
  baseBranch: string;
  autoMerge?: boolean;
  hooks?: TaskHookRunner;
  activity?: (taskId: string, event: HarnessEvent) => void;
  diagnostic?: (message: string) => void;
  logError?: (error: AgileError) => Promise<void>;
  now?: () => string;
  progress?: (record: ExecutionRecord) => void;
};

/** Reports a safe error with its task location without exposing unknown exception contents. */
export async function reportTaskFailure(
  input: Pick<GitHubRunnerInput, "logError" | "diagnostic">,
  task: NativeTask,
  error: unknown,
): Promise<AgileError> {
  const normalized = normalizeError(error, {
    code: "TASK_EXECUTION_FAILED",
    category: "infra",
    component: "scheduler",
    retryable: false,
    message:
      "Task execution failed; inspect retained work before creating an approved recovery task",
  });
  const diagnostic = new AgileError({
    ...normalized,
    message: `${normalized.message} Phase: ${task.execution?.phase ?? task.task.status}.`,
    taskId: task.task.id,
    attemptId: task.execution?.attempts.at(-1)?.descriptor.attemptId,
    cause: error,
  });
  await input.logError?.(diagnostic).catch(() => {
    input.diagnostic?.("Could not write the task diagnostic log");
  });
  return diagnostic;
}

/** Executes one admitted Issue with its own role and hook cancellation scope. */
export class GitHubTaskRunner {
  private activeAttempt?: string;
  admissionChanged = false;
  private pendingStart?: Promise<unknown>;
  private coordinated?: {
    task: NativeTask;
    stop: AbortController;
    done: Promise<void>;
    stopReason?: string;
  };
  /** Connects remote checkpoints to the existing Pi, Git and hook execution boundaries. */
  constructor(private readonly input: GitHubRunnerInput) {
    this.hooks = input.hooks ?? new BunTaskHookRunner();
  }
  private readonly hooks: TaskHookRunner;

  /** Advances the first eligible task, leaving blocked plans and unmerged dependencies alone. */
  async runOnce(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const { tasks, diagnostics } = await this.input.store.list(signal);
    for (const diagnostic of diagnostics) this.input.diagnostic?.(diagnostic);
    const task = await this.claimNext(tasks, signal);
    if (!task) return false;
    await this.execute(task, signal);
    return true;
  }

  /** Claims the first admissible Issue after repairing labels and verifying dependency merges. */
  async claimNext(
    tasks: NativeTask[],
    signal: AbortSignal,
    admit: (task: NativeTask) => boolean = () => true,
  ): Promise<NativeTask | undefined> {
    this.admissionChanged = false;
    for (let task of tasks) {
      signal.throwIfAborted();
      if (!admit(task)) continue;
      await this.input.store
        .syncLabels(task)
        .catch(() =>
          this.input.diagnostic?.(
            `Issue #${task.issue.number}: status label synchronization is pending`,
          ),
        );
      if (task.execution?.phase === "done") {
        if (task.issue.state === "OPEN") await this.repairClosure(task, signal);
        continue;
      }
      if (
        !task.blockedReason &&
        (task.execution?.phase === "awaiting_merge" ||
          (task.execution?.phase === "reviewing" &&
            task.execution.refreshes?.length))
      ) {
        await this.coordinate(task, signal);
        continue;
      }
      if (!task.approved || task.blockedReason || task.issue.state !== "OPEN")
        continue;
      if (
        task.execution &&
        ["rejected", "failed_infra"].includes(task.execution.phase)
      ) {
        const record = task.execution;
        const hook = record.hooks.posthook;
        if (
          !task.task.spec.posthook ||
          hook?.status === "succeeded" ||
          record.failure === "posthook exhausted retries" ||
          record.failure === "Interrupted posthook requires reconciliation"
        )
          continue;
        if (
          record.failure === "Untrusted posthook" &&
          !this.input.store.hookTrusted(task, "posthook")
        )
          continue;
        return task;
      }
      const trustedHookResume =
        task.task.status === "needs_input" &&
        (["prehook", "posthook"] as const).some(
          (phase) =>
            task.execution?.failure === `Untrusted ${phase}` &&
            this.input.store.hookTrusted(task, phase),
        );
      if (
        !trustedHookResume &&
        ![
          "ready",
          "claimed",
          "scouting",
          "implementing",
          "reviewing",
          "publishing",
        ].includes(task.task.status)
      )
        continue;
      if (!task.execution) {
        const plan = await this.input.store.freshPlan(task, signal);
        const fresh = plan.tasks.find(
          (item) => item.issue.number === task.issue.number,
        );
        if (
          !fresh ||
          fresh.execution ||
          !fresh.approved ||
          fresh.blockedReason ||
          fresh.issue.state !== "OPEN" ||
          fresh.task.status !== "ready" ||
          jsonHash(fresh.envelope) !== jsonHash(task.envelope)
        )
          continue;
        task = fresh;
        const chain = task.task.spec.continues
          ? this.chainBase(task, tasks)
          : undefined;
        if (task.task.spec.continues && !chain) continue;
        const base = chain
          ? chain.base
          : await this.dependencyBase(task, plan.tasks, signal);
        if (!base) continue;
        const confirmed = await this.input.store.freshPlan(task, signal);
        if (confirmed.version !== plan.version) {
          this.admissionChanged = true;
          return undefined;
        }
        signal.throwIfAborted();
        task.execution = initialExecution(
          task,
          chain?.baseBranch ?? this.input.baseBranch,
          base,
          this.now(),
        );
        await this.input.store.save(task, task.execution, signal);
      }
      return task;
    }
    return undefined;
  }

  /** Executes an already reserved Issue without selecting or claiming any other task. */
  async execute(task: NativeTask, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (
      task.execution &&
      ["rejected", "failed_infra"].includes(task.execution.phase)
    ) {
      await this.runHook(task, task.execution, "posthook", signal);
    } else await this.runTask(task, signal);
  }

  /** Records interrupted execution after confirmed cleanup without overwriting changed specifications. */
  async interrupt(task: NativeTask, reason: string): Promise<boolean> {
    const fresh = await this.input.store.get(task.issue.number);
    const record = fresh.execution;
    if (!record || record.specHash !== jsonHash(fresh.envelope)) return false;
    if (
      record.phase === "done" ||
      (record.phase === "awaiting_merge" &&
        !record.refreshes?.some((refresh) => !refresh.result))
    )
      return false;
    if (!["rejected", "failed_infra", "done"].includes(record.phase))
      record.phase = "needs_replan";
    record.failure = reason;
    if (record.refreshes?.length) delete record.mergeReview;
    for (const attempt of record.attempts) {
      if (attempt.status !== "running") continue;
      attempt.status = "blocked_policy";
      attempt.failure = reason;
      attempt.retryable = false;
      attempt.endedAt = this.now();
    }
    await this.checkpoint(fresh, record, new AbortController().signal, true);
    return true;
  }

  /** Cancels the currently owned role and hook processes without starting new work. */
  async cancel(): Promise<void> {
    // A first dispatch may still be registering its child with the harness.
    await this.pendingStart?.catch(() => undefined);
    await Promise.all([
      this.activeAttempt
        ? this.input.harness.cancel(this.activeAttempt)
        : Promise.resolve(),
      this.hooks.stop(),
    ]);
  }

  /** Cancels and drains only the selector-owned Issue, including uncancellable Git mutation and readback. */
  async cancelCoordinated(
    taskId?: string,
    reason = "Task cancellation requested",
  ): Promise<void> {
    const owned = this.coordinated;
    if (!owned || (taskId !== undefined && taskId !== owned.task.task.id))
      return;
    if (owned.stopReason === undefined)
      this.input.diagnostic?.(
        `Issue #${owned.task.issue.number}: cancelling coordinated work; ${reason}`,
      );
    owned.stopReason ??= reason;
    owned.stop.abort();
    await this.cancel();
    await owned.done.catch((error) => {
      if (error instanceof AgileError) throw error;
    });
  }

  /** Stops selector-owned work when the pool's next remote poll withdraws its authority. */
  async cancelUnapproved(
    tasks: NativeTask[],
    signal: AbortSignal,
  ): Promise<void> {
    const owned = this.coordinated;
    if (!owned) return;
    const fresh = tasks.find((task) => task.task.id === owned.task.task.id);
    const reason = await this.input.store.confirmCancellation(
      owned.task,
      fresh,
      signal,
    );
    signal.throwIfAborted();
    if (this.coordinated === owned && reason)
      await this.cancelCoordinated(owned.task.task.id, reason);
  }

  /** Keeps refresh and fresh Review inside the serialized selector with task-local cancellation and recovery. */
  private async coordinate(
    task: NativeTask,
    signal: AbortSignal,
  ): Promise<void> {
    const stop = new AbortController();
    const combined = AbortSignal.any([signal, stop.signal]);
    const owned: NonNullable<GitHubTaskRunner["coordinated"]> = {
      task,
      stop,
      done: Promise.resolve(),
    };
    this.coordinated = owned;
    owned.done = (async () => {
      try {
        if (task.execution?.phase === "reviewing")
          await this.reviewRefresh(task, combined);
        else await this.reconcileMerge(task, combined);
      } catch (error) {
        const diagnostic = await reportTaskFailure(this.input, task, error);
        try {
          await this.cancel();
        } catch {
          throw await reportTaskFailure(
            this.input,
            task,
            new AgileError({
              code: "TASK_CLEANUP_UNCONFIRMED",
              category: "infra",
              component: "scheduler",
              retryable: false,
              message:
                "Coordinator cleanup could not be confirmed; execution ownership must be retained",
            }),
          );
        }
        if (
          error instanceof AgileError &&
          error.code === "GITHUB_CHECKPOINT_UNCONFIRMED"
        )
          throw error;
        const interrupted = await this.interrupt(
          task,
          combined.aborted
            ? `Task cancelled: ${owned.stopReason ?? "Daemon shutdown requested"}; execution requires replan`
            : `${diagnostic.code}: ${diagnostic.message}`,
        );
        signal.throwIfAborted();
        if (!interrupted && !combined.aborted) throw error;
      }
    })();
    try {
      await owned.done;
    } finally {
      this.coordinated = undefined;
    }
  }

  /** Saves a new checkpoint revision after the current operation and before the next one. */
  private async checkpoint(
    task: NativeTask,
    record: ExecutionRecord,
    signal: AbortSignal,
    cleanup = false,
  ): Promise<void> {
    signal.throwIfAborted();
    record.revision += 1;
    record.updatedAt = this.now();
    if (record.timeline && record.timeline.at(-1)?.phase !== record.phase)
      record.timeline.push({ phase: record.phase, at: record.updatedAt });
    await this.input.store.save(task, record, cleanup ? undefined : signal);
    this.input.progress?.(record);
    signal.throwIfAborted();
  }

  /** Reads the execution clock for durable phase times and activity coalescing. */
  private now(): string {
    return this.input.now?.() ?? new Date().toISOString();
  }

  /** Resolves the frozen branch segment of the declared chain predecessor, or explains why the chain is blocked. */
  private chainBase(
    task: NativeTask,
    tasks: NativeTask[],
  ): { base: string; baseBranch: string } | undefined {
    const continues = task.task.spec.continues;
    if (!continues) return undefined;
    const predecessor = tasks.find(
      (candidate) => candidate.issue.number === continues.issue,
    );
    if (!predecessor) {
      this.input.diagnostic?.(
        `Issue #${task.issue.number}: chain predecessor issue #${continues.issue} not found`,
      );
      return undefined;
    }
    const publication = predecessor.execution?.publication;
    if (
      predecessor.execution?.phase !== "awaiting_merge" ||
      !publication?.branch ||
      !publication.commitSha
    ) {
      this.input.diagnostic?.(
        `Issue #${task.issue.number}: chain predecessor issue #${continues.issue} has no frozen branch segment yet`,
      );
      return undefined;
    }
    return { base: publication.commitSha, baseBranch: publication.branch };
  }

  /** Chain tickets merge through the global target; other tickets verify their recorded base. */
  private mergeTargetBase(task: NativeTask, record: ExecutionRecord): string {
    return task.task.spec.continues ? this.input.baseBranch : record.baseBranch;
  }

  /** Requires chain publications to stay on the shared chain branch; others must own their task branch. */
  private publicationBranchOk(
    task: NativeTask,
    record: ExecutionRecord,
  ): boolean {
    return task.task.spec.continues
      ? record.publication?.branch === record.baseBranch
      : record.publication?.branch === taskBranchName(task.task.id);
  }

  /** Credits a merged chain PR only when the frozen segment is part of the merged history. */
  private async chainMergeResult(
    commitSha: string,
    mergeCommit: string,
  ): Promise<MergeResult> {
    try {
      await this.command([
        "git",
        "merge-base",
        "--is-ancestor",
        commitSha,
        mergeCommit,
      ]);
      return { kind: "merged", mergeCommit };
    } catch {
      return {
        kind: "waiting",
        reason:
          "Published chain segment is not an ancestor of the merged PR head; reconcile the chain branch history",
      };
    }
  }

  /** Credits a ticket continued by any successor with the chain reconciliation exemptions. */
  private isChainPredecessor(
    task: NativeTask,
    tasks: readonly NativeTask[],
  ): boolean {
    return tasks.some(
      (candidate) => candidate.task.spec.continues?.issue === task.issue.number,
    );
  }

  /** Lists every remote task for predecessor detection, degrading to none on listing failure. */
  private async chainDetectionTasks(
    signal: AbortSignal,
  ): Promise<NativeTask[]> {
    try {
      return (await this.input.store.list(signal)).tasks;
    } catch {
      return [];
    }
  }

  /** Fetches a base containing every dependency's confirmed merge commit. */
  private async dependencyBase(
    task: NativeTask,
    tasks: NativeTask[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const commits: string[] = [];
    for (const id of task.envelope.task.spec.dependencies) {
      const dependency = tasks.find(
        (candidate) =>
          candidate.envelope.planId === task.envelope.planId &&
          candidate.envelope.task.id === id,
      );
      if (
        dependency?.execution?.phase !== "done" ||
        !dependency.execution.publication?.number ||
        !dependency.execution.publication.mergeCommit ||
        !dependency.approved ||
        dependency.blockedReason
      )
        return undefined;
      const pr = await this.readPr(
        dependency.execution.publication.number,
        signal,
      );
      signal.throwIfAborted();
      if (
        pr.state !== "MERGED" ||
        pr.baseRefName !== this.input.baseBranch ||
        !pr.mergeCommit ||
        pr.mergeCommit.oid !== dependency.execution.publication.mergeCommit ||
        pr.headRefName !== dependency.execution.publication.branch ||
        pr.headRefOid !== dependency.execution.publication.commitSha
      )
        return undefined;
      commits.push(pr.mergeCommit.oid);
    }
    await this.command(["git", "fetch", "origin", this.input.baseBranch]);
    const base = (
      await this.command([
        "git",
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${this.input.baseBranch}^{commit}`,
      ])
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(base))
      throw Error("Invalid fetched base commit");
    for (const commit of commits)
      await this.command(["git", "merge-base", "--is-ancestor", commit, base]);
    signal.throwIfAborted();
    return base;
  }

  /** Runs the remaining roles and publication for a task with a pinned base. */
  private async runTask(task: NativeTask, signal: AbortSignal): Promise<void> {
    const record = task.execution;
    if (!record) throw Error("Task has no remote checkpoint");
    if (
      record.baseBranch !== this.input.baseBranch &&
      !task.task.spec.continues
    ) {
      record.phase = "needs_replan";
      record.failure = "Configured target branch changed";
      await this.checkpoint(task, record, signal);
      return;
    }
    task.task.baseCommit = record.baseCommit;
    await this.input.branches.prepare(
      task.task.id,
      record.baseCommit,
      task.task.spec.continues ? record.baseBranch : undefined,
    );
    if (!(await this.runHook(task, record, "prehook", signal))) return;
    for (const role of ["scout", "implement", "review"] as const) {
      if (role === "scout" && task.task.spec.skipScout) continue;
      if (!(await this.runRole(task, record, role, signal))) {
        if (["rejected", "failed_infra"].includes(record.phase))
          await this.runHook(task, record, "posthook", signal);
        return;
      }
    }
    const implementation = record.attempts.findLast(
      (attempt) =>
        attempt.status === "succeeded" && attempt.output?.kind === "implement",
    )?.output;
    if (implementation?.kind !== "implement")
      throw Error("Missing validated implementation");
    const fresh = await this.input.store.get(task.issue.number, signal);
    if (!fresh.approved || fresh.blockedReason || fresh.issue.state !== "OPEN")
      return;
    if (!(await this.runHook(task, record, "posthook", signal))) return;
    const workspace = await this.input.branches.prepare(
      task.task.id,
      record.baseCommit,
    );
    record.phase = "publishing";
    record.publication ??= {
      branch: workspace.branch,
      commitSha: implementation.commitSha,
    };
    await this.checkpoint(task, record, signal);
    const publishingAuthority = await this.input.store.get(
      task.issue.number,
      signal,
    );
    signal.throwIfAborted();
    if (
      !publishingAuthority.approved ||
      publishingAuthority.blockedReason ||
      publishingAuthority.issue.state !== "OPEN"
    )
      return;
    const acceptance = this.publicationAcceptance(record);
    const pr = await this.input.publisher.publish({
      task: {
        ...task.task,
        status: "publishing",
        baseCommit: record.baseCommit,
      },
      implementation,
      publication: {
        taskId: task.task.id,
        branch: record.publication.branch,
        baseBranch: record.baseBranch,
        commitSha: record.publication.commitSha,
        status: "pending",
      },
      ...(acceptance === undefined ? {} : { acceptance }),
    });
    signal.throwIfAborted();
    record.publication.number = pr.number;
    record.publication.url = pr.url;
    record.phase = "awaiting_merge";
    await this.checkpoint(task, record, signal);
  }

  /** Executes or recovers one role using its persisted descriptor and exact delivery cursor. */
  private async runRole(
    task: NativeTask,
    record: ExecutionRecord,
    role: "scout" | "implement" | "review",
    signal: AbortSignal,
  ): Promise<boolean> {
    const refresh = role === "review" ? record.refreshes?.at(-1) : undefined;
    let previous = record.attempts.findLast(
      (attempt) =>
        attempt.descriptor.role === role &&
        (!refresh ||
          (attempt.reviewTarget?.headSha === refresh.result?.headSha &&
            attempt.reviewTarget?.baseSha === refresh.targetBase)),
    );
    if (previous?.status === "succeeded")
      return (
        previous.output?.kind !== "review" ||
        previous.output.decision === "accepted"
      );
    while (true) {
      const fresh = await this.input.store.get(task.issue.number, signal);
      signal.throwIfAborted();
      if (
        !fresh.approved ||
        fresh.blockedReason ||
        fresh.issue.state !== "OPEN"
      )
        return false;
      let attempt = previous;
      let created = false;
      if (attempt?.status !== "running") {
        const retry = attempt ? attempt.descriptor.retryIndex + 1 : 0;
        if (retry > 2 || previous?.retryable === false) {
          record.phase = refresh ? "needs_replan" : "failed_infra";
          if (refresh)
            record.failure = "Fresh Review exhausted retries; replan required";
          await this.checkpoint(task, record, signal);
          return false;
        }
        const retryIndex = retry as 0 | 1 | 2;
        if (previous && role === "implement" && !previous.output) {
          const workspace = await this.input.branches.prepare(
            task.task.id,
            record.baseCommit,
          );
          const head = await this.input.command.run({
            command: ["git", "rev-parse", "HEAD"],
            cwd: workspace.path,
          });
          if (head.exitCode !== 0 || head.stdout.trim() !== record.baseCommit) {
            record.phase = "needs_replan";
            record.failure =
              "Implementation history exists without a confirmed role result";
            await this.checkpoint(task, record, signal);
            return false;
          }
        }
        const route = this.input.advisor.decide({
          role,
          risk: task.task.spec.risk,
          retryIndex,
          priorProfile: previous?.descriptor.modelProfile,
          priorErrorCode: previous?.failure,
        });
        if (!route) {
          record.phase = "needs_replan";
          record.failure = "no_compatible_model";
          await this.checkpoint(task, record, signal);
          return false;
        }
        attempt = {
          descriptor: {
            attemptId: randomUUID(),
            taskId: task.task.id,
            role,
            retryIndex,
            model: route.model,
            modelProfile: route.profile,
            effort: route.effort,
          },
          ...(role === "review"
            ? {
                reviewTarget: {
                  headSha: this.reviewHead(record),
                  baseSha: record.baseCommit,
                },
              }
            : {}),
          status: "running",
          startedAt: this.now(),
          sequence: 0,
          events: {},
          usage: { ...zeroUsage },
          usageKnown: false,
        };
        record.attempts.push(attempt);
        created = true;
        record.phase =
          role === "scout"
            ? "scouting"
            : role === "implement"
              ? "implementing"
              : "reviewing";
        await this.checkpoint(task, record, signal);
      }
      const scoutOutput = record.attempts.findLast(
        (item) => item.status === "succeeded" && item.output?.kind === "scout",
      )?.output;
      const scout = scoutOutput?.kind === "scout" ? scoutOutput : undefined;
      const implementation = record.attempts.findLast(
        (item) =>
          item.status === "succeeded" && item.output?.kind === "implement",
      )?.output;
      const ticket = {
        ...task.task,
        status: record.phase,
        baseCommit: record.baseCommit,
      };
      let input: HarnessRoleInput;
      if (role === "scout") input = { role, ticket };
      else if (!scout && !ticket.spec.skipScout)
        throw Error("Missing Scout output");
      else if (role === "implement") input = { role, ticket, scout };
      else if (implementation?.kind === "implement")
        input = {
          role,
          ticket,
          scout,
          implementation: {
            ...implementation,
            commitSha: this.reviewHead(record),
          },
        };
      else throw Error("Missing Implement output");
      if (input.role === "review")
        await this.input.branches.assertReviewReady(
          task.task.id,
          input.implementation.commitSha,
          record.baseCommit,
        );
      let request: HarnessStepRequest = {
        mode: created ? "dispatch" : "reconcile",
        attempt: attempt.descriptor,
        input,
        backendCursor: attempt.cursor,
      };
      this.activeAttempt = attempt.descriptor.attemptId;
      try {
        while (attempt.status === "running") {
          signal.throwIfAborted();
          const step = this.input.harness.step(request);
          if (
            request.mode === "dispatch" &&
            request.backendCursor === undefined
          )
            this.pendingStart = step;
          let delivered: HarnessDelivery;
          try {
            delivered = HarnessDeliverySchema.parse(await step);
          } finally {
            this.pendingStart = undefined;
          }
          signal.throwIfAborted();
          if (delivered.kind === "idle") continue;
          if (delivered.kind === "closed")
            throw Error("Harness closed before role completion");
          const event = delivered.event;
          if (event.attemptId !== attempt.descriptor.attemptId)
            throw Error("Mismatched attempt event");
          const hash = jsonHash(event);
          if (attempt.events[event.eventId] !== undefined) {
            if (attempt.events[event.eventId] !== hash)
              throw Error("Conflicting repeated event");
          } else {
            if (event.sequence <= attempt.sequence)
              throw Error("Non-monotonic attempt event");
            attempt.sequence = event.sequence;
            this.input.activity?.(task.task.id, event);
            if (event.type === "attempt.activity") {
              attempt.activity = {
                ...event.activity,
                occurredAt: event.occurredAt,
              };
              if (
                Date.parse(this.now()) - Date.parse(record.updatedAt) >=
                30_000
              ) {
                attempt.cursor = delivered.nextCursor;
                await this.checkpoint(task, record, signal);
              }
            } else {
              if (
                event.type === "attempt.completed" &&
                input.role === "review" &&
                attempt.output?.kind === "review" &&
                attempt.output.decision === "accepted"
              )
                await this.input.branches.assertReviewReady(
                  task.task.id,
                  input.implementation.commitSha,
                  record.baseCommit,
                );
              attempt.events[event.eventId] = hash;
              this.applyEvent(record, attempt, event);
              attempt.cursor = delivered.nextCursor;
              await this.checkpoint(task, record, signal);
            }
          }
          request = {
            ...request,
            mode: "dispatch",
            backendCursor: delivered.nextCursor,
          };
        }
      } finally {
        if (attempt.status !== "running") this.activeAttempt = undefined;
      }
      if (attempt.status === "succeeded")
        return (
          role !== "review" ||
          (attempt.output?.kind === "review" &&
            attempt.output.decision === "accepted")
        );
      if (attempt.status === "blocked_policy") return false;
      previous = attempt;
    }
  }

  /** Applies one validated non-activity delivery to the remote checkpoint candidate. */
  private applyEvent(
    record: ExecutionRecord,
    attempt: AttemptReceipt,
    event: HarnessEvent,
  ): void {
    if (event.type === "attempt.usage_delta") {
      for (const key of Object.keys(zeroUsage) as (keyof typeof zeroUsage)[])
        attempt.usage[key] += event[key];
    } else if (event.type === "attempt.output") {
      if (event.output.kind !== attempt.descriptor.role)
        throw Error("Role output mismatch");
      attempt.output = event.output;
    } else if (event.type === "attempt.completed") {
      if (!attempt.output)
        throw Error("Role completed without validated output");
      attempt.status = "succeeded";
      attempt.endedAt = event.occurredAt;
      attempt.usageKnown = true;
      if (attempt.output.kind === "review") {
        delete record.mergeReview;
        if (attempt.output.decision === "rejected") {
          record.phase = record.refreshes?.length ? "needs_replan" : "rejected";
          if (record.refreshes?.length)
            record.failure =
              "Fresh Review rejected the rebased patch; replan required";
        } else {
          const implementation = record.attempts.findLast(
            (item) =>
              item.status === "succeeded" && item.output?.kind === "implement",
          )?.output;
          if (implementation?.kind !== "implement")
            throw Error("Missing reviewed implementation");
          record.mergeReview = {
            specHash: record.specHash,
            headSha: attempt.reviewTarget?.headSha ?? implementation.commitSha,
            baseSha: attempt.reviewTarget?.baseSha ?? record.baseCommit,
            reviewAttemptId: attempt.descriptor.attemptId,
          };
        }
      }
    } else if (
      event.type === "attempt.failed_infra" ||
      event.type === "attempt.blocked_policy"
    ) {
      attempt.status =
        event.type === "attempt.failed_infra"
          ? "failed_infra"
          : "blocked_policy";
      attempt.failure = event.code;
      attempt.retryable =
        event.type === "attempt.failed_infra" && event.retryable;
      attempt.endedAt = event.occurredAt;
      if (event.type === "attempt.blocked_policy") {
        record.phase = "needs_replan";
        record.failure = event.code;
      }
    }
  }

  /** Runs an explicitly trusted hook and persists attempts before and after side effects. */
  private async runHook(
    task: NativeTask,
    record: ExecutionRecord,
    phase: "prehook" | "posthook",
    signal: AbortSignal,
  ): Promise<boolean> {
    const hook = task.task.spec[phase];
    if (!hook) return true;
    const fresh = await this.input.store.get(task.issue.number, signal);
    signal.throwIfAborted();
    if (!fresh.approved || fresh.blockedReason || fresh.issue.state !== "OPEN")
      return false;
    const terminal = ["rejected", "failed_infra"].includes(record.phase);
    if (!this.input.store.hookTrusted(fresh, phase)) {
      if (!terminal) record.phase = "needs_input";
      record.failure = `Untrusted ${phase}`;
      await this.checkpoint(task, record, signal);
      return false;
    }
    const hash = jsonHash({ phase, hook });
    let receipt = record.hooks[phase];
    if (receipt?.hash === hash && receipt.status === "succeeded") return true;
    if (receipt?.status === "running") {
      if (!terminal) record.phase = "needs_replan";
      record.failure = `Interrupted ${phase} requires reconciliation`;
      await this.checkpoint(task, record, signal);
      return false;
    }
    const workspace = await this.input.branches.prepare(
      task.task.id,
      record.baseCommit,
    );
    while ((receipt?.attempts ?? 0) < 3) {
      receipt = {
        hash,
        status: "running",
        attempts: (receipt?.attempts ?? 0) + 1,
      };
      record.hooks[phase] = receipt;
      await this.checkpoint(task, record, signal);
      const outcome = await this.hooks.run({ hook, cwd: workspace.path });
      signal.throwIfAborted();
      receipt.status = outcome.succeeded ? "succeeded" : "failed";
      if (outcome.succeeded && record.failure === `Untrusted ${phase}`)
        delete record.failure;
      await this.checkpoint(task, record, signal);
      if (outcome.succeeded) return true;
    }
    record.failure = `${phase} exhausted retries`;
    if (!["rejected", "failed_infra"].includes(record.phase))
      record.phase = phase === "prehook" ? "failed_infra" : "needs_replan";
    await this.checkpoint(task, record, signal);
    return false;
  }

  /** Repairs only Issue closure, rechecking merge evidence without replaying completed execution. */
  private async repairClosure(
    task: NativeTask,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      signal.throwIfAborted();
      const record = task.execution;
      const publication = record?.publication;
      const chain =
        Boolean(task.task.spec.continues) ||
        this.isChainPredecessor(task, await this.chainDetectionTasks(signal));
      if (
        task.blockedReason ||
        !task.approved ||
        record?.phase !== "done" ||
        !publication?.number ||
        !publication.mergeCommit ||
        (!chain && record.baseBranch !== this.input.baseBranch) ||
        !this.publicationBranchOk(task, record)
      )
        throw Error("Missing closure evidence");
      const pr = await this.readPr(publication.number, signal);
      if (
        pr.number !== publication.number ||
        pr.state !== "MERGED" ||
        pr.baseRefName !== this.mergeTargetBase(task, record) ||
        pr.headRefName !== publication.branch ||
        (!chain && pr.headRefOid !== publication.commitSha) ||
        pr.mergeCommit?.oid !== publication.mergeCommit
      )
        throw Error("Merge evidence changed");
      if (chain && pr.mergeCommit)
        await this.command([
          "git",
          "merge-base",
          "--is-ancestor",
          publication.commitSha,
          pr.mergeCommit.oid,
        ]);
      const targetBase = this.mergeTargetBase(task, record);
      await this.command(["git", "fetch", "origin", targetBase]);
      await this.command([
        "git",
        "merge-base",
        "--is-ancestor",
        publication.mergeCommit,
        `refs/remotes/origin/${targetBase}`,
      ]);
      signal.throwIfAborted();
      await this.input.store.closeCompleted(task);
    } catch {
      const error = new AgileError({
        code: "GITHUB_ISSUE_CLOSE_PENDING",
        category: "infra",
        component: "github-state",
        retryable: true,
        taskId: task.task.id,
        message: `Issue #${task.issue.number}: completed checkpoint retained; closure pending. Check approval, specification, PR merge evidence and repository access; polling will retry`,
      });
      this.input.diagnostic?.(error.message);
      await this.input.logError?.(error).catch(() => undefined);
    }
  }

  /** Marks completion only after the intended PR head was merged into the configured target. */
  private async reconcileMerge(
    task: NativeTask,
    signal: AbortSignal,
  ): Promise<void> {
    const fresh = await this.input.store.get(task.issue.number, signal);
    signal.throwIfAborted();
    Object.assign(task, fresh);
    const record = task.execution;
    if (!record?.publication?.number || record.phase !== "awaiting_merge")
      return;
    if (!fresh.approved || fresh.blockedReason) return;
    let result: MergeResult;
    if (record.refreshes?.some((refresh) => !refresh.result)) {
      result = {
        kind: "replan",
        reason:
          "Interrupted base refresh intent requires reconciliation; Git will not be replayed",
      };
    } else if (
      record.baseBranch !== this.input.baseBranch &&
      !task.task.spec.continues
    ) {
      result = { kind: "replan", reason: "Configured target branch changed" };
    } else if (!this.publicationBranchOk(task, record)) {
      result = {
        kind: "replan",
        reason: "Publication is not the Roc-owned task branch; replan required",
      };
    } else if (
      this.input.autoMerge &&
      fresh.issue.state === "OPEN" &&
      !task.task.spec.continues
    ) {
      if (!this.hasMergeReview(record)) {
        result = {
          kind: "replan",
          reason:
            "Exact successful independent Review evidence is missing or mismatched; explicit replan required",
        };
      } else {
        const merger = new GitHubPullRequestMerger(
          this.input.store.repository,
          this.input.cwd,
          this.input.command,
        );
        result = await merger.reconcile(
          {
            number: record.publication.number,
            headBranch: record.publication.branch,
            headSha: record.publication.commitSha,
            baseBranch: record.baseBranch,
            baseSha: record.baseCommit,
          },
          async () => {
            const authority = await this.input.store.get(
              task.issue.number,
              signal,
            );
            signal.throwIfAborted();
            if (
              !authority.approved ||
              authority.blockedReason ||
              authority.issue.state !== "OPEN"
            )
              return "Trusted Issue approval is missing or withdrawn, or the Issue is not open";
            if (
              jsonHash(authority.envelope) !== record.specHash ||
              jsonHash(authority.execution) !== jsonHash(record)
            )
              return "Issue specification or execution evidence changed before merge; reconcile the remote checkpoint";
            return undefined;
          },
          signal,
        );
      }
    } else {
      // Auto-closed Issues may recover a completed merge, but never submit one.
      const pr = await this.readPr(record.publication.number, signal);
      const chain =
        Boolean(task.task.spec.continues) ||
        this.isChainPredecessor(task, await this.chainDetectionTasks(signal));
      if (
        pr.baseRefName !== this.mergeTargetBase(task, record) ||
        pr.headRefName !== record.publication.branch ||
        (!chain && pr.headRefOid !== record.publication.commitSha) ||
        pr.state === "CLOSED"
      )
        result = {
          kind: "replan",
          reason: "Published PR changed or closed without merge",
        };
      else if (pr.state === "MERGED" && pr.mergeCommit) {
        result = chain
          ? await this.chainMergeResult(
              record.publication.commitSha,
              pr.mergeCommit.oid,
            )
          : { kind: "merged", mergeCommit: pr.mergeCommit.oid };
      } else return;
    }
    signal.throwIfAborted();
    if (result.kind === "refresh") {
      await this.refreshBase(task, result.targetBase, signal);
      return;
    }
    if (result.kind === "merged") {
      try {
        const targetBase = this.mergeTargetBase(task, record);
        await this.command(["git", "fetch", "origin", targetBase]);
        await this.command([
          "git",
          "merge-base",
          "--is-ancestor",
          result.mergeCommit,
          `refs/remotes/origin/${targetBase}`,
        ]);
      } catch {
        result = {
          kind: "waiting",
          reason:
            "Remote merge is not yet verified in the fetched target; check origin access and merge ancestry",
        };
      }
    }
    signal.throwIfAborted();
    const phase =
      result.kind === "merged"
        ? "done"
        : result.kind === "replan"
          ? "needs_replan"
          : "awaiting_merge";
    const reason = result.kind === "merged" ? undefined : result.reason;
    if (record.phase === phase && record.failure === reason) return;
    if (result.kind === "merged")
      record.publication.mergeCommit = result.mergeCommit;
    record.phase = phase;
    if (reason) record.failure = reason;
    else delete record.failure;
    await this.checkpoint(task, record, signal);
    if (record.phase === "done") await this.repairClosure(task, signal);
  }

  /** Persists a bounded intent before any Git mutation and a confirmed result before dispatching fresh Review. */
  private async refreshBase(
    task: NativeTask,
    targetBase: string,
    signal: AbortSignal,
  ): Promise<void> {
    const record = task.execution;
    const publication = record?.publication;
    if (!record || !publication) throw Error("Missing refresh publication");
    if ((record.refreshes?.length ?? 0) >= 2) {
      record.phase = "needs_replan";
      record.failure =
        "Automatic base refresh budget exhausted (two cycles); replan required";
      await this.checkpoint(task, record, signal);
      return;
    }
    const refresh: NonNullable<ExecutionRecord["refreshes"]>[number] = {
      expectedHead: publication.commitSha,
      expectedBase: record.baseCommit,
      targetBase,
      budgetRemaining: 1 - (record.refreshes?.length ?? 0),
    };
    record.refreshes ??= [];
    record.refreshes.push(refresh);
    delete record.mergeReview;
    delete record.failure;
    await this.checkpoint(task, record, signal);
    const authority = await this.input.store.get(task.issue.number, signal);
    signal.throwIfAborted();
    if (
      !authority.approved ||
      authority.blockedReason ||
      authority.issue.state !== "OPEN" ||
      jsonHash(authority.envelope) !== record.specHash ||
      jsonHash(authority.execution) !== jsonHash(record)
    )
      throw Error("Issue authority changed before base refresh");
    if (!(await this.invalidateChecklistPublication(task, record, signal)))
      return;
    const headSha = await this.input.branches.refresh(task.task.id, {
      ...refresh,
      baseBranch: record.baseBranch,
    });
    signal.throwIfAborted();
    refresh.result = { headSha };
    record.baseCommit = targetBase;
    publication.commitSha = headSha;
    record.phase = "reviewing";
    await this.checkpoint(task, record, signal);
    await this.reviewRefresh(task, signal);
  }

  /** Resumes only a confirmed refresh's independent Review without replaying Implement, hooks or publication. */
  private async reviewRefresh(
    task: NativeTask,
    signal: AbortSignal,
  ): Promise<void> {
    const fresh = await this.input.store.get(task.issue.number, signal);
    signal.throwIfAborted();
    Object.assign(task, fresh);
    const record = task.execution;
    if (
      record?.phase !== "reviewing" ||
      !fresh.approved ||
      fresh.blockedReason ||
      fresh.issue.state !== "OPEN"
    )
      return;
    if (record.baseBranch !== this.input.baseBranch)
      throw Error("Configured target branch changed");
    const head = this.reviewHead(record);
    if (!record.refreshes?.length || head !== record.publication?.commitSha)
      throw Error("Confirmed refreshed publication is missing or mismatched");
    task.task.baseCommit = record.baseCommit;
    await this.input.branches.assertReviewReady(
      task.task.id,
      head,
      record.baseCommit,
    );
    if (!(await this.runRole(task, record, "review", signal))) return;
    if (!this.hasMergeReview(record))
      throw Error("Fresh Review evidence is missing or mismatched");
    if (!(await this.refreshChecklistPublication(task, record, signal))) return;
    record.phase = "awaiting_merge";
    delete record.failure;
    await this.checkpoint(task, record, signal);
    // CI and PR authority must be reread on a later coordinator poll for the rewritten head.
  }

  /** Derives the exact Review target from the original Implement output and a complete bounded refresh chain. */
  private reviewHead(record: ExecutionRecord): string {
    const implementation = record.attempts.findLast(
      (attempt) => attempt.descriptor.role === "implement",
    );
    if (
      implementation?.status !== "succeeded" ||
      implementation.output?.kind !== "implement"
    )
      throw Error("Missing validated implementation");
    let head = implementation.output.commitSha;
    let base = record.refreshes?.[0]?.expectedBase ?? record.baseCommit;
    for (const [index, refresh] of (record.refreshes ?? []).entries()) {
      if (
        !refresh.result ||
        refresh.expectedHead !== head ||
        refresh.expectedBase !== base ||
        refresh.targetBase === base ||
        refresh.result.headSha === head ||
        refresh.budgetRemaining !== 1 - index
      )
        throw Error(
          "Interrupted or mismatched base refresh requires reconciliation",
        );
      head = refresh.result.headSha;
      base = refresh.targetBase;
    }
    if (base !== record.baseCommit)
      throw Error("Confirmed refresh base does not match the checkpoint");
    return head;
  }

  /** Requires the latest independent accepted Review to bind the approved spec, published head and pinned base. */
  private hasMergeReview(record: ExecutionRecord): boolean {
    const evidence = record.mergeReview;
    const review = record.attempts.findLast(
      (attempt) => attempt.descriptor.role === "review",
    );
    const implementation = record.attempts.findLast(
      (attempt) => attempt.descriptor.role === "implement",
    );
    let head: string;
    try {
      head = this.reviewHead(record);
    } catch {
      return false;
    }
    return (
      !!evidence &&
      evidence.specHash === record.specHash &&
      evidence.baseSha === record.baseCommit &&
      evidence.headSha === record.publication?.commitSha &&
      review?.descriptor.attemptId === evidence.reviewAttemptId &&
      review.status === "succeeded" &&
      review.output?.kind === "review" &&
      review.output.decision === "accepted" &&
      implementation?.status === "succeeded" &&
      implementation.output?.kind === "implement" &&
      head === evidence.headSha &&
      (!record.refreshes?.length ||
        (review.reviewTarget?.headSha === head &&
          review.reviewTarget.baseSha === record.baseCommit)) &&
      implementation.descriptor.attemptId !== review.descriptor.attemptId &&
      record.attempts.indexOf(review) > record.attempts.indexOf(implementation)
    );
  }

  /** Returns only Review evidence that is bound to the current specification, base, and published head. */
  private publicationAcceptance(record: ExecutionRecord) {
    if (!this.hasMergeReview(record) || !record.mergeReview) return undefined;
    const review = record.attempts.find(
      (attempt) =>
        attempt.descriptor.attemptId === record.mergeReview?.reviewAttemptId,
    );
    if (review?.output?.kind !== "review") return undefined;
    return {
      review: review.output,
      binding: {
        currentSpecHash: record.specHash,
        reviewedSpecHash: record.mergeReview.specHash,
        currentHeadSha: record.publication?.commitSha ?? "",
        reviewedHeadSha: record.mergeReview.headSha,
        currentBaseSha: record.baseCommit,
        reviewedBaseSha: record.mergeReview.baseSha,
      },
    };
  }

  /** Reconciles the existing PR body after a rebased head receives fresh independent Review evidence. */
  private async refreshChecklistPublication(
    task: NativeTask,
    record: ExecutionRecord,
    signal: AbortSignal,
  ): Promise<boolean> {
    const acceptance = this.publicationAcceptance(record);
    if (acceptance === undefined || record.publication === undefined)
      throw Error("Fresh Review publication evidence is missing");
    return this.reconcileChecklistPublication(task, record, signal, acceptance);
  }

  /** Replaces stale checked rows with unverified rows before the refreshed head is lease-pushed. */
  private async invalidateChecklistPublication(
    task: NativeTask,
    record: ExecutionRecord,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.reconcileChecklistPublication(task, record, signal, undefined);
  }

  /** Updates only the existing PR body after verifying its current remote head without pushing the task branch. */
  private async reconcileChecklistPublication(
    task: NativeTask,
    record: ExecutionRecord,
    signal: AbortSignal,
    acceptance: ReturnType<typeof this.publicationAcceptance> | undefined,
  ): Promise<boolean> {
    const implementation = record.attempts.findLast(
      (attempt) =>
        attempt.status === "succeeded" && attempt.output?.kind === "implement",
    )?.output;
    const publication = record.publication;
    if (implementation?.kind !== "implement" || publication === undefined)
      throw Error("Refreshed publication implementation is missing");
    const authority = await this.input.store.get(task.issue.number, signal);
    signal.throwIfAborted();
    if (
      !authority.approved ||
      authority.blockedReason ||
      authority.issue.state !== "OPEN"
    )
      return false;
    const pr = await this.input.publisher.publish({
      task: {
        ...task.task,
        status: "publishing",
        baseCommit: record.baseCommit,
      },
      implementation,
      publication: {
        taskId: task.task.id,
        branch: publication.branch,
        baseBranch: record.baseBranch,
        commitSha: publication.commitSha,
        status: "pending",
      },
      reconcileOnly: true,
      ...(acceptance === undefined ? {} : { acceptance }),
    });
    signal.throwIfAborted();
    publication.number = pr.number;
    publication.url = pr.url;
    return true;
  }

  /** Reads only the PR fields needed for dependency and completion verification. */
  private async readPr(number: number, signal?: AbortSignal) {
    return PrSchema.parse(
      JSON.parse(
        await this.command(
          [
            "gh",
            "pr",
            "view",
            String(number),
            "--repo",
            this.input.store.repository,
            "--json",
            "number,state,baseRefName,headRefName,headRefOid,mergeCommit",
          ],
          signal,
        ),
      ),
    );
  }

  /** Executes a bounded GitHub or Git command without exposing its raw diagnostics. */
  private async command(
    command: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.input.command.run({
      command,
      cwd: this.input.cwd,
      signal,
    });
    if (result.exitCode !== 0)
      throw Error("GitHub or Git execution boundary failed");
    return result.stdout;
  }
}
