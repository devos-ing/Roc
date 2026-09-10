import { AgileError } from "../../runtime/errors";
import type {
  CatalogModel,
  ModelMapping,
  RoleEfforts,
} from "../../scheduler/model-routing";
import { loadRocSettings } from "../../settings";
import {
  buildDefaultSkillConfig,
  discoverTrustedSkills,
  loadSchedulerSkillPolicy,
} from "../../skills/policy";
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
 * none. Without a thinking-level map the safe default subset is medium and
 * high; with one, a missing key keeps the default support for medium/high
 * while an explicit null drops that level, and xhigh is only ever published
 * from an explicit non-null mapping.
 */
function supportedEfforts(model: PiModel): string[] {
  if (model.reasoning === false) return [];
  const map = model.thinkingLevelMap;
  if (map === undefined) return ["medium", "high"];
  return ROC_EFFORTS.filter((effort) => {
    const level = map[effort];
    return effort === "xhigh" ? level != null : level !== null;
  });
}

/** Reads the model the Pi process would run into a validated Pi model. */
function validateDefaultModel(raw: unknown): PiModel | undefined {
  const parsed = PiModelSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Requires explicit acknowledgement before Pi runs with the process user permissions. */
function assertExecutionPermission(allowUnsandboxed = false): void {
  if (!allowUnsandboxed && process.env.ROC_ALLOW_UNSANDBOXED !== "1") {
    throw new AgileError({
      code: "PI_SANDBOX_REQUIRED",
      category: "startup",
      retryable: false,
      component: "pi-backend",
      message:
        "Pi has no built-in sandbox and " +
        "its tools run with the full process user permissions, so a role " +
        "turn can write anywhere the user can. Run onboard to authorize execution, or set ROC_ALLOW_UNSANDBOXED=1 " +
        "to acknowledge and confine the process with an external OS " +
        "sandbox or container.",
    });
  }
}

/**
 * Starts the registry-facing Pi backend: a probe process resolves the
 * attributed default model and the durable catalog, then every role attempt
 * runs in its own child process rooted at its task workspace. Safety limits
 * and the execution permission requirement live in docs/architecture.md.
 */
export const startPiBackend: BackendFactory = async (context) => {
  const settings = await loadRocSettings();
  const allowUnsandboxed = settings.execution?.allowUnsandboxed === true;
  assertExecutionPermission(allowUnsandboxed);
  const policy = await loadSchedulerSkillPolicy();
  const skillPaths = buildDefaultSkillConfig(
    await discoverTrustedSkills(policy),
    policy,
  )
    .filter((skill) => skill.enabled)
    .map((skill) => skill.path);
  return buildPiBackendFactory({
    startProbeClient: () => PiClient.start({ cwd: process.cwd() }),
    skillPaths,
    allowUnsandboxed,
    models: settings.models,
    efforts: settings.efforts,
  })(context);
};

/**
 * Builds a Pi backend factory around injectable process starters; tests use
 * this to drive the real factory path against scripted clients, while
 * production code enters through startPiBackend only.
 */
export function buildPiBackendFactory(input: {
  startProbeClient: () => Promise<PiClientApi>;
  skillPaths?: readonly string[];
  allowUnsandboxed?: boolean;
  models?: ModelMapping;
  efforts?: RoleEfforts;
  startAttemptClient?: (cwd: string) => Promise<PiClientApi>;
}): BackendFactory {
  return async ({ branches }: { branches: TaskBranchManager }) => {
    assertExecutionPermission(input.allowUnsandboxed);

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
        // Unconfigured profiles use the probe's effective default model.
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

      const modelMapping: Record<"luna" | "terra" | "sol", string> = {
        luna: defaultId,
        terra: defaultId,
        sol: defaultId,
      };
      for (const profile of ["luna", "terra", "sol"] as const) {
        const configured = input.models?.[profile];
        if (configured === undefined) continue;
        if (
          !catalog.some(
            (model) =>
              model.id === configured &&
              model.supportedReasoningEfforts.includes("high"),
          )
        ) {
          throw new AgileError({
            code: "PI_MODEL_MAPPING_INVALID",
            category: "startup",
            retryable: false,
            component: "pi-backend",
            message: `The configured ${profile} model must exist in the Pi catalog and support high reasoning`,
          });
        }
        modelMapping[profile] = configured;
      }

      // The probe process is only a catalog oracle; role attempts spawn
      // their own children.
      const liveClients = new Set<PiClientApi>();
      const closeFailures: unknown[] = [];
      /**
       * Tracks a live attempt client so runtime shutdown closes it, and
       * drops it only after confirmed close while retaining any failure evidence.
       */
      const trackAttemptClient = (client: PiClientApi): PiClientApi => {
        liveClients.add(client);
        return {
          request: (command, params) => client.request(command, params),
          send: (message) => client.send(message),
          nextEvent: () => client.nextEvent(),
          close: async () => {
            try {
              await client.close();
              liveClients.delete(client);
            } catch (error) {
              closeFailures.push(error);
              throw error;
            }
          },
        };
      };
      /**
       * Starts one attempt client through the injected or the default
       * starter, unified under the same tracking wrapper so shutdown covers
       * injected clients too.
       */
      const startAttemptClient = async (cwd: string) =>
        trackAttemptClient(
          input.startAttemptClient
            ? await input.startAttemptClient(cwd)
            : await PiClient.start({ cwd, skillPaths: input.skillPaths }),
        );
      let closed: Promise<void> | undefined;
      return {
        catalog,
        modelMapping,
        efforts: input.efforts,
        harness: createPiHarness({ branches, startClient: startAttemptClient }),
        close: () => {
          closed ??= (async () => {
            const results = await Promise.allSettled(
              [...liveClients, probe].map((client) =>
                Promise.resolve().then(() => client.close()),
              ),
            );
            if (closeFailures.length > 0) throw closeFailures[0];
            const failed = results.find(
              (result) => result.status === "rejected",
            );
            if (failed?.status === "rejected") throw failed.reason;
            liveClients.clear();
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
