import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { agentEnvironment } from "./command.mjs";
import { ChangeDelivery } from "./delivery.mjs";
import { createOpenAmpExtension } from "./extension.mjs";
import { AgentSupervisor } from "./supervisor.mjs";
import { ChangeWorkspace, createChange, resumeChange } from "./workspace.mjs";

/** Parses OpenAmp's intentionally small process-level CLI surface. */
export function parseArguments(args) {
  const options = { resume: undefined, base: undefined, help: false };
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
export function helpText() {
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
export async function runOpenAmp(args, options = {}) {
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
  await supervisor.recover();
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

  const createRuntime = async ({
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
  let runtime;
  try {
    runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: store.state.workspace,
      agentDir,
      sessionManager,
    });
    await store.update((state) => {
      state.sessionId = runtime.session.sessionId;
      state.sessionFile = runtime.session.sessionFile;
    });
    const Mode = options.InteractiveMode ?? InteractiveMode;
    const mode = new Mode(runtime, {
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
