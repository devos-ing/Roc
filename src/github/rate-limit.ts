import { setTimeout as delay } from "node:timers/promises";
import { graphQLFailure, graphQLQuota } from "./graphql-reader";
import type { GitHubCommandResult, GitHubCommandRunner } from "./pr-publisher";

export type GitHubRateLimitOptions = {
  signal: AbortSignal;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onWait?: (until: number) => void;
};

/** Recognizes GitHub reads without replaying commands that may perform several writes. */
function isRead(command: string[]): boolean {
  if (command[1] === "api") {
    const methodIndex = command.findIndex(
      (arg) => arg === "--method" || arg === "-X",
    );
    const method = methodIndex < 0 ? undefined : command[methodIndex + 1];
    if (command.includes("graphql")) return false;
    if (method !== undefined) return method.toUpperCase() === "GET";
    return !command.some(
      (arg) =>
        /^-(?:f|F|X)/u.test(arg) ||
        /^(?:--method|--field|--raw-field|--input)(?:=|$)/u.test(arg),
    );
  }
  return (
    (["issue", "pr", "repo"].includes(command[1] ?? "") &&
      ["view", "list"].includes(command[2] ?? "")) ||
    (command[1] === "auth" && command[2] === "status")
  );
}

/** Distinguishes quota failures from permission failures using response evidence. */
function isRateLimited(result: GitHubCommandResult): boolean {
  if (result.exitCode === 0 || result.exitCode === 124) return false;
  const status =
    result.httpStatus ?? Number(result.stderr.match(/HTTP (\d{3})/u)?.[1]);
  return (
    status === 429 ||
    ((status === 403 || !Number.isFinite(status)) &&
      (result.rateLimit?.remaining === 0 ||
        /(?:api rate limit (?:already )?exceeded|secondary rate limit|abuse detection)/iu.test(
          result.stderr,
        )))
  );
}

/** Shares GitHub rate-limit waiting across a scheduler's commands. */
export class GitHubRateLimitRunner implements GitHubCommandRunner {
  private resumeAt = 0;
  private waiting?: Promise<void>;
  private probe?: Promise<number | undefined>;

  /** Binds the transport and cancellation signal for one scheduler session. */
  constructor(
    private readonly transport: GitHubCommandRunner,
    private readonly options: GitHubRateLimitOptions,
  ) {}

  /** Returns the clock used to calculate server deadlines and deterministic waits. */
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Extends the shared pause without repeating the same waiting notice. */
  private pause(until: number): void {
    if (
      !Number.isFinite(until) ||
      until >= 8.64e15 ||
      until <= Math.max(this.resumeAt, this.now())
    )
      return;
    this.resumeAt = until;
    this.options.onWait?.(until);
  }

  /** Waits once for concurrent callers and wakes immediately when the session stops. */
  private async ready(signal?: AbortSignal): Promise<void> {
    while (this.resumeAt > this.now()) {
      this.options.signal.throwIfAborted();
      const milliseconds = Math.min(this.resumeAt - this.now(), 2_147_483_647);
      this.waiting ??= (
        this.options.wait?.(milliseconds, this.options.signal) ??
        delay(milliseconds, undefined, { signal: this.options.signal })
      ).finally(() => {
        this.waiting = undefined;
      });
      await this.waitForCaller(this.waiting, signal);
      this.options.signal.throwIfAborted();
    }
  }

  /** Lets one caller leave a shared wait without aborting sibling callers. */
  private async waitForCaller(
    waiting: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!signal) return waiting;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        waiting,
        new Promise<never>((_resolve, reject) => {
          /** Rejects only this caller when its worker is cancelled. */
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  /** Uses the quota endpoint only when a high-level gh command omitted reset headers. */
  private async resetTime(cwd: string): Promise<number | undefined> {
    this.probe ??= this.transport
      .run({
        command: ["gh", "api", "rate_limit"],
        cwd,
        signal: this.options.signal,
      })
      .then((result) => {
        if (result.exitCode !== 0) return undefined;
        const body = JSON.parse(result.stdout);
        const exhausted = [body.resources?.core, body.resources?.graphql]
          .filter(
            (entry) => entry?.remaining === 0 && Number.isFinite(entry.reset),
          )
          .map((entry) => entry.reset * 1_000);
        return exhausted.length ? Math.max(...exhausted) : undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        this.probe = undefined;
      });
    return this.probe;
  }

  /** Retries quota-limited reads after a shared cancellable wait, leaving write reconciliation to callers. */
  async run(input: Parameters<GitHubCommandRunner["run"]>[0]) {
    if (input.command[0] !== "gh") return this.transport.run(input);
    let retries = 0;
    while (true) {
      const read = input.intent === "graphql-read" || isRead(input.command);
      const signal =
        read && input.signal
          ? AbortSignal.any([this.options.signal, input.signal])
          : input.signal;
      signal?.throwIfAborted();
      await this.ready(signal);
      signal?.throwIfAborted();
      const result = await this.transport.run({ ...input, signal });
      signal?.throwIfAborted();
      const failure =
        input.intent === "graphql-read" ? graphQLFailure(result) : undefined;
      const limit =
        input.intent === "graphql-read"
          ? { ...result.rateLimit, ...graphQLQuota(result.stdout) }
          : result.rateLimit;
      if (
        failure === "permission" ||
        (failure === "incomplete" && result.exitCode === 0)
      )
        return result;
      if (failure !== "quota" && !isRateLimited(result)) {
        if (limit?.remaining === 0 && Number.isFinite(limit.resetAt))
          this.pause(limit.resetAt ?? 0);
        return result;
      }
      const now = this.now();
      let until: number | undefined;
      if (
        Number.isFinite(limit?.retryAfterMs) &&
        (limit?.retryAfterMs ?? -1) >= 0
      )
        until = now + Math.max(1_000, limit?.retryAfterMs ?? 0);
      else if (limit?.remaining === 0 && (limit.resetAt ?? 0) > now)
        until = limit.resetAt;
      else if (this.resumeAt > now) until = this.resumeAt;
      else until = await this.resetTime(input.cwd);
      this.pause(
        until !== undefined &&
          Number.isFinite(until) &&
          until < 8.64e15 &&
          until > now
          ? until
          : now + Math.min(60_000 * 2 ** Math.min(retries, 4), 900_000),
      );
      if (!read) return result;
      retries++;
    }
  }
}
