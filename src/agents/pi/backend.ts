import { AgileError } from "../../runtime/errors";
import type { CatalogModel } from "../../scheduler/model-routing";
import type { TaskBranchManager } from "../../workspace/task-branch";
import type { BackendFactory } from "../types";
import { PiClient, type PiClientApi } from "./client";
import { createPiHarness } from "./harness";
import {
  PiAvailableModelsDataSchema,
  PiGetStateDataSchema,
  type PiModel,
  PiModelSchema,
} from "./protocol";

/** Every Roc reasoning effort is also a Pi thinking level. */
const ROC_EFFORTS = ["medium", "high", "xhigh"] as const;

/** Builds the catalog identifier for one provider model. */
function catalogId(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Lists the Roc efforts a model supports. Reasoning-disabled models support
 * none. A mapped model supports exactly its explicitly non-null levels; an
 * unmapped reasoning model gets the safe default subset, and xhigh is only
 * ever published from an explicit non-null mapping.
 */
function supportedEfforts(model: PiModel): string[] {
  if (model.reasoning === false) return [];
  const levels =
    model.thinkingLevelMap === undefined
      ? []
      : Object.entries(model.thinkingLevelMap)
          .filter(([, level]) => level != null)
          .map(([level]) => level);
  if (levels.length === 0) return ["medium", "high"];
  return ROC_EFFORTS.filter((effort) => levels.includes(effort));
}

/** Reads the model the Pi process would run into a validated Pi model. */
function validateDefaultModel(raw: unknown): PiModel | undefined {
  const parsed = PiModelSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Starts the registry-facing Pi backend: a probe process resolves the
 * attributed default model and the durable catalog, then every role attempt
 * runs in its own child process rooted at its task workspace. Safety limits
 * and the experimental gate rationale live in docs/architecture.md.
 */
export const startPiBackend: BackendFactory = (context) =>
  buildPiBackendFactory({
    startProbeClient: () => PiClient.start({ cwd: process.cwd() }),
  })(context);

/**
 * Builds a Pi backend factory around injectable process starters; tests use
 * this to drive the real factory path against scripted clients, while
 * production code enters through startPiBackend only.
 */
export function buildPiBackendFactory(input: {
  startProbeClient: () => Promise<PiClientApi>;
  startAttemptClient?: (cwd: string) => Promise<PiClientApi>;
}): BackendFactory {
  return async ({ branches }: { branches: TaskBranchManager }) => {
    if (process.env.ROC_PI_EXPERIMENTAL !== "1") {
      throw new AgileError({
        code: "PI_EXPERIMENTAL_GATE",
        category: "startup",
        retryable: false,
        component: "pi-backend",
        message:
          "--backend pi is production-gated: Pi has no built-in sandbox and " +
          "its tools run with the full process user permissions, so a role " +
          "turn can write anywhere the user can. Set ROC_PI_EXPERIMENTAL=1 " +
          "to acknowledge and confine the process with an external OS " +
          "sandbox or container.",
      });
    }

    const probe = await input.startProbeClient();
    try {
      let defaultModel: PiModel | undefined;
      let catalogModels: readonly PiModel[];
      try {
        const models = PiAvailableModelsDataSchema.parse(
          await probe.request("get_available_models"),
        ).models;
        const state = PiGetStateDataSchema.parse(
          await probe.request("get_state"),
        );
        // The probe's effective model is the one attributed attempt runs
        // re-assert; an unresolvable default would run an unobservable
        // server-side default instead.
        defaultModel = validateDefaultModel(state.model);
        catalogModels = models;
      } catch (error) {
        throw new AgileError({
          code: "PI_CATALOG_UNAVAILABLE",
          category: "startup",
          retryable: false,
          component: "pi-backend",
          message: "The Pi probe could not resolve its model catalog",
          cause: error,
        });
      }
      if (defaultModel === undefined) {
        throw new AgileError({
          code: "PI_MODEL_UNRESOLVED",
          category: "startup",
          retryable: false,
          component: "pi-backend",
          message:
            "The Pi probe reports no effective default model; role attempts " +
            "must not run an unobservable server-side default",
        });
      }
      const defaultEfforts = supportedEfforts(defaultModel);
      if (!defaultEfforts.includes("high")) {
        throw new AgileError({
          code: "PI_MODEL_UNSUPPORTED",
          category: "startup",
          retryable: false,
          component: "pi-backend",
          message:
            "The Pi default model does not support the Roc reasoning efforts",
        });
      }

      const defaultId = catalogId(defaultModel);
      const catalog: CatalogModel[] = [];
      for (const model of catalogModels) {
        const efforts = supportedEfforts(model);
        if (efforts.length === 0) continue;
        catalog.push({
          id: catalogId(model),
          supportedReasoningEfforts: efforts,
        });
      }
      if (!catalog.some((model) => model.id === defaultId)) {
        catalog.push({
          id: defaultId,
          supportedReasoningEfforts: defaultEfforts,
        });
      }

      // The probe process is only a catalog oracle; role attempts spawn
      // their own children, and every live child is reaped on close. Both
      // the default and the injected starter are tracked through the same
      // wrapper so shutdown covers injected clients too, and a client that
      // closes itself is dropped from tracking instead of accumulating.
      const liveClients = new Set<PiClientApi>();
      const trackAttemptClient = (client: PiClientApi): PiClientApi => {
        liveClients.add(client);
        return {
          request: (command, params) => client.request(command, params),
          send: (message) => client.send(message),
          nextEvent: () => client.nextEvent(),
          close: async () => {
            try {
              await client.close();
            } finally {
              liveClients.delete(client);
            }
          },
        };
      };
      const startAttemptClient = async (cwd: string) =>
        trackAttemptClient(
          input.startAttemptClient
            ? await input.startAttemptClient(cwd)
            : await PiClient.start({ cwd }),
        );
      let closed: Promise<void> | undefined;
      return {
        catalog,
        // Pi exposes one attributed default model, so every advisor profile
        // routes to it explicitly instead of relying on profile-suffixed IDs.
        modelMapping: {
          luna: defaultId,
          terra: defaultId,
          sol: defaultId,
        },
        harness: createPiHarness({ branches, startClient: startAttemptClient }),
        close: () => {
          closed ??= (async () => {
            await Promise.allSettled(
              [...liveClients].map((client) => client.close()),
            );
            liveClients.clear();
            await probe.close();
          })();
          return closed;
        },
      };
    } catch (error) {
      await probe.close().catch(() => undefined);
      throw error;
    }
  };
}
