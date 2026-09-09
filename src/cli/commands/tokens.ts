import type { Command } from "commander";
import {
  commandProjectRoot,
  currentCycle,
  errorMessage,
} from "../command-context";
import { renderTokenUsageChart } from "../token-chart";
import type { CliCommandContext } from "../types";

/** Registers recorded GitHub usage reporting for the active Agile cycle. */
export function registerTokensCommand(
  program: Command,
  context: CliCommandContext,
): void {
  program
    .command("tokens")
    .description("Show recorded GitHub task usage for the active cycle")
    .option("--no-color", "disable ANSI color")
    .action(async (options: { color: boolean }) => {
      try {
        const root = await commandProjectRoot(context);
        const cycle = await currentCycle(context.runtime);
        if (!context.runtime.readTasks)
          throw Error("GitHub task reads are unavailable");
        const snapshot = await context.runtime.readTasks(root);
        const ids = new Set(
          snapshot.tasks
            .filter((task) => task.cycleId === cycle.id)
            .map((task) => task.id),
        );
        const attempts = snapshot.inspection.tasks
          .filter((task) => ids.has(task.id))
          .flatMap((task) => task.attempts);
        if (!attempts.length) {
          context.io.out(`No token usage recorded for cycle: ${cycle.id}`);
          return;
        }
        if (snapshot.usageIncomplete)
          context.io.out(
            "Recorded totals are partial: some attempts have no confirmed usage receipt.",
          );
        const categories = ["scout", "implement", "review"].map((category) => ({
          category,
          inputTokens: attempts
            .filter((attempt) => attempt.role === category)
            .reduce((sum, attempt) => sum + attempt.inputTokens, 0),
          outputTokens: attempts
            .filter((attempt) => attempt.role === category)
            .reduce((sum, attempt) => sum + attempt.outputTokens, 0),
        }));
        context.io.out(
          renderTokenUsageChart(cycle.id, categories, {
            color: options.color,
            width: process.stdout.columns ?? 80,
          }),
        );
      } catch (error) {
        context.io.err(errorMessage(error));
        context.exitCode = 1;
      }
    });
}
