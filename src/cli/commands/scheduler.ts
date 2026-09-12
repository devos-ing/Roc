import type { Command } from "commander";
import { backends, isRealBackendName } from "../../agents/registry";
import { readCheckoutOwnerRecord } from "../../workspace/checkout-ownership";
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
      "--auto-merge",
      "Squash merge reviewed PR heads after strict GitHub protection, checks and reviews pass",
    )
    .option("--concurrency <count>", "Concurrent independent Issues (1-8)", "2")
    .action(
      async (options: {
        baseBranch?: string;
        backend: string;
        source: string;
        once?: boolean;
        autoMerge?: boolean;
        concurrency: string;
      }) => {
        if (!/^[1-8]$/.test(options.concurrency)) {
          context.io.err("--concurrency must be an integer from 1 through 8");
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
            autoMerge: options.autoMerge,
            concurrency: Number(options.concurrency),
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
  scheduler
    .command("status")
    .description(
      "Report daemon health from the checkout lock; exits 0 while the owner process is alive, 1 when stopped, stale or unreadable",
    )
    .action(async () => {
      try {
        const root = await commandProjectRoot(context);
        const owner = await readCheckoutOwnerRecord(root);
        if (owner.state === "absent") {
          context.io.out(
            JSON.stringify({ running: false, reason: "no-lock" }, null, 2),
          );
          context.exitCode = 1;
          return;
        }
        if (owner.state === "unreadable") {
          context.io.out(
            JSON.stringify(
              {
                running: false,
                reason: "unreadable-lock",
                hint: "the checkout lock exists but its owner record is unreadable; inspect it and confirm no scheduler is running before removing it",
              },
              null,
              2,
            ),
          );
          context.exitCode = 1;
          return;
        }
        const { ownerPid, runId, acquiredAt } = owner.record;
        // Best-effort liveness: signal 0 to the recorded owner. EPERM still
        // proves the process exists (another user owns it) while ESRCH marks
        // it gone. A recycled PID can make a stale lock look live; that
        // residual reuse risk is accepted and unverifiable from the lock alone.
        let alive = false;
        try {
          process.kill(ownerPid, 0);
          alive = true;
        } catch (error) {
          alive =
            error instanceof Error &&
            "code" in error &&
            error.code === "EPERM";
        }
        if (alive) {
          context.io.out(
            JSON.stringify(
              { running: true, pid: ownerPid, runId, acquiredAt },
              null,
              2,
            ),
          );
          return;
        }
        context.io.out(
          JSON.stringify(
            {
              running: false,
              staleLock: true,
              pid: ownerPid,
              runId,
              acquiredAt,
              hint: "owner process is gone; the stale guard can be removed after verifying no scheduler is running",
            },
            null,
            2,
          ),
        );
        context.exitCode = 1;
      } catch (error) {
        context.io.err(errorMessage(error));
        context.exitCode = 1;
      }
    });
}
