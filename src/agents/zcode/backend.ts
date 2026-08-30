import { AgileError } from "../../runtime/errors";
import type { CatalogModel } from "../../scheduler/model-routing";
import type { TaskBranchManager } from "../../workspace/task-branch";
import type { BackendFactory, BackendRuntime } from "../types";
import { ZcodeClient, type ZcodeClientApi } from "./client";
import { createZcodeHarness } from "./harness";

/**
 * Starts ZCode and returns its single-entry catalog, harness, and cleanup
 * handle.
 *
 * ZCode exposes no model catalog RPC, so the catalog is the one effective
 * model the client resolved at startup — the same model injected into the
 * child environment — and the advertised efforts are the thought levels the
 * harness forwards on every session create. The factory refuses to start
 * without the experimental acknowledgement because ZCode has no
 * protocol-level filesystem sandbox; see docs/architecture.md.
 */
export const startZcodeBackend: BackendFactory = (context) =>
  startZcodeBackendWith({ ...context, startClient: () => ZcodeClient.start() });

/**
 * Runs the real factory path with an injectable client starter, so vertical
 * tests exercise the gate, model resolution, catalog, and harness wiring
 * against a scripted client instead of the bundled app-server.
 */
export async function startZcodeBackendWith(input: {
  branches: TaskBranchManager;
  startClient: () => Promise<ZcodeClientApi>;
}): Promise<BackendRuntime> {
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
  const client = await input.startClient();
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
      harness: createZcodeHarness({ client, branches: input.branches }),
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
