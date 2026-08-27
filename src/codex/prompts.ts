import { z } from "zod";
import {
  HarnessRoleInputSchema,
  type HarnessStepRequest,
  ImplementOutputSchema,
  ReviewOutputSchema,
  ScoutOutputSchema,
} from "../harness/contracts";

export const ScoutOutputJsonSchema = z.toJSONSchema(ScoutOutputSchema);
export const ImplementDraftOutputSchema = ImplementOutputSchema.omit({
  commitSha: true,
});
export const ImplementDraftOutputJsonSchema = z.toJSONSchema(
  ImplementDraftOutputSchema,
);
export const ImplementOutputJsonSchema = z.toJSONSchema(ImplementOutputSchema);
export const ReviewOutputJsonSchema = z.toJSONSchema(ReviewOutputSchema);

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
  if (validated.role !== "implement")
    throw new Error("Expected Implement input");

  return [
    "You are the Implement agent for an isolated software ticket.",
    "Implement only the validated ticket, using the Scout capsule as repository guidance.",
    "Run every validation listed in the ticket and report the validations actually completed.",
    "Do not run Git metadata commands or attempt to create a commit.",
    "The trusted Harness will create the commit after it validates your final draft.",
    "Return exactly one JSON object matching the supplied Implement draft output schema.",
    "Do not include a commitSha field.",
    "",
    "Validated ticket:",
    JSON.stringify(validated.ticket, null, 2),
    "",
    "Validated Scout capsule:",
    JSON.stringify(validated.scout, null, 2),
  ].join("\n");
}

export function reviewPrompt(
  input: Extract<HarnessStepRequest["input"], { role: "review" }>,
): string {
  const validated = HarnessRoleInputSchema.parse(input);
  if (validated.role !== "review") throw new Error("Expected Review input");

  return [
    "You are the Review agent for an isolated software ticket.",
    `Review the exact Implement commit ${validated.implementation.commitSha}.`,
    "Do not create, edit, rename, or delete files. Do not make commits.",
    "Return only one JSON object matching this exact Review output JSON schema:",
    JSON.stringify(ReviewOutputJsonSchema),
    'Do not infer acceptance from prose. Use decision "accepted" only when the ticket is satisfied.',
    "",
    "Validated ticket:",
    JSON.stringify(validated.ticket, null, 2),
    "",
    "Validated Scout capsule:",
    JSON.stringify(validated.scout, null, 2),
    "",
    "Validated Implement result:",
    JSON.stringify(validated.implementation, null, 2),
  ].join("\n");
}
