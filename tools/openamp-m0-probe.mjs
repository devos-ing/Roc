#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  InteractiveMode,
  ModelRuntime,
  RpcClient,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REMOTE_MUTATION =
  /(?:^|[;&|]\s*)(?:git\s+push|gh\s+pr\s+(?:create|merge|close|reopen)|gh\s+api\b)/u;

/** Throws when an M0 feasibility invariant is not satisfied. */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Classifies direct shell commands that must remain owned by Delivery. */
function remoteMutationReason(command) {
  return REMOTE_MUTATION.test(command)
    ? "OpenAmp agents cannot mutate GitHub or Git remotes"
    : undefined;
}

/** Creates the controlled extension used by the automated and TUI probes. */
function openAmpExtension(remoteAttempts) {
  return {
    name: "openamp-m0",
    factory(pi) {
      pi.on("session_start", (_event, context) => {
        context.ui.setStatus("openamp", "agents: 0 active");
      });
      pi.on("tool_call", (event) => {
        if (event.toolName !== "bash") return undefined;
        const command = String(event.input.command ?? "");
        const reason = remoteMutationReason(command);
        if (reason) remoteAttempts.push(command);
        return reason ? { block: true, reason } : undefined;
      });
      pi.on("user_bash", (event) => {
        const reason = remoteMutationReason(event.command);
        return reason
          ? {
              result: {
                output: reason,
                exitCode: 1,
                cancelled: false,
                truncated: false,
              },
            }
          : undefined;
      });
      pi.registerCommand("agents", {
        description: "Show OpenAmp child agents",
        handler: async (_arguments, context) => {
          context.ui.setWidget("openamp-agents", [
            "OpenAmp agents",
            "No active child agents",
          ]);
          context.ui.notify("OpenAmp agents: 0 active", "info");
        },
      });
      pi.registerCommand("m0-exit", {
        description: "Exit the OpenAmp M0 TUI probe",
        handler: async (_arguments, context) => {
          context.shutdown();
        },
      });
    },
  };
}

/** Creates a resource loader containing only the controlled M0 extension. */
async function createProbeLoader(cwd, extension) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [extension],
  });
  await loader.reload();
  return loader;
}

/** Returns the text carried by a Pi tool result. */
function toolResultText(message) {
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

/** Proves controlled tools, two turns, blocking, and durable result recovery. */
async function runSessionProbe(cwd) {
  const remoteAttempts = [];
  const extension = openAmpExtension(remoteAttempts);
  const loader = await createProbeLoader(cwd, extension);
  const faux = fauxProvider({ tokensPerSecond: 1_000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("probe_status", { value: "turn-one" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("turn one complete"),
    fauxAssistantMessage(
      fauxToolCall("bash", { command: "printf openamp-allowed" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command: "git push /definitely/not/a/remote HEAD",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("turn two complete"),
  ]);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const statusTool = defineTool({
    name: "probe_status",
    label: "Probe status",
    description: "Returns a deterministic M0 status value.",
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_toolCallId, parameters) => ({
      content: [{ type: "text", text: `status:${parameters.value}` }],
      details: {},
    }),
  });
  const sessionDirectory = join(cwd, ".sessions");
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    modelRuntime,
    model: faux.getModel(),
    tools: ["bash", "probe_status"],
    customTools: [statusTool],
    resourceLoader: loader,
    sessionManager: SessionManager.create(cwd, sessionDirectory),
  });
  const sessionId = session.sessionId;
  const sessionFile = session.sessionFile;
  try {
    await session.prompt("run the first controlled tool");
    await session.prompt("run an allowed command, then attempt a remote push");
    const results = session.messages.filter(
      (message) => message.role === "toolResult",
    );
    const texts = results.map(toolResultText);
    assert(
      session.agent.state.tools.map((tool) => tool.name).join(",") ===
        "bash,probe_status",
      "The session exposed tools outside the explicit allowlist",
    );
    assert(
      texts.includes("status:turn-one"),
      "The controlled custom tool did not execute",
    );
    assert(
      texts.includes("openamp-allowed"),
      "The allowed shell command did not execute",
    );
    assert(
      texts.includes("OpenAmp agents cannot mutate GitHub or Git remotes"),
      "The remote mutation attempt was not blocked",
    );
    assert(remoteAttempts.length === 1, "Unexpected remote mutation attempts");
    assert(sessionFile !== undefined, "The persistent session has no file");
    session.sessionManager.appendCustomEntry("openamp-result", {
      resultId: "result-m0-1",
    });
  } finally {
    session.dispose();
  }

  const { session: reopened } = await createAgentSession({
    cwd,
    modelRuntime,
    model: faux.getModel(),
    tools: ["bash", "probe_status"],
    customTools: [statusTool],
    resourceLoader: loader,
    sessionManager: SessionManager.open(sessionFile),
  });
  try {
    const recovered = reopened.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "openamp-result" &&
          entry.data?.resultId === "result-m0-1",
      );
    assert(
      reopened.sessionId === sessionId,
      "Session identity changed on resume",
    );
    assert(recovered, "The persisted result ID was not recovered");
    return {
      extension: extensionsResult.extensions.some(
        (loaded) => loaded.path === "<inline:openamp-m0>",
      ),
      activeTools: reopened.agent.state.tools.map((tool) => tool.name),
      turns: 2,
      allowedCommand: true,
      remoteMutationBlocked: true,
      sessionRecovered: true,
      resultRecovered: true,
    };
  } finally {
    reopened.dispose();
  }
}

/** Proves that a steering message is queued during a streaming Pi turn. */
async function runSteeringProbe() {
  const faux = fauxProvider({
    tokensPerSecond: 20,
    tokenSize: { min: 1, max: 1 },
  });
  faux.setResponses([
    fauxAssistantMessage("A".repeat(120)),
    fauxAssistantMessage("steered response"),
  ]);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    modelRuntime,
    model: faux.getModel(),
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
  });
  const queueSizes = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "queue_update") {
      queueSizes.push(event.steering.length);
    }
  });
  try {
    const running = session.prompt("start streaming");
    for (let attempts = 0; attempts < 100 && !session.isStreaming; attempts++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(session.isStreaming, "The faux response did not begin streaming");
    await session.steer("change course");
    await running;
    assert(
      queueSizes.includes(1) && queueSizes.at(-1) === 0,
      "The steering queue was not filled and drained",
    );
    return { queued: true, delivered: true, modelCalls: faux.state.callCount };
  } finally {
    unsubscribe();
    session.dispose();
  }
}

/** Proves that an active Pi stream can be cancelled and returns to idle. */
async function runCancellationProbe() {
  const faux = fauxProvider({
    tokensPerSecond: 10,
    tokenSize: { min: 1, max: 1 },
  });
  faux.setResponses([fauxAssistantMessage("A".repeat(200))]);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    modelRuntime,
    model: faux.getModel(),
    noTools: "all",
    sessionManager: SessionManager.inMemory(),
  });
  try {
    const running = session.prompt("start cancellable work");
    for (let attempts = 0; attempts < 100 && !session.isStreaming; attempts++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(session.isStreaming, "The cancellable response did not start");
    await session.abort();
    await running;
    const lastAssistant = session.messages.findLast(
      (message) => message.role === "assistant",
    );
    assert(
      lastAssistant?.stopReason === "aborted",
      "Cancellation did not persist an aborted assistant result",
    );
    assert(!session.isStreaming, "The cancelled session remained busy");
    return { aborted: true, returnedToIdle: true };
  } finally {
    session.dispose();
  }
}

/** Proves the exported Node RPC client using Pi's explicit public rpc-entry. */
async function runRpcProbe(cwd) {
  const rpcEntry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
  );
  const client = new RpcClient({
    cliPath: rpcEntry,
    cwd,
    args: [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--no-session",
    ],
  });
  try {
    await client.start();
    const state = await client.getState();
    assert(!state.isStreaming, "The new RPC session unexpectedly started busy");
    return {
      started: true,
      stateReadable: typeof state.sessionId === "string",
      stopped: true,
      requiresExplicitCliPath: true,
    };
  } finally {
    await client.stop();
  }
}

/** Runs all deterministic M0 checks without credentials or paid model calls. */
async function runAutomatedProbe() {
  const cwd = await mkdtemp(join(tmpdir(), "openamp-m0-"));
  try {
    return {
      node: process.version,
      publicExports: {
        InteractiveMode: typeof InteractiveMode === "function",
        createAgentSessionRuntime:
          typeof createAgentSessionRuntime === "function",
        RpcClient: typeof RpcClient === "function",
      },
      session: await runSessionProbe(cwd),
      steering: await runSteeringProbe(),
      cancellation: await runCancellationProbe(),
      rpc: await runRpcProbe(cwd),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Launches Pi's native TUI with an OpenAmp status and agent-list extension. */
async function runTuiProbe(manualInput) {
  const remoteAttempts = [];
  const extension = openAmpExtension(remoteAttempts);
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: getAgentDir(),
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [extension],
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: faux.getModel(),
        noTools: "all",
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    sessionManager: SessionManager.inMemory(process.cwd()),
  });
  const mode = new InteractiveMode(runtime, {
    migratedProviders: [],
    initialMessage: manualInput ? undefined : "/agents",
    initialMessages: manualInput ? [] : ["/m0-exit"],
    verbose: false,
  });
  await mode.run();
}

/** Selects the automated JSON probe or the self-closing native TUI probe. */
async function main() {
  if (process.argv.includes("--tui-manual")) {
    await runTuiProbe(true);
    return;
  }
  if (process.argv.includes("--tui")) {
    await runTuiProbe(false);
    return;
  }
  process.stdout.write(
    `${JSON.stringify(await runAutomatedProbe(), null, 2)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
