import {
  FakeScenarioSchema,
  HarnessStepRequestSchema,
  type AgentHarness,
  type FakeScenario,
  type HarnessDelivery,
  type HarnessStepRequest,
} from "./contracts";

function keyOf(input: Pick<HarnessStepRequest["attempt"], "taskId" | "role" | "retryIndex">): string {
  return `${input.taskId}:${input.role}:${input.retryIndex}`;
}

export function createFakeHarness(input: unknown): {
  harness: AgentHarness;
  assertComplete(): void;
} {
  const scenario: FakeScenario = FakeScenarioSchema.parse(input);
  const consumed = new Map<string, string>();

  const harness: AgentHarness = {
    async step(rawInput): Promise<HarnessDelivery> {
      const request = HarnessStepRequestSchema.parse(rawInput);
      const key = keyOf(request.attempt);
      const script = scenario.attempts.find((candidate) => keyOf(candidate) === key);
      if (!script) throw new Error(`Missing fake script for ${key}`);
      if (request.attempt.model !== script.expect.model) {
        throw new Error(`Fake expectation failed for ${key}: model ${request.attempt.model} !== ${script.expect.model}`);
      }
      if (request.attempt.effort !== script.expect.effort) {
        throw new Error(`Fake expectation failed for ${key}: effort ${request.attempt.effort} !== ${script.expect.effort}`);
      }
      if (JSON.stringify(request.attempt.contextRef) !== JSON.stringify(script.expect.contextRef)) {
        throw new Error(`Fake expectation failed for ${key}: contextRef mismatch`);
      }

      const cursorIndex = request.backendCursor === undefined
        ? -1
        : script.deliveries.findIndex((delivery) => delivery.nextCursor === request.backendCursor);
      if (request.backendCursor !== undefined && cursorIndex === -1) {
        throw new Error(`Unknown fake cursor for ${key}: ${request.backendCursor}`);
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
    async cancel(): Promise<void> {},
  };

  return {
    harness,
    assertComplete(): void {
      for (const script of scenario.attempts) {
        const key = keyOf(script);
        const finalCursor = script.deliveries.at(-1)?.nextCursor;
        if (consumed.get(key) !== finalCursor) {
          throw new Error(`Unconsumed fake deliveries for ${key}`);
        }
      }
    },
  };
}
