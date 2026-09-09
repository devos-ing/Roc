import type { NativeTask } from "../github/execution-store";
import { AgileError } from "../runtime/errors";
import { type GitHubRunnerInput, GitHubTaskRunner } from "./github-runner";
import { canRunTogether } from "./parallel-admission";

type Worker = {
  task: NativeTask;
  runner: GitHubTaskRunner;
  stop: AbortController;
  done: Promise<void>;
  cancellation?: Promise<void>;
  cancelError?: AgileError;
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

  /** Shares provider and Git boundaries while creating hook and cancellation ownership per task. */
  constructor(
    private readonly input: Omit<GitHubRunnerInput, "hooks"> & {
      concurrency?: 1 | 2;
    },
  ) {
    if (
      input.concurrency !== undefined &&
      input.concurrency !== 1 &&
      input.concurrency !== 2
    )
      throw Error("Concurrency must be 1 or 2");
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
        const { tasks, diagnostics } = await this.input.store.list();
        signal.throwIfAborted();
        for (const message of diagnostics) this.input.diagnostic?.(message);
        for (const worker of this.workers.values()) {
          const fresh = tasks.find(
            (task) => task.task.id === worker.task.task.id,
          );
          if (
            !fresh?.approved ||
            fresh.blockedReason ||
            fresh.issue.state !== "OPEN"
          ) {
            this.requestStop(worker);
          }
        }
        while (
          !this.stopped &&
          !signal.aborted &&
          !this.failure &&
          this.workers.size < limit
        ) {
          const task = await this.selector.claimNext(
            tasks,
            admission,
            (candidate) =>
              !selected.has(candidate.task.id) &&
              !this.workers.has(candidate.task.id) &&
              [...this.workers.values()].every((worker) =>
                canRunTogether(worker.task, candidate),
              ),
          );
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
    } finally {
      this.running = false;
    }
  }

  /** Cancels one Issue or all workers and waits for each owned execution and cleanup path to settle. */
  async cancel(taskId?: string): Promise<void> {
    if (taskId === undefined) {
      this.stopped = true;
      this.admissionStop.abort();
    }
    const workers = [...this.workers.values()].filter(
      (worker) => taskId === undefined || worker.task.task.id === taskId,
    );
    for (const worker of workers) this.requestStop(worker);
    await Promise.all(workers.map((worker) => worker.done));
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
      })
      .finally(() => {
        this.workers.delete(task.task.id);
        this.completions++;
      });
  }

  /** Starts cancellation once and keeps its acknowledgement inside the worker's slot lifetime. */
  private requestStop(worker: Worker): void {
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
      try {
        await worker.runner.cancel();
      } catch {
        throw this.cleanupFailure();
      }
      if (
        error instanceof AgileError &&
        error.code === "GITHUB_CHECKPOINT_UNCONFIRMED"
      )
        throw error;
      const reason = worker.stop.signal.aborted
        ? "Task cancelled; execution requires replan"
        : "Task execution failed; inspect diagnostics and replan";
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
