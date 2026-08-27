import { z } from "zod";

export const ErrorCategorySchema = z.enum([
  "startup",
  "protocol",
  "infra",
  "policy",
  "domain",
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export type AgileErrorInput = {
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  component: string;
  message: string;
  runId?: string;
  taskId?: string;
  attemptId?: string;
  threadId?: string;
  requestId?: string;
  cause?: unknown;
};

export class AgileError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly component: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly threadId?: string;
  readonly requestId?: string;

  /** Creates a validated operational error with structured diagnostic context. */
  constructor(input: AgileErrorInput) {
    super(input.message, { cause: input.cause });
    this.name = "AgileError";
    this.code = z.string().trim().min(1).parse(input.code);
    this.category = ErrorCategorySchema.parse(input.category);
    this.retryable = input.retryable;
    this.component = z.string().trim().min(1).parse(input.component);
    this.runId = input.runId;
    this.taskId = input.taskId;
    this.attemptId = input.attemptId;
    this.threadId = input.threadId;
    this.requestId = input.requestId;
  }
}

/** Preserves an AgileError or wraps an unknown value with structured fallback metadata. */
export function normalizeError(
  error: unknown,
  fallback: Omit<AgileErrorInput, "cause">,
): AgileError {
  return error instanceof AgileError
    ? error
    : new AgileError({ ...fallback, cause: error });
}
