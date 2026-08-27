import { Database } from "bun:sqlite";
import { prepareSafeFilePath } from "../runtime/safe-file";
import { migrate } from "./migrations";

/** Opens a safely located SQLite database, configures it, and applies migrations. */
export function openDatabase(path: string): Database {
  const safePath = path === ":memory:" ? path : prepareSafeFilePath(path);
  const db = new Database(safePath, { create: true, strict: true });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
