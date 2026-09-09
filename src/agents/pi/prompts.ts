import { z } from "zod";
import {
  HarnessRoleInputSchema,
  type HarnessStepRequest,
  ImplementOutputSchema,
  ReviewOutputSchema,
  ScoutOutputSchema,
} from "../../harness/contracts";

export const ScoutOutputJsonSchema = z.toJSONSchema(ScoutOutputSchema);
export const ImplementDraftOutputSchema = ImplementOutputSchema.omit({
  commitSha: true,
});
export const ImplementDraftOutputJsonSchema = z.toJSONSchema(
  ImplementDraftOutputSchema,
);
export const ReviewOutputJsonSchema = z.toJSONSchema(ReviewOutputSchema);

/** Builds the constrained repository-inspection prompt for a Scout request. */
export function scoutPrompt(
  input: Extract<HarnessStepRequest["input"], { role: "scout" }>,
): string {
  const validated = HarnessRoleInputSchema.parse(input);
  if (validated.role !== "scout") throw new Error("Expected Scout input");

  return [
    "You are the Scout for an isolated software ticket.",
    "Inspect the repository and identify the smallest safe implementation path.",
    "Do not create, edit, rename, or delete files. Do not make commits.",
    "Your final message must be exactly one JSON object and nothing else.",
    "Do not include a $schema property; emit only the data object itself.",
    "The JSON object must match this exact schema:",
    JSON.stringify(ScoutOutputJsonSchema),
    "Output the JSON object without markdown fences or any surrounding prose.",
    "Base every file, test, and risk entry on evidence from the repository.",
    "Keep the capsule concise and focused on this ticket; omit unrelated context, never necessary risks.",
    "Use repository-relative paths and relevant symbol names in files. Point tests to existing tests or runnable validation commands.",
    "Describe unresolved conditions and their evidence in risks. Do not copy whole source files into the capsule.",
    "",
    "Validated ticket:",
    JSON.stringify(validated.ticket, null, 2),
  ].join("\n");
}

/** Builds the constrained ticket-implementation prompt from validated Scout context. */
export function implementPrompt(
  input: Extract<HarnessStepRequest["input"], { role: "implement" }>,
): string {
  const validated = HarnessRoleInputSchema.parse(input);
  if (validated.role !== "implement")
    throw new Error("Expected Implement input");

  return [
    "You are the Implement agent for an isolated software ticket.",
    "Implement only the validated ticket. Read the current source before editing.",
    validated.scout
      ? "Use the Scout capsule as a retrieval guide; line numbers are hints and do not replace evidence."
      : "Scout was explicitly omitted by the approved low-risk ticket. Inspect the scoped files and validation yourself; no Scout inspection has been performed.",
    "Run every validation listed in the ticket and report the validations actually completed.",
    "Do not run Git metadata commands or attempt to create a commit.",
    "The trusted Harness will create the commit after it validates your final draft.",
    "Your final message must be exactly one JSON object and nothing else.",
    "Do not include a $schema property; emit only the data object itself.",
    "The JSON object must match this exact schema:",
    JSON.stringify(ImplementDraftOutputJsonSchema),
    "Output the JSON object without markdown fences or any surrounding prose.",
    "Do not include a commitSha field.",
    "",
    "Validated ticket:",
    JSON.stringify(validated.ticket, null, 2),
    "",
    ...(validated.scout
      ? ["Validated Scout capsule:", JSON.stringify(validated.scout, null, 2)]
      : []),
  ].join("\n");
}

/** Builds an independent read-only review prompt requiring fresh validation of the exact head and base. */
export function reviewPrompt(
  input: Extract<HarnessStepRequest["input"], { role: "review" }>,
): string {
  const validated = HarnessRoleInputSchema.parse(input);
  if (validated.role !== "review") throw new Error("Expected Review input");

  return [
    "You are the Review agent for an isolated software ticket.",
    `Review the exact trusted task head ${validated.implementation.commitSha} against base ${validated.ticket.baseCommit}.`,
    "This head may be the original Implement commit or the same patch rebased by Roc; review the current exact diff independently.",
    "Run every approved validation command below against this exact head and report actual results or blockers in findings/remainingGaps; historical Implement validation is not fresh validation.",
    JSON.stringify(validated.ticket.spec.validation),
    validated.scout
      ? "The Scout capsule is a retrieval guide. Verify the ticket against the actual diff and current source, including the reported risks."
      : "Scout was explicitly omitted by the approved low-risk ticket. Independently inspect the actual diff and current source against every requirement and validation; do not infer prior repository inspection.",
    "Do not create, edit, rename, or delete files. Do not make commits.",
    "Your final message must be exactly one JSON object and nothing else.",
    "Do not include a $schema property; emit only the data object itself.",
    "The JSON object must match this exact schema:",
    JSON.stringify(ReviewOutputJsonSchema),
    "Output the JSON object without markdown fences or any surrounding prose.",
    'Do not infer acceptance from prose. Use decision "accepted" only when the ticket is satisfied.',
    "",
    "Validated ticket:",
    JSON.stringify(validated.ticket, null, 2),
    "",
    ...(validated.scout
      ? ["Validated Scout capsule:", JSON.stringify(validated.scout, null, 2)]
      : []),
    "",
    "Historical Implement report with the trusted current review-target SHA (not a new Implement attempt):",
    JSON.stringify(validated.implementation, null, 2),
  ].join("\n");
}
