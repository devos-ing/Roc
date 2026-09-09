import { resolve } from "node:path";
import type { Command } from "commander";
import { BacklogManifestSchema } from "../../domain/schemas";
import { BunGitHubCommandRunner } from "../../github/pr-publisher";
import { jsonHash, withGitHubBodyFile } from "../../github/remote-tasks";
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
