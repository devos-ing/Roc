import { homedir } from "node:os";
import { AgileError } from "../../runtime/errors";
import type { CatalogModel } from "../../scheduler/model-routing";
import { loadRocSettings } from "../../settings";
import type { BackendFactory } from "../types";
import { CodexClient } from "./client";
import { createCodexHarness } from "./harness";
import { ModelListResponseSchema } from "./protocol";
import {
  type DefaultSkillPolicy,
  loadDefaultSkillPolicy,
} from "./skill-policy";

/** Loads the current trusted policy intersected with the saved global selection. */
export async function loadSchedulerSkillPolicy(
  homeRoot = homedir(),
): Promise<DefaultSkillPolicy> {
  const settings = await loadRocSettings(homeRoot);
  return loadDefaultSkillPolicy(homeRoot, settings.skills?.allowlist);
}

/** Loads the visible Codex model catalog over the running client connection. */
async function loadCatalog(client: CodexClient): Promise<CatalogModel[]> {
  try {
    const response = ModelListResponseSchema.parse(
      await client.request("model/list", {
        limit: 100,
        includeHidden: false,
      }),
    );
    return response.data
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.id,
        supportedReasoningEfforts: model.supportedReasoningEfforts.map(
          (effort) => effort.reasoningEffort,
        ),
      }));
  } catch (error) {
    throw new AgileError({
      code: "CODEX_MODEL_CATALOG_FAILED",
      category: "startup",
      retryable: false,
      component: "cli",
      message: "Could not load the Codex model catalog",
      cause: error,
    });
  }
}

/** Starts Codex and returns its catalog, harness, and cleanup handle. */
export const startCodexBackend: BackendFactory = async ({ branches }) => {
  const client = await CodexClient.start();
  try {
    const catalog = await loadCatalog(client);
    const harness = createCodexHarness({
      client,
      branches,
      skillPolicy: await loadSchedulerSkillPolicy(),
    });
    return {
      catalog,
      harness,
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
};
