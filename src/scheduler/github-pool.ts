import type { NativeTask } from "../github/execution-store";
import { AgileError } from "../runtime/errors";
import {
  type GitHubRunnerInput,
  GitHubTaskRunner,
  reportTaskFailure,
} from "./github-runner";
import { canRunTogether } from "./parallel-admission";

type Worker = {
  task: NativeTask;
  runner: GitHubTaskRunner;
  stop: AbortController;
  done: Promise<void>;
  cancellation?: Promise<void>;
  cancelError?: AgileError;
  stopReason?: string;
};

/** Waits for a task completion, a remote refresh deadline or daemon shutdown and removes its listeners. */
async function waitForChange(
  work: Promise<void>[],
  signal: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  try {
    const poll = new Promise<void>((resolve) => {
      wake = () => resolve();
      timer = setTimeout(resolve, 30_000);
      signal.addEventListener("abort", wake, { once: true });
      if (signal.aborted) resolve();
    });
    await Promise.race([...work, poll]);
  } finally {
    clearTimeout(timer);
    if (wake) signal.removeEventListener("abort", wake);
  }
}

/** Owns bounded admission and independent Issue workers for one GitHub daemon. */
export class GitHubTaskPool {
  private readonly workers = new Map<string, Worker>();
  private running = false;
  private stopped = false;
  private failure?: unknown;
  private completions = 0;
  private readonly selector: GitHubTaskRunner;
  private readonly admissionStop = new AbortController();
  private selection?: Promise<NativeTask | undefined>;

  /** Shares provider and Git boundaries while creating hook and cancellation ownership per task. */
  constructor(
    private readonly input: Omit<GitHubRunnerInput, "hooks"> & {
      concurrency?: number;
    },
  ) {
    if (
      input.concurrency !== undefined &&
      (!Number.isInteger(input.concurrency) ||
        input.concurrency < 1 ||
        input.concurrency > 8)
    )
      throw Error("Concurrency must be an integer from 1 through 8");
    this.selector = new GitHubTaskRunner(input);
  }

  /** Refills free slots immediately, refreshing remote authority while other tasks remain in flight. */
  async run(signal: AbortSignal, once = false): Promise<void> {
    if (this.running) throw Error("Task pool is already running");
    this.running = true;
    const limit = once ? 1 : (this.input.concurrency ?? 2);
    const admission = AbortSignal.any([signal, this.admissionStop.signal]);
    try {
      while (!this.stopped) {
        signal.throwIfAborted();
        if (this.failure) throw this.failure;
        const selected = new Set(this.workers.keys());
        const completedBeforeRead = this.completions;
        const tasks = await this.refreshAuthority(admission);
        while (
          !this.stopped &&
          !signal.aborted &&
          !this.failure &&
          this.workers.size < limit
        ) {
          this.selection = this.selector.claimNext(
            tasks,
            admission,
            (candidate) =>
              !this.stopped &&
              !this.failure &&
              !admission.aborted &&
              !selected.has(candidate.task.id) &&
              !this.workers.has(candidate.task.id) &&
              [...this.workers.values()].every((worker) =>
                canRunTogether(worker.task, candidate),
              ),
          );
          let task: NativeTask | undefined;
          try {
            task = await this.awaitSelection(this.selection, admission);
          } finally {
            this.selection = undefined;
          }
          if (!task) break;
          selected.add(task.task.id);
          if (signal.aborted || this.stopped || this.failure) break;
          this.start(task);
          if (once) break;
        }
        if (this.failure) throw this.failure;
        if (once) {
          await Promise.all(
            [...this.workers.values()].map((worker) => worker.done),
          );
          if (this.failure) throw this.failure;
          return;
        }
        if (this.completions !== completedBeforeRead) continue;
        await waitForChange(
          [...this.workers.values()].map((worker) => worker.done),
          admission,
        );
      }
    } catch (error) {
      if (error instanceof AgileError) {
        this.failure ??= error;
        this.admissionStop.abort();
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  /** Refreshes Issue authority for workers and selector-owned Review even while admission is occupied. */
  private async refreshAuthority(signal: AbortSignal): Promise<NativeTask[]> {
    const { tasks, diagnostics } = await this.input.store.list();
    signal.throwIfAborted();
    for (const message of diagnostics) this.input.diagnostic?.(message);
    for (const worker of this.workers.values()) {
      const fresh = tasks.find((task) => task.task.id === worker.task.task.id);
      const reason = await this.input.store.confirmCancellation(
        worker.task,
        fresh,
      );
      signal.throwIfAborted();
      if (reason && this.workers.get(worker.task.task.id) === worker)
        this.requestStop(worker, reason);
    }
    await this.selector.cancelUnapproved(tasks, signal);
    return tasks;
  }

  /** Maintains authority polling during a long refresh/Review while keeping its entire selection owned until drained. */
  private async awaitSelection(
    selection: Promise<NativeTask | undefined>,
    signal: AbortSignal,
  ): Promise<NativeTask | undefined> {
    let settled = false;
    const owned = selection.finally(() => {
      settled = true;
    });
    try {
      while (!settled && !signal.aborted) {
        await waitForChange([owned.then(() => undefined)], signal);
        if (!settled && !signal.aborted) await this.refreshAuthority(signal);
      }
      return await owned;
    } catch (error) {
      this.admissionStop.abort();
      try {
        await this.selector.cancelCoordinated(
          undefined,
          error instanceof AgileError
            ? `Scheduler stopped: ${error.code}`
            : "Authority polling failed",
        );
        await owned.catch(() => undefined);
      } catch (cleanup) {
        throw cleanup instanceof AgileError ? cleanup : this.cleanupFailure();
      }
      throw error;
    }
  }

  /** Cancels workers and selector-owned refresh/merge work, draining mutations and cleanup before releasing ownership. */
  async cancel(taskId?: string): Promise<void> {
    if (taskId === undefined) {
      this.stopped = true;
      this.admissionStop.abort();
    }
    const workers = [...this.workers.values()].filter(
      (worker) => taskId === undefined || worker.task.task.id === taskId,
    );
    const reason = this.failure
      ? `Scheduler stopped: ${this.failure instanceof AgileError ? this.failure.code : "scheduler failure"}`
      : taskId === undefined
        ? "Daemon shutdown requested"
        : "Task cancellation requested";
    for (const worker of workers) this.requestStop(worker, reason);
    await Promise.all([
      ...workers.map((worker) => worker.done),
      this.selector.cancelCoordinated(taskId, reason).catch((error) => {
        this.failure ??=
          error instanceof AgileError ? error : this.cleanupFailure();
        throw this.failure;
      }),
      ...(taskId === undefined && this.selection
        ? [
            this.selection.catch((error) => {
              if (error instanceof AgileError) {
                this.failure ??= error;
                throw error;
              }
            }),
          ]
        : []),
    ]);
    if (this.failure) throw this.failure;
  }

  /** Reserves an Issue synchronously and releases its slot only after its work and cleanup finish. */
  private start(task: NativeTask): void {
    const runner = new GitHubTaskRunner(this.input);
    const stop = new AbortController();
    const worker: Worker = { task, runner, stop, done: Promise.resolve() };
    this.workers.set(task.task.id, worker);
    worker.done = this.execute(worker)
      .finally(async () => {
        await worker.cancellation;
        if (worker.cancelError) throw worker.cancelError;
      })
      .catch((error) => {
        this.failure ??= error;
        this.admissionStop.abort();
      })
      .finally(() => {
        this.workers.delete(task.task.id);
        this.completions++;
      });
  }

  /** Starts cancellation once and keeps its acknowledgement inside the worker's slot lifetime. */
  private requestStop(worker: Worker, reason: string): void {
    if (worker.stopReason === undefined)
      this.input.diagnostic?.(
        `Issue #${worker.task.issue.number}: cancelling task; ${reason}`,
      );
    worker.stopReason ??= reason;
    worker.stop.abort();
    worker.cancellation ??= worker.runner.cancel().catch(() => {
      worker.cancelError = this.cleanupFailure();
      this.failure ??= worker.cancelError;
    });
  }

  /** Contains task-local errors while escalating unconfirmed remote writes or cleanup to the daemon. */
  private async execute(worker: Worker): Promise<void> {
    try {
      await worker.runner.execute(worker.task, worker.stop.signal);
    } catch (error) {
      const diagnostic = await reportTaskFailure(
        this.input,
        worker.task,
        error,
      );
      try {
        await worker.runner.cancel();
      } catch {
        throw await reportTaskFailure(
          this.input,
          worker.task,
          this.cleanupFailure(),
        );
      }
      if (
        error instanceof AgileError &&
        error.code === "GITHUB_CHECKPOINT_UNCONFIRMED"
      )
        throw error;
      const reason = worker.stop.signal.aborted
        ? `Task cancelled: ${worker.stopReason ?? "Daemon shutdown requested"}; execution requires replan`
        : `${diagnostic.code}: ${diagnostic.message}`;
      if (await worker.runner.interrupt(worker.task, reason)) {
        this.input.diagnostic?.(
          `Issue #${worker.task.issue.number}: ${reason}`,
        );
      }
    }
  }

  /** Marks uncertain child ownership so runtime retains the repository guard. */
  private cleanupFailure(): AgileError {
    return new AgileError({
      code: "TASK_CLEANUP_UNCONFIRMED",
      category: "infra",
      component: "scheduler",
      retryable: false,
      message:
        "Task cleanup could not be confirmed; execution ownership must be retained",
    });
  }
}
