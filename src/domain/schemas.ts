import { z } from "zod";

const NonEmpty = z.string().trim().min(1);

export const ModelProfileSchema = z.enum(["luna", "terra", "sol"]);

export const TaskStatusSchema = z.enum([
  "draft",
  "needs_input",
  "needs_replan",
  "ready",
  "claimed",
  "scouting",
  "implementing",
  "reviewing",
  "done",
  "rejected",
  "failed_infra",
]);

export const ContextRefSchema = z
  .object({
    threadId: NonEmpty,
    anchorId: NonEmpty,
    sourceTaskId: NonEmpty,
    gitCommit: NonEmpty,
    summaryArtifact: NonEmpty.optional(),
  })
  .strict();

export const TicketSpecSchema = z
  .object({
    problem: NonEmpty,
    desiredOutcome: NonEmpty,
    scope: z.array(NonEmpty).min(1),
    nonGoals: z.array(NonEmpty),
    acceptanceCriteria: z.array(NonEmpty).min(1),
    validation: z.array(NonEmpty).min(1),
    dependencies: z.array(NonEmpty),
    risk: z.enum(["low", "medium", "high"]),
    contextCandidates: z.array(ContextRefSchema),
    tokenCeiling: z.number().int().positive(),
  })
  .strict();

export const WeeklyPlanSchema = z
  .object({
    id: z.string().regex(/^\d{4}-W\d{2}$/),
    goal: NonEmpty,
    nonGoals: z.array(NonEmpty),
    tokenBudget: z.number().int().positive(),
    ticketIds: z.array(NonEmpty),
  })
  .strict();

export const TaskCreateSchema = z
  .object({
    id: NonEmpty,
    weekId: WeeklyPlanSchema.shape.id,
    title: NonEmpty,
    spec: TicketSpecSchema,
    priority: z.number().int().min(0),
    approvalRequired: z.boolean(),
    approved: z.boolean(),
  })
  .strict();

export const StoredTaskSchema = TaskCreateSchema.extend({
  status: TaskStatusSchema,
  specPath: NonEmpty.optional(),
  specHash: NonEmpty.optional(),
  baseCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
}).strict();

export const ModelDecisionSchema = z
  .object({
    modelProfile: ModelProfileSchema,
    model: NonEmpty,
    reasoningEffort: z.enum(["medium", "high", "xhigh"]),
    tokenBudget: z.number().int().positive(),
    contextRef: ContextRefSchema.optional(),
    fallbackModels: z.array(NonEmpty),
    decidedBy: z.enum(["rule", "advisor-llm", "fallback"]),
    confidence: z.number().min(0).max(1),
    rationale: z.array(NonEmpty).min(1),
  })
  .strict();

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TicketSpec = z.infer<typeof TicketSpecSchema>;
export type WeeklyPlan = z.infer<typeof WeeklyPlanSchema>;
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type StoredTask = z.infer<typeof StoredTaskSchema>;
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type ModelDecision = z.infer<typeof ModelDecisionSchema>;
