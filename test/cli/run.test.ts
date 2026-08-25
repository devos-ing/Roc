import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../../src/cli/run";

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
  future.exec("PRAGMA user_version = 3");
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
    expect(errors).toEqual(["Database version 3 is newer than supported version 2"]);
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
