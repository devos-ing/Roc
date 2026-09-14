import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  type InteractiveModeOptions,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { agentEnvironment } from "./command.js";
import { ChangeDelivery, type DeliveryOptions } from "./delivery.js";
import { createOpenAmpExtension } from "./extension.js";
import { AgentSupervisor, type SupervisorOptions } from "./supervisor.js";
import { ChangeWorkspace, createChange, resumeChange } from "./workspace.js";

interface ParsedArguments {
  resume?: string;
  base?: string;
  help: boolean;
}

type InteractiveModeConstructor = new (
  runtime: AgentSessionRuntime,
  options: InteractiveModeOptions,
) => { run(): Promise<void> };

export interface RunOpenAmpOptions {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  cwd?: string;
  supervisorOptions?: SupervisorOptions;
  deliveryOptions?: DeliveryOptions;
  InteractiveMode?: InteractiveModeConstructor;
}

/** Parses OpenAmp's intentionally small process-level CLI surface. */
export function parseArguments(args: string[]): ParsedArguments {
  const options: ParsedArguments = { help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--resume") options.resume = args[++index];
    else if (argument === "--base") options.base = args[++index];
    else throw new Error(`Unknown OpenAmp option: ${argument}`);
  }
  if (args.at(-1) === "--resume" || args.at(-1) === "--base") {
    throw new Error(`${args.at(-1)} requires a value`);
  }
  if (options.resume && options.base) {
    throw new Error("--base cannot change an existing --resume change");
  }
  return options;
}

/** Returns the public OpenAmp command help. */
export function helpText(): string {
  return [
    "OpenAmp - interactive Pi agent collaboration",
    "",
    "Usage:",
    "  openamp [--base <ref>]",
    "  openamp --resume <change-id>",
    "",
    "OpenAmp creates a dedicated feature worktree, keeps Pi sessions durable,",
    "delegates through /agents, and opens reviewed pull requests without merging.",
  ].join("\n");
}

/** Starts or resumes one OpenAmp native Pi TUI session. */
export async function runOpenAmp(
  args: string[],
  options: RunOpenAmpOptions = {},
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.help) {
    (options.stdout ?? process.stdout).write(`${helpText()}\n`);
    return 0;
  }
  const cwd = options.cwd ?? process.cwd();
  const store = parsed.resume
    ? await resumeChange(cwd, parsed.resume)
    : await createChange(cwd, { base: parsed.base });
  const workspace = new ChangeWorkspace(store);
  const supervisor = new AgentSupervisor(
    store,
    workspace,
    options.supervisorOptions,
  );
  const delivery = new ChangeDelivery(
    store,
    workspace,
    supervisor,
    options.deliveryOptions,
  );
  const agentDir = getAgentDir();
  const isolatedHome = await mkdtemp(join(tmpdir(), "openamp-agent-home-"));
  const originalEnvironment = { ...process.env };
  const childEnvironment = agentEnvironment(process.env, isolatedHome);
  const changedEnvironmentNames = new Set([
    ...Object.keys(process.env),
    ...Object.keys(childEnvironment),
  ]);
  for (const name of changedEnvironmentNames) {
    if (process.env[name] === childEnvironment[name]) {
      changedEnvironmentNames.delete(name);
    } else if (childEnvironment[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = childEnvironment[name];
    }
  }
  const extension = createOpenAmpExtension(
    store,
    supervisor,
    workspace,
    delivery,
  );
  const sessionDirectory = store.state.commonDir
    ? join(store.state.commonDir, "openamp", "sessions")
    : join(dirname(store.path), "sessions");
  const sessionManager = store.state.sessionFile
    ? SessionManager.open(store.state.sessionFile, sessionDirectory)
    : SessionManager.create(store.state.workspace, sessionDirectory);

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: runtimeCwd,
    sessionManager: manager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir,
      resourceLoaderOptions: {
        noExtensions: true,
        extensionFactories: [extension],
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager: manager,
        sessionStartEvent,
        tools: [
          "read",
          "grep",
          "find",
          "ls",
          "bash",
          "edit",
          "write",
          "delegate",
          "agent_status",
          "integrate_result",
          "deliver_change",
        ],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  let runtime: AgentSessionRuntime | undefined;
  try {
    await supervisor.recover();
    const activeRuntime = await createAgentSessionRuntime(createRuntime, {
      cwd: store.state.workspace,
      agentDir,
      sessionManager,
    });
    runtime = activeRuntime;
    await store.update((state) => {
      state.sessionId = activeRuntime.session.sessionId;
      state.sessionFile = activeRuntime.session.sessionFile ?? null;
    });
    const Mode = options.InteractiveMode ?? InteractiveMode;
    const mode = new Mode(activeRuntime, {
      migratedProviders: [],
      initialMessage: undefined,
      initialImages: [],
      initialMessages: [],
      verbose: false,
    });
    await mode.run();
  } finally {
    try {
      await supervisor.shutdown();
    } finally {
      runtime?.session.dispose();
      for (const name of changedEnvironmentNames) {
        if (originalEnvironment[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnvironment[name];
      }
      await rm(isolatedHome, { recursive: true, force: true });
    }
  }
  return 0;
}
