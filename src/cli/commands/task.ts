import { resolve } from "node:path";
import type { Command } from "commander";
import type { AcceptanceChecklistItem } from "../../domain/acceptance-checklist";
import { BacklogManifestSchema } from "../../domain/schemas";
import { BunGitHubCommandRunner } from "../../github/pr-publisher";
import { jsonHash, withGitHubBodyFile } from "../../github/remote-tasks";
import { cleanupTaskWorktrees } from "../../workspace/task-branch";
import {
  commandProjectRoot,
  currentCycle,
  errorMessage,
} from "../command-context";
import { connectGitHub } from "../runtime";
import type { CliCommandContext } from "../types";
import { executeTaskBoard } from "./tui";

/** Parses a GitHub Issue number without treating arbitrary text as a CLI argument. */
function issueNumber(value: string): number {
  const raw = value.replace(/^(?:#|issue-)/u, "");
  if (!/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw Error("Use a GitHub Issue number");
  return Number(raw);
}

/** Renders one read-only acceptance checklist without treating it as human approval. */
function renderAcceptanceChecklist(
  task: { id: string; title: string },
  checklist: readonly AcceptanceChecklistItem[],
): string {
  return [
    `Acceptance checklist for ${task.id} · ${task.title}`,
    "Automated Review evidence; human acceptance is separate.",
    ...checklist.flatMap((item) => [
      `[${item.status === "passed" ? "x" : " "}] ${item.criterion}`,
      `  Status: ${item.status}`,
      ...(item.evidence === undefined
        ? ["  Evidence: No item-level evidence recorded."]
        : [
            "  Evidence:",
            ...item.evidence.split("\n").map((line) => `    ${line}`),
          ]),
    ]),
  ].join("\n");
}

/** Registers task commands that read or modify GitHub directly. */
export function registerTaskCommands(
  program: Command,
  context: CliCommandContext,
): void {
  const task = program
    .command("task")
    .description("Manage tasks in GitHub Issues");
  task
    .command("publish-github <manifest>")
    .description("Publish one approved backlog as GitHub Issues")
    .action(async (path: string) => {
      try {
        const manifest = BacklogManifestSchema.parse(
          await Bun.file(resolve(path)).json(),
        );
        const root = await commandProjectRoot(context);
        if (!context.runtime.publishGitHubTasks)
          throw Error("GitHub publication is unavailable");
        for (const issue of await context.runtime.publishGitHubTasks(
          manifest,
          root,
        ))
          context.io.out(`${issue.taskId}: ${issue.issueUrl}`);
      } catch (error) {
        context.io.err(errorMessage(error));
        context.exitCode = 1;
      }
    });
  task
    .command("list")
    .description("List GitHub task checkpoints")
    .option("--all", "Include other Agile cycles")
    .option("--history", "Include retired tasks")
    .action(async (options: { all?: boolean; history?: boolean }) => {
      try {
        const root = await commandProjectRoot(context);
        if (!context.runtime.readTasks)
          throw Error("GitHub task reads are unavailable");
        const snapshot = await context.runtime.readTasks(root);
        const cycle = await currentCycle(context.runtime);
        const tasks = snapshot.tasks.filter(
          (item) =>
            (options.all || item.cycleId === cycle.id) &&
            (options.history || item.status !== "retired"),
        );
        for (const diagnostic of snapshot.diagnostics)
          context.io.err(diagnostic);
        if (!tasks.length)
          context.io.out(
            "No GitHub tasks. Publish an approved backlog with task publish-github.",
          );
        for (const item of tasks)
          context.io.out(`${item.id} · ${item.status} · ${item.title}`);
      } catch (error) {
        context.io.err(errorMessage(error));
        context.exitCode = 1;
      }
    });
  task
    .command("board")
    .description("Open the read-only GitHub task board")
    .option("--all", "Include other Agile cycles")
    .option("--history", "Include retired tasks")
    .action(async (options: { all?: boolean; history?: boolean }) => {
      context.exitCode = await executeTaskBoard(
        context,
        options.all,
        options.history,
      );
    });
  task
    .command("acceptance <issue>")
    .description("Show read-only per-item Review evidence for one GitHub task")
    .action(async (value: string) => {
      try {
        if (!context.runtime.readTasks)
          throw Error("GitHub task reads are unavailable");
        const root = await commandProjectRoot(context);
        const snapshot = await context.runtime.readTasks(root);
        const taskId = `issue-${issueNumber(value)}`;
        const item = snapshot.tasks.find(
          (candidate) => candidate.id === taskId,
        );
        const inspected = snapshot.inspection.tasks.find(
          (candidate) => candidate.id === taskId,
        );
        if (!item || !inspected)
          throw Error(`GitHub task ${taskId} was not found`);
        context.io.out(
          renderAcceptanceChecklist(item, inspected.acceptanceChecklist),
        );
      } catch (error) {
        context.io.err(errorMessage(error));
        context.exitCode = 1;
      }
    });
  task
    .command("trust-hooks <issue>")
    .description("Approve exact hook commands in a GitHub task")
    .requiredOption("--phase <phase>", "prehook or posthook")
    .action(async (value: string, options: { phase: string }) => {
      try {
        const phase = options.phase;
        if (phase !== "prehook" && phase !== "posthook")
          throw Error("Choose prehook or posthook");
        const root = await commandProjectRoot(context);
        const { store, api, login } = await connectGitHub(root);
        if (!store.publishers.has(login))
          throw Error("Current GitHub login is not a trusted publisher");
        const item = await store.get(issueNumber(value));
        const hook = item.envelope.task.spec[phase];
        if (!hook)
          throw Error("This task has no configured hook for that phase");
        if (!store.hookTrusted(item, phase))
          await api.writeComment(
            store.repository,
            item.issue.number,
            `<!-- roc:hook-trust ${jsonHash({ phase, hook })} -->`,
          );
        if (!store.hookTrusted(await store.get(item.issue.number), phase))
          throw Error("Hook trust could not be confirmed");
        context.io.out(`Trusted ${phase} for Issue #${item.issue.number}`);
      } catch (error) {
        context.io.err(errorMessage(error));
        context.exitCode = 1;
      }
    });
  task
    .command("cleanup")
    .description("Remove worktrees of finished GitHub tasks")
    .option("--dry-run", "Print the removal plan without changing anything")
    .option(
      "--all",
      "Also remove worktrees of rejected, failed_infra and retired tasks",
    )
    .action(async (options: { dryRun?: boolean; all?: boolean }) => {
      try {
        if (!context.runtime.readTasks)
          throw Error("GitHub task reads are unavailable");
        const root = await commandProjectRoot(context);
        const snapshot = await context.runtime.readTasks(root);
        for (const diagnostic of snapshot.diagnostics)
          context.io.err(diagnostic);
        const result = await cleanupTaskWorktrees(
          root,
          new Map(
            snapshot.tasks.map((task) => [task.id, task.status] as const),
          ),
          { dryRun: options.dryRun === true, all: options.all === true },
        );
        context.io.out(
          JSON.stringify(
            { removed: result.removed, kept: result.kept },
            null,
            2,
          ),
        );
        context.io.out(
          options.dryRun
            ? `Dry run: would remove ${result.removed.length} task worktree(s), kept ${result.kept.length}.`
            : `Removed ${result.removed.length} task worktree(s), kept ${result.kept.length}. Task branches are never deleted.`,
        );
        if (result.failures > 0) {
          context.io.err(
            `${result.failures} task worktree removal(s) failed; see kept reasons`,
          );
          context.exitCode = 1;
        }
      } catch (error) {
        context.io.err(errorMessage(error));
        context.exitCode = 1;
      }
    });
  task
    .command("retire <issue>")
    .description("Close a GitHub task without treating it as completed work")
    .requiredOption("--reason <text>", "Why the task is no longer needed")
    .action(async (value: string, options: { reason: string }) => {
      try {
        const root = await commandProjectRoot(context);
        const { store, api } = await connectGitHub(root);
        const item = await store.get(issueNumber(value));
        if (item.issue.state === "CLOSED") {
          context.io.out(`Issue #${item.issue.number} is already closed`);
          return;
        }
        await api.writeComment(
          store.repository,
          item.issue.number,
          `Retired: ${options.reason}`,
        );
        const runner = new BunGitHubCommandRunner();
        const result = await withGitHubBodyFile(
          JSON.stringify({ state: "closed", state_reason: "not_planned" }),
          (path) =>
            runner.run({
              cwd: root,
              command: [
                "gh",
                "api",
                "--method",
                "PATCH",
                `repos/${store.repository}/issues/${item.issue.number}`,
                "--input",
                path,
              ],
            }),
        );
        if (
          result.exitCode !== 0 ||
          (await api.get(store.repository, item.issue.number)).state !==
            "CLOSED"
        )
          throw Error("Issue retirement could not be confirmed");
        context.io.out(`Retired Issue #${item.issue.number}`);
      } catch (error) {
        context.io.err(errorMessage(error));
        context.exitCode = 1;
      }
    });
}
