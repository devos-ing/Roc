import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

test("logger rejects a symlinked runtime directory without writing outside the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-log-symlink-"));
  const external = await mkdtemp(join(tmpdir(), "agile-log-external-"));
  try {
    await mkdir(join(root, ".agile"));
    await writeFile(join(external, "sentinel.txt"), "unchanged\n");
    await symlink(external, join(root, ".agile", "runtime"), "dir");
    const logger = createJsonlLogger({
      path: join(root, ".agile", "runtime", "agile.log"),
      err: () => {},
    });

    await expect(logger.write({
      level: "info",
      code: "TEST",
      category: "domain",
      component: "test",
      retryable: false,
      message: "must not escape",
    })).rejects.toThrow(/symbolic link/i);

    expect(await readdir(external)).toEqual(["sentinel.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("logger rejects a symlinked ancestor even when the runtime directory already exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-log-ancestor-symlink-"));
  const external = await mkdtemp(join(tmpdir(), "agile-log-ancestor-external-"));
  try {
    await mkdir(join(external, "runtime"));
    await symlink(external, join(root, ".agile"), "dir");
    const logger = createJsonlLogger({
      path: join(root, ".agile", "runtime", "agile.log"),
      err: () => {},
    });

    await expect(logger.write({
      level: "info",
      code: "TEST",
      category: "domain",
      component: "test",
      retryable: false,
      message: "must not escape through an ancestor",
    })).rejects.toThrow(/symbolic link/i);

    expect(await readdir(join(external, "runtime"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("logger rejects a symlinked log target without changing its referent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-log-target-symlink-"));
  const external = join(root, "external.log");
  try {
    await mkdir(join(root, ".agile", "runtime"), { recursive: true });
    await writeFile(external, "unchanged\n");
    await symlink(external, join(root, ".agile", "runtime", "agile.log"), "file");
    const logger = createJsonlLogger({
      path: join(root, ".agile", "runtime", "agile.log"),
      err: () => {},
    });

    await expect(logger.write({
      level: "info",
      code: "TEST",
      category: "domain",
      component: "test",
      retryable: false,
      message: "must not follow",
    })).rejects.toThrow(/symbolic link/i);
    expect(await readFile(external, "utf8")).toBe("unchanged\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
