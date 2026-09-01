import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { z } from "zod";
import { AgileError, normalizeError } from "../../runtime/errors";
import {
  ResponseEnvelopeSchema,
  RpcErrorSchema,
  ServerMessageSchema,
} from "./protocol";

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

export type ZcodeClientApi = {
  /** Sends an RPC request and resolves it from the matching response envelope. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Sends a fire-and-forget RPC notification. */
  notify(method: string, params: unknown): void;
  /** Sends a successful response to an app-server request. */
  respond(id: string | number, result: unknown): void;
  /** Sends an error response to an app-server request. */
  respondError(id: string | number, code: number, message: string): void;
  /** Returns the next queued server message or waits until one arrives. */
  nextServerMessage(): Promise<ServerMessage>;
  /** Idempotently closes the client and its child process resources. */
  close(): Promise<void>;
  /**
   * The one session model preference resolved at startup, after every
   * environment priority has merged: the model id from the effective
   * ZCODE_MODEL (explicit override, else the enabled desktop provider), the
   * provider id from that provider. Undefined when no complete pair can be
   * formed, which leaves the child on an unknowable server-side default;
   * production callers must refuse to start.
   */
  readonly sessionModel?: ZcodeSessionModel;
};

/** One immutable provider/model pair used by the child env, catalog, and session create. */
export type ZcodeSessionModel = Readonly<{
  providerId: string;
  modelId: string;
}>;

type ProviderConfig = {
  enabled?: boolean;
  options?: { baseURL?: string; apiKey?: string };
  models?: Record<string, unknown>;
};

/** Reads the enabled provider's credentials from the desktop ZCode config. */
function loadCredentials(configPath: string): {
  providerId?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
} {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider?: Record<string, ProviderConfig>;
    };
    for (const [providerId, provider] of Object.entries(
      config.provider ?? {},
    )) {
      if (provider?.enabled) {
        return {
          providerId,
          model: Object.keys(provider.models ?? {})[0],
          baseURL: provider.options?.baseURL,
          apiKey: provider.options?.apiKey,
        };
      }
    }
  } catch {
    // A missing or unreadable desktop config leaves environment vars as-is.
  }
  return {};
}

export class ZcodeClient implements ZcodeClientApi {
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
  private closePromise: Promise<void> | undefined;
  readonly sessionModel?: ZcodeSessionModel;

  /** Creates a client around a spawned app-server process and starts its I/O watchers. */
  private constructor(
    process: AppServerProcess,
    sessionModel: ZcodeSessionModel | undefined,
  ) {
    this.process = process;
    this.sessionModel = sessionModel;
    this.stdoutTask = this.watchStdout();
    this.stderrTask = this.drainStderr();
    this.exitTask = this.watchExit();
  }

  /** Starts a ZCode app-server client; ZCode has no initialize handshake. */
  static async start(input?: {
    command?: string[];
    env?: Record<string, string | undefined>;
    credentialsPath?: string;
  }): Promise<ZcodeClient> {
    // The app-server bundle requires the Node runtime (node:sqlite), so an
    // explicit ZCODE_BIN path is launched with "node" rather than Bun.
    const zcodeBin = process.env.ZCODE_BIN;
    const command =
      input?.command ??
      (zcodeBin !== undefined && zcodeBin !== ""
        ? ["node", zcodeBin, "app-server"]
        : ["zcode", "app-server"]);

    // Desktop-app credentials fill any model variables the caller did not
    // set, so an unattended scheduler works from a fresh shell.
    const credentials = loadCredentials(
      input?.credentialsPath ?? `${homedir()}/.zcode/v2/config.json`,
    );
    const injected: Record<string, string | undefined> = {
      ZCODE_MODEL: credentials.model,
      ZCODE_BASE_URL: credentials.baseURL,
      ANTHROPIC_API_KEY: credentials.apiKey,
    };
    for (const key of Object.keys(injected)) {
      if (injected[key] === undefined) {
        delete injected[key];
        continue;
      }
      const explicitValue = process.env[key]?.trim();
      if (
        key !== "ZCODE_BASE_URL" &&
        explicitValue !== undefined &&
        explicitValue !== ""
      ) {
        // Explicit caller-provided model and key settings win over config;
        // blank values count as unset.
        delete injected[key];
      }
    }
    // ZCODE_BASE_URL is always taken from the enabled desktop provider when
    // one exists: the desktop app exports its own gateway URL
    // (https://zcode.z.ai) into every process it launches, and honoring that
    // inherited value makes every model request fail with 404. An explicit
    // override can still be passed through start({env}).
    const processEnv: Record<string, string | undefined> = {
      ...process.env,
      ...injected,
      ...(input?.env ?? {}),
    };

    // Resolve the ONE session model after every environment priority has
    // merged, so the child env, the published catalog, and session/create
    // cannot disagree: an explicit override (input.env or process env) wins,
    // else the enabled desktop provider's first model, always attributed to
    // that provider. A model without a provider id cannot form a complete
    // preference and stays undefined; production callers must refuse to
    // start, because the server-side default would be unobservable.
    const mergedModel = processEnv.ZCODE_MODEL?.trim() || undefined;
    const sessionModel =
      mergedModel !== undefined && credentials.providerId !== undefined
        ? Object.freeze({
            providerId: credentials.providerId,
            modelId: mergedModel,
          })
        : undefined;
    if (sessionModel !== undefined) {
      // Pin the resolved pair so the child runs exactly the attributed
      // model, even when the incoming value carried surrounding whitespace.
      processEnv.ZCODE_MODEL = sessionModel.modelId;
    }

    let spawned: AppServerProcess;
    try {
      spawned = Bun.spawn(command, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: processEnv,
      });
    } catch (error) {
      throw normalizeError(error, {
        code: "ZCODE_APP_SERVER_START_FAILED",
        category: "startup",
        retryable: false,
        component: "zcode-client",
        message: "Could not start the ZCode app-server",
      });
    }

    return new ZcodeClient(spawned, sessionModel);
  }

  /** Sends an RPC request and resolves it from the matching response envelope. */
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

  /** Sends a fire-and-forget RPC notification. */
  notify(method: string, params: unknown): void {
    this.sendWithoutResponse({ method, params });
  }

  /** Sends a successful response to an app-server request. */
  respond(id: string | number, result: unknown): void {
    this.sendWithoutResponse({ id, result });
  }

  /** Sends an error response to an app-server request. */
  respondError(id: string | number, code: number, message: string): void {
    this.sendWithoutResponse({ id, error: { code, message } });
  }

  /** Returns the next queued server message or waits until one arrives. */
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

  /** Idempotently closes the client and its child process resources. */
  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  /** Queues a message whose write failures terminate the client without a response promise. */
  private sendWithoutResponse(message: unknown): void {
    if (this.terminalError) {
      return;
    }
    void this.enqueueWrite(message).catch((error: unknown) => {
      this.fail(this.normalizeWriteFailure(error), true);
    });
  }

  /** Serializes one message behind prior writes and flushes it to app-server stdin. */
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
          code: "ZCODE_APP_SERVER_WRITE_FAILED",
          category: "infra",
          retryable: true,
          component: "zcode-client",
          message: "Could not write to the ZCode app-server",
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

  /** Reads stdout, frames complete lines, and dispatches each protocol message. */
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
        code: "ZCODE_APP_SERVER_READ_FAILED",
        category: "infra",
        retryable: true,
        component: "zcode-client",
        message: "Could not read from the ZCode app-server",
      });
      this.fail(safeError, true);
    } finally {
      reader.releaseLock();
    }
  }

  /** Dispatches every complete line in a buffer and returns its trailing partial line. */
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

  /** Parses and routes one response or server message from the app-server. */
  private handleLine(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new AgileError({
        code: "ZCODE_APP_SERVER_INVALID_JSON",
        category: "protocol",
        retryable: false,
        component: "zcode-client",
        message: "ZCode app-server sent invalid JSON",
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
        const rpcError = RpcErrorSchema.parse(response.data.error);
        pending.reject(
          new AgileError({
            code: "ZCODE_APP_SERVER_RPC_ERROR",
            category: "protocol",
            retryable: false,
            component: "zcode-client",
            // The provider's raw text may embed request payloads or keys, so
            // only the fixed message can reach events, logs, or stderr; the
            // original error travels in the non-persisted cause.
            message: "ZCode app-server rejected the request",
            cause: rpcError,
            requestId: String(response.data.id),
          }),
        );
      } else {
        pending.resolve(response.data.result);
      }
      return;
    }

    const serverMessage = ServerMessageSchema.safeParse(decoded);
    if (!serverMessage.success) {
      throw new AgileError({
        code: "ZCODE_APP_SERVER_INVALID_MESSAGE",
        category: "protocol",
        retryable: false,
        component: "zcode-client",
        message: "ZCode app-server sent an invalid message",
      });
    }

    if (
      typeof (decoded as { id?: unknown }).id !== "undefined" &&
      this.autoRespond(
        serverMessage.data as ServerMessage & { id: string | number },
      )
    ) {
      return;
    }
    const waiter = this.messageWaiters.shift();
    if (waiter) {
      waiter.resolve(serverMessage.data);
    } else {
      this.messages.push(serverMessage.data);
    }
  }

  /**
   * Answers protocol-required server requests inline: runtime preferences
   * block session creation until answered, and official MCP auth headers are
   * unavailable to an unattended scheduler.
   */
  private autoRespond(
    message: ServerMessage & { id: string | number },
  ): boolean {
    if (message.method === "session/requestRuntimePreferences") {
      this.respond(message.id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      });
      return true;
    }
    if (message.method === "interaction/requestOfficialMcpAuthHeaders") {
      this.respondError(
        message.id,
        -32601,
        "No official MCP auth headers are available",
      );
      return true;
    }
    return false;
  }

  /** Drains child stderr without retaining potentially unsafe text. */
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

  /** Converts an unexpected child exit into terminal client failure. */
  private async watchExit(): Promise<void> {
    await this.process.exited;
    await this.stdoutTask;
    if (!this.closing && !this.terminalError) {
      this.fail(this.appServerExitedError(), false);
    }
  }

  /** Normalizes a write failure, preferring an observed app-server exit. */
  private normalizeWriteFailure(error: unknown): AgileError {
    if (this.process.exitCode !== null) {
      return this.appServerExitedError();
    }
    return normalizeError(error, {
      code: "ZCODE_APP_SERVER_WRITE_FAILED",
      category: "infra",
      retryable: true,
      component: "zcode-client",
      message: "Could not write to the ZCode app-server",
    });
  }

  /** Creates the stable operational error for an exited app-server process. */
  private appServerExitedError(): AgileError {
    return new AgileError({
      code: "ZCODE_APP_SERVER_EXITED",
      category: "infra",
      retryable: true,
      component: "zcode-client",
      message: "ZCode app-server exited",
    });
  }

  /** Transitions the client to terminal failure and rejects all pending consumers. */
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

  /** Performs bounded graceful shutdown before force-killing and draining client tasks. */
  private async performClose(): Promise<void> {
    this.closing = true;
    const closedError =
      this.terminalError ??
      new AgileError({
        code: "ZCODE_CLIENT_CLOSED",
        category: "infra",
        retryable: false,
        component: "zcode-client",
        message: "ZCode client closed",
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
      this.process.kill("SIGKILL");
      await this.waitForExit(1_000);
    }
    await this.waitForCloseTasks(stdinEnd, 1_000);
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

  /** Reports whether the app-server exits before a timeout. */
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
        () => finish(true),
      );
    });
  }
}
