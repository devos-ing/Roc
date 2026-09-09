import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type AttemptReceipt,
  type ExecutionRecord,
  type GitHubExecutionStore,
  initialExecution,
  type NativeTask,
} from "../github/execution-store";
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
import type { TaskBranchManager } from "../workspace/task-branch";
import type { ModelAdvisor } from "./model-routing";
import { BunTaskHookRunner, type TaskHookRunner } from "./task-hooks";

const zeroUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};
const PrSchema = z.object({
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
  hooks?: TaskHookRunner;
  activity?: (taskId: string, event: HarnessEvent) => void;
  diagnostic?: (message: string) => void;
};

/** Executes one admitted Issue with its own role and hook cancellation scope. */
export class GitHubTaskRunner {
  private activeAttempt?: string;
  private pendingStart?: Promise<unknown>;
  /** Connects remote checkpoints to the existing Pi, Git and hook execution boundaries. */
  constructor(private readonly input: GitHubRunnerInput) {
    this.hooks = input.hooks ?? new BunTaskHookRunner();
  }
  private readonly hooks: TaskHookRunner;

  /** Advances the first eligible task, leaving blocked plans and unmerged dependencies alone. */
  async runOnce(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const { tasks, diagnostics } = await this.input.store.list();
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
    for (const task of tasks) {
      signal.throwIfAborted();
      if (!admit(task)) continue;
      await this.input.store
        .syncLabels(task)
        .catch(() =>
          this.input.diagnostic?.(
            `Issue #${task.issue.number}: status label synchronization is pending`,
          ),
        );
      if (task.execution?.phase === "awaiting_merge" && !task.blockedReason) {
        await this.reconcileMerge(task, signal);
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
        const base = await this.dependencyBase(task, tasks, signal);
        if (!base) continue;
        task.execution = initialExecution(task, this.input.baseBranch, base);
        await this.input.store.save(task, task.execution);
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
    if (record.phase === "awaiting_merge" || record.phase === "done")
      return false;
    if (
      !["rejected", "failed_infra", "done", "awaiting_merge"].includes(
        record.phase,
      )
    )
      record.phase = "needs_replan";
    record.failure = reason;
    for (const attempt of record.attempts) {
      if (attempt.status !== "running") continue;
      attempt.status = "blocked_policy";
      attempt.failure = reason;
      attempt.retryable = false;
      attempt.endedAt = new Date().toISOString();
    }
    await this.checkpoint(fresh, record, new AbortController().signal);
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

  /** Saves a new checkpoint revision after the current operation and before the next one. */
  private async checkpoint(
    task: NativeTask,
    record: ExecutionRecord,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    await this.input.store.save(task, record);
    signal.throwIfAborted();
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
        !dependency?.execution?.publication?.number ||
        dependency.blockedReason
      )
        return undefined;
      const pr = await this.readPr(dependency.execution.publication.number);
      signal.throwIfAborted();
      if (
        pr.state !== "MERGED" ||
        pr.baseRefName !== this.input.baseBranch ||
        !pr.mergeCommit ||
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
    if (record.baseBranch !== this.input.baseBranch) {
      record.phase = "needs_replan";
      record.failure = "Configured target branch changed";
      await this.checkpoint(task, record, signal);
      return;
    }
    task.task.baseCommit = record.baseCommit;
    await this.input.branches.prepare(task.task.id, record.baseCommit);
    if (!(await this.runHook(task, record, "prehook", signal))) return;
    for (const role of ["scout", "implement", "review"] as const) {
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
    const fresh = await this.input.store.get(task.issue.number);
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
    const publishingAuthority = await this.input.store.get(task.issue.number);
    signal.throwIfAborted();
    if (
      !publishingAuthority.approved ||
      publishingAuthority.blockedReason ||
      publishingAuthority.issue.state !== "OPEN"
    )
      return;
    const pr = await this.input.publisher.publish({
      task: { ...task.task, status: "publishing" },
      implementation,
      publication: {
        taskId: task.task.id,
        branch: record.publication.branch,
        baseBranch: record.baseBranch,
        commitSha: record.publication.commitSha,
        status: "pending",
      },
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
    let previous = record.attempts.findLast(
      (attempt) => attempt.descriptor.role === role,
    );
    if (previous?.status === "succeeded")
      return (
        previous.output?.kind !== "review" ||
        previous.output.decision === "accepted"
      );
    while (true) {
      const fresh = await this.input.store.get(task.issue.number);
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
          record.phase = "failed_infra";
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
          status: "running",
          startedAt: new Date().toISOString(),
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
      const scout = record.attempts.findLast(
        (item) => item.status === "succeeded" && item.output?.kind === "scout",
      )?.output;
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
      else if (scout?.kind !== "scout") throw Error("Missing Scout output");
      else if (role === "implement") input = { role, ticket, scout };
      else if (implementation?.kind === "implement")
        input = { role, ticket, scout, implementation };
      else throw Error("Missing Implement output");
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
            if (event.type !== "attempt.activity") {
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
      if (
        attempt.output.kind === "review" &&
        attempt.output.decision === "rejected"
      )
        record.phase = "rejected";
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
    const fresh = await this.input.store.get(task.issue.number);
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

  /** Marks completion only after the intended PR head was merged into the configured target. */
  private async reconcileMerge(
    task: NativeTask,
    signal: AbortSignal,
  ): Promise<void> {
    const record = task.execution;
    if (!record?.publication?.number) return;
    const pr = await this.readPr(record.publication.number);
    signal.throwIfAborted();
    if (
      pr.baseRefName !== record.baseBranch ||
      pr.headRefName !== record.publication.branch ||
      pr.headRefOid !== record.publication.commitSha ||
      pr.state === "CLOSED"
    ) {
      record.phase = "needs_replan";
      record.failure = "Published PR changed or closed without merge";
    } else if (pr.state === "MERGED" && pr.mergeCommit) {
      await this.command(["git", "fetch", "origin", record.baseBranch]);
      await this.command([
        "git",
        "merge-base",
        "--is-ancestor",
        pr.mergeCommit.oid,
        `refs/remotes/origin/${record.baseBranch}`,
      ]);
      record.publication.mergeCommit = pr.mergeCommit.oid;
      record.phase = "done";
    } else return;
    await this.checkpoint(task, record, signal);
  }

  /** Reads only the PR fields needed for dependency and completion verification. */
  private async readPr(number: number) {
    return PrSchema.parse(
      JSON.parse(
        await this.command([
          "gh",
          "pr",
          "view",
          String(number),
          "--repo",
          this.input.store.repository,
          "--json",
          "state,baseRefName,headRefName,headRefOid,mergeCommit",
        ]),
      ),
    );
  }

  /** Executes a bounded GitHub or Git command without exposing its raw diagnostics. */
  private async command(command: string[]): Promise<string> {
    const result = await this.input.command.run({
      command,
      cwd: this.input.cwd,
    });
    if (result.exitCode !== 0)
      throw Error("GitHub or Git execution boundary failed");
    return result.stdout;
  }
}
