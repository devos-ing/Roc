import type { Command } from "commander";
import { backends, isRealBackendName } from "../../agents/registry";
import { openDatabase } from "../../store/database";
import { OrchestrationRepository } from "../../store/orchestration-repository";
import {
  commandProjectRoot,
  errorMessage,
  projectDatabasePath,
  reportOperationalError,
} from "../command-context";
import type { CliCommandContext, SchedulerRunInput } from "../types";

/** Runs the public scheduler against a registered backend in the current project. */
async function executeSchedulerRun(
  context: CliCommandContext,
  options: { base: string; baseBranch?: string; backend: string },
): Promise<number> {
  if (!isRealBackendName(options.backend)) {
    context.io.err(
      `scheduler run requires --backend ${Object.keys(backends).join("|")}`,
    );
    return 2;
  }
  let repoPath: string;
  try {
    repoPath = await commandProjectRoot(context);
  } catch (error) {
    context.io.err(errorMessage(error));
    return 1;
  }
  const dbPath = projectDatabasePath(repoPath);
  const input: SchedulerRunInput = {
    backend: options.backend,
    dbPath,
    repoPath,
    baseRef: options.base,
    ...(options.baseBranch === undefined
      ? {}
      : { baseBranch: options.baseBranch }),
  };
  try {
    context.io.out("Status: Starting");
    await context.runtime.runScheduler(input);
    context.io.out("Result: Stopped");
    return 0;
  } catch (error) {
    return reportOperationalError(error, context, { dbPath, repoPath });
  }
}

/** Prints the current project's durable scheduler snapshot. */
async function executeSchedulerInspect(
  context: CliCommandContext,
): Promise<number> {
  try {
    const projectRoot = await commandProjectRoot(context);
    const db = openDatabase(projectDatabasePath(projectRoot));
    try {
      context.io.out(
        JSON.stringify(new OrchestrationRepository(db).inspect(), null, 2),
      );
      return 0;
    } finally {
      db.close();
    }
  } catch (error) {
    context.io.err(errorMessage(error));
    return 1;
  }
}

/** Registers scheduler execution and inspection commands. */
export function registerSchedulerCommands(
  program: Command,
  context: CliCommandContext,
): void {
  const scheduler = program
    .command("scheduler")
    .description("Run and inspect the scheduler");
  scheduler
    .command("run")
    .description("Run ready tasks with a registered backend")
    .option("--base <ref>", "Git ref used as the task base", "HEAD")
    .option(
      "--base-branch <branch>",
      "GitHub branch targeted by published pull requests",
    )
    .option(
      "--backend <name>",
      `Scheduler backend (${Object.keys(backends).join("|")})`,
      "codex",
    )
    .action(
      async (options: {
        base: string;
        baseBranch?: string;
        backend: string;
      }) => {
        context.exitCode = await executeSchedulerRun(context, options);
      },
    );
  scheduler
    .command("inspect")
    .description("Print the durable scheduler state")
    .action(async () => {
      context.exitCode = await executeSchedulerInspect(context);
    });
}
