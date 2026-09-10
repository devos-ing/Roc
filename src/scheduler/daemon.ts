import { Cause, Clock, Deferred, Effect, Exit, Fiber, Option } from "effect";
import type { Scheduler, TickResult } from "./scheduler";

export type LeaseStore = {
  acquireLease(ownerId: string, now: string, expiresAt: string): boolean;
  heartbeatLease(ownerId: string, now: string, expiresAt: string): boolean;
  releaseLease(ownerId: string): boolean;
};

type Runtime = { ownerId: string };

export type SchedulerSource = {
  beforeTick(): Promise<boolean>;
  /** Allows only already-running attempts to settle while remote authority is unavailable. */
  canStartWork?(): boolean;
  afterTick?(result: TickResult): Promise<void>;
};

export class SchedulerDaemon {
  /** Creates a daemon from scheduler, lease-store, and ownership dependencies. */
  constructor(
    private readonly scheduler: Pick<Scheduler, "tick"> &
      Partial<Pick<Scheduler, "drain">>,
    private readonly leases: LeaseStore,
    private readonly runtime: Runtime,
    private readonly source?: SchedulerSource,
  ) {}

  /** Runs ticks under a lease and drains owned work before sealing continuation. */
  runEffect(input: {
    stop: AbortSignal;
    cancel(): Promise<void>;
    drainMs?: number;
    onDrainTimeout?: () => void;
  }): Effect.Effect<void, unknown> {
    const self = this;
    return Effect.scoped(
      Effect.gen(function* () {
        if (input.stop.aborted) return;
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              if (
                !self.leases.acquireLease(
                  self.runtime.ownerId,
                  new Date(now).toISOString(),
                  new Date(now + 10_000).toISOString(),
                )
              )
                throw new Error("Scheduler lease is already held");
            },
            catch: (error) => error,
          }),
          () =>
            Effect.sync(() => self.leases.releaseLease(self.runtime.ownerId)),
        );
        const seal = new AbortController();
        const draining = yield* Deferred.make<void>();
        let admitting = true;
        const worker = yield* Effect.gen(function* () {
          while (admitting && !input.stop.aborted) {
            const source = self.source;
            const mayAdvance =
              source === undefined
                ? true
                : yield* Effect.tryPromise({
                    try: () => source.beforeTick(),
                    catch: (error) => error,
                  });
            if (!admitting || input.stop.aborted || seal.signal.aborted) break;
            if (!mayAdvance) {
              yield* Effect.raceFirst(
                Effect.sleep(1_000),
                Deferred.await(draining),
              );
              continue;
            }
            const result = yield* Effect.tryPromise({
              try: () =>
                self.scheduler.tick(
                  self.runtime.ownerId,
                  seal.signal,
                  source?.canStartWork?.() ?? true,
                ),
              catch: (error) => error,
            });
            if (source?.afterTick !== undefined && !seal.signal.aborted) {
              yield* Effect.tryPromise({
                try: async () => {
                  await source.afterTick?.(result);
                },
                catch: (error) => error,
              });
            }
            if (result.kind === "idle")
              yield* Effect.raceFirst(
                Effect.sleep(1_000),
                Deferred.await(draining),
              );
            else yield* Effect.yieldNow();
          }
        }).pipe(Effect.forkScoped);
        // This finalizer runs before forkScoped interrupts the worker and before lease release.
        yield* Effect.addFinalizer((sessionExit) =>
          Effect.gen(function* () {
            admitting = false;
            yield* Deferred.succeed(draining, undefined);
            // Keep a completed tick's failure even if cancellation consumes the remaining grace.
            let drained: Exit.Exit<void, unknown> | undefined;
            let taskDrain: Exit.Exit<void, unknown> | undefined;
            const completed = yield* Effect.all(
              [
                Fiber.await(worker).pipe(
                  Effect.tap((exit) =>
                    Effect.sync(() => {
                      drained = exit;
                    }),
                  ),
                ),
                Effect.exit(
                  Effect.tryPromise({
                    try: () => self.scheduler.drain?.() ?? Promise.resolve(),
                    catch: (error) => error,
                  }),
                ).pipe(
                  Effect.tap((exit) =>
                    Effect.sync(() => {
                      taskDrain = exit;
                    }),
                  ),
                ),
                Effect.exit(
                  Effect.tryPromise({
                    try: input.cancel,
                    catch: (error) => error,
                  }),
                ),
              ],
              { concurrency: "unbounded" },
            ).pipe(
              Effect.interruptible,
              Effect.timeoutOption(input.drainMs ?? 250),
            );
            if (Option.isNone(completed)) input.onDrainTimeout?.();
            seal.abort(new Error("Scheduler session sealed"));
            yield* Fiber.interrupt(worker);
            if (
              Exit.isSuccess(sessionExit) &&
              taskDrain !== undefined &&
              Exit.isFailure(taskDrain)
            )
              yield* Effect.die(Cause.squash(taskDrain.cause));
            if (
              Exit.isSuccess(sessionExit) &&
              drained !== undefined &&
              Exit.isFailure(drained)
            ) {
              yield* Effect.die(Cause.squash(drained.cause));
            }
          }),
        );
        const heartbeat = Effect.gen(function* () {
          yield* Effect.sleep(3_000);
          const timestamp = yield* Clock.currentTimeMillis;
          yield* Effect.try({
            try: () => {
              if (
                !self.leases.heartbeatLease(
                  self.runtime.ownerId,
                  new Date(timestamp).toISOString(),
                  new Date(timestamp + 10_000).toISOString(),
                )
              )
                throw new Error("Scheduler lease was lost");
            },
            catch: (error) => error,
          });
        }).pipe(Effect.forever);
        const stopped = Effect.async<void>((resume) => {
          /** Wakes the owner while allowing the pending tick to finish its grace period. */
          const onStop = (): void => resume(Effect.void);
          input.stop.addEventListener("abort", onStop, { once: true });
          if (input.stop.aborted) onStop();
          return Effect.sync(() =>
            input.stop.removeEventListener("abort", onStop),
          );
        });
        yield* Effect.raceFirst(
          Fiber.join(worker),
          Effect.raceFirst(heartbeat, stopped),
        );
      }),
    );
  }
}
