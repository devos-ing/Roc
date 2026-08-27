import { expect, test } from "bun:test";
import { join } from "node:path";
import { ZcodeClient } from "../../../src/agents/zcode/client";

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
