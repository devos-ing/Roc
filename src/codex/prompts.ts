import { z } from "zod";
import {
  HarnessRoleInputSchema,
  ImplementOutputSchema,
  ScoutOutputSchema,
  type HarnessStepRequest,
} from "../harness/contracts";

export const ScoutOutputJsonSchema = z.toJSONSchema(ScoutOutputSchema);
export const ImplementOutputJsonSchema = z.toJSONSchema(ImplementOutputSchema);

export function scoutPrompt(
  input: Extract<HarnessStepRequest["input"], { role: "scout" }>,
): string {
  const validated = HarnessRoleInputSchema.parse(input);
  if (validated.role !== "scout") throw new Error("Expected Scout input");

  return [
    "You are the Scout for an isolated software ticket.",
    "Inspect the repository and identify the smallest safe implementation path.",
    "Do not create, edit, rename, or delete files. Do not make commits.",
    "Return exactly one JSON object matching the supplied Scout output schema.",
    "Base every file, test, and risk entry on evidence from the repository.",
    "",
    "Validated ticket:",
    JSON.stringify(validated.ticket, null, 2),
  ].join("\n");
}

export function implementPrompt(
  input: Extract<HarnessStepRequest["input"], { role: "implement" }>,
): string {
  const validated = HarnessRoleInputSchema.parse(input);
  if (validated.role !== "implement") throw new Error("Expected Implement input");

  return [
    "You are the Implement agent for an isolated software ticket.",
    "Implement only the validated ticket, using the Scout capsule as repository guidance.",
    "Run every validation listed in the ticket and report the validations actually completed.",
    "Create exactly one Git commit containing the attempted change.",
    "Return exactly one JSON object matching the supplied Implement output schema.",
    "The commitSha field must be the full SHA of that commit. Do not claim success without it.",
    "",
    "Validated ticket:",
    JSON.stringify(validated.ticket, null, 2),
    "",
    "Validated Scout capsule:",
    JSON.stringify(validated.scout, null, 2),
  ].join("\n");
}
