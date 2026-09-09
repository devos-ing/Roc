import type { Command } from "commander";
import {
  commandProjectRoot,
  currentCycle,
  errorMessage,
  reportOperationalError,
} from "../command-context";
import { resolveProjectDisplaySlug } from "../project-root";
import { buildTaskBoardSnapshot } from "../task-board-model";
import { renderTaskBoard } from "../task-board-renderer";
import { runTaskBoardSession } from "../task-board-session";
import type { CliCommandContext } from "../types";

/** Displays GitHub checkpoints without creating a local task database. */
export async function executeTaskBoard(
  context: CliCommandContext,
  allCycles = false,
  history = false,
): Promise<number> {
  let repoPath: string;
  try {
    repoPath = await commandProjectRoot(context);
  } catch (error) {
    context.io.err(errorMessage(error));
    return 1;
  }
  try {
    const cycle = await currentCycle(context.runtime);
    const projectSlug = await resolveProjectDisplaySlug(repoPath);
    const readTasks = context.runtime.readTasks;
    if (!readTasks) throw Error("GitHub task reads are unavailable");
    /** Refreshes the existing board from authoritative remote checkpoints. */
    const read = async () => {
      const snapshot = await readTasks(repoPath);
      return buildTaskBoardSnapshot({
        tasks: snapshot.tasks,
        inspection: snapshot.inspection,
        currentCycleId: cycle.id,
        allCycles,
        history,
        remoteCheckpoints: true,
        usageIncomplete: snapshot.usageIncomplete,
      });
    };
    const { input, output } = context.io;
    if (input?.isTTY && output?.isTTY)
      await runTaskBoardSession({
        input,
        output,
        read,
        projectSlug,
        refreshIntervalMs: 30000,
      });
    else
      context.io.out(
        renderTaskBoard(await read(), {
          width: output?.columns ?? 80,
          isTTY: false,
          projectSlug,
        }),
      );
    return 0;
  } catch (error) {
    return reportOperationalError(
      error,
      context,
      { repoPath },
      {
        code: "TASK_BOARD_FAILED",
        category: "infra",
        retryable: true,
        component: "cli",
        message: "Could not read GitHub task checkpoints",
      },
    );
  }
}

/** Registers the read-only board alias. */
export function registerTuiCommand(
  program: Command,
  context: CliCommandContext,
): void {
  program
    .command("tui")
    .description("Open the GitHub task board")
    .action(async () => {
      context.exitCode = await executeTaskBoard(context);
    });
}
