import {
  type AgentHarness,
  type FakeScenario,
  FakeScenarioAttemptSchema,
  FakeScenarioSchema,
  type HarnessDelivery,
  type HarnessStepRequest,
  HarnessStepRequestSchema,
} from "./contracts";

/** Builds the stable lookup key for one scripted fake attempt. */
function keyOf(
  input: Pick<HarnessStepRequest["attempt"], "taskId" | "role" | "retryIndex">,
): string {
  return `${input.taskId}:${input.role}:${input.retryIndex}`;
}

/** Creates a deterministic harness backed by a validated scripted scenario. */
export function createFakeHarness(input: unknown): {
  harness: AgentHarness;
  assertComplete(): void;
  /**
   * Upserts one scripted attempt after creation (validated against the same
   * schema); a later script for an existing key replaces its deliveries.
   * Lets drivers that script turns just-in-time (conformance suite) reuse the
   * fake harness unchanged.
   */
  scriptAttempt(attempt: unknown): void;
} {
  const scenario: FakeScenario = FakeScenarioSchema.parse(input);
  const consumed = new Map<string, string>();

  const harness: AgentHarness = {
    /** Returns the next scripted delivery after validating the attempt expectations. */
    async step(rawInput): Promise<HarnessDelivery> {
      const request = HarnessStepRequestSchema.parse(rawInput);
      const key = keyOf(request.attempt);
      const script = scenario.attempts.find(
        (candidate) => keyOf(candidate) === key,
      );
      if (!script) throw new Error(`Missing fake script for ${key}`);
      if (request.attempt.model !== script.expect.model) {
        throw new Error(
          `Fake expectation failed for ${key}: model ${request.attempt.model} !== ${script.expect.model}`,
        );
      }
      if (request.attempt.effort !== script.expect.effort) {
        throw new Error(
          `Fake expectation failed for ${key}: effort ${request.attempt.effort} !== ${script.expect.effort}`,
        );
      }
      if (
        JSON.stringify(request.attempt.contextRef) !==
        JSON.stringify(script.expect.contextRef)
      ) {
        throw new Error(
          `Fake expectation failed for ${key}: contextRef mismatch`,
        );
      }

      const cursorIndex =
        request.backendCursor === undefined
          ? -1
          : script.deliveries.findIndex(
              (delivery) => delivery.nextCursor === request.backendCursor,
            );
      if (request.backendCursor !== undefined && cursorIndex === -1) {
        throw new Error(
          `Unknown fake cursor for ${key}: ${request.backendCursor}`,
        );
      }
      const index = cursorIndex + 1;
      const delivery = script.deliveries[index];
      if (!delivery) throw new Error(`Unexpected extra fake call for ${key}`);
      consumed.set(key, delivery.nextCursor);
      return {
        kind: "event",
        nextCursor: delivery.nextCursor,
        event: { ...delivery.event, attemptId: request.attempt.attemptId },
      };
    },
    /** Accepts cancellation without side effects for the in-memory fake harness. */
    async cancel(): Promise<void> {},
  };

  return {
    harness,
    /** Verifies that every scripted attempt was consumed through its final delivery. */
    assertComplete(): void {
      for (const script of scenario.attempts) {
        const key = keyOf(script);
        const finalCursor = script.deliveries.at(-1)?.nextCursor;
        if (consumed.get(key) !== finalCursor) {
          throw new Error(`Unconsumed fake deliveries for ${key}`);
        }
      }
    },
    /** Upserts one validated scripted attempt, replacing deliveries by key. */
    scriptAttempt(attempt: unknown): void {
      const parsed = FakeScenarioAttemptSchema.parse(attempt);
      const key = keyOf(parsed);
      const existing = scenario.attempts.findIndex(
        (candidate) => keyOf(candidate) === key,
      );
      if (existing === -1) scenario.attempts.push(parsed);
      else scenario.attempts[existing] = parsed;
    },
  };
}
