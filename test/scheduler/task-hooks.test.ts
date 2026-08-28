import { expect, test } from "bun:test";
import {
  BunTaskHookRunner,
  sanitizeHookOutput,
  TASK_HOOK_MAX_OUTPUT_BYTES,
} from "../../src/scheduler/task-hooks";

test("argv hook runner bounds sanitized output and reports a nonzero exit", async () => {
  const runner = new BunTaskHookRunner();
  const escapeCode = String.fromCharCode(27);
  const result = await runner.run({
    hook: {
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(${JSON.stringify(`before${escapeCode}[31m`)} + "x".repeat(70000)); process.exit(7);`,
      ],
      timeoutSeconds: 1,
    },
    cwd: process.cwd(),
  });

  expect(result).toMatchObject({
    succeeded: false,
    exitCode: 7,
    timedOut: false,
  });
  expect(result.stdout).not.toContain(escapeCode);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
    TASK_HOOK_MAX_OUTPUT_BYTES,
  );
});

test("output truncation keeps the final UTF-8 character boundary intact", () => {
  const output = sanitizeHookOutput(
    `${"x".repeat(TASK_HOOK_MAX_OUTPUT_BYTES - 1)}€`,
  );

  expect(Buffer.byteLength(output)).toBe(TASK_HOOK_MAX_OUTPUT_BYTES - 1);
  expect(output).not.toContain("\uFFFD");
  expect(output.endsWith("€")).toBe(false);
});

test("argv hook runner records the process's actual signal metadata", async () => {
  const runner = new BunTaskHookRunner();
  const result = await runner.run({
    hook: {
      command: process.execPath,
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
      timeoutSeconds: 1,
    },
    cwd: process.cwd(),
  });

  expect(result).toMatchObject({
    succeeded: false,
    timedOut: false,
    signal: "SIGTERM",
  });
});

test("argv hook runner records SIGKILL when a timed-out process ignores SIGTERM", async () => {
  const runner = new BunTaskHookRunner();
  const result = await runner.run({
    hook: {
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      timeoutSeconds: 1,
    },
    cwd: process.cwd(),
  });

  expect(result).toMatchObject({
    succeeded: false,
    timedOut: true,
    signal: "SIGKILL",
  });
});
