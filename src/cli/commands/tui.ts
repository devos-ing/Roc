import type { Command } from "commander";
import { openDatabase } from "../../store/database";
import { OrchestrationRepository } from "../../store/orchestration-repository";
import { PlanningRepository } from "../../store/planning-repository";
import {
  commandProjectRoot,
  currentCycle,
  errorMessage,
  projectDatabasePath,
  reportOperationalError,
} from "../command-context";
import { buildTaskBoardSnapshot } from "../task-board-model";
import { runTaskBoardSession } from "../task-board-session";
import type { CliCommandContext } from "../types";

/** Runs the read-only interactive task board for the current Agile cycle. */
async function executeTui(context: CliCommandContext): Promise<number> {
  let dbPath: string;
  try {
    dbPath = projectDatabasePath(await commandProjectRoot(context));
  } catch (error) {
    context.io.err(errorMessage(error));
    return 1;
  }
  if (context.io.input === undefined || context.io.output === undefined) {
    context.io.err("Task board requires an interactive terminal");
    return 1;
  }
  try {
    const cycle = await currentCycle(context.runtime);
    const db = openDatabase(dbPath);
    try {
      const planning = new PlanningRepository(db);
      const orchestration = new OrchestrationRepository(db);
      await runTaskBoardSession({
        input: context.io.input,
        output: context.io.output,
        read: () =>
          buildTaskBoardSnapshot({
            tasks: planning.listTasks(),
            inspection: orchestration.inspect(),
            currentCycleId: cycle.id,
          }),
      });
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
        code: "TASK_BOARD_FAILED",
        category: "infra",
        retryable: true,
        component: "cli",
        message: "Task board stopped unexpectedly",
      },
    );
  }
}

/** Registers the read-only interactive task board command. */
export function registerTuiCommand(
  program: Command,
  context: CliCommandContext,
): void {
  program
    .command("tui")
    .description("Open the live read-only task board")
    .action(async () => {
      context.exitCode = await executeTui(context);
    });
}
