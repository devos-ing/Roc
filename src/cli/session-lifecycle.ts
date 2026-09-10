import { Cause, Effect, Exit, type Scope } from "effect";

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
