import { z } from "zod";
import {
  AgentRoleSchema,
  HarnessActivitySchema,
  ReasoningEffortSchema,
  RetryIndexSchema,
} from "../harness/contracts";
import { AcceptanceChecklistItemSchema } from "./acceptance-checklist";
import {
  ContextRefSchema,
  ModelProfileSchema,
  TaskStatusSchema,
} from "./schemas";

const NonEmpty = z.string().trim().min(1);
const CycleIdSchema = NonEmpty;
const TokenTotalsSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  })
  .strict();
const CategoryTokenUsageSchema = z
  .object({
    category: NonEmpty,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
const CycleCategoryUsageSchema = z
  .object({
    cycleId: CycleIdSchema,
    categories: z.array(CategoryTokenUsageSchema),
  })
  .strict();
const InspectionModelDecisionSchema = z
  .object({
    id: NonEmpty,
    role: AgentRoleSchema,
    modelProfile: ModelProfileSchema,
    model: NonEmpty,
    effort: z.enum(["medium", "high", "xhigh"]),
    tokenTarget: z.number().int().positive(),
    fallbackModels: z.array(NonEmpty),
    decidedBy: z.enum(["rule", "advisor-llm", "fallback"]),
    confidence: z.number().min(0).max(1),
    rationale: z.array(NonEmpty).min(1),
  })
  .strict();
const InspectionRoleSchema = z
  .object({
    role: AgentRoleSchema,
    actual: TokenTotalsSchema,
  })
  .strict();
const InspectionAttemptSchema = z
  .object({
    id: NonEmpty,
    role: AgentRoleSchema,
    modelProfile: ModelProfileSchema,
    model: NonEmpty,
    effort: ReasoningEffortSchema,
    status: z.enum(["running", "succeeded", "failed_infra", "blocked_policy"]),
    retryIndex: RetryIndexSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    usageKnown: z.boolean().optional(),
    activity: HarnessActivitySchema.extend({
      occurredAt: z.string().datetime(),
    }).optional(),
    reviewDecision: z.enum(["accepted", "rejected"]).optional(),
    failure: NonEmpty.optional(),
    threadId: NonEmpty.optional(),
    turnId: NonEmpty.optional(),
    gitCommit: NonEmpty.optional(),
    ...TokenTotalsSchema.shape,
  })
  .strict();
const InspectionTaskSchema = z
  .object({
    id: NonEmpty,
    issueUrl: z.string().url().optional(),
    pullRequestUrl: z.string().url().optional(),
    acceptanceChecklist: z.array(AcceptanceChecklistItemSchema),
    failure: NonEmpty.optional(),
    status: TaskStatusSchema,
    usageIncomplete: z.boolean().optional(),
    timing: z
      .object({
        startedAt: z.string().datetime(),
        elapsedMs: z.number().nonnegative(),
        phaseElapsedMs: z.number().nonnegative(),
        attemptMs: z.number().nonnegative().optional(),
        waitingMs: z.number().nonnegative(),
        phaseDurationsMs: z.record(z.string(), z.number().nonnegative()),
      })
      .strict()
      .optional(),
    priority: z.number().int().nonnegative(),
    tokenTarget: z.number().int().positive(),
    actual: TokenTotalsSchema,
    contextRef: ContextRefSchema.optional(),
    modelDecisions: z.array(InspectionModelDecisionSchema),
    roles: z.array(InspectionRoleSchema),
    attempts: z.array(InspectionAttemptSchema),
  })
  .strict();
const InspectionSchedulerSchema = z
  .object({
    active: z
      .array(z.object({ taskId: NonEmpty, attemptId: NonEmpty }).strict())
      .optional(),
  })
  .strict();
const InspectionCycleSchema = z
  .object({
    id: CycleIdSchema,
    tokenTarget: z.number().int().positive(),
    actual: TokenTotalsSchema,
  })
  .strict();
const InspectionSnapshotSchema = z
  .object({
    scheduler: InspectionSchedulerSchema,
    cycles: z.array(InspectionCycleSchema),
    tasks: z.array(InspectionTaskSchema),
  })
  .strict();

export type TokenTotals = z.infer<typeof TokenTotalsSchema>;
export type CategoryTokenUsage = z.infer<typeof CategoryTokenUsageSchema>;
export type CycleCategoryUsage = z.infer<typeof CycleCategoryUsageSchema>;
export type InspectionModelDecision = z.infer<
  typeof InspectionModelDecisionSchema
>;
export type InspectionRole = z.infer<typeof InspectionRoleSchema>;
export type InspectionAttempt = z.infer<typeof InspectionAttemptSchema>;
export type InspectionTask = z.infer<typeof InspectionTaskSchema>;
export type InspectionScheduler = z.infer<typeof InspectionSchedulerSchema>;
export type InspectionCycle = z.infer<typeof InspectionCycleSchema>;
export type InspectionSnapshot = z.infer<typeof InspectionSnapshotSchema>;
