import { AgileError } from "../../runtime/errors";
import type { CatalogModel } from "../../scheduler/model-routing";
import type { TaskBranchManager } from "../../workspace/task-branch";
import type { BackendFactory, BackendRuntime } from "../types";
import { ZcodeClient, type ZcodeClientApi } from "./client";
import { createZcodeHarness } from "./harness";

/**
 * Starts the registry-facing ZCode backend: one attributable session model
 * published as a single-entry catalog that routes every advisor profile.
 * Safety limits and the experimental gate rationale live in
 * docs/architecture.md.
 */
export const startZcodeBackend: BackendFactory = (context) =>
  buildZcodeBackendFactory(() => ZcodeClient.start())(context);

/**
 * Builds a ZCode backend factory around an injectable client starter; tests
 * use this to drive the real factory path against a scripted client, while
 * production code enters through startZcodeBackend only.
 */
export function buildZcodeBackendFactory(
  startClient: () => Promise<ZcodeClientApi>,
): BackendFactory {
  return async ({ branches }) => {
    if (process.env.ROC_ZCODE_EXPERIMENTAL !== "1") {
      throw new AgileError({
        code: "ZCODE_EXPERIMENTAL_GATE",
        category: "startup",
        retryable: false,
        component: "zcode-backend",
        message:
          "--backend zcode is production-gated: ZCode has no protocol-level " +
          "filesystem sandbox and unattended yolo sessions auto-approve sandbox " +
          "disable requests. Set ROC_ZCODE_EXPERIMENTAL=1 to acknowledge and " +
          "confine the process with an external OS sandbox or container.",
      });
    }
    const client = await startClient();
    const sessionModel = client.sessionModel;
    if (sessionModel === undefined) {
      await client.close().catch(() => undefined);
      throw new AgileError({
        code: "ZCODE_MODEL_UNRESOLVED",
        category: "startup",
        retryable: false,
        component: "zcode-backend",
        message:
          "ZCODE_MODEL is unset or blank and no enabled desktop provider " +
          "attributes a complete provider/model pair; the child would run an " +
          "unobservable server-side default",
      });
    }
    try {
      const catalog: CatalogModel[] = [
        {
          id: sessionModel.modelId,
          supportedReasoningEfforts: ["high", "xhigh"],
        },
      ];
      return {
        catalog,
        // ZCode exposes exactly one effective model, so every advisor profile
        // routes to it explicitly instead of relying on profile-suffixed IDs.
        modelMapping: {
          luna: sessionModel.modelId,
          terra: sessionModel.modelId,
          sol: sessionModel.modelId,
        },
        harness: createZcodeHarness({ client, branches }),
        close: () => client.close(),
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  };
}
