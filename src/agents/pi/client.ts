import type { z } from "zod";
import { AgileError, normalizeError } from "../../runtime/errors";
import { PiEventEnvelopeSchema, PiResponseEnvelopeSchema } from "./protocol";

type PiEvent = z.infer<typeof PiEventEnvelopeSchema>;
type PiProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

type PendingRequest = {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: AgileError) => void;
};

type EventWaiter = {
  resolve: (event: PiEvent) => void;
  reject: (error: AgileError) => void;
};

export type PiClientApi = {
  /**
   * Sends one RPC command and resolves its response data; params are merged
   * into the command object per the Pi wire format.
   */
  request(command: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Sends a fire-and-forget protocol message, e.g. an extension UI response. */
  send(message: Record<string, unknown>): void;
  /** Returns the next queued stdout event or waits until one arrives. */
  nextEvent(): Promise<PiEvent>;
  /** Idempotently closes the client and its child process resources. */
  close(): Promise<void>;
};

/** The deterministic startup flags shared by every spawned Pi process. */
export const PI_DETERMINISM_FLAGS = [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
] as const;

export class PiClient implements PiClientApi {
  private readonly process: PiProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: PiEvent[] = [];
  private readonly eventWaiters: EventWaiter[] = [];
  private readonly stdoutTask: Promise<void>;
  private readonly stderrTask: Promise<void>;
  private readonly exitTask: Promise<void>;
  private nextRequestNumber = 1;
  private writeTail: Promise<void> = Promise.resolve();
  private terminalError: AgileError | undefined;
  private closing = false;
  private closePromise: Promise<void> | undefined;

  /** Creates a client around a spawned Pi process and starts its I/O watchers. */
  private constructor(process: PiProcess) {
    this.process = process;
    this.stdoutTask = this.watchStdout();
    this.stderrTask = this.drainStderr();
    this.exitTask = this.watchExit();
  }

  /**
   * Starts a Pi client. The working directory is process-level state in Pi
   * (there is no per-session workspace parameter), so every attempt must
   * spawn its own child rooted at its task workspace.
   */
  static async start(input: {
    cwd: string;
    command?: string[];
    env?: Record<string, string | undefined>;
  }): Promise<PiClient> {
    const piBin = process.env.PI_BIN;
    const command =
      input.command ??
      (piBin !== undefined && piBin !== ""
        ? [piBin, "--mode", "rpc", ...PI_DETERMINISM_FLAGS]
        : ["pi", "--mode", "rpc", ...PI_DETERMINISM_FLAGS]);

    let spawned: PiProcess;
    try {
      spawned = Bun.spawn(command, {
        cwd: input.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...(input.env ?? {}) },
      });
    } catch (error) {
      throw normalizeError(error, {
        code: "PI_RPC_START_FAILED",
        category: "startup",
        retryable: false,
        component: "pi-client",
        message: "Could not start the Pi RPC process",
      });
    }

    return new PiClient(spawned);
  }

  /** Sends one RPC command and resolves its response data. */
  request(
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }

    const id = `req_${this.nextRequestId()}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { command, resolve, reject });
      void this.enqueueWrite({ type: command, id, ...params }).catch(
        (error: unknown) => {
          this.fail(this.normalizeWriteFailure(error), true);
        },
      );
    });
  }

  /** Sends a fire-and-forget protocol message. */
  send(message: Record<string, unknown>): void {
    if (this.terminalError) {
      return;
    }
    void this.enqueueWrite(message).catch((error: unknown) => {
      this.fail(this.normalizeWriteFailure(error), true);
    });
  }

  /** Returns the next queued stdout event or waits until one arrives. */
  nextEvent(): Promise<PiEvent> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    const event = this.events.shift();
    if (event) {
      return Promise.resolve(event);
    }
    return new Promise((resolve, reject) => {
      this.eventWaiters.push({ resolve, reject });
    });
  }

  /** Idempotently closes the client and its child process resources. */
  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  /** Allocates the next strict-increasing request id. */
  private nextRequestId(): string {
    const id = this.nextRequestNumber;
    this.nextRequestNumber += 1;
    return String(id);
  }

  /** Serializes one message behind prior writes and flushes it to Pi stdin. */
  private enqueueWrite(message: unknown): Promise<void> {
    const operation = this.writeTail.then(async () => {
      if (this.terminalError) {
        throw this.terminalError;
      }

      let line: string;
      try {
        line = `${JSON.stringify(message)}\n`;
      } catch (error) {
        throw normalizeError(error, {
          code: "PI_RPC_WRITE_FAILED",
          category: "infra",
          retryable: true,
          component: "pi-client",
          message: "Could not write to the Pi RPC process",
        });
      }

      try {
        await this.process.stdin.write(line);
        await this.process.stdin.flush();
      } catch (error) {
        // Pipe closure can arrive before Bun observes the child's exit. Give
        // that notification a bounded chance to settle before classifying it.
        if (this.process.exitCode === null) {
          await this.waitForExit(100);
        }
        throw this.normalizeWriteFailure(error);
      }
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  /** Reads stdout, frames complete LF-delimited lines, and dispatches each. */
  private async watchStdout(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.process.stdout.getReader();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = this.consumeCompleteLines(buffer);
      }

      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        this.handleLine(buffer);
      }
    } catch (error) {
      const safeError = normalizeError(error, {
        code: "PI_RPC_READ_FAILED",
        category: "infra",
        retryable: true,
        component: "pi-client",
        message: "Could not read from the Pi RPC process",
      });
      this.fail(safeError, true);
    } finally {
      reader.releaseLock();
    }
  }

  /** Dispatches every complete LF line and returns its trailing partial line. */
  private consumeCompleteLines(buffer: string): string {
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        this.handleLine(line);
      }
      newline = buffer.indexOf("\n");
    }
    return buffer;
  }

  /** Parses and routes one response or event line from the Pi process. */
  private handleLine(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new AgileError({
        code: "PI_RPC_INVALID_JSON",
        category: "protocol",
        retryable: false,
        component: "pi-client",
        message: "Pi RPC process sent invalid JSON",
      });
    }

    const response = PiResponseEnvelopeSchema.safeParse(decoded);
    if (response.success) {
      this.settlePending(response.data);
      return;
    }

    const event = PiEventEnvelopeSchema.safeParse(decoded);
    if (!event.success) {
      throw new AgileError({
        code: "PI_RPC_INVALID_MESSAGE",
        category: "protocol",
        retryable: false,
        component: "pi-client",
        message: "Pi RPC process sent an invalid message",
      });
    }

    const waiter = this.eventWaiters.shift();
    if (waiter) {
      waiter.resolve(event.data);
    } else {
      this.events.push(event.data);
    }
  }

  /** Resolves or rejects the pending request a response envelope answers. */
  private settlePending(
    response: z.infer<typeof PiResponseEnvelopeSchema>,
  ): void {
    let entry: { id: string; pending: PendingRequest } | undefined;
    if (response.id !== undefined) {
      const pending = this.pending.get(response.id);
      if (pending === undefined) return;
      entry = { id: response.id, pending };
    } else {
      // A response may omit its id; correlate by command instead, oldest
      // in-flight first so identical concurrent commands stay FIFO.
      for (const [id, pending] of this.pending) {
        if (pending.command === response.command) {
          entry = { id, pending };
          break;
        }
      }
      if (entry === undefined) return;
    }

    this.pending.delete(entry.id);
    if (response.success) {
      entry.pending.resolve(response.data);
      return;
    }
    // The provider's raw text may embed request payloads or keys, so only
    // the fixed message can reach events, logs, or stderr; the original
    // error travels in the non-persisted cause.
    entry.pending.reject(
      new AgileError({
        code: "PI_RPC_ERROR",
        category: "protocol",
        retryable: false,
        component: "pi-client",
        message: "Pi rejected the command",
        cause: { command: response.command, error: response.error },
        requestId: entry.id,
      }),
    );
  }

  /** Drains child stderr without retaining potentially unsafe text. */
  private async drainStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    try {
      while (!(await reader.read()).done) {
        // Drain without retaining child stderr; it is not safe error text.
      }
    } catch {
      // Process exit is authoritative, and stderr contents are discarded.
    } finally {
      reader.releaseLock();
    }
  }

  /** Converts an unexpected child exit into terminal client failure. */
  private async watchExit(): Promise<void> {
    await this.process.exited;
    await this.stdoutTask;
    if (!this.closing && !this.terminalError) {
      this.fail(this.processExitedError(), false);
    }
  }

  /** Normalizes a write failure, preferring an observed process exit. */
  private normalizeWriteFailure(error: unknown): AgileError {
    if (this.process.exitCode !== null) {
      return this.processExitedError();
    }
    return normalizeError(error, {
      code: "PI_RPC_WRITE_FAILED",
      category: "infra",
      retryable: true,
      component: "pi-client",
      message: "Could not write to the Pi RPC process",
    });
  }

  /** Creates the stable operational error for an exited Pi process. */
  private processExitedError(): AgileError {
    return new AgileError({
      code: "PI_RPC_EXITED",
      category: "infra",
      retryable: true,
      component: "pi-client",
      message: "Pi RPC process exited",
    });
  }

  /** Transitions the client to terminal failure and rejects all consumers. */
  private fail(error: AgileError, killChild: boolean): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.eventWaiters) {
      waiter.reject(error);
    }
    this.eventWaiters.length = 0;
    this.events.length = 0;
    if (killChild && this.process.exitCode === null) {
      this.process.kill();
    }
  }

  /** Performs bounded graceful shutdown before force-killing and draining. */
  private async performClose(): Promise<void> {
    this.closing = true;
    const closedError =
      this.terminalError ??
      new AgileError({
        code: "PI_CLIENT_CLOSED",
        category: "infra",
        retryable: false,
        component: "pi-client",
        message: "Pi client closed",
      });
    this.fail(closedError, false);

    let stdinEnd: Promise<unknown>;
    try {
      stdinEnd = Promise.resolve(this.process.stdin.end());
    } catch {
      stdinEnd = Promise.resolve();
    }

    let exited = await this.waitForExit(2_000);
    if (!exited) {
      this.process.kill("SIGKILL");
      exited = await this.waitForExit(1_000);
    }
    await this.waitForCloseTasks(stdinEnd, 1_000);
    if (!exited) {
      throw new AgileError({
        code: "PI_PROCESS_EXIT_UNCONFIRMED",
        category: "infra",
        retryable: false,
        component: "pi-client",
        message: "Pi process exit could not be confirmed",
      });
    }
  }

  /** Waits for client I/O tasks to settle up to a fixed timeout. */
  private waitForCloseTasks(
    stdinEnd: Promise<unknown>,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      /** Resolves the bounded wait exactly once and clears its timer. */
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      void Promise.allSettled([
        stdinEnd,
        this.stdoutTask,
        this.stderrTask,
        this.exitTask,
      ]).then(finish);
    });
  }

  /** Reports whether the child exits before a timeout. */
  private waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      /** Resolves the exit race exactly once with its observed result. */
      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void this.process.exited.then(
        () => finish(true),
        () => finish(false),
      );
    });
  }
}
