import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCancel, multiselect } from "@clack/prompts";
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
import { createPiedPiperExtension } from "./extension.js";
import {
  createPiedPiperObservationPackExtension,
  OBSERVATION_PACK_TOOL,
  validateObservationPackRuntime,
} from "./observation-pack.js";
import type { ChangeStore } from "./state.js";
import {
  AgentSupervisor,
  parseOracleModel,
  type SupervisorOptions,
} from "./supervisor.js";
import {
  ChangeWorkspace,
  createChange,
  resumeChange,
  sessionDirectory,
} from "./workspace.js";

interface ParsedArguments {
  resume?: string;
  base?: string;
  oracleModel?: string;
  plugins: boolean;
  observationPack?: boolean;
  help: boolean;
}

type InteractiveModeConstructor = new (
  runtime: AgentSessionRuntime,
  options: InteractiveModeOptions,
) => { run(): Promise<void> };

export interface RunPiedPiperOptions {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  cwd?: string;
  supervisorOptions?: SupervisorOptions;
  deliveryOptions?: DeliveryOptions;
  InteractiveMode?: InteractiveModeConstructor;
  selectPlugins?: (
    initialObservationPack: boolean,
  ) => Promise<boolean | undefined>;
}

/** Parses Pied Piper's intentionally small process-level CLI surface. */
export function parseArguments(args: string[]): ParsedArguments {
  const options: ParsedArguments = { help: false, plugins: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (
      argument === "--resume" ||
      argument === "--base" ||
      argument === "--oracle-model"
    ) {
      const value = args[++index];
      if (!value || value.startsWith("-"))
        throw new Error(`${argument} requires a value`);
      if (argument === "--resume") options.resume = value;
      else if (argument === "--base") options.base = value;
      else {
        parseOracleModel(value);
        options.oracleModel = value;
      }
    } else if (argument === "--plugins") options.plugins = true;
    else if (argument === "--observation-pack") options.observationPack = true;
    else if (argument === "--no-observation-pack")
      options.observationPack = false;
    else throw new Error(`Unknown Pied Piper option: ${argument}`);
  }
  if (options.resume && options.base) {
    throw new Error("--base cannot change an existing --resume change");
  }
  if (options.plugins && options.observationPack !== undefined) {
    throw new Error(
      "--plugins cannot be combined with an ObservationPack flag",
    );
  }
  return options;
}

/** Returns the public Pied Piper command help. */
export function helpText(): string {
  return [
    "Pied Piper - interactive Pi agent collaboration",
    "",
    "Usage:",
    "  piedpiper [--base <ref>] [--observation-pack|--no-observation-pack]",
    "  piedpiper --resume <change-id> [--plugins]",
    "  piedpiper --oracle-model <provider/model>",
    "",
    "Pied Piper creates a dedicated feature worktree, keeps Pi sessions durable,",
    "delegates through /agents, and opens validated pull requests without merging.",
  ].join("\n");
}

/** Presents the native checkbox list that selects optional Pied Piper plugins. */
async function selectPlugins(
  initialObservationPack: boolean,
): Promise<boolean | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return initialObservationPack;
  }
  const selected = await multiselect({
    message: "Plugins",
    options: [
      {
        value: OBSERVATION_PACK_TOOL,
        label: "ObservationPack",
        hint: "keep large tool results reachable with obs_recall",
      },
    ],
    initialValues: initialObservationPack ? [OBSERVATION_PACK_TOOL] : [],
    required: false,
  });
  if (isCancel(selected)) return undefined;
  return selected.includes(OBSERVATION_PACK_TOOL);
}

/** Returns the explicit main-session tool allowlist for an optional plugin choice. */
export function mainSessionTools(observationPack: boolean): string[] {
  return [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
    "delegate",
    "ask_oracle",
    "agent_wait",
    "update_plan",
    "agent_status",
    "integrate_result",
    "deliver_change",
    ...(observationPack ? [OBSERVATION_PACK_TOOL] : []),
  ];
}

/** Starts or resumes one Pied Piper native Pi TUI session. */
export async function runPiedPiper(
  args: string[],
  options: RunPiedPiperOptions = {},
): Promise<number> {
  const parsed = parseArguments(args);
  if (parsed.help) {
    (options.stdout ?? process.stdout).write(`${helpText()}\n`);
    return 0;
  }
  const cwd = options.cwd ?? process.cwd();
  let store: ChangeStore;
  if (parsed.resume) {
    store = await resumeChange(cwd, parsed.resume);
    const selection =
      parsed.observationPack ??
      (parsed.plugins
        ? await (options.selectPlugins ?? selectPlugins)(
            store.state.observationPack === true,
          )
        : undefined);
    if (parsed.plugins && selection === undefined) {
      throw new Error("Pied Piper plugin selection cancelled");
    }
    if (selection !== undefined) {
      await store.update((state) => {
        state.observationPack = selection;
      });
    }
  } else {
    const selection =
      parsed.observationPack ??
      (await (options.selectPlugins ?? selectPlugins)(false));
    if (selection === undefined) {
      throw new Error("Pied Piper plugin selection cancelled");
    }
    store = await createChange(cwd, {
      base: parsed.base,
      observationPack: selection,
    });
  }
  if (parsed.oracleModel !== undefined) {
    await store.update((state) => {
      state.oracleModel = parsed.oracleModel;
    });
  }
  const observationPack = store.state.observationPack === true;
  if (observationPack) await validateObservationPackRuntime();
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
  const isolatedHome = await mkdtemp(join(tmpdir(), "piedpiper-agent-home-"));
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
  const extension = createPiedPiperExtension(
    store,
    supervisor,
    workspace,
    delivery,
  );
  const sessionPath = sessionDirectory(store.state);
  const sessionManager = store.state.sessionFile
    ? SessionManager.open(store.state.sessionFile, sessionPath)
    : SessionManager.create(store.state.workspace, sessionPath);

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
        extensionFactories: [
          extension,
          ...(observationPack
            ? [await createPiedPiperObservationPackExtension()]
            : []),
        ],
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager: manager,
        sessionStartEvent,
        tools: mainSessionTools(observationPack),
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
