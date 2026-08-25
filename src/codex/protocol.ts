import { z } from "zod";

export const NonEmpty = z.string().trim().min(1);
export const RpcIdSchema = z.union([z.string(), z.number()]);

export const RpcErrorSchema = z.object({
  code: z.number(),
  message: NonEmpty,
  data: z.unknown().optional(),
}).passthrough();

export const ResponseEnvelopeSchema = z.union([
  z.object({ id: RpcIdSchema, result: z.unknown() }).passthrough(),
  z.object({ id: RpcIdSchema, error: RpcErrorSchema }).passthrough(),
]);

export const NotificationEnvelopeSchema = z.object({
  method: NonEmpty,
  params: z.unknown(),
}).passthrough();

export const ServerRequestEnvelopeSchema = z.object({
  method: NonEmpty,
  id: RpcIdSchema,
  params: z.unknown(),
}).passthrough();

export const ModelListResponseSchema = z.object({
  data: z.array(z.object({
    id: NonEmpty,
    hidden: z.boolean(),
    supportedReasoningEfforts: z.array(z.object({
      reasoningEffort: NonEmpty,
    }).passthrough()),
  }).passthrough()),
  nextCursor: NonEmpty.nullable(),
}).passthrough();

export const ThreadStartResponseSchema = z.object({
  thread: z.object({ id: NonEmpty }).passthrough(),
}).passthrough();

export const TurnStartResponseSchema = z.object({
  turn: z.object({ id: NonEmpty }).passthrough(),
}).passthrough();

export const TokenUsageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
}).passthrough().superRefine((usage, context) => {
  if (usage.cachedInputTokens > usage.inputTokens) {
    context.addIssue({
      code: "custom",
      path: ["cachedInputTokens"],
      message: "Cached input tokens cannot exceed input tokens",
    });
  }
  if (usage.reasoningOutputTokens > usage.outputTokens) {
    context.addIssue({
      code: "custom",
      path: ["reasoningOutputTokens"],
      message: "Reasoning output tokens cannot exceed output tokens",
    });
  }
});

export const ThreadTokenUsageUpdatedNotificationSchema = z.object({
  method: z.literal("thread/tokenUsage/updated"),
  params: z.object({
    threadId: NonEmpty,
    turnId: NonEmpty,
    tokenUsage: z.object({ total: TokenUsageTotalsSchema }).passthrough(),
  }).passthrough(),
}).passthrough();

export const AgentMessageItemSchema = z.object({
  type: z.literal("agentMessage"),
  id: NonEmpty,
  text: z.string(),
  phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
}).passthrough();

export const ItemCompletedNotificationSchema = z.object({
  method: z.literal("item/completed"),
  params: z.object({
    threadId: NonEmpty,
    turnId: NonEmpty,
    item: z.object({ type: NonEmpty, id: NonEmpty }).passthrough(),
  }).passthrough(),
}).passthrough();

export const CodexErrorInfoSchema = z.union([
  z.enum([
    "contextWindowExceeded",
    "sessionBudgetExceeded",
    "usageLimitExceeded",
    "serverOverloaded",
    "cyberPolicy",
    "internalServerError",
    "unauthorized",
    "badRequest",
    "threadRollbackFailed",
    "sandboxError",
    "other",
  ]),
  z.object({
    httpConnectionFailed: z.object({ httpStatusCode: z.number().int().nullable() }).passthrough(),
  }).passthrough(),
  z.object({
    responseStreamConnectionFailed: z.object({
      httpStatusCode: z.number().int().nullable(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    responseStreamDisconnected: z.object({
      httpStatusCode: z.number().int().nullable(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    responseTooManyFailedAttempts: z.object({
      httpStatusCode: z.number().int().nullable(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    activeTurnNotSteerable: z.object({ turnKind: NonEmpty }).passthrough(),
  }).passthrough(),
]);

export const TurnErrorSchema = z.object({
  message: NonEmpty,
  codexErrorInfo: CodexErrorInfoSchema.nullable().optional(),
  additionalDetails: z.string().nullable().optional(),
}).passthrough();

export const TurnCompletedNotificationSchema = z.object({
  method: z.literal("turn/completed"),
  params: z.object({
    threadId: NonEmpty,
    turn: z.object({
      id: NonEmpty,
      status: z.enum(["completed", "interrupted", "failed"]),
      error: TurnErrorSchema.nullable().optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export const ServerMessageSchema = z.union([
  ServerRequestEnvelopeSchema,
  NotificationEnvelopeSchema,
]);
