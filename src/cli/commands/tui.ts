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
import { resolveProjectDisplaySlug } from "../project-root";
import { buildTaskBoardSnapshot } from "../task-board-model";
import { renderTaskBoard } from "../task-board-renderer";
import { runTaskBoardSession } from "../task-board-session";
import type { CliCommandContext } from "../types";

/** Runs the read-only task board for the current cycle or every stored cycle. */
export async function executeTaskBoard(
  context: CliCommandContext,
  allCycles = false,
  history = false,
): Promise<number> {
  let dbPath: string;
  let projectSlug: string;
  try {
    const projectRoot = await commandProjectRoot(context);
    dbPath = projectDatabasePath(projectRoot);
    projectSlug = await resolveProjectDisplaySlug(projectRoot);
  } catch (error) {
    context.io.err(errorMessage(error));
    return 1;
  }
  try {
    const cycle = await currentCycle(context.runtime);
    const db = openDatabase(dbPath);
    try {
      const planning = new PlanningRepository(db);
      const orchestration = new OrchestrationRepository(db);
      const read = () =>
        buildTaskBoardSnapshot({
          tasks: planning.listTasks(),
          inspection: orchestration.inspect(),
          currentCycleId: cycle.id,
          allCycles,
          history,
        });
      const { input, output } = context.io;
      if (input?.isTTY === true && output?.isTTY === true) {
        await runTaskBoardSession({ input, output, read, projectSlug });
      } else {
        context.io.out(
          renderTaskBoard(read(), {
            width: output?.columns ?? 80,
            isTTY: false,
            projectSlug,
          }),
        );
      }
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
        message: errorMessage(error),
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
      context.exitCode = await executeTaskBoard(context);
    });
}
