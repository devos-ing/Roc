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

/** Renders one retired task's preserved retirement history for the task list. */
function renderRetirementHistory(task: {
  retirementReason?: string | null;
  replacementTaskId?: string | null;
  retiredAt?: string | null;
}): string {
  const label = task.replacementTaskId == null ? "Archived" : "Superseded";
  const replacement =
    task.replacementTaskId == null
      ? ""
      : ` by ${JSON.stringify(task.replacementTaskId)}`;
  return `  ${label}${replacement}: ${JSON.stringify(task.retirementReason)} at ${task.retiredAt}`;
}

/** Pads a task-list cell to the requested terminal display width. */
function padTaskListCell(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - Bun.stringWidth(value)))}`;
}

/** Renders task records as a display-width-aware, left-aligned CLI table. */
function renderTaskList(
  tasks: Array<{
    id: string;
    status: string;
    title: string;
    retirementReason?: string | null;
    replacementTaskId?: string | null;
    retiredAt?: string | null;
  }>,
): string {
  const rows = tasks.map((task) => ({
    task,
    id: JSON.stringify(task.id),
    status: task.status,
    title: JSON.stringify(task.title),
  }));
  const idWidth = Math.max(
    Bun.stringWidth("ID"),
    ...rows.map((row) => Bun.stringWidth(row.id)),
  );
  const statusWidth = Math.max(
    Bun.stringWidth("STATUS"),
    ...rows.map((row) => Bun.stringWidth(row.status)),
  );
  return [
    [
      padTaskListCell("ID", idWidth),
      padTaskListCell("STATUS", statusWidth),
      "TITLE",
    ].join("  "),
    ...rows.flatMap((row) => [
      [
        padTaskListCell(row.id, idWidth),
        padTaskListCell(row.status, statusWidth),
        row.title,
      ].join("  "),
      ...(row.task.status === "retired"
        ? [renderRetirementHistory(row.task)]
        : []),
    ]),
  ].join("\n");
}

/** Lists current-project tasks, optionally including preserved retirement history. */
async function executeTaskList(
  context: CliCommandContext,
  history = false,
): Promise<number> {
  try {
    const projectRoot = await commandProjectRoot(context);
    const db = openDatabase(projectDatabasePath(projectRoot));
    try {
      const tasks = new PlanningRepository(db)
        .listTasks()
        .filter((task) => history || task.status !== "retired");
      context.io.out(
        tasks.length ? renderTaskList(tasks) : renderEmptyTaskList(),
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

/** Retires one obsolete task while preserving its history and optional replacement link. */
async function executeTaskRetire(
  context: CliCommandContext,
  taskId: string,
  options: { reason: string; replacement?: string },
): Promise<number> {
  try {
    const projectRoot = await commandProjectRoot(context);
    const db = openDatabase(projectDatabasePath(projectRoot));
    try {
      const result = new PlanningRepository(db).retireTask({
        taskId,
        reason: options.reason,
        ...(options.replacement === undefined
          ? {}
          : { replacementTaskId: options.replacement }),
      });
      context.io.out(
        result.replacementTaskId === undefined
          ? `Archived ${JSON.stringify(result.taskId)}.`
          : `Superseded ${JSON.stringify(result.taskId)} by ${JSON.stringify(result.replacementTaskId)}.`,
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
    .option("--history", "include retired tasks and their history")
    .action(async (options: { history?: boolean }) => {
      context.exitCode = await executeTaskList(
        context,
        options.history === true,
      );
    });
  task
    .command("retire")
    .description("Retire an obsolete task while preserving its history")
    .argument("<task-id>", "task identifier")
    .requiredOption("--reason <text>", "why this task is obsolete")
    .option("--replacement <task-id>", "task that replaces this one")
    .action(
      async (
        taskId: string,
        options: { reason: string; replacement?: string },
      ) => {
        context.exitCode = await executeTaskRetire(context, taskId, options);
      },
    );
  task
    .command("board")
    .description("Open the read-only task board")
    .option("--all", "include tasks from every cycle")
    .option("--history", "include retired tasks and their history")
    .action(async (options: { all?: boolean; history?: boolean }) => {
      context.exitCode = await executeTaskBoard(
        context,
        options.all === true,
        options.history === true,
      );
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
