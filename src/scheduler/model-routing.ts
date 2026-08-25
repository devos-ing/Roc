import type { z } from "zod";
import { AgentRoleSchema, ReasoningEffortSchema } from "../harness/contracts";

export type Route = {
  model: "luna" | "terra" | "sol";
  effort: z.infer<typeof ReasoningEffortSchema>;
  fallbacks: Array<"luna" | "terra" | "sol">;
  rationale: string[];
};

export function baselineRoute(role: z.infer<typeof AgentRoleSchema>, risk: "low" | "medium" | "high"): Route {
  const model = role === "scout" ? "luna" : role === "implement" ? "terra" : "sol";
  const effort = risk === "high" ? "xhigh" : "high";
  const fallbacks: Route["fallbacks"] = model === "luna" ? ["terra", "sol"] : model === "terra" ? ["sol"] : [];
  return { model, effort, fallbacks, rationale: [`${role} baseline`, `${risk} risk`] };
}

export function retryRoute(
  role: "scout" | "implement" | "review",
  risk: "low" | "medium" | "high",
  retryIndex: 1 | 2,
  priorModel: "luna" | "terra" | "sol",
  priorErrorCode: string,
): Route {
  const shouldUpgrade = retryIndex === 2 || priorErrorCode === "model_unavailable";
  const model = shouldUpgrade
    ? priorModel === "luna" ? "terra" : "sol"
    : priorModel;
  const baseline = baselineRoute(role, risk);
  return {
    model,
    effort: baseline.effort,
    fallbacks: model === "luna" ? ["terra", "sol"] : model === "terra" ? ["sol"] : [],
    rationale: [`${role} retry ${retryIndex}`, shouldUpgrade ? "model upgraded" : "model retained"],
  };
}
