import { z } from "zod";

// The ZCode app-server speaks a JSON-RPC-shaped line protocol without the
// "jsonrpc" envelope key: requests are {id, method, params?}, notifications
// are {method, params?}, and responses are {id, result} or {id, error}.

export const NonEmpty = z.string().trim().min(1);
export const RpcIdSchema = z.union([z.string(), z.number()]);

export const RpcErrorSchema = z
  .object({
    code: z.number(),
    message: NonEmpty,
    data: z.unknown().optional(),
  })
  .passthrough();

export const ResponseEnvelopeSchema = z.union([
  z.object({ id: RpcIdSchema, result: z.unknown() }).passthrough(),
  z.object({ id: RpcIdSchema, error: RpcErrorSchema }).passthrough(),
]);

export const NotificationEnvelopeSchema = z
  .object({
    method: NonEmpty,
    params: z.unknown(),
  })
  .passthrough();

export const ServerRequestEnvelopeSchema = z
  .object({
    method: NonEmpty,
    id: RpcIdSchema,
    params: z.unknown(),
  })
  .passthrough();

export const ServerMessageSchema = z.union([
  ServerRequestEnvelopeSchema,
  NotificationEnvelopeSchema,
]);

export const SessionCreateResponseSchema = z
  .object({
    session: z.object({ sessionId: NonEmpty }).passthrough(),
  })
  .passthrough();

export const SessionSubscribeResponseSchema = z
  .object({
    sessionId: NonEmpty,
  })
  .passthrough();

/** Role-attempt usage totals in scheduler terms, mapped from ZCode fields. */
export const TokenUsageTotalsSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  })
  .superRefine((usage, context) => {
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

const ZcodeUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type TokenUsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

/** Maps a native ZCode usage object onto scheduler usage totals. */
export function mapZcodeUsage(
  usage: z.infer<typeof ZcodeUsageSchema>,
): TokenUsageTotals {
  const cacheRead = usage.cacheReadTokens ?? 0;
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: Math.min(cacheRead, usage.inputTokens),
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: Math.min(
      usage.reasoningTokens ?? 0,
      usage.outputTokens,
    ),
  };
}

export const SessionEventNotificationSchema = z
  .object({
    method: z.literal("session/event"),
    params: z
      .object({
        sessionId: NonEmpty,
        type: NonEmpty,
        payload: z.unknown(),
      })
      .passthrough(),
  })
  .passthrough();

export const TurnCompletedEventSchema = z
  .object({
    response: z.string(),
    usage: ZcodeUsageSchema,
    resultType: z.string(),
    toolCallCount: z.number().int().nonnegative(),
  })
  .passthrough();

export type ZcodeTurnFailure = {
  code: string;
  category: "protocol" | "infra" | "policy";
  retryable: boolean;
  message: string;
};

/** Classifies a failed or non-success ZCode turn into a stable operational failure. */
export function classifyZcodeTurnFailure(
  resultType: string,
  errorText: string | undefined,
): ZcodeTurnFailure {
  const text = (errorText ?? "").toLowerCase();
  if (resultType === "cancelled" || resultType === "interrupted") {
    return {
      code: "turn_interrupted",
      category: "infra",
      retryable: true,
      message: "The ZCode role turn was interrupted",
    };
  }
  if (/unauthorized|authentication|api key|401|403/.test(text)) {
    return {
      code: "authentication_failed",
      category: "infra",
      retryable: false,
      message: "ZCode authentication failed",
    };
  }
  if (/context window|context_window/.test(text)) {
    return {
      code: "context_window_exceeded",
      category: "protocol",
      retryable: false,
      message: "The ZCode context window was exceeded",
    };
  }
  if (/rate limit|429|overloaded|temporarily unavailable/.test(text)) {
    return {
      code: "backend_unavailable",
      category: "infra",
      retryable: true,
      message: "The ZCode backend is temporarily unavailable",
    };
  }
  return {
    code: "turn_failed",
    category: "infra",
    retryable: true,
    message: "The ZCode role turn failed",
  };
}
