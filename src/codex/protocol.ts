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

export const ReviewStartResponseSchema = z.object({
  reviewThreadId: NonEmpty,
  turn: z.object({ id: NonEmpty }).passthrough(),
}).passthrough();

export const ExitedReviewModeItemSchema = z.object({
  type: z.literal("exitedReviewMode"),
  id: NonEmpty,
  review: z.string(),
}).passthrough();

export const ThreadHistoryTurnSchema = z.object({
  id: NonEmpty,
  items: z.array(z.object({ type: NonEmpty, id: NonEmpty }).passthrough()),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  error: z.unknown().nullable().optional(),
  completedAt: z.number().nonnegative().nullable().optional(),
}).passthrough();

export const ThreadReadResponseSchema = z.object({
  thread: z.object({
    id: NonEmpty,
    turns: z.array(ThreadHistoryTurnSchema),
  }).passthrough(),
}).passthrough();

const CommandExecutionRequestApprovalSchema = z.object({
  method: z.literal("item/commandExecution/requestApproval"),
  id: RpcIdSchema,
  params: z.object({
    threadId: NonEmpty,
    turnId: NonEmpty,
    itemId: NonEmpty,
    startedAtMs: z.number().nonnegative(),
    environmentId: NonEmpty.nullable(),
  }).passthrough(),
}).passthrough();

const FileChangeRequestApprovalSchema = z.object({
  method: z.literal("item/fileChange/requestApproval"),
  id: RpcIdSchema,
  params: z.object({
    threadId: NonEmpty,
    turnId: NonEmpty,
    itemId: NonEmpty,
    startedAtMs: z.number().nonnegative(),
  }).passthrough(),
}).passthrough();

const PermissionsRequestApprovalSchema = z.object({
  method: z.literal("item/permissions/requestApproval"),
  id: RpcIdSchema,
  params: z.object({
    threadId: NonEmpty,
    turnId: NonEmpty,
    itemId: NonEmpty,
    environmentId: NonEmpty.nullable(),
    startedAtMs: z.number().nonnegative(),
    cwd: NonEmpty,
    reason: z.string().nullable(),
    permissions: z.object({}).passthrough(),
  }).passthrough(),
}).passthrough();

const ToolRequestUserInputSchema = z.object({
  method: z.literal("item/tool/requestUserInput"),
  id: RpcIdSchema,
  params: z.object({
    threadId: NonEmpty,
    turnId: NonEmpty,
    itemId: NonEmpty,
    questions: z.array(z.unknown()),
    autoResolutionMs: z.number().nonnegative().nullable(),
  }).passthrough(),
}).passthrough();

const McpServerElicitationRequestSchema = z.object({
  method: z.literal("mcpServer/elicitation/request"),
  id: RpcIdSchema,
  params: z.discriminatedUnion("mode", [
    z.object({
      threadId: NonEmpty,
      turnId: NonEmpty.nullable(),
      serverName: NonEmpty,
      mode: z.literal("form"),
      _meta: z.unknown(),
      message: z.string(),
      requestedSchema: z.object({
        type: z.literal("object"),
        properties: z.object({}).passthrough(),
      }).passthrough(),
    }).passthrough(),
    z.object({
      threadId: NonEmpty,
      turnId: NonEmpty.nullable(),
      serverName: NonEmpty,
      mode: z.literal("openai/form"),
      _meta: z.unknown(),
      message: z.string(),
      requestedSchema: z.unknown(),
    }).passthrough(),
    z.object({
      threadId: NonEmpty,
      turnId: NonEmpty.nullable(),
      serverName: NonEmpty,
      mode: z.literal("url"),
      _meta: z.unknown(),
      message: z.string(),
      url: NonEmpty,
      elicitationId: NonEmpty,
    }).passthrough(),
  ]),
}).passthrough();

export const KnownServerRequestSchema = z.discriminatedUnion("method", [
  CommandExecutionRequestApprovalSchema,
  FileChangeRequestApprovalSchema,
  PermissionsRequestApprovalSchema,
  ToolRequestUserInputSchema,
  McpServerElicitationRequestSchema,
]);

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
