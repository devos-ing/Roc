import type { z } from "zod";
import type { ModelProfileSchema } from "../domain/schemas";

export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type CatalogModel = Readonly<{
  id: string;
  supportedReasoningEfforts: readonly string[];
}>;
export type ModelMapping = Readonly<Partial<Record<ModelProfile, string>>>;
export type AdvisorInput = {
  role: "scout" | "implement" | "review";
  risk: "low" | "medium" | "high";
  retryIndex: 0 | 1 | 2;
  priorProfile?: ModelProfile;
  priorErrorCode?: string;
};
export type Route = {
  profile: ModelProfile;
  model: string;
  effort: "high" | "xhigh";
  fallbacks: string[];
  rationale: string[];
};
export type ModelAdvisor = { decide(input: AdvisorInput): Route | undefined };

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

/** Creates a model advisor from a stable catalog snapshot and optional mappings. */
export function createModelAdvisor(
  catalog: readonly CatalogModel[],
  mapping: ModelMapping = {},
): ModelAdvisor {
  const catalogSnapshot = catalog.map((model) => ({
    id: model.id,
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
  }));
  const mappingSnapshot: ModelMapping = { ...mapping };
  /** Finds the configured or inferred catalog model supporting a profile and effort. */
  const modelForProfile = (
    profile: ModelProfile,
    effort: Route["effort"],
  ): string | undefined => {
    const mapped = mappingSnapshot[profile];
    const configured =
      mapped === undefined
        ? undefined
        : catalogSnapshot.find((model) => model.id === mapped);
    if (configured?.supportedReasoningEfforts.includes(effort))
      return configured.id;
    return catalogSnapshot.find(
      (model) =>
        profileForModel(model.id) === profile &&
        model.supportedReasoningEfforts.includes(effort),
    )?.id;
  };

  return {
    /** Chooses the first compatible routed model and records its fallbacks and rationale. */
    decide(input) {
      const effort: Route["effort"] = input.risk === "high" ? "xhigh" : "high";
      const choices = routeProfiles(input).flatMap((profile) => {
        const model = modelForProfile(profile, effort);
        return model === undefined ? [] : [{ profile, model }];
      });
      const choice = choices[0];
      if (choice === undefined) return undefined;

      return {
        profile: choice.profile,
        model: choice.model,
        effort,
        fallbacks: choices.slice(1).map((fallback) => fallback.model),
        rationale: routeRationale(input, choice.profile),
      };
    },
  };
}

/** Creates the deterministic built-in advisor for the three standard profiles. */
export function createStaticModelAdvisor(): ModelAdvisor {
  return createModelAdvisor(
    profileOrder.map((id) => ({
      id,
      supportedReasoningEfforts: ["high", "xhigh"],
    })),
    { luna: "luna", terra: "terra", sol: "sol" },
  );
}
