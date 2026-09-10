import type { z } from "zod";
import type { ModelProfileSchema } from "../domain/schemas";

export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type AgentRole = "scout" | "implement" | "review";
/** Every Roc effort is also a Pi thinking level; no other levels exist. */
export type ReasoningEffort = "medium" | "high" | "xhigh";
export type CatalogModel = Readonly<{
  id: string;
  supportedReasoningEfforts: readonly string[];
}>;
export type ModelMapping = Readonly<Partial<Record<ModelProfile, string>>>;
/** Per-role configured efforts from Roc settings; unset roles keep defaults. */
export type RoleEfforts = Readonly<Partial<Record<AgentRole, ReasoningEffort>>>;
export type AdvisorInput = {
  role: AgentRole;
  risk: "low" | "medium" | "high";
  retryIndex: 0 | 1 | 2;
  priorProfile?: ModelProfile;
  priorErrorCode?: string;
};
export type Route = {
  profile: ModelProfile;
  model: string;
  effort: ReasoningEffort;
  fallbacks: string[];
  rationale: string[];
};
export type ModelAdvisor = { decide(input: AdvisorInput): Route | undefined };
export type AdvisorOptions = Readonly<{
  efforts?: RoleEfforts;
  /** Receives one bounded message per role when its configured effort is unsupported. */
  onDiagnostic?: (message: string) => void;
}>;

const profileOrder: ModelProfile[] = ["luna", "terra", "sol"];

/** Selects the baseline model profile for an agent role. */
function baselineProfile(role: AdvisorInput["role"]): ModelProfile {
  return role === "scout" ? "luna" : role === "implement" ? "terra" : "sol";
}

/** Returns a profile and every progressively stronger fallback after it. */
function profilesFrom(profile: ModelProfile): ModelProfile[] {
  return profileOrder.slice(profileOrder.indexOf(profile));
}

/** Selects the eligible profile sequence for an initial attempt or retry. */
function routeProfiles(input: AdvisorInput): ModelProfile[] {
  if (input.risk === "high") return ["sol"];
  const baseline = baselineProfile(input.role);
  if (input.retryIndex === 0 || input.priorProfile === undefined)
    return profilesFrom(baseline);

  const shouldUpgrade =
    input.retryIndex === 2 || input.priorErrorCode === "model_unavailable";
  if (!shouldUpgrade) return profilesFrom(input.priorProfile);
  return profilesFrom(
    profileOrder[
      Math.min(
        profileOrder.indexOf(input.priorProfile) + 1,
        profileOrder.length - 1,
      )
    ]!,
  );
}

/** Infers a known model profile from a catalog model identifier. */
function profileForModel(id: string): ModelProfile | undefined {
  const normalized = id.toLowerCase();
  return profileOrder.find(
    (profile) => normalized === profile || normalized.endsWith(`-${profile}`),
  );
}

/** Explains the baseline or retry decision for a chosen model profile. */
function routeRationale(
  input: AdvisorInput,
  chosenProfile: ModelProfile,
): string[] {
  if (input.retryIndex === 0)
    return [`${input.role} baseline`, `${input.risk} risk`];
  return [
    `${input.role} retry ${input.retryIndex}`,
    chosenProfile === input.priorProfile ? "model retained" : "model upgraded",
  ];
}

/** Explains how the effective effort relates to the configured one. */
function effortRationale(
  configured: ReasoningEffort | undefined,
  applied: ReasoningEffort,
): string[] {
  if (configured === undefined) return [];
  if (configured === applied) return [`effort ${applied} (configured)`];
  return [
    `configured effort ${configured} unsupported`,
    `effort ${applied} (default)`,
  ];
}

/** Creates a model advisor from a stable catalog snapshot and optional mappings. */
export function createModelAdvisor(
  catalog: readonly CatalogModel[],
  mapping: ModelMapping = {},
  options: AdvisorOptions = {},
): ModelAdvisor {
  const catalogSnapshot = catalog.map((model) => ({
    id: model.id,
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
  }));
  const mappingSnapshot: ModelMapping = { ...mapping };
  const effortsSnapshot: RoleEfforts = { ...(options.efforts ?? {}) };
  const reportedRoles = new Set<AgentRole>();
  /** Reports an unsupported configured effort once per role, never failing the run. */
  const reportUnsupported = (
    role: AgentRole,
    configured: ReasoningEffort,
    fallback: ReasoningEffort,
  ): void => {
    if (reportedRoles.has(role)) return;
    reportedRoles.add(role);
    options.onDiagnostic?.(
      `Configured ${role} effort "${configured}" is unsupported by the routed models; using the default "${fallback}" instead.`,
    );
  };
  /** Finds the configured or inferred catalog model supporting a profile and effort. */
  const modelForProfile = (
    profile: ModelProfile,
    effort: Route["effort"],
  ): string | undefined => {
    const mapped = mappingSnapshot[profile];
    if (mapped !== undefined) {
      return catalogSnapshot.find(
        (model) =>
          model.id === mapped &&
          model.supportedReasoningEfforts.includes(effort),
      )?.id;
    }
    return catalogSnapshot.find(
      (model) =>
        profileForModel(model.id) === profile &&
        model.supportedReasoningEfforts.includes(effort),
    )?.id;
  };

  return {
    /** Chooses the first compatible routed model and records its fallbacks and rationale. */
    decide(input) {
      const defaultEffort: ReasoningEffort =
        input.role === "implement" ? "medium" : "high";
      const configured = effortsSnapshot[input.role];
      const candidates: ReasoningEffort[] =
        configured !== undefined && configured !== defaultEffort
          ? [configured, defaultEffort]
          : [defaultEffort];
      for (const effort of candidates) {
        const choices = routeProfiles(input).flatMap((profile) => {
          const model = modelForProfile(profile, effort);
          return model === undefined ? [] : [{ profile, model }];
        });
        const choice = choices[0];
        if (choice === undefined) {
          if (effort !== defaultEffort)
            reportUnsupported(input.role, effort, defaultEffort);
          continue;
        }

        return {
          profile: choice.profile,
          model: choice.model,
          effort,
          fallbacks: choices.slice(1).map((fallback) => fallback.model),
          rationale: [
            ...routeRationale(input, choice.profile),
            ...effortRationale(configured, effort),
          ],
        };
      }
      return undefined;
    },
  };
}

/** Creates the deterministic built-in advisor for the three standard profiles. */
export function createStaticModelAdvisor(): ModelAdvisor {
  return createModelAdvisor(
    profileOrder.map((id) => ({
      id,
      supportedReasoningEfforts: ["medium", "high"],
    })),
    { luna: "luna", terra: "terra", sol: "sol" },
  );
}
