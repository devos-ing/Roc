import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { type AgileError, ErrorCategorySchema } from "./errors";
import { prepareSafeFilePath } from "./safe-file";

export const LogRecordSchema = z
  .object({
    timestamp: z.string().datetime(),
    level: z.enum(["debug", "info", "warn", "error"]),
    code: z.string().trim().min(1),
    category: ErrorCategorySchema,
    component: z.string().trim().min(1),
    retryable: z.boolean(),
    message: z.string().trim().min(1),
    runId: z.string().trim().min(1).optional(),
    taskId: z.string().trim().min(1).optional(),
    attemptId: z.string().trim().min(1).optional(),
    threadId: z.string().trim().min(1).optional(),
    requestId: z.string().trim().min(1).optional(),
  })
  .strict();

export type LogInput = Omit<z.infer<typeof LogRecordSchema>, "timestamp">;
export type Logger = {
  write(input: LogInput): Promise<void>;
  error(error: AgileError): Promise<void>;
};

/** Creates a safe JSON Lines logger that emits structured operational errors. */
export function createJsonlLogger(input: {
  path: string;
  err(line: string): void;
  now?: () => string;
}): Logger {
  /** Returns the current timestamp through the injected or system clock. */
  const now = input.now ?? (() => new Date().toISOString());
  /** Validates and appends one log record to the configured safe file. */
  const write = async (recordInput: LogInput): Promise<void> => {
    const record = LogRecordSchema.parse({ timestamp: now(), ...recordInput });
    const path = prepareSafeFilePath(input.path);
    const handle = await open(
      path,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  };
  return {
    write,
    /** Persists a sanitized structured error and emits its safe summary. */
    async error(error) {
      await write({
        level: "error",
        code: error.code,
        category: error.category,
        component: error.component,
        retryable: error.retryable,
        message: error.message,
        ...(error.runId === undefined ? {} : { runId: error.runId }),
        ...(error.taskId === undefined ? {} : { taskId: error.taskId }),
        ...(error.attemptId === undefined
          ? {}
          : { attemptId: error.attemptId }),
        ...(error.threadId === undefined ? {} : { threadId: error.threadId }),
        ...(error.requestId === undefined
          ? {}
          : { requestId: error.requestId }),
      });
      input.err(`${error.code}: ${error.message}`);
    },
  };
}
