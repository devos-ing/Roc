import { Command, CommanderError } from "commander";
import { registerCycleCommands } from "./commands/cycle";
import { registerOnboardCommand } from "./commands/onboard";
import { registerSchedulerCommands } from "./commands/scheduler";
import { registerTaskCommands } from "./commands/task";
import { registerTokensCommand } from "./commands/tokens";
import type { CliCommandContext, CliIo, CliRuntime } from "./types";

/** Creates the complete public Roc command tree around injected dependencies. */
function createCliProgram(context: CliCommandContext): Command {
  const program = new Command();
  program
    .name("roc-it")
    .description("Run Codex agents through an agile software flow")
    .helpOption("-h, --help", "display help for command")
    .addHelpCommand("help [command]", "display help for command")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (text) => context.io.out(text.trimEnd()),
      writeErr: (text) => context.io.err(text.trimEnd()),
    });

  registerOnboardCommand(program, context);
  registerCycleCommands(program, context);
  registerTaskCommands(program, context);
  registerTokensCommand(program, context);
  registerSchedulerCommands(program, context);
  return program;
}

/** Parses and executes one CLI invocation without terminating the host process. */
export async function executeCli(
  args: string[],
  io: CliIo,
  runtime: CliRuntime,
): Promise<number> {
  const context: CliCommandContext = { io, runtime, exitCode: 0 };
  const program = createCliProgram(context);
  if (args.length === 0) {
    io.out(program.helpInformation().trimEnd());
    return 0;
  }
  try {
    await program.parseAsync(args, { from: "user" });
    return context.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    throw error;
  }
}
