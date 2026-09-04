import { Cause, Effect, Exit, Option, type Scope } from "effect";
import type { Logger } from "../runtime/logger";

/** Runs one scoped session and removes its signal listeners on every exit. */
export async function runSession(
  body: (stop: AbortSignal) => Effect.Effect<void, unknown, Scope.Scope>,
): Promise<void> {
  const stop = new AbortController();
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          /** Closes admission synchronously; repeated signals share the same shutdown. */
          const onSignal = (): void => stop.abort();
          process.on("SIGINT", onSignal);
          process.on("SIGTERM", onSignal);
          return onSignal;
        }),
        (onSignal) =>
          Effect.sync(() => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
          }),
      );
      yield* body(stop.signal);
    }),
  );
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
}

/** Reports a fixed safe diagnostic without allowing logging to block teardown. */
export function reportCleanup(logger: Logger, runId: string, code: string) {
  return Effect.tryPromise({
    try: () =>
      logger.write({
        level: "warn",
        code,
        category: "infra",
        component: "cli",
        retryable: false,
        runId,
        message: "Scheduler cleanup did not finish normally",
      }),
    catch: () => undefined,
  }).pipe(
    Effect.catchAll(() => Effect.void),
    Effect.interruptible,
    Effect.timeoutOption(100),
    Effect.asVoid,
  );
}

/** Confirms cleanup only within its deadline, marking uncertainty before diagnostics and preserving primary failure. */
export function closeBackendEffect(
  close: () => Promise<void>,
  sessionExit: Exit.Exit<unknown, unknown>,
  logger: Logger,
  runId: string,
  onIncomplete?: () => void,
) {
  return Effect.gen(function* () {
    const result = yield* Effect.exit(
      Effect.tryPromise({
        try: close,
        catch: (error) => error,
      }).pipe(Effect.interruptible, Effect.timeoutOption(250)),
    );
    if (Exit.isFailure(result)) {
      onIncomplete?.();
      yield* reportCleanup(logger, runId, "SCHEDULER_BACKEND_CLOSE_FAILED");
      if (Exit.isSuccess(sessionExit))
        yield* Effect.die(Cause.squash(result.cause));
    } else if (Option.isNone(result.value)) {
      onIncomplete?.();
      yield* reportCleanup(logger, runId, "SCHEDULER_BACKEND_CLOSE_TIMEOUT");
    } else {
      return true;
    }
    return false;
  });
}
