import { homedir } from "node:os";
import type { Command } from "commander";
import { activeAgileCycle } from "../../domain/agile-cycle";
import { loadRocSettingsIfPresent } from "../../settings";
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
import { renderWelcome } from "../tui-renderer";
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

/** Opens Welcome immediately; configuration and remote failures remain recoverable status. */
export async function executeTui(context: CliCommandContext): Promise<number> {
  const { input, output } = context.io;
  if (!input?.isTTY || !output?.isTTY) {
    context.io.out(renderWelcome(output?.columns ?? 80));
    return 0;
  }
  let projectSlug: string | undefined;
  try {
    await runTaskBoardSession({
      input,
      output,
      /** Returns the project label resolved during checkpoint refresh. */
      get projectSlug() {
        return projectSlug;
      },
      initialTab: "welcome",
      refreshIntervalMs: 30000,
      /** Loads settings and remote checkpoints while leaving setup failures recoverable. */
      async read() {
        const settings = await loadRocSettingsIfPresent(
          context.runtime.homeRoot ?? homedir(),
        );
        if (!settings)
          throw new Error(
            "Roc settings not configured. Run roc-it onboard, then press R. GitHub connection not checked.",
          );
        const repoPath = await commandProjectRoot(context, {
          allowCurrentDirectory: true,
        });
        projectSlug = await resolveProjectDisplaySlug(repoPath);
        if (!context.runtime.readTasks)
          throw new Error("GitHub task reads are unavailable");
        const snapshot = await context.runtime.readTasks(repoPath);
        const cycle = activeAgileCycle(
          settings.cycle,
          context.runtime.now?.() ?? new Date(),
        );
        return buildTaskBoardSnapshot({
          tasks: snapshot.tasks,
          inspection: snapshot.inspection,
          currentCycleId: cycle.id,
          remoteCheckpoints: true,
          usageIncomplete: snapshot.usageIncomplete,
        });
      },
    });
    return 0;
  } catch (error) {
    context.io.err(errorMessage(error));
    return 1;
  }
}

/** Registers the read-only Welcome entry. */
export function registerTuiCommand(
  program: Command,
  context: CliCommandContext,
): void {
  program
    .command("tui")
    .description("Open Welcome and the read-only Tasks monitor")
    .action(async () => {
      context.exitCode = await executeTui(context);
    });
}
