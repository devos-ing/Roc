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

export const ServerMessageSchema = z.union([
  ServerRequestEnvelopeSchema,
  NotificationEnvelopeSchema,
]);

