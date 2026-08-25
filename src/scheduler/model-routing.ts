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
