import type { Command } from "commander";
import { currentCycle, errorMessage } from "../command-context";
import type { CliCommandContext } from "../types";

/** Prints the active Agile cycle selected by global settings. */
async function executeCurrentCycle(
  context: CliCommandContext,
): Promise<number> {
  try {
    context.io.out((await currentCycle(context.runtime)).id);
    return 0;
  } catch (error) {
    context.io.err(errorMessage(error));
    return 1;
  }
}

/** Registers commands that report Agile cycle state. */
export function registerCycleCommands(
  program: Command,
  context: CliCommandContext,
): void {
  program
    .command("cycle")
    .description("Manage the active Agile cycle")
    .command("current")
    .description("Show the current Agile cycle")
    .action(async () => {
      context.exitCode = await executeCurrentCycle(context);
    });
}
