import type { z } from "zod";
import type { ModelProfileSchema } from "../domain/schemas";

export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type CatalogModel = {
  id: string;
  supportedReasoningEfforts: string[];
};
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

function baselineProfile(role: AdvisorInput["role"]): ModelProfile {
  return role === "scout" ? "luna" : role === "implement" ? "terra" : "sol";
}

function profilesFrom(profile: ModelProfile): ModelProfile[] {
  return profileOrder.slice(profileOrder.indexOf(profile));
}

function routeProfiles(input: AdvisorInput): ModelProfile[] {
  const baseline = baselineProfile(input.role);
  if (input.retryIndex === 0 || input.priorProfile === undefined) return profilesFrom(baseline);

  const shouldUpgrade = input.retryIndex === 2 || input.priorErrorCode === "model_unavailable";
  if (!shouldUpgrade) return profilesFrom(input.priorProfile);
  return profilesFrom(profileOrder[Math.min(profileOrder.indexOf(input.priorProfile) + 1, profileOrder.length - 1)]!);
}

function profileForModel(id: string): ModelProfile | undefined {
  return profileOrder.find((profile) => id.toLowerCase().includes(profile));
}

function routeRationale(input: AdvisorInput, chosenProfile: ModelProfile): string[] {
  if (input.retryIndex === 0) return [`${input.role} baseline`, `${input.risk} risk`];
  return [`${input.role} retry ${input.retryIndex}`, chosenProfile === input.priorProfile ? "model retained" : "model upgraded"];
}

export function createModelAdvisor(
  catalog: CatalogModel[],
  mapping: Partial<Record<ModelProfile, string>> = {},
): ModelAdvisor {
  const modelForProfile = (profile: ModelProfile, effort: Route["effort"]): string | undefined => {
    const mapped = mapping[profile];
    const configured = mapped === undefined ? undefined : catalog.find((model) => model.id === mapped);
    if (configured?.supportedReasoningEfforts.includes(effort)) return configured.id;
    return catalog.find((model) =>
      profileForModel(model.id) === profile && model.supportedReasoningEfforts.includes(effort),
    )?.id;
  };

  return {
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

export function createStaticModelAdvisor(): ModelAdvisor {
  return createModelAdvisor(
    profileOrder.map((id) => ({ id, supportedReasoningEfforts: ["high", "xhigh"] })),
    { luna: "luna", terra: "terra", sol: "sol" },
  );
}
