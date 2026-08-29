import { executeCli } from "./program";
import { defaultRuntime } from "./runtime";
import type { CliIo, CliRuntime } from "./types";

export { runDaemon, schedulerSleep } from "./runtime";
export type { CliIo, CliRuntime, SchedulerRunInput } from "./types";

/** Executes a CLI command and returns its process exit code. */
export async function runCli(
  args: string[],
  io: CliIo,
  runtime: CliRuntime = defaultRuntime,
): Promise<number> {
  return executeCli(args, io, runtime);
}
