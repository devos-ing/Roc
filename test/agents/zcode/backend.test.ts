import { expect, test } from "bun:test";
import {
  buildZcodeBackendFactory,
  startZcodeBackend,
} from "../../../src/agents/zcode/backend";
import type { ZcodeClientApi } from "../../../src/agents/zcode/client";

/**
 * Runs the factory with one experimental-gate value and captures its failure.
 * The gate must reject before any ZCode process is spawned, so the branches
 * context is never touched.
 */
async function gateFailureWith(value: string | undefined): Promise<unknown> {
  const previous = process.env.ROC_ZCODE_EXPERIMENTAL;
  try {
    if (value === undefined) delete process.env.ROC_ZCODE_EXPERIMENTAL;
    else process.env.ROC_ZCODE_EXPERIMENTAL = value;
    try {
      await startZcodeBackend({ branches: undefined as never });
    } catch (error) {
      return error;
    }
    return undefined;
  } finally {
    if (previous === undefined) delete process.env.ROC_ZCODE_EXPERIMENTAL;
    else process.env.ROC_ZCODE_EXPERIMENTAL = previous;
  }
}

test("the backend factory refuses to start without the acknowledgement", async () => {
  for (const value of [undefined, "0"]) {
    await expect(gateFailureWith(value)).resolves.toMatchObject({
      name: "AgileError",
      code: "ZCODE_EXPERIMENTAL_GATE",
      category: "startup",
      retryable: false,
      component: "zcode-backend",
    });
  }
});

test("the gate message tells the operator how to acknowledge", async () => {
  const error = (await gateFailureWith(undefined)) as Error;
  expect(error.message).toContain("ROC_ZCODE_EXPERIMENTAL=1");
  expect(error.message).toContain("filesystem sandbox");
});

test("the factory fails closed and closes the client when no session model can be attributed", async () => {
  const previous = process.env.ROC_ZCODE_EXPERIMENTAL;
  let closed = false;
  try {
    process.env.ROC_ZCODE_EXPERIMENTAL = "1";
    const unattributedClient: ZcodeClientApi = {
      request: async () => {
        throw new Error("unreachable without a session");
      },
      notify: () => {},
      respond: () => {},
      respondError: () => {},
      nextServerMessage: async () => {
        throw new Error("unreachable without a session");
      },
      close: async () => {
        closed = true;
      },
    };

    const factory = buildZcodeBackendFactory(async () => unattributedClient);
    await expect(
      factory({ branches: undefined as never }),
    ).rejects.toMatchObject({
      code: "ZCODE_MODEL_UNRESOLVED",
      category: "startup",
      retryable: false,
      component: "zcode-backend",
    });
    expect(closed).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.ROC_ZCODE_EXPERIMENTAL;
    else process.env.ROC_ZCODE_EXPERIMENTAL = previous;
  }
});
