import { expect, test } from "bun:test";
import {
  buildPiBackendFactory,
  startPiBackend,
} from "../../../src/agents/pi/backend";
import type { PiClientApi } from "../../../src/agents/pi/client";
import { backends } from "../../../src/agents/registry";
import {
  collect,
  makeImplementRequest,
  makeReviewRequest,
  makeScoutRequest,
  memoryBranches,
  messageEnd,
  RecordedPiClient,
} from "./fixtures";

/** Returns the scripted attempt client recorded at one dispatch index. */
function clientAt(
  clients: RecordedPiClient[],
  index: number,
): RecordedPiClient {
  const client = clients.at(index);
  if (client === undefined) {
    throw new Error(`missing scripted attempt client at ${index}`);
  }
  return client;
}

/** A scripted probe client that never reaches the event stream. */
class ScriptedProbeClient implements PiClientApi {
  closeCount = 0;

  constructor(
    private readonly models: unknown,
    private readonly stateModel: unknown,
  ) {}

  async request(command: string): Promise<unknown> {
    if (command === "get_available_models") return { models: this.models };
    if (command === "get_state") {
      return {
        sessionId: "sess-probe",
        sessionFile: "/tmp/pi-fixture/sess-probe.jsonl",
        model: this.stateModel,
      };
    }
    throw new Error(`Unexpected probe command: ${command}`);
  }

  send(): void {}

  async nextEvent(): Promise<never> {
    throw new Error("the probe never streams events");
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

const probeModels = [
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    thinkingLevelMap: { medium: 1, high: 2, xhigh: 3 },
  },
  {
    id: "glm-5.3",
    provider: "bigmodel",
    name: "GLM-5.3",
    reasoning: true,
  },
];

const probeDefaultModel = {
  id: "claude-sonnet-4-6",
  provider: "anthropic",
  name: "Claude Sonnet 4.6",
  reasoning: true,
  thinkingLevelMap: { medium: 1, high: 2, xhigh: 3 },
};

/**
 * Runs the factory with one experimental-gate value and captures its
 * failure. The gate must reject before any Pi process is spawned, so the
 * branches context is never touched.
 */
async function gateFailureWith(value: string | undefined): Promise<unknown> {
  const previous = process.env.ROC_PI_EXPERIMENTAL;
  try {
    if (value === undefined) delete process.env.ROC_PI_EXPERIMENTAL;
    else process.env.ROC_PI_EXPERIMENTAL = value;
    try {
      await startPiBackend({ branches: undefined as never });
    } catch (error) {
      return error;
    }
    return undefined;
  } finally {
    if (previous === undefined) delete process.env.ROC_PI_EXPERIMENTAL;
    else process.env.ROC_PI_EXPERIMENTAL = previous;
  }
}

test("the backend factory refuses to start without the acknowledgement", async () => {
  for (const value of [undefined, "0"]) {
    await expect(gateFailureWith(value)).resolves.toMatchObject({
      name: "AgileError",
      code: "PI_EXPERIMENTAL_GATE",
      category: "startup",
      retryable: false,
      component: "pi-backend",
    });
  }
});

test("the gate message tells the operator how to acknowledge", async () => {
  const error = (await gateFailureWith(undefined)) as Error;
  expect(error.message).toContain("ROC_PI_EXPERIMENTAL=1");
  expect(error.message).toContain("sandbox");
});

test("the gate open path attributes the probe default model and reaps the probe", async () => {
  const previous = process.env.ROC_PI_EXPERIMENTAL;
  const probe = new ScriptedProbeClient(probeModels, probeDefaultModel);
  try {
    process.env.ROC_PI_EXPERIMENTAL = "1";
    const factory = buildPiBackendFactory({
      startProbeClient: async () => probe,
      startAttemptClient: async () => {
        throw new Error("no role attempt runs in this test");
      },
    });
    const runtime = await factory({ branches: undefined as never });
    try {
      expect(runtime.catalog).toContainEqual({
        id: "anthropic/claude-sonnet-4-6",
        supportedReasoningEfforts: ["medium", "high", "xhigh"],
      });
      // A model without a thinking level map gets the safe default subset;
      // xhigh is only published from an explicit non-null mapping.
      expect(runtime.catalog).toContainEqual({
        id: "bigmodel/glm-5.3",
        supportedReasoningEfforts: ["medium", "high"],
      });
      expect(runtime.modelMapping).toEqual({
        luna: "anthropic/claude-sonnet-4-6",
        terra: "anthropic/claude-sonnet-4-6",
        sol: "anthropic/claude-sonnet-4-6",
      });
    } finally {
      await runtime.close();
    }
    expect(probe.closeCount).toBe(1);
    // Closing again stays idempotent across repeated calls.
    await runtime.close();
    expect(probe.closeCount).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.ROC_PI_EXPERIMENTAL;
    else process.env.ROC_PI_EXPERIMENTAL = previous;
  }
});

test("the factory fails closed and closes the probe when no default model resolves", async () => {
  const previous = process.env.ROC_PI_EXPERIMENTAL;
  const probe = new ScriptedProbeClient(probeModels, null);
  try {
    process.env.ROC_PI_EXPERIMENTAL = "1";
    const factory = buildPiBackendFactory({
      startProbeClient: async () => probe,
    });
    await expect(
      factory({ branches: undefined as never }),
    ).rejects.toMatchObject({
      code: "PI_MODEL_UNRESOLVED",
      category: "startup",
      retryable: false,
      component: "pi-backend",
    });
    expect(probe.closeCount).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.ROC_PI_EXPERIMENTAL;
    else process.env.ROC_PI_EXPERIMENTAL = previous;
  }
});

test("the registry exposes the gated pi factory under one name", () => {
  expect(backends.pi).toBe(startPiBackend);
});

test("reasoning-disabled models publish no efforts and null levels are excluded", async () => {
  const previous = process.env.ROC_PI_EXPERIMENTAL;
  const models = [
    {
      id: "no-reasoning",
      provider: "acme",
      reasoning: false,
      thinkingLevelMap: { medium: 1, high: 2, xhigh: 3 },
    },
    {
      id: "null-levels",
      provider: "acme",
      reasoning: true,
      thinkingLevelMap: { medium: 1, high: null, xhigh: 3 },
    },
    {
      id: "no-map",
      provider: "acme",
      reasoning: true,
    },
  ];
  const probe = new ScriptedProbeClient(models, probeDefaultModel);
  try {
    process.env.ROC_PI_EXPERIMENTAL = "1";
    const factory = buildPiBackendFactory({
      startProbeClient: async () => probe,
      startAttemptClient: async () => {
        throw new Error("no role attempt runs in this test");
      },
    });
    const runtime = await factory({ branches: undefined as never });
    try {
      const ids = runtime.catalog.map((model) => model.id);
      // A reasoning-disabled model publishes no efforts at all.
      expect(ids).not.toContain("acme/no-reasoning");
      // A null map entry is not a published level.
      expect(runtime.catalog).toContainEqual({
        id: "acme/null-levels",
        supportedReasoningEfforts: ["medium", "xhigh"],
      });
      // An unmapped reasoning model gets the safe subset without xhigh.
      expect(runtime.catalog).toContainEqual({
        id: "acme/no-map",
        supportedReasoningEfforts: ["medium", "high"],
      });
    } finally {
      await runtime.close();
    }
  } finally {
    if (previous === undefined) delete process.env.ROC_PI_EXPERIMENTAL;
    else process.env.ROC_PI_EXPERIMENTAL = previous;
  }
});

test("the factory drives a scripted scout-implement-review task to done", async () => {
  const previous = process.env.ROC_PI_EXPERIMENTAL;
  const probe = new ScriptedProbeClient(probeModels, probeDefaultModel);
  const clients: RecordedPiClient[] = [];
  try {
    process.env.ROC_PI_EXPERIMENTAL = "1";
    const factory = buildPiBackendFactory({
      startProbeClient: async () => probe,
      startAttemptClient: async () => {
        const client = new RecordedPiClient();
        clients.push(client);
        return client;
      },
    });
    const runtime = await factory({ branches: memoryBranches() });
    try {
      // Every advisor profile routes through the attributed default model.
      expect(runtime.modelMapping).toEqual({
        luna: "anthropic/claude-sonnet-4-6",
        terra: "anthropic/claude-sonnet-4-6",
        sol: "anthropic/claude-sonnet-4-6",
      });

      const scoutStart = await runtime.harness.step(makeScoutRequest());
      if (scoutStart.kind !== "event") throw new Error("unreachable");
      clientAt(clients, 0).enqueue(messageEnd(), { type: "agent_settled" });
      const scout = await collect(runtime.harness, {
        ...makeScoutRequest(),
        backendCursor: scoutStart.nextCursor,
      });
      expect(scout.events.at(-1)?.type).toBe("attempt.completed");

      // Implement hands its structured output to the trusted harness, which
      // owns the sole implementation commit.
      const commitSha = "b".repeat(40);
      const implementStart = await runtime.harness.step(makeImplementRequest());
      if (implementStart.kind !== "event") throw new Error("unreachable");
      clientAt(clients, 1).enqueue(
        messageEnd({
          text: JSON.stringify({
            kind: "implement",
            validation: ["bun test"],
            risks: [],
            limitations: [],
          }),
        }),
        { type: "agent_settled" },
      );
      const implement = await collect(runtime.harness, {
        ...makeImplementRequest(),
        backendCursor: implementStart.nextCursor,
      });
      const implementOutput = implement.events.find(
        (event) => event.type === "attempt.output",
      );
      if (implementOutput?.type !== "attempt.output") {
        throw new Error("unreachable");
      }
      expect(implementOutput.output).toMatchObject({
        kind: "implement",
        commitSha,
      });

      // Review runs detached in its own child process and accepts the
      // untouched workspace, finishing the task.
      const reviewStart = await runtime.harness.step(
        makeReviewRequest({ commitSha }),
      );
      if (reviewStart.kind !== "event") throw new Error("unreachable");
      clientAt(clients, 2).enqueue(
        messageEnd({
          text: JSON.stringify({
            kind: "review",
            decision: "accepted",
            findings: [],
            remainingGaps: [],
          }),
        }),
        { type: "agent_settled" },
      );
      const review = await collect(runtime.harness, {
        ...makeReviewRequest({ commitSha }),
        backendCursor: reviewStart.nextCursor,
      });
      expect(review.events.at(-1)?.type).toBe("attempt.completed");

      // One detached child process per role attempt, all routed to the
      // attributed default model.
      expect(clients).toHaveLength(3);
      for (const client of clients) {
        expect(client.requests).toContainEqual({
          command: "set_model",
          params: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
        });
      }

      // Deliveries of one attempt publish strictly increasing sequences.
      for (const run of [scout, implement, review]) {
        const sequences = run.events.map((event) => event.sequence);
        expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
        expect(new Set(sequences).size).toBe(sequences.length);
      }
    } finally {
      await runtime.close();
    }
  } finally {
    if (previous === undefined) delete process.env.ROC_PI_EXPERIMENTAL;
    else process.env.ROC_PI_EXPERIMENTAL = previous;
  }
});

test("shutdown reaps live injected clients and drops closed ones", async () => {
  const previous = process.env.ROC_PI_EXPERIMENTAL;
  const probe = new ScriptedProbeClient(probeModels, probeDefaultModel);
  const clients: RecordedPiClient[] = [];
  try {
    process.env.ROC_PI_EXPERIMENTAL = "1";
    const factory = buildPiBackendFactory({
      startProbeClient: async () => probe,
      startAttemptClient: async () => {
        const client = new RecordedPiClient();
        clients.push(client);
        return client;
      },
    });
    const runtime = await factory({ branches: memoryBranches() });
    try {
      // Attempt A runs to completion; its client is reaped and untracked by
      // the terminalization path.
      const startedA = await runtime.harness.step(
        makeScoutRequest("attempt-done"),
      );
      if (startedA.kind !== "event") throw new Error("unreachable");
      clientAt(clients, 0).enqueue(messageEnd(), { type: "agent_settled" });
      await collect(runtime.harness, {
        ...makeScoutRequest("attempt-done"),
        backendCursor: startedA.nextCursor,
      });
      expect(clientAt(clients, 0).closeCount).toBe(1);

      // Attempt B stays live mid-turn.
      await runtime.harness.step(makeScoutRequest("attempt-live"));
    } finally {
      await runtime.close();
    }
    // The live injected client is reaped by shutdown; the already-closed
    // one is not closed a second time.
    expect(clientAt(clients, 0).closeCount).toBe(1);
    expect(clientAt(clients, 1).closeCount).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.ROC_PI_EXPERIMENTAL;
    else process.env.ROC_PI_EXPERIMENTAL = previous;
  }
});
