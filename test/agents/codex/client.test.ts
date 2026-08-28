import { expect, test } from "bun:test";
import { join } from "node:path";
import { CodexClient } from "../../../src/agents/codex/client";
import { ModelListResponseSchema } from "../../../src/agents/codex/protocol";

test("initializes the app server and correlates requests while preserving inbound messages", async () => {
  const fixturePath = join(
    import.meta.dir,
    "..",
    "..",
    "fixtures",
    "scripted-app-server.ts",
  );
  const client = await CodexClient.start({
    command: [process.execPath, fixturePath],
    clientInfo: {
      name: "agile_agents_test",
      title: "Agile Agents Test",
      version: "0.1.0",
    },
  });

  try {
    const models = ModelListResponseSchema.parse(
      await client.request("model/list", {
        limit: 100,
        includeHidden: false,
      }),
    );
    expect(models.data[0]).toMatchObject({
      id: "gpt-5.6-terra",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    });
    expect(await client.nextServerMessage()).toMatchObject({
      method: "warning",
    });

    await client.request("fixture/exit", {});
    await expect(client.request("model/list", {})).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_EXITED",
      category: "infra",
    });
  } finally {
    await client.close();
  }
});

test("child exit rejects future message reads instead of exposing queued messages", async () => {
  const fixturePath = join(
    import.meta.dir,
    "..",
    "..",
    "fixtures",
    "scripted-app-server.ts",
  );
  const client = await CodexClient.start({
    command: [process.execPath, fixturePath],
    clientInfo: {
      name: "agile_agents_test",
      title: "Agile Agents Test",
      version: "0.1.0",
    },
  });

  try {
    await client.request("fixture/exit", {});
    await expect(client.request("model/list", {})).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_EXITED",
      category: "infra",
    });
    await expect(client.nextServerMessage()).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_EXITED",
      category: "infra",
    });
  } finally {
    await client.close();
  }
});

test("close immediately rejects a blocked server-message read and terminates promptly", async () => {
  const fixturePath = join(
    import.meta.dir,
    "..",
    "..",
    "fixtures",
    "scripted-app-server.ts",
  );
  const client = await CodexClient.start({
    command: [process.execPath, fixturePath],
    clientInfo: {
      name: "agile_agents_test",
      title: "Agile Agents Test",
      version: "0.1.0",
    },
  });
  await client.nextServerMessage();
  const blocked = client.nextServerMessage();
  const startedAt = Date.now();

  const closing = client.close();

  await expect(blocked).rejects.toMatchObject({ code: "CODEX_CLIENT_CLOSED" });
  await closing;
  expect(Date.now() - startedAt).toBeLessThan(2_500);
});

test("close force-terminates an app server that ignores graceful termination", async () => {
  const fixturePath = join(
    import.meta.dir,
    "..",
    "..",
    "fixtures",
    "scripted-app-server.ts",
  );
  const client = await CodexClient.start({
    command: [process.execPath, fixturePath],
    clientInfo: {
      name: "agile_agents_test",
      title: "Agile Agents Test",
      version: "0.1.0",
    },
  });
  await client.request("fixture/ignoreSigterm", {});
  const startedAt = Date.now();

  await client.close();

  expect(Date.now() - startedAt).toBeLessThan(3_000);
});

test("classifies structured RPC failure data for scheduler fallback", async () => {
  const fixturePath = join(
    import.meta.dir,
    "..",
    "..",
    "fixtures",
    "scripted-app-server.ts",
  );
  const client = await CodexClient.start({
    command: [process.execPath, fixturePath],
    clientInfo: {
      name: "agile_agents_test",
      title: "Agile Agents Test",
      version: "0.1.0",
    },
  });
  try {
    await expect(
      client.request("fixture/modelUnavailable", {}),
    ).rejects.toMatchObject({
      code: "model_unavailable",
      category: "infra",
      retryable: true,
      message: "The requested Codex model is unavailable",
    });
  } finally {
    await client.close();
  }
});
