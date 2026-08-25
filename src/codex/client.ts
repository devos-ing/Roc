import { z } from "zod";
import { AgileError, normalizeError } from "../runtime/errors";
import { ResponseEnvelopeSchema, ServerMessageSchema } from "./protocol";

type ServerMessage = z.infer<typeof ServerMessageSchema>;
type AppServerProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: AgileError) => void;
};

type MessageWaiter = {
  resolve: (message: ServerMessage) => void;
  reject: (error: AgileError) => void;
};

export type CodexClientApi = {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, code: number, message: string): void;
  nextServerMessage(): Promise<ServerMessage>;
  close(): Promise<void>;
};

export class CodexClient implements CodexClientApi {
  private readonly process: AppServerProcess;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly messages: ServerMessage[] = [];
  private readonly messageWaiters: MessageWaiter[] = [];
  private readonly stdoutTask: Promise<void>;
  private readonly stderrTask: Promise<void>;
  private readonly exitTask: Promise<void>;
  private nextRequestId = 1;
  private writeTail: Promise<void> = Promise.resolve();
  private terminalError: AgileError | undefined;
  private closing = false;
  private initializedSent = false;
  private closePromise: Promise<void> | undefined;

  private constructor(process: AppServerProcess) {
    this.process = process;
    this.stdoutTask = this.watchStdout();
    this.stderrTask = this.drainStderr();
    this.exitTask = this.watchExit();
  }

  static async start(input?: {
    command?: string[];
    clientInfo?: { name: string; title: string; version: string };
  }): Promise<CodexClient> {
    const command = input?.command ?? ["codex", "app-server", "--stdio"];
    const clientInfo = input?.clientInfo ?? {
      name: "agile_agents",
      title: "Agile Agents",
      version: "0.1.0",
    };

    let process: AppServerProcess;
    try {
      process = Bun.spawn(command, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      throw normalizeError(error, {
        code: "CODEX_APP_SERVER_START_FAILED",
        category: "startup",
        retryable: false,
        component: "codex-client",
        message: "Could not start the Codex app-server",
      });
    }

    const client = new CodexClient(process);
    try {
      await client.request("initialize", { clientInfo });
      await client.sendInitialized();
      return client;
    } catch (error) {
      await client.close();
      throw normalizeError(error, {
        code: "CODEX_APP_SERVER_INITIALIZE_FAILED",
        category: "startup",
        retryable: false,
        component: "codex-client",
        message: "Could not initialize the Codex app-server",
      });
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      void this.enqueueWrite({ method, id, params }).catch((error: unknown) => {
        this.fail(this.normalizeWriteFailure(error), true);
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.sendWithoutResponse({ method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.sendWithoutResponse({ id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.sendWithoutResponse({ id, error: { code, message } });
  }

  nextServerMessage(): Promise<ServerMessage> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    const message = this.messages.shift();
    if (message) {
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      this.messageWaiters.push({ resolve, reject });
    });
  }

  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private async sendInitialized(): Promise<void> {
    if (this.initializedSent) {
      return;
    }
    this.initializedSent = true;
    try {
      await this.enqueueWrite({ method: "initialized", params: {} });
    } catch (error) {
      const safeError = this.normalizeWriteFailure(error);
      this.fail(safeError, true);
      throw safeError;
    }
  }

  private sendWithoutResponse(message: unknown): void {
    if (this.terminalError) {
      return;
    }
    void this.enqueueWrite(message).catch((error: unknown) => {
      this.fail(this.normalizeWriteFailure(error), true);
    });
  }

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
          code: "CODEX_APP_SERVER_WRITE_FAILED",
          category: "infra",
          retryable: true,
          component: "codex-client",
          message: "Could not write to the Codex app-server",
        });
      }

      try {
        await this.process.stdin.write(line);
        await this.process.stdin.flush();
      } catch (error) {
        throw this.normalizeWriteFailure(error);
      }
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

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
        this.handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      }
    } catch (error) {
      const safeError = normalizeError(error, {
        code: "CODEX_APP_SERVER_READ_FAILED",
        category: "infra",
        retryable: true,
        component: "codex-client",
        message: "Could not read from the Codex app-server",
      });
      this.fail(safeError, true);
    } finally {
      reader.releaseLock();
    }
  }

  private consumeCompleteLines(buffer: string): string {
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.trim().length > 0) {
        this.handleLine(line);
      }
      newline = buffer.indexOf("\n");
    }
    return buffer;
  }

  private handleLine(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new AgileError({
        code: "CODEX_APP_SERVER_INVALID_JSON",
        category: "protocol",
        retryable: false,
        component: "codex-client",
        message: "Codex app-server sent invalid JSON",
      });
    }

    const response = ResponseEnvelopeSchema.safeParse(decoded);
    if (response.success) {
      const pending = this.pending.get(response.data.id);
      if (!pending) {
        return;
      }
      this.pending.delete(response.data.id);
      if ("error" in response.data) {
        pending.reject(new AgileError({
          code: "CODEX_APP_SERVER_RPC_ERROR",
          category: "protocol",
          retryable: false,
          component: "codex-client",
          message: "Codex app-server rejected the request",
          requestId: String(response.data.id),
        }));
      } else {
        pending.resolve(response.data.result);
      }
      return;
    }

    const serverMessage = ServerMessageSchema.safeParse(decoded);
    if (!serverMessage.success) {
      throw new AgileError({
        code: "CODEX_APP_SERVER_INVALID_MESSAGE",
        category: "protocol",
        retryable: false,
        component: "codex-client",
        message: "Codex app-server sent an invalid message",
      });
    }
    const waiter = this.messageWaiters.shift();
    if (waiter) {
      waiter.resolve(serverMessage.data);
    } else {
      this.messages.push(serverMessage.data);
    }
  }

  private async drainStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    try {
      while (!(await reader.read()).done) {
        // Drain without retaining child stderr; it is not safe error text.
      }
    } catch {
      // Process exit is authoritative, and stderr contents are intentionally discarded.
    } finally {
      reader.releaseLock();
    }
  }

  private async watchExit(): Promise<void> {
    await this.process.exited;
    await this.stdoutTask;
    if (!this.closing && !this.terminalError) {
      this.fail(this.appServerExitedError(), false);
    }
  }

  private normalizeWriteFailure(error: unknown): AgileError {
    if (this.process.exitCode !== null) {
      return this.appServerExitedError();
    }
    return normalizeError(error, {
      code: "CODEX_APP_SERVER_WRITE_FAILED",
      category: "infra",
      retryable: true,
      component: "codex-client",
      message: "Could not write to the Codex app-server",
    });
  }

  private appServerExitedError(): AgileError {
    return new AgileError({
      code: "CODEX_APP_SERVER_EXITED",
      category: "infra",
      retryable: true,
      component: "codex-client",
      message: "Codex app-server exited",
    });
  }

  private fail(error: AgileError, killChild: boolean): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.messageWaiters) {
      waiter.reject(error);
    }
    this.messageWaiters.length = 0;
    this.messages.length = 0;
    if (killChild && this.process.exitCode === null) {
      this.process.kill();
    }
  }

  private async performClose(): Promise<void> {
    this.closing = true;
    const closedError = this.terminalError ?? new AgileError({
      code: "CODEX_CLIENT_CLOSED",
      category: "infra",
      retryable: false,
      component: "codex-client",
      message: "Codex client closed",
    });
    this.fail(closedError, false);

    let stdinEnd: Promise<unknown>;
    try {
      stdinEnd = Promise.resolve(this.process.stdin.end());
    } catch {
      stdinEnd = Promise.resolve();
    }

    const exited = await this.waitForExit(2_000);
    if (!exited) {
      this.process.kill();
      await this.process.exited.catch(() => undefined);
    }
    await stdinEnd.catch(() => undefined);
    await Promise.allSettled([this.stdoutTask, this.stderrTask, this.exitTask]);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void this.process.exited.then(() => finish(true), () => finish(true));
    });
  }
}
