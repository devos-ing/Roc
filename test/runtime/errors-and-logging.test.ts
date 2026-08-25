import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgileError, normalizeError } from "../../src/runtime/errors";
import { createJsonlLogger } from "../../src/runtime/logger";

test("normalizes unknown failures and logs only safe AgileError fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-error-log-"));
  const path = join(root, "agile.log");
  const stderr: string[] = [];
  try {
    const cause = new Error("secret-token-must-not-leak");
    const error = new AgileError({
      code: "CODEX_STREAM_DISCONNECTED",
      category: "infra",
      retryable: true,
      component: "codex-client",
      message: "Codex stream disconnected",
      runId: "run-1",
      taskId: "T1",
      attemptId: "A1",
      cause,
    });
    const logger = createJsonlLogger({
      path,
      err: (line) => stderr.push(line),
      now: () => "2026-08-26T00:00:00.000Z",
    });

    await logger.write({
      level: "info",
      code: "SCHEDULER_RUN_STARTED",
      category: "domain",
      component: "cli",
      retryable: false,
      message: "Scheduler run started",
      runId: "run-1",
    });
    await logger.error(error);

    expect(stderr).toEqual(["CODEX_STREAM_DISCONNECTED: Codex stream disconnected"]);
    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      level: "info",
      code: "SCHEDULER_RUN_STARTED",
      runId: "run-1",
    });
    expect(lines[1]).toEqual({
      timestamp: "2026-08-26T00:00:00.000Z",
      level: "error",
      code: "CODEX_STREAM_DISCONNECTED",
      category: "infra",
      component: "codex-client",
      retryable: true,
      message: "Codex stream disconnected",
      runId: "run-1",
      taskId: "T1",
      attemptId: "A1",
    });
    expect(text).not.toContain("secret-token-must-not-leak");
    expect(normalizeError(cause, {
      code: "UNEXPECTED_RUNTIME_FAILURE",
      category: "infra",
      retryable: false,
      component: "runtime",
      message: "Unexpected runtime failure",
    })).toBeInstanceOf(AgileError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
