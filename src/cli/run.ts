import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { helpText } from "./help";
import { openDatabase } from "../store/database";
import { PlanningRepository } from "../store/planning-repository";

export type CliIo = { out(text: string): void; err(text: string): void };

function parseCliArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { db: { type: "string" } },
  });
}

export async function runCli(args: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const [command, subcommand] = parsed.positionals;
  if (!command || command === "help") {
    io.out(helpText.trimEnd());
    return 0;
  }

  const dbPath = resolve(parsed.values.db ?? ".agile/runtime/agile.db");
  if (command === "init") {
    const db = openDatabase(dbPath);
    try {
      io.out(`Initialized ${dbPath}`);
      return 0;
    } finally {
      db.close();
    }
  }

  if (command === "task" && subcommand === "list") {
    const db = openDatabase(dbPath);
    try {
      const tasks = new PlanningRepository(db).listTasks();
      io.out(tasks.length ? tasks.map((task) => `${task.id}\t${task.status}\t${task.title}`).join("\n") : "No tasks.");
      return 0;
    } finally {
      db.close();
    }
  }

  io.err(`Unknown command: ${parsed.positionals.join(" ")}`);
  return 2;
}
