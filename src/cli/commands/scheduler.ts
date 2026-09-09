import type { Command } from "commander";
import { backends, isRealBackendName } from "../../agents/registry";
import {
  commandProjectRoot,
  errorMessage,
  reportOperationalError,
} from "../command-context";
import type { CliCommandContext } from "../types";

/** Registers GitHub-only scheduler execution and remote inspection. */
export function registerSchedulerCommands(
  program: Command,
  context: CliCommandContext,
): void {
  const scheduler = program
    .command("scheduler")
    .description("Run and inspect GitHub tasks");
  scheduler
    .command("run")
    .description("Run approved GitHub Issues through Pi")
    .option(
      "--base-branch <branch>",
      "PR target branch (defaults to repository default)",
    )
    .option(
      "--backend <name>",
      `Scheduler backend (${Object.keys(backends).join("|")})`,
      "pi",
    )
    .option("--source <name>", "Task source (github only)", "github")
    .option("--once", "Process one eligible task and return")
    .option(
      "--concurrency <count>",
      "Concurrent independent Issues (1 or 2)",
      "2",
    )
    .action(
      async (options: {
        baseBranch?: string;
        backend: string;
        source: string;
        once?: boolean;
        concurrency: string;
      }) => {
        if (options.concurrency !== "1" && options.concurrency !== "2") {
          context.io.err("--concurrency must be 1 or 2");
          context.exitCode = 2;
          return;
        }
        if (
          !isRealBackendName(options.backend) ||
          options.source !== "github"
        ) {
          context.io.err(
            "scheduler run requires --backend pi and --source github; local SQLite queues are no longer supported",
          );
          context.exitCode = 2;
          return;
        }
        let repoPath: string;
        try {
          repoPath = await commandProjectRoot(context);
        } catch (error) {
          context.io.err(errorMessage(error));
          context.exitCode = 1;
          return;
        }
        try {
          context.io.out("Status: Starting GitHub task execution");
          await context.runtime.runScheduler({
            backend: options.backend,
            repoPath,
            source: "github",
            baseBranch: options.baseBranch,
            once: options.once,
            concurrency: options.concurrency === "1" ? 1 : 2,
          });
          context.io.out("Result: Stopped");
        } catch (error) {
          context.exitCode = await reportOperationalError(error, context, {
            repoPath,
          });
        }
      },
    );
  scheduler
    .command("inspect")
    .description("Read execution checkpoints from GitHub")
    .action(async () => {
      try {
        const root = await commandProjectRoot(context);
        if (!context.runtime.readTasks)
          throw Error("GitHub task reads are unavailable");
        context.io.out(
          JSON.stringify(await context.runtime.readTasks(root), null, 2),
        );
      } catch (error) {
        context.io.err(errorMessage(error));
        context.exitCode = 1;
      }
    });
}
