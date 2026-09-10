import { z } from "zod";

const NonEmpty = z.string().trim().min(1);

export const AcceptanceResultSchema = z
  .object({
    criterionIndex: z.number().int().nonnegative(),
    status: z.enum(["passed", "failed", "unverified"]),
    evidence: NonEmpty,
  })
  .strict();

export type AcceptanceResult = z.infer<typeof AcceptanceResultSchema>;

export type AcceptanceChecklistBinding = {
  currentSpecHash: string;
  reviewedSpecHash: string;
  currentHeadSha: string;
  reviewedHeadSha: string;
  currentBaseSha: string;
  reviewedBaseSha: string;
};

export const AcceptanceChecklistItemSchema = z
  .object({
    criterionIndex: z.number().int().nonnegative(),
    criterion: NonEmpty,
    status: z.enum(["passed", "failed", "unverified"]),
    evidence: NonEmpty.optional(),
  })
  .strict();

export type AcceptanceChecklistItem = z.infer<
  typeof AcceptanceChecklistItemSchema
>;

/** Returns whether Review evidence still names the current specification, head, and base. */
export function hasCurrentAcceptanceBinding(
  binding: AcceptanceChecklistBinding | undefined,
): boolean {
  return (
    binding !== undefined &&
    binding.currentSpecHash === binding.reviewedSpecHash &&
    binding.currentHeadSha === binding.reviewedHeadSha &&
    binding.currentBaseSha === binding.reviewedBaseSha
  );
}

/** Projects original acceptance criteria into safe per-item statuses and evidence. */
export function projectAcceptanceChecklist(
  criteria: readonly string[],
  results: readonly AcceptanceResult[] | undefined,
  binding: AcceptanceChecklistBinding | undefined,
): AcceptanceChecklistItem[] {
  const valid =
    hasCurrentAcceptanceBinding(binding) &&
    results !== undefined &&
    results.length === criteria.length &&
    results.every(
      (result) =>
        result.criterionIndex < criteria.length &&
        result.evidence.trim().length > 0,
    ) &&
    new Set(results.map((result) => result.criterionIndex)).size ===
      criteria.length;
  if (!valid)
    return criteria.map((criterion, criterionIndex) => ({
      criterionIndex,
      criterion,
      status: "unverified",
    }));
  const byIndex = new Map(
    results.map((result) => [result.criterionIndex, result]),
  );
  return criteria.map((criterion, criterionIndex) => {
    const result = byIndex.get(criterionIndex);
    if (!result) return { criterionIndex, criterion, status: "unverified" };
    return {
      criterionIndex,
      criterion,
      status: result.status,
      evidence: result.evidence,
    };
  });
}
