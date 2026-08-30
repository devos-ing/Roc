import { expect, test } from "bun:test";
import { loadCatalog } from "../../../src/agents/codex/backend";
import { AgileError } from "../../../src/runtime/errors";

test("catalog loading preserves a structured client failure", async () => {
  const clientError = new AgileError({
    code: "CODEX_APP_SERVER_EXITED",
    category: "infra",
    retryable: true,
    component: "codex-client",
    message: "Codex app-server exited",
  });
  const client = {
    request: async () => {
      throw clientError;
    },
  };

  await expect(loadCatalog(client)).rejects.toMatchObject({
    code: "CODEX_APP_SERVER_EXITED",
    category: "infra",
    retryable: true,
    component: "codex-client",
  });
});

test("catalog loading wraps an unstructured request failure", async () => {
  const client = {
    request: async () => {
      throw new Error("unsafe provider detail");
    },
  };

  await expect(loadCatalog(client)).rejects.toMatchObject({
    code: "CODEX_MODEL_CATALOG_FAILED",
    category: "startup",
    retryable: false,
    component: "cli",
    message: "Could not load the Codex model catalog",
  });
});
