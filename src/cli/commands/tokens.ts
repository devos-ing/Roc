import type { Command } from "commander";
import { openDatabase } from "../../store/database";
import { OrchestrationRepository } from "../../store/orchestration-repository";
import {
  commandProjectRoot,
  currentCycle,
  errorMessage,
  projectDatabasePath,
  reportOperationalError,
} from "../command-context";
import { renderTokenUsageChart } from "../token-chart";
import type { CliCommandContext } from "../types";

/** Prints token usage for the active Agile cycle. */
async function executeTokens(
  context: CliCommandContext,
  options: { color: boolean },
): Promise<number> {
  let dbPath: string;
  try {
    dbPath = projectDatabasePath(await commandProjectRoot(context));
  } catch (error) {
    context.io.err(errorMessage(error));
    return 1;
  }
  try {
    const cycle = await currentCycle(context.runtime);
    const db = openDatabase(dbPath);
    try {
      const usage = new OrchestrationRepository(db).getCycleCategoryUsage(
        cycle.id,
      );
      if (usage === undefined) {
        context.io.out(`No token usage recorded for cycle: ${cycle.id}`);
        return 0;
      }
      context.io.out(
        renderTokenUsageChart(cycle.id, usage.categories, {
          color: options.color,
          width: process.stdout.columns ?? 80,
        }),
      );
      return 0;
    } finally {
      db.close();
    }
  } catch (error) {
    return reportOperationalError(
      error,
      context,
      { dbPath },
      {
        code: "TOKEN_USAGE_READ_FAILED",
        category: "infra",
        retryable: false,
        component: "cli",
        message: "Could not read token usage",
      },
    );
  }
}

/** Registers the active-cycle token usage command. */
export function registerTokensCommand(
  program: Command,
  context: CliCommandContext,
): void {
  program
    .command("tokens")
    .description("Show token use for the active Agile cycle")
    .option("--no-color", "disable ANSI color")
    .action(async (options: { color: boolean }) => {
      context.exitCode = await executeTokens(context, options);
    });
}
