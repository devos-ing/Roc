import { expect, test } from "bun:test";
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
