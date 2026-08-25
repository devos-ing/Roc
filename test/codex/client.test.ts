import { expect, test } from "bun:test";
import { join } from "node:path";
import { CodexClient } from "../../src/codex/client";
import { ModelListResponseSchema } from "../../src/codex/protocol";

test("initializes the app server and correlates requests while preserving inbound messages", async () => {
  const fixturePath = join(import.meta.dir, "..", "fixtures", "scripted-app-server.ts");
  const client = await CodexClient.start({
    command: [process.execPath, fixturePath],
    clientInfo: {
      name: "agile_agents_test",
      title: "Agile Agents Test",
      version: "0.1.0",
    },
  });

  try {
    const models = ModelListResponseSchema.parse(await client.request("model/list", {
      limit: 100,
      includeHidden: false,
    }));
    expect(models.data[0]).toMatchObject({
      id: "gpt-5.6-terra",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    });
    expect(await client.nextServerMessage()).toMatchObject({ method: "warning" });

    await client.request("fixture/exit", {});
    await expect(client.request("model/list", {})).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_EXITED",
      category: "infra",
    });
  } finally {
    await client.close();
  }
});
