import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiClient } from "../../../src/agents/pi/client";
import { AgileError } from "../../../src/runtime/errors";

const fixturePath = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "scripted-pi-rpc.ts",
);

/** Starts a client against the scripted fixture rooted at a temp cwd. */
async function startFixtureClient(): Promise<{
  client: PiClient;
  cwd: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "roc-pi-client-"));
  const cwd = await realpath(root);
  const client = await PiClient.start({
    cwd,
    command: [process.execPath, fixturePath],
  });
  return {
    client,
    cwd,
    cleanup: async () => {
      await client.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("resolves command responses, streams events, and honors the cwd", async () => {
  const { client, cwd, cleanup } = await startFixtureClient();
  try {
    const echoed = (await client.request("fixture/echoCwd")) as {
      cwd: string;
    };
    // The working directory is process-level in Pi, so the client must root
    // the child at the requested task workspace.
    expect(echoed.cwd).toBe(cwd);

    const state = (await client.request("get_state")) as {
      sessionId: string;
      sessionFile: string;
    };
    expect(state.sessionId).toBe("sess_fixture_1");
    expect(state.sessionFile).toBe(
      "/tmp/pi-fixture/sessions/sess_fixture_1.jsonl",
    );

    await client.request("set_model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    await client.request("set_thinking_level", { level: "high" });
    await client.request("prompt", { message: "scout" });

    const first = (await client.nextEvent()) as { type: string };
    expect(first.type).toBe("agent_start");
    const settled = (await client.nextEvent()) as { type: string };
    // message_end precedes agent_settled in the fixture's event sequence.
    expect(settled.type).toBe("message_end");
    const third = (await client.nextEvent()) as { type: string };
    expect(third.type).toBe("agent_settled");
  } finally {
    await cleanup();
  }
});

test("child exit rejects future requests and event reads", async () => {
  const { client, cleanup } = await startFixtureClient();
  try {
    await client.request("fixture/exit");
    await expect(client.request("get_state", {})).rejects.toMatchObject({
      code: "PI_RPC_EXITED",
      category: "infra",
    });
    await expect(client.nextEvent()).rejects.toMatchObject({
      code: "PI_RPC_EXITED",
    });
  } finally {
    await cleanup();
  }
});

test("command rejection text never reaches the durable error message", async () => {
  const { client, cleanup } = await startFixtureClient();
  try {
    let failure: unknown;
    try {
      await client.request("fixture/rpcError");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AgileError);
    const error = failure as AgileError;
    expect(error.code).toBe("PI_RPC_ERROR");
    expect(error.message).toBe("Pi rejected the command");
    expect(error.message).not.toContain("pi-secret-sentinel");
    // The raw provider text stays in the non-persisted cause for debugging.
    expect(JSON.stringify(error.cause)).toContain("pi-secret-sentinel");
  } finally {
    await cleanup();
  }
});

test("extension UI requests round-trip a cancellation response", async () => {
  const { client, cleanup } = await startFixtureClient();
  try {
    await client.request("fixture/emitUiRequest");
    const event = (await client.nextEvent()) as {
      type: string;
      id: string;
      method: string;
    };
    expect(event).toMatchObject({
      type: "extension_ui_request",
      method: "confirm",
    });
    client.send({
      type: "extension_ui_response",
      id: event.id,
      cancelled: true,
    });
    const echoed = (await client.request("fixture/uiResponses")) as {
      responses: { id: unknown; cancelled: unknown }[];
    };
    expect(echoed.responses).toEqual([{ id: "ui-fixture-1", cancelled: true }]);
  } finally {
    await cleanup();
  }
});

test("close is idempotent and rejects in-flight consumers", async () => {
  const { client, cleanup } = await startFixtureClient();
  try {
    // Capture the rejection synchronously so closing never races an
    // unhandled rejection past the test's await point.
    const observed = client.nextEvent().then(
      () => undefined,
      (error: unknown) => error,
    );
    await client.close();
    const failure = await observed;
    expect(failure).toMatchObject({ code: "PI_CLIENT_CLOSED" });
    await expect(client.close()).resolves.toBeUndefined();
  } finally {
    await cleanup();
  }
});
