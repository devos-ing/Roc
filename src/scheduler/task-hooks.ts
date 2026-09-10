import type { TaskHook } from "../domain/schemas";
import { gitPathResolutionEnvironment } from "../workspace/git-environment";
export const TASK_HOOK_MAX_OUTPUT_BYTES = 64 * 1024;
const HOOK_TERMINATION_GRACE_MS = 250;

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

type KillableProcess = {
  pid: number;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
};

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
        env: gitPathResolutionEnvironment(),
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
