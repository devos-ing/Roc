import { expect, test } from "bun:test";
import {
  buildPiBackendFactory,
  startPiBackend,
} from "../../../src/agents/pi/backend";
import type { PiClientApi } from "../../../src/agents/pi/client";
import { backends } from "../../../src/agents/registry";

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
      // A model without a thinking level map supports every Roc effort.
      expect(runtime.catalog).toContainEqual({
        id: "bigmodel/glm-5.3",
        supportedReasoningEfforts: ["medium", "high", "xhigh"],
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
