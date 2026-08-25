import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../../src/cli/run";

test("runs a validated fake scenario through the scheduler runtime seam", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-cli-"));
  const scenarioPath = join(root, "scenario.json");
  const calls: unknown[] = [];
  try {
    await writeFile(scenarioPath, JSON.stringify({ attempts: [{
      taskId: "T1",
      role: "scout",
      retryIndex: 0,
      expect: { model: "luna", effort: "high" },
      deliveries: [{
        nextCursor: "1",
        event: {
          type: "attempt.completed",
          eventId: "T1:completed",
          attemptId: "A1",
          sequence: 1,
          occurredAt: "2026-08-25T00:00:00.000Z",
        },
      }],
    }] }));
    const output: string[] = [];
    const code = await runCli(
      ["scheduler", "run", "--db", join(root, "state.db"), "--fake-script", scenarioPath],
      { out: (text) => output.push(text), err: (text) => output.push(text) },
      { runScheduler: async (input) => { calls.push(input.scenario); } },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(output).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prints a stable JSON inspection snapshot", async () => {
  const output: string[] = [];
  const code = await runCli(["scheduler", "inspect", "--db", ":memory:"], {
    out: (text) => output.push(text),
    err: (text) => output.push(text),
  });
  expect(code).toBe(0);
  expect(JSON.parse(output[0] ?? "null")).toEqual({ scheduler: {}, weeks: [], tasks: [] });
});

test("returns configuration errors before opening a database", async () => {
  const output: string[] = [];
  expect(await runCli(["scheduler", "run"], {
    out: (text) => output.push(text),
    err: (text) => output.push(text),
  })).toBe(2);
  expect(output[0]).toContain("--fake-script");
});

test("returns configuration errors for invalid fake scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-cli-"));
  const invalidJson = join(root, "invalid.json");
  const invalidSchema = join(root, "invalid-schema.json");
  try {
    await writeFile(invalidJson, "{");
    await writeFile(invalidSchema, JSON.stringify({ attempts: [] }));
    for (const fakeScript of [invalidJson, invalidSchema]) {
      const output: string[] = [];
      expect(await runCli(["scheduler", "run", "--db", join(root, "state.db"), "--fake-script", fakeScript], {
        out: (text) => output.push(text),
        err: (text) => output.push(text),
      })).toBe(2);
      expect(output).toHaveLength(1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns operational errors for an unreadable scheduler database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-scheduler-cli-"));
  const scenarioPath = join(root, "scenario.json");
  const output: string[] = [];
  try {
    await writeFile(scenarioPath, JSON.stringify({ attempts: [{
      taskId: "T1",
      role: "scout",
      retryIndex: 0,
      expect: { model: "luna", effort: "high" },
      deliveries: [{
        nextCursor: "1",
        event: {
          type: "attempt.completed",
          eventId: "T1:completed",
          attemptId: "A1",
          sequence: 1,
          occurredAt: "2026-08-25T00:00:00.000Z",
        },
      }],
    }] }));
    expect(await runCli(["scheduler", "run", "--db", "/dev/null/state.db", "--fake-script", scenarioPath], {
      out: (text) => output.push(text),
      err: (text) => output.push(text),
    })).toBe(1);
    expect(output).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
