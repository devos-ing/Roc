import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { currentIsoWeekId } from "../../src/cli/token-chart";
import { runCli } from "../../src/cli/run";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";

test("init creates a database and task list reads it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const output: string[] = [];
  const io = { out: (text: string) => output.push(text), err: (text: string) => output.push(text) };

  try {
    expect(await runCli(["init", "--db", dbPath], io)).toBe(0);
    expect(await runCli(["task", "list", "--db", dbPath], io)).toBe(0);
    expect(output).toEqual([`Initialized ${dbPath}`, "No tasks."]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational database failures report an error, return 1, and close the database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "future.db");
  const future = new Database(dbPath, { create: true });
  future.exec("PRAGMA user_version = 4");
  future.close();
  const output: string[] = [];
  const errors: string[] = [];
  const close = spyOn(Database.prototype, "close");

  try {
    expect(await runCli(["task", "list", "--db", dbPath], {
      out: (text) => output.push(text),
      err: (text) => errors.push(text),
    })).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual(["Database version 4 is newer than supported version 3"]);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("argument and unknown-command errors keep exit code 2", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const io = { out: (text: string) => output.push(text), err: (text: string) => errors.push(text) };

  expect(await runCli(["--unknown-option"], io)).toBe(2);
  expect(await runCli(["unknown"], io)).toBe(2);
  expect(output).toEqual([]);
  expect(errors).toHaveLength(2);
  expect(errors[1]).toBe("Unknown command: unknown");
});

test("tokens prints the current-week report", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const weekId = currentIsoWeekId();
  const db = openDatabase(dbPath);
  new PlanningRepository(db).createWeek({
    id: weekId,
    goal: "See token usage",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: [],
  });
  db.query(`
    INSERT INTO usage(
      id, week_id, category,
      input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
    ) VALUES('cli-usage', ?, 'implement', 100, 80, 50, 30)
  `).run(weekId);
  db.close();
  const output: string[] = [];

  try {
    expect(await runCli(["tokens", "--db", dbPath], {
      out: (text) => output.push(text),
      err: (text) => output.push(text),
    })).toBe(0);
    expect(output).toEqual([[
      `Token usage · ${weekId}`,
      "",
      "Implement  150 tokens  100%",
      "",
      "Total: 150 tokens",
    ].join("\n")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tokens reports a missing current week as an empty state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const output: string[] = [];

  try {
    expect(await runCli(["tokens", "--db", dbPath], {
      out: (text) => output.push(text),
      err: (text) => output.push(text),
    })).toBe(0);
    expect(output).toEqual([`No active week: ${currentIsoWeekId()}`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tokens rejects scheduler-only options and reports read failures through the runtime", async () => {
  const output: string[] = [];
  const logged: string[] = [];
  const runtime = {
    runScheduler: async () => {},
    logError: async (error: { code: string }) => { logged.push(error.code); },
  };

  expect(await runCli(["tokens", "--backend", "fake"], {
    out: (text) => output.push(text),
    err: (text) => output.push(text),
  }, runtime)).toBe(2);

  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "future.db");
  const future = new Database(dbPath, { create: true });
  future.exec("PRAGMA user_version = 4");
  future.close();
  try {
    expect(await runCli(["tokens", "--db", dbPath], {
      out: (text) => output.push(text),
      err: (text) => output.push(text),
    }, runtime)).toBe(1);
    expect(logged).toEqual(["TOKEN_USAGE_READ_FAILED"]);
    expect(output.at(-1)).toBe("TOKEN_USAGE_READ_FAILED: Could not read token usage");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
