import { resolve } from "node:path";
import { Argument, type Command } from "commander";
import { BacklogManifestSchema } from "../../domain/schemas";
import { safeTaskPathComponent } from "../../domain/task-path";
import { importApprovedGitHubIssues } from "../../github/import-service";
import { readApprovedGitHubIssueCandidates } from "../../github/import-source";
import { taskHookConfigHash } from "../../scheduler/task-hooks";
import { openDatabase } from "../../store/database";
import { OrchestrationRepository } from "../../store/orchestration-repository";
import { PlanningRepository } from "../../store/planning-repository";
import {
  commandProjectRoot,
  currentCycle,
  errorMessage,
  projectDatabasePath,
} from "../command-context";
import { renderEmptyTaskList } from "../presentation";
import type { CliCommandContext } from "../types";
import { executeTaskBoard } from "./tui";

/** Returns whether a backlog manifest still uses the removed weekId field. */
function usesLegacyWeekId(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "weekId" in value
  );
}

/** Imports one approved backlog manifest into the current project. */
async function executeTaskImport(
  context: CliCommandContext,
  manifestPath: string,
): Promise<number> {
  try {
    const input: unknown = await Bun.file(resolve(manifestPath)).json();
    if (usesLegacyWeekId(input)) {
      throw new Error("Manifest uses weekId; replace it with cycleId");
    }
    const manifest = BacklogManifestSchema.parse(input);
    for (const task of manifest.tasks) safeTaskPathComponent(task.id);
    const projectRoot = await commandProjectRoot(context);
    const db = openDatabase(projectDatabasePath(projectRoot));
    try {
      const result = new PlanningRepository(db).importBacklog(manifest);
      context.io.out(
        [
          `Created: ${result.created}`,
          `Already present: ${result.skipped}`,
          `Total: ${result.total}`,
          "Next:",
          "  npx roc-it@latest task list",
        ].join("\n"),
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

/** Imports approved GitHub Issues into the current project. */
async function executeGitHubImport(
  context: CliCommandContext,
): Promise<number> {
  try {
    const cycle = await currentCycle(context.runtime);
    const issues = await (context.runtime.readGitHubIssues
      ? context.runtime.readGitHubIssues()
      : readApprovedGitHubIssueCandidates({ stderr: () => undefined }));
    const projectRoot = await commandProjectRoot(context);
    const db = openDatabase(projectDatabasePath(projectRoot));
    try {
      const result = await importApprovedGitHubIssues({
        repository: new PlanningRepository(db),
        cycleId: cycle.id,
        readIssues: async () => issues,
      });
      context.io.out(
        `created=${result.created} skipped=${result.skipped} total=${result.total}`,
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

/** Lists the current project's stored tasks. */
async function executeTaskList(context: CliCommandContext): Promise<number> {
  try {
    const projectRoot = await commandProjectRoot(context);
    const db = openDatabase(projectDatabasePath(projectRoot));
    try {
      const tasks = new PlanningRepository(db).listTasks();
      context.io.out(
        tasks.length
          ? tasks
              .map(
                (task) =>
                  `- ${JSON.stringify(task.id)} [${task.status}] ${JSON.stringify(task.title)}`,
              )
              .join("\n")
          : renderEmptyTaskList(),
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

/** Trusts the current task-scoped hook configuration for one phase. */
async function executeHookTrust(
  context: CliCommandContext,
  taskId: string,
  phase: "prehook" | "posthook",
): Promise<number> {
  try {
    const projectRoot = await commandProjectRoot(context);
    const db = openDatabase(projectDatabasePath(projectRoot));
    try {
      const repo = new OrchestrationRepository(db);
      const task = repo.getTask(taskId);
      if (task === undefined) {
        context.io.err(`Task not found: ${taskId}`);
        return 1;
      }
      const hook = task.spec[phase];
      if (hook === undefined) {
        context.io.err(`Task ${taskId} has no ${phase}`);
        return 1;
      }
      const hash = taskHookConfigHash(hook);
      repo.trustTaskHook(taskId, phase, hash);
      context.io.out(`Trusted ${phase} for ${taskId}: ${hash}`);
      return 0;
    } finally {
      db.close();
    }
  } catch (error) {
    context.io.err(errorMessage(error));
    return 1;
  }
}

/** Registers task import, board, listing, and hook trust commands. */
export function registerTaskCommands(
  program: Command,
  context: CliCommandContext,
): void {
  const task = program.command("task").description("Plan and inspect work");
  task
    .command("import")
    .description("Import an approved backlog")
    .argument("<file>", "approved backlog JSON file")
    .action(async (file: string) => {
      context.exitCode = await executeTaskImport(context, file);
    });
  task
    .command("import-github")
    .description("Import approved GitHub Issues")
    .action(async () => {
      context.exitCode = await executeGitHubImport(context);
    });
  task
    .command("list")
    .description("List the current project's tasks")
    .action(async () => {
      context.exitCode = await executeTaskList(context);
    });
  task
    .command("board")
    .description("Open the read-only task board")
    .option("--all", "include tasks from every cycle")
    .action(async (options: { all?: boolean }) => {
      context.exitCode = await executeTaskBoard(context, options.all === true);
    });
  task
    .command("hook")
    .description("Manage task-scoped hooks")
    .command("trust")
    .description("Trust one task hook configuration")
    .argument("<task-id>", "task identifier")
    .addArgument(
      new Argument("<phase>", "hook phase").choices(["prehook", "posthook"]),
    )
    .action(async (taskId: string, phase: "prehook" | "posthook") => {
      context.exitCode = await executeHookTrust(context, taskId, phase);
    });
}
