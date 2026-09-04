import { createHash } from "node:crypto";
import type { StoredTask, TaskHook, TaskHookPhase } from "../domain/schemas";
import type {
  OrchestrationRepository,
  TaskHookRecord,
} from "../store/orchestration-repository";

export const TASK_HOOK_MAX_ATTEMPTS = 3;
export const TASK_HOOK_MAX_OUTPUT_BYTES = 64 * 1024;
const HOOK_TERMINATION_GRACE_MS = 250;

export type TaskHookWorkspace = { path: string };

export type TaskHookWorkspaceProvider = {
  prepare(taskId: string, baseCommit?: string): Promise<TaskHookWorkspace>;
};

export type TaskHookExecution = {
  succeeded: boolean;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

export type TaskHookRunner = {
  run(input: { hook: TaskHook; cwd: string }): Promise<TaskHookExecution>;
  stop(): Promise<void>;
};

export type TaskHookOutcome =
  | { kind: "skipped" }
  | { kind: "untrusted" }
  | { kind: "succeeded" }
  | { kind: "retrying" }
  | { kind: "failed" };

type KillableProcess = {
  pid: number;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
};

/** Serializes hook configuration in a stable field order for task-scoped trust decisions. */
function canonicalHookConfig(hook: TaskHook): string {
  return JSON.stringify({
    command: hook.command,
    args: hook.args,
    timeoutSeconds: hook.timeoutSeconds,
  });
}

/** Hashes the normalized hook configuration into the exact value that must be trusted. */
export function taskHookConfigHash(hook: TaskHook): string {
  return createHash("sha256").update(canonicalHookConfig(hook)).digest("hex");
}

/** Removes control characters and preserves only complete UTF-8 characters within the output limit. */
export function sanitizeHookOutput(output: string): string {
  const retained: string[] = [];
  let bytes = 0;
  for (const character of output) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) continue;
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > TASK_HOOK_MAX_OUTPUT_BYTES) break;
    retained.push(character);
    bytes += characterBytes;
  }
  return retained.join("");
}

/** Sends one signal to a detached hook process group, falling back to its direct child process. */
function signalProcess(process: KillableProcess, signal: NodeJS.Signals): void {
  try {
    globalThis.process.kill(-process.pid, signal);
  } catch {
    // Group signalling is unavailable on some platforms.
  }
  try {
    process.kill(signal);
  } catch {
    // A process that already exited needs no further cleanup.
  }
}

/** Starts graceful hook termination and escalates to SIGKILL if the process remains alive. */
function terminateProcess(
  process: KillableProcess,
): ReturnType<typeof setTimeout> {
  signalProcess(process, "SIGTERM");
  return setTimeout(
    () => signalProcess(process, "SIGKILL"),
    HOOK_TERMINATION_GRACE_MS,
  );
}

/** Reads a piped Bun subprocess stream while treating non-piped output as empty diagnostics. */
function readPipedOutput(
  output: number | ReadableStream<Uint8Array> | undefined,
): Promise<string> {
  return output instanceof ReadableStream
    ? new Response(output).text()
    : Promise.resolve("");
}

/** Executes argv-only hooks while retaining only bounded, printable diagnostic output. */
export class BunTaskHookRunner implements TaskHookRunner {
  private readonly active = new Set<KillableProcess>();

  /** Runs one hook in its prepared workspace and converts process outcomes into a durable receipt. */
  async run(input: {
    hook: TaskHook;
    cwd: string;
  }): Promise<TaskHookExecution> {
    let subprocess: ReturnType<typeof Bun.spawn>;
    try {
      subprocess = Bun.spawn({
        cmd: [input.hook.command, ...input.hook.args],
        cwd: input.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
    } catch (error) {
      return {
        succeeded: false,
        timedOut: false,
        stdout: "",
        stderr: sanitizeHookOutput(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }

    const process = subprocess as unknown as KillableProcess;
    this.active.add(process);
    let timedOut = false;
    let forcedTermination: ReturnType<typeof setTimeout> | undefined;
    /** Stops the owned process group when the configured timeout expires. */
    const onTimeout = () => {
      timedOut = true;
      forcedTermination = terminateProcess(process);
    };
    const timeout = setTimeout(onTimeout, input.hook.timeoutSeconds * 1_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        readPipedOutput(subprocess.stdout),
        readPipedOutput(subprocess.stderr),
      ]);
      return {
        succeeded: !timedOut && exitCode === 0,
        exitCode,
        signal: subprocess.signalCode ?? undefined,
        timedOut,
        stdout: sanitizeHookOutput(stdout),
        stderr: sanitizeHookOutput(stderr),
      };
    } finally {
      clearTimeout(timeout);
      if (forcedTermination !== undefined) clearTimeout(forcedTermination);
      this.active.delete(process);
    }
  }

  /** Stops every hook process still owned by the current scheduler process. */
  async stop(): Promise<void> {
    const active = [...this.active];
    const forceTimers = active.map(terminateProcess);
    await Promise.all(
      active.map(async (process) => {
        await Promise.race([
          process.exited,
          new Promise<void>((resolve) => {
            setTimeout(resolve, HOOK_TERMINATION_GRACE_MS);
          }),
        ]);
      }),
    );
    for (const timer of forceTimers) clearTimeout(timer);
  }
}

/** Runs trusted task hooks once per durable receipt while preserving at-least-once crash recovery. */
export class TaskHookService {
  /** Connects durable hook state to a workspace provider and an argv-only process runner. */
  constructor(
    private readonly repo: OrchestrationRepository,
    private readonly workspaces: TaskHookWorkspaceProvider,
    private readonly runner: TaskHookRunner = new BunTaskHookRunner(),
  ) {}

  /** Executes one configured phase when trusted, returning its durable scheduler-facing state. */
  async run(
    task: StoredTask,
    phase: TaskHookPhase,
    leaseOwnerId?: string,
    signal?: AbortSignal,
  ): Promise<TaskHookOutcome> {
    signal?.throwIfAborted();
    const hook = task.spec[phase];
    if (hook === undefined) return { kind: "skipped" };
    const configHash = taskHookConfigHash(hook);
    const existing = this.repo.getTaskHook(task.id, phase);
    if (!this.isTrusted(existing, configHash)) return { kind: "untrusted" };
    if (existing?.status === "succeeded") return { kind: "succeeded" };
    if (existing?.attempts === TASK_HOOK_MAX_ATTEMPTS)
      return { kind: "failed" };

    let workspace: TaskHookWorkspace;
    try {
      workspace = await this.workspaces.prepare(task.id, task.baseCommit);
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      return this.recordWorkspaceFailure(
        task,
        phase,
        configHash,
        error,
        leaseOwnerId,
      );
    }
    const started = this.repo.beginTaskHook(
      task.id,
      phase,
      configHash,
      workspace.path,
      leaseOwnerId,
    );
    if (started.kind === "untrusted") return { kind: "untrusted" };
    if (started.kind === "succeeded") return { kind: "succeeded" };
    if (started.kind === "exhausted") return { kind: "failed" };

    let result: TaskHookExecution;
    try {
      result = await this.runner.run({ hook, cwd: workspace.path });
    } catch (error) {
      result = {
        succeeded: false,
        timedOut: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    signal?.throwIfAborted();
    this.repo.finishTaskHook({
      taskId: task.id,
      phase,
      ...result,
      stdout: sanitizeHookOutput(result.stdout),
      stderr: sanitizeHookOutput(result.stderr),
      leaseOwnerId,
    });
    if (result.succeeded) return { kind: "succeeded" };
    return started.attempt === TASK_HOOK_MAX_ATTEMPTS
      ? { kind: "failed" }
      : { kind: "retrying" };
  }

  /** Cancels currently owned hook processes during scheduler shutdown. */
  async stop(): Promise<void> {
    await this.runner.stop();
  }

  /** Checks that a ledger row authorizes the exact configuration now attached to the task. */
  private isTrusted(
    record: TaskHookRecord | undefined,
    configHash: string,
  ): boolean {
    return (
      record !== undefined &&
      record.configHash === configHash &&
      record.trustedHash === configHash
    );
  }

  /** Converts workspace preparation failures into counted hook receipts without starting an agent. */
  private recordWorkspaceFailure(
    task: StoredTask,
    phase: TaskHookPhase,
    configHash: string,
    error: unknown,
    leaseOwnerId?: string,
  ): TaskHookOutcome {
    const started = this.repo.beginTaskHook(
      task.id,
      phase,
      configHash,
      "",
      leaseOwnerId,
    );
    if (started.kind === "untrusted") return { kind: "untrusted" };
    if (started.kind === "succeeded") return { kind: "succeeded" };
    if (started.kind === "exhausted") return { kind: "failed" };
    this.repo.finishTaskHook({
      taskId: task.id,
      phase,
      succeeded: false,
      timedOut: false,
      stdout: "",
      stderr: sanitizeHookOutput(
        error instanceof Error ? error.message : String(error),
      ),
      leaseOwnerId,
    });
    return started.attempt === TASK_HOOK_MAX_ATTEMPTS
      ? { kind: "failed" }
      : { kind: "retrying" };
  }
}
