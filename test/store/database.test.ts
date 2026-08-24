import { expect, test } from "bun:test";
import { openDatabase } from "../../src/store/database";

test("migration creates every approved table", () => {
  const db = openDatabase(":memory:");
  const rows = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all();
  const names = rows.map((row) => row.name);

  for (const name of [
    "attempts", "contexts", "events", "model_decisions", "reviews",
    "task_deps", "tasks", "usage", "weeks",
  ]) {
    expect(names).toContain(name);
  }
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
  db.close();
});
