import { z } from "zod";
import { ContextRefSchema, ModelProfileSchema, StoredTaskSchema } from "../domain/schemas";

const NonEmpty = z.string().trim().min(1);
export const AgentRoleSchema = z.enum(["scout", "implement", "review"]);
export const RetryIndexSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export const ReasoningEffortSchema = z.enum(["medium", "high", "xhigh"]);

const EventBaseSchema = z.object({
  eventId: NonEmpty,
  attemptId: NonEmpty,
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime(),
});

export const ScoutOutputSchema = z.object({
  kind: z.literal("scout"),
  summary: NonEmpty,
  files: z.array(NonEmpty),
  tests: z.array(NonEmpty),
  risks: z.array(NonEmpty),
}).strict();

export const ImplementOutputSchema = z.object({
  kind: z.literal("implement"),
  commitSha: NonEmpty,
  validation: z.array(NonEmpty),
  risks: z.array(NonEmpty),
  limitations: z.array(NonEmpty),
}).strict();

export const ReviewOutputSchema = z.object({
  kind: z.literal("review"),
  decision: z.enum(["accepted", "rejected"]),
  findings: z.array(NonEmpty),
  remainingGaps: z.array(NonEmpty),
}).strict();

export const HarnessEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("attempt.started"),
    threadId: NonEmpty.optional(),
    turnId: NonEmpty.optional(),
    baseCommit: NonEmpty.optional(),
  }).strict(),
  EventBaseSchema.extend({
    type: z.literal("attempt.output"),
    output: z.discriminatedUnion("kind", [
      ScoutOutputSchema,
      ImplementOutputSchema,
      ReviewOutputSchema,
    ]),
  }).strict(),
  EventBaseSchema.extend({
    type: z.literal("attempt.usage_delta"),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  }).strict(),
  EventBaseSchema.extend({ type: z.literal("attempt.completed") }).strict(),
  EventBaseSchema.extend({
    type: z.literal("attempt.failed_infra"),
    code: NonEmpty,
    message: NonEmpty,
    retryable: z.boolean(),
  }).strict(),
  EventBaseSchema.extend({
    type: z.literal("attempt.blocked_policy"),
    code: NonEmpty,
    message: NonEmpty,
  }).strict(),
]);

export const HarnessAttemptSchema = z.object({
  attemptId: NonEmpty,
  taskId: NonEmpty,
  role: AgentRoleSchema,
  retryIndex: RetryIndexSchema,
  modelProfile: ModelProfileSchema,
  model: NonEmpty,
  effort: ReasoningEffortSchema,
  contextRef: ContextRefSchema.optional(),
}).strict();

export const HarnessRoleInputSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("scout"), ticket: StoredTaskSchema }).strict(),
  z.object({
    role: z.literal("implement"),
    ticket: StoredTaskSchema,
    scout: ScoutOutputSchema,
  }).strict(),
  z.object({
    role: z.literal("review"),
    ticket: StoredTaskSchema,
    scout: ScoutOutputSchema,
    implementation: ImplementOutputSchema,
  }).strict(),
]);

export const HarnessStepRequestSchema = z.object({
  mode: z.enum(["dispatch", "reconcile"]),
  attempt: HarnessAttemptSchema,
  input: HarnessRoleInputSchema,
  backendCursor: NonEmpty.optional(),
}).strict();

export const HarnessDeliverySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), nextCursor: NonEmpty, event: HarnessEventSchema }).strict(),
  z.object({ kind: z.literal("idle"), nextCursor: NonEmpty.optional() }).strict(),
  z.object({ kind: z.literal("closed"), nextCursor: NonEmpty.optional() }).strict(),
]);

export const FakeScenarioSchema = z.object({
  attempts: z.array(z.object({
    taskId: NonEmpty,
    role: AgentRoleSchema,
    retryIndex: RetryIndexSchema,
    expect: z.object({
      model: NonEmpty,
      effort: ReasoningEffortSchema,
      contextRef: ContextRefSchema.optional(),
    }).strict(),
    deliveries: z.array(z.object({
      nextCursor: NonEmpty,
      event: HarnessEventSchema,
    }).strict()).min(1),
  }).strict()).min(1),
}).strict().superRefine((scenario, context) => {
  const attemptKeys = new Set<string>();
  scenario.attempts.forEach((attempt, attemptIndex) => {
    const attemptKey = `${attempt.taskId}:${attempt.role}:${attempt.retryIndex}`;
    if (attemptKeys.has(attemptKey)) {
      context.addIssue({
        code: "custom",
        path: ["attempts", attemptIndex],
        message: `Duplicate fake script for ${attemptKey}`,
      });
    }
    attemptKeys.add(attemptKey);

    const cursors = new Set<string>();
    attempt.deliveries.forEach((delivery, deliveryIndex) => {
      if (cursors.has(delivery.nextCursor)) {
        context.addIssue({
          code: "custom",
          path: ["attempts", attemptIndex, "deliveries", deliveryIndex, "nextCursor"],
          message: `Duplicate fake cursor for ${attemptKey}: ${delivery.nextCursor}`,
        });
      }
      cursors.add(delivery.nextCursor);
    });
  });
});

export type HarnessEvent = z.infer<typeof HarnessEventSchema>;
export type ScoutOutput = z.infer<typeof ScoutOutputSchema>;
export type ImplementOutput = z.infer<typeof ImplementOutputSchema>;
export type HarnessRoleInput = z.infer<typeof HarnessRoleInputSchema>;
export type HarnessStepRequest = z.infer<typeof HarnessStepRequestSchema>;
export type HarnessDelivery = z.infer<typeof HarnessDeliverySchema>;
export type FakeScenario = z.infer<typeof FakeScenarioSchema>;

export interface AgentHarness {
  step(input: HarnessStepRequest): Promise<HarnessDelivery>;
  cancel(attemptId: string): Promise<void>;
}
