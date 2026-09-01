import { z } from "zod";

// The Pi coding agent (`pi --mode rpc`) speaks a strict JSONL protocol: one
// JSON object per line on stdin and stdout, separated by bare \n. Commands
// are {type: "<command>", id?, ...params}; responses are
// {id?, type: "response", command, success, data?|error?}; events are
// unwrapped {type: "<event>", ...payload} notifications without any envelope.

export const NonEmpty = z.string().trim().min(1);

/** Correlates one command with its response; ids are client-assigned. */
export const PiRequestIdSchema = NonEmpty;

export const PiResponseEnvelopeSchema = z
  .object({
    id: PiRequestIdSchema.optional(),
    type: z.literal("response"),
    command: NonEmpty,
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

/**
 * One unwrapped stdout event. Only the discriminator is narrowed here;
 * payload-bearing events are parsed by their own schemas at the point of use.
 */
export const PiEventEnvelopeSchema = z
  .object({
    type: NonEmpty,
  })
  .passthrough();

/** Signals that the current prompt loop has fully settled. */
export const PiAgentSettledEventSchema = z
  .object({
    type: z.literal("agent_settled"),
  })
  .passthrough();

/** Native Pi usage fields as reported per assistant message. */
const PiUsageSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative().optional(),
    cacheWrite: z.number().int().nonnegative().optional(),
    reasoning: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type PiUsage = z.infer<typeof PiUsageSchema>;

/** One assistant message as finalized by message_end; the terminal form. */
export const PiAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.array(z.unknown()),
    provider: z.unknown().optional(),
    model: z.unknown().optional(),
    usage: PiUsageSchema,
    stopReason: z.string(),
    errorMessage: z.string().optional(),
  })
  .passthrough();

export type PiAssistantMessage = z.infer<typeof PiAssistantMessageSchema>;

export const PiMessageEndEventSchema = z
  .object({
    type: z.literal("message_end"),
    message: z.unknown(),
  })
  .passthrough();

/** A server-initiated extension UI interaction that blocks until answered. */
export const PiExtensionUiRequestEventSchema = z
  .object({
    type: z.literal("extension_ui_request"),
    id: NonEmpty,
    method: NonEmpty,
  })
  .passthrough();

/** get_state data; sessionId and sessionFile identify the durable session. */
export const PiGetStateDataSchema = z
  .object({
    sessionId: NonEmpty,
    sessionFile: NonEmpty,
    model: z.unknown().optional(),
    thinkingLevel: z.string().optional(),
  })
  .passthrough();

/** get_entries data; leafId is the durable entry-tree cursor (null if empty). */
export const PiGetEntriesDataSchema = z
  .object({
    leafId: z.string().nullable(),
  })
  .passthrough();

/** One provider model from get_available_models. */
export const PiModelSchema = z
  .object({
    id: NonEmpty,
    provider: NonEmpty,
    name: z.string().optional(),
    reasoning: z.boolean().optional(),
    thinkingLevelMap: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const PiAvailableModelsDataSchema = z
  .object({
    models: z.array(PiModelSchema),
  })
  .passthrough();

export type PiModel = z.infer<typeof PiModelSchema>;

/** Role-attempt usage totals in scheduler terms, mapped from Pi fields. */
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

export type TokenUsageTotals = z.infer<typeof TokenUsageTotalsSchema>;

/**
 * Maps one native Pi usage report onto scheduler usage totals. The scheduler's
 * inputTokens is the full prompt cost, so cache reads and writes are folded
 * into it rather than reported as input alone; cachedInputTokens stays the
 * raw cache-read share of that total.
 */
export function mapPiUsage(usage: PiUsage): TokenUsageTotals {
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return {
    inputTokens: usage.input + cacheRead + cacheWrite,
    cachedInputTokens: cacheRead,
    outputTokens: usage.output,
    reasoningOutputTokens: Math.min(usage.reasoning ?? 0, usage.output),
  };
}

export type PiTurnFailure = {
  code: string;
  category: "protocol" | "infra" | "policy";
  retryable: boolean;
  message: string;
};

/**
 * Classifies a non-success Pi stop reason, with the message's errorMessage
 * text, into a stable operational failure. "stop" is the success reason and
 * must never reach this classifier.
 */
export function classifyPiTurnFailure(
  stopReason: string,
  errorMessage: string | undefined,
): PiTurnFailure {
  const text = (errorMessage ?? "").toLowerCase();
  if (stopReason === "aborted") {
    return {
      code: "turn_interrupted",
      category: "infra",
      retryable: true,
      message: "The Pi role turn was interrupted",
    };
  }
  if (stopReason === "length") {
    return {
      code: "context_window_exceeded",
      category: "protocol",
      retryable: false,
      message: "The Pi context window was exceeded",
    };
  }
  if (/unauthorized|authentication|api key|401|403/.test(text)) {
    return {
      code: "authentication_failed",
      category: "infra",
      retryable: false,
      message: "Pi authentication failed",
    };
  }
  if (/rate limit|429|overloaded|temporarily unavailable/.test(text)) {
    return {
      code: "backend_unavailable",
      category: "infra",
      retryable: true,
      message: "The Pi backend is temporarily unavailable",
    };
  }
  return {
    code: "turn_failed",
    category: "infra",
    retryable: true,
    message: "The Pi role turn failed",
  };
}

/**
 * The opaque Pi backend cursor persisted with each delivery. The session
 * file and entry anchor form a durable resume point for a future
 * continuation path; v1 reconciliation only reads the completion markers.
 */
export const PiBackendCursorSchema = z
  .object({
    version: z.literal(1),
    nextSequence: z.number().int().positive(),
    sessionId: NonEmpty,
    sessionFile: NonEmpty,
    entryAnchor: z.string().optional(),
    usage: TokenUsageTotalsSchema,
    outputDelivered: z.literal(true).optional(),
    reviewStatusBefore: z.string().optional(),
  })
  .strict();

export type PiBackendCursor = z.infer<typeof PiBackendCursorSchema>;
