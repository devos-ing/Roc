import { AgileError } from "../../runtime/errors";
import type { CatalogModel } from "../../scheduler/model-routing";
import type { BackendFactory } from "../types";
import { ZcodeClient } from "./client";
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
export const startZcodeBackend: BackendFactory = async ({ branches }) => {
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
  const client = await ZcodeClient.start();
  const effectiveModel = client.effectiveModel;
  if (effectiveModel === undefined) {
    await client.close().catch(() => undefined);
    throw new AgileError({
      code: "ZCODE_MODEL_UNRESOLVED",
      category: "startup",
      retryable: false,
      component: "zcode-backend",
      message:
        "ZCODE_MODEL is unset and no enabled desktop provider defines a model; " +
        "the child would run an unobservable server-side default",
    });
  }
  try {
    const catalog: CatalogModel[] = [
      { id: effectiveModel, supportedReasoningEfforts: ["high", "xhigh"] },
    ];
    const harness = createZcodeHarness({ client, branches });
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
