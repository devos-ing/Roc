import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZcodeClient } from "../../../src/agents/zcode/client";
import { AgileError } from "../../../src/runtime/errors";

const fixturePath = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "scripted-zcode-app-server.ts",
);

test("creates a session past the preferences handshake and delivers turn events", async () => {
  const client = await ZcodeClient.start({
    command: [process.execPath, fixturePath],
  });

  try {
    const created = (await client.request("session/create", {
      workspace: { workspacePath: "/tmp", workspaceKey: "/tmp" },
      mode: "yolo",
    })) as { session: { sessionId: string } };
    expect(created.session.sessionId).toBe("sess_fixture_1");

    await client.request("session/subscribe", {
      sessionId: "sess_fixture_1",
      deliveryKind: "desktop-continuous",
    });
    const sent = (await client.request("session/send", {
      sessionId: "sess_fixture_1",
      content: "scout",
    })) as { accepted: boolean };
    expect(sent.accepted).toBe(true);

    const event = (await client.nextServerMessage()) as {
      method: string;
      params: { type: string };
    };
    expect(event.method).toBe("session/event");
    expect(event.params.type).toBe("turn.completed");

    await client.request("fixture/exit", {});
    await expect(client.request("session/list", {})).rejects.toMatchObject({
      code: "ZCODE_APP_SERVER_EXITED",
      category: "infra",
    });
  } finally {
    await client.close();
  }
});

test("child exit rejects future message reads instead of exposing queued messages", async () => {
  const client = await ZcodeClient.start({
    command: [process.execPath, fixturePath],
  });

  try {
    const created = (await client.request("session/create", {
      workspace: { workspacePath: "/tmp", workspaceKey: "/tmp" },
      mode: "yolo",
    })) as { session: { sessionId: string } };
    expect(created.session.sessionId).toBe("sess_fixture_1");
    await client.request("fixture/exit", {});
    await expect(client.nextServerMessage()).rejects.toMatchObject({
      code: "ZCODE_APP_SERVER_EXITED",
    });
  } finally {
    await client.close();
  }
});

test("a write racing stdin closure waits for the pending child exit", async () => {
  const client = await ZcodeClient.start({
    command: [
      "node",
      join(import.meta.dir, "../../fixtures/closed-stdin-rpc.mjs"),
    ],
  });
  try {
    await client.request("fixture/closeStdin", { exitDelayMs: 25 });
    const messageFailure = client
      .nextServerMessage()
      .catch((error: unknown) => error);
    await expect(client.request("session/list", {})).rejects.toMatchObject({
      code: "ZCODE_APP_SERVER_EXITED",
      category: "infra",
      retryable: true,
    });
    expect(await messageFailure).toMatchObject({
      code: "ZCODE_APP_SERVER_EXITED",
    });
  } finally {
    await client.close();
  }
});

test("closed stdin on a live child fails promptly with a sanitized write error", async () => {
  const client = await ZcodeClient.start({
    command: [
      "node",
      join(import.meta.dir, "../../fixtures/closed-stdin-rpc.mjs"),
    ],
  });
  try {
    await client.request("fixture/closeStdin", {});
    const messageFailure = client
      .nextServerMessage()
      .catch((error: unknown) => error);
    client.notify("fixture/notify", { secret: "zcode-secret-sentinel" });
    expect(await messageFailure).toMatchObject({
      code: "ZCODE_APP_SERVER_WRITE_FAILED",
      category: "infra",
      retryable: true,
      message: "Could not write to the ZCode app-server",
    });
    await expect(client.request("session/list", {})).rejects.toMatchObject({
      code: "ZCODE_APP_SERVER_WRITE_FAILED",
    });
  } finally {
    await client.close();
  }
}, 2_000);

/** Writes one desktop-style enabled-provider credentials fixture. */
async function writeCredentials(root: string): Promise<string> {
  const path = join(root, "zcode-config.json");
  await writeFile(
    path,
    JSON.stringify({
      provider: {
        bigmodel: {
          enabled: true,
          options: {
            baseURL: "https://api.bigmodel.test/anthropic",
            apiKey: "test-key",
          },
          models: { "GLM-5.3": {} },
        },
      },
    }),
  );
  return path;
}

/** Neutralizes an inherited ZCODE_MODEL so resolution tests are hermetic. */
async function withCleanModelEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.ZCODE_MODEL;
  delete process.env.ZCODE_MODEL;
  try {
    return await run();
  } finally {
    if (previous !== undefined) process.env.ZCODE_MODEL = previous;
  }
}

/** Reads the child process's effective ZCODE_MODEL through the fixture. */
async function echoChildModel(client: ZcodeClient): Promise<string | null> {
  const echoed = (await client.request("fixture/echoEnv", {})) as {
    zcodeModel: string | null;
  };
  return echoed.zcodeModel;
}

test("session model resolution: an input.env override wins and pins the child env", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-zcode-resolve-"));
  try {
    const credentialsPath = await writeCredentials(root);
    const client = await withCleanModelEnv(() =>
      ZcodeClient.start({
        command: [process.execPath, fixturePath],
        credentialsPath,
        env: { ZCODE_MODEL: "  glm-4.7  " },
      }),
    );
    try {
      expect(client.sessionModel).toEqual({
        providerId: "bigmodel",
        modelId: "glm-4.7",
      });
      expect(await echoChildModel(client)).toBe("glm-4.7");
    } finally {
      await client.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session model resolution: blank process values fall back to the enabled provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-zcode-resolve-"));
  const previous = process.env.ZCODE_MODEL;
  process.env.ZCODE_MODEL = "   ";
  try {
    const credentialsPath = await writeCredentials(root);
    const client = await ZcodeClient.start({
      command: [process.execPath, fixturePath],
      credentialsPath,
    });
    try {
      expect(client.sessionModel).toEqual({
        providerId: "bigmodel",
        modelId: "GLM-5.3",
      });
      expect(await echoChildModel(client)).toBe("GLM-5.3");
    } finally {
      await client.close();
    }
  } finally {
    if (previous === undefined) delete process.env.ZCODE_MODEL;
    else process.env.ZCODE_MODEL = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("session model resolution: the enabled provider's first model is attributed", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-zcode-resolve-"));
  try {
    const credentialsPath = await writeCredentials(root);
    const client = await withCleanModelEnv(() =>
      ZcodeClient.start({
        command: [process.execPath, fixturePath],
        credentialsPath,
      }),
    );
    try {
      expect(client.sessionModel).toEqual({
        providerId: "bigmodel",
        modelId: "GLM-5.3",
      });
      expect(await echoChildModel(client)).toBe("GLM-5.3");
    } finally {
      await client.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session model resolution: missing config leaves no attributable pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-zcode-resolve-"));
  try {
    const client = await withCleanModelEnv(() =>
      ZcodeClient.start({
        command: [process.execPath, fixturePath],
        credentialsPath: join(root, "absent.json"),
      }),
    );
    try {
      expect(client.sessionModel).toBeUndefined();
    } finally {
      await client.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider rpc rejection text never reaches the durable error message", async () => {
  const client = await withCleanModelEnv(() =>
    ZcodeClient.start({ command: [process.execPath, fixturePath] }),
  );
  try {
    let failure: unknown;
    try {
      await client.request("fixture/rpcError", {});
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AgileError);
    const error = failure as AgileError;
    expect(error.code).toBe("ZCODE_APP_SERVER_RPC_ERROR");
    expect(error.message).toBe("ZCode app-server rejected the request");
    expect(error.message).not.toContain("zcode-secret-sentinel");
    // The raw provider text stays in the non-persisted cause for debugging.
    expect(JSON.stringify(error.cause)).toContain("zcode-secret-sentinel");
  } finally {
    await client.close();
  }
});
