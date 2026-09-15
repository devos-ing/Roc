import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  type RpcClientOptions,
  type RpcSessionState,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mainSessionTools } from "../../src/openamp/cli.ts";
import { runGit } from "../../src/openamp/command.ts";
import { ChangeDelivery } from "../../src/openamp/delivery.ts";
import { createOpenAmpExtension } from "../../src/openamp/extension.ts";
import {
  ChangeStore,
  type ChecklistItem,
  readChange,
} from "../../src/openamp/state.ts";
import {
  AgentSupervisor,
  type SupervisorOptions,
} from "../../src/openamp/supervisor.ts";
import { ChangeWorkspace, createChange } from "../../src/openamp/workspace.ts";

/** Loads the real Pi extension with a captured UI boundary and an on-disk task store. */
async function boot(
  store: ChangeStore,
  agentDir: string,
  options?: SupervisorOptions,
) {
  const workspace = new ChangeWorkspace(store);
  const supervisor = new AgentSupervisor(store, workspace, options);
  const delivery = new ChangeDelivery(store, workspace, supervisor);
  const services = await createAgentSessionServices({
    cwd: store.state.workspace,
    agentDir,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      extensionFactories: [
        createOpenAmpExtension(store, supervisor, workspace, delivery),
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(),
    tools: mainSessionTools(false),
  });
  const runner = session.extensionRunner;
  const widgets = new Map<string, string[]>();
  const statuses = new Map<string, string>();
  await session.bindExtensions({
    mode: "tui",
    uiContext: {
      ...runner.getUIContext(),
      setWidget(name: string, content: unknown) {
        if (Array.isArray(content)) widgets.set(name, content.map(String));
      },
      setStatus(name: string, content: string | undefined) {
        statuses.set(name, content ?? "");
      },
    },
  });
  return { session, runner, widgets, statuses, supervisor };
}

test("native Pi checklist tool persists progress, rejects stale writes, and restores its widget without changing delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "openamp-progress-integration-"));
  const sessions: Awaited<ReturnType<typeof boot>>[] = [];
  try {
    const source = join(root, "source");
    await runGit(root, ["init", "-b", "main", source]);
    await writeFile(join(source, "README.md"), "progress fixture\n");
    await runGit(source, ["add", "."]);
    await runGit(source, ["commit", "-m", "baseline"]);
    const store = await createChange(source, {
      id: "change-progress-integration",
      base: "main",
    });
    const initialPhase = store.state.phase;
    const first = await boot(store, join(root, "pi-config"));
    sessions.push(first);
    expect(first.session.getActiveToolNames()).toContain("update_plan");
    const tool = first.runner.getToolDefinition("update_plan");
    if (!tool) throw new Error("Checklist tool not registered");
    const items: ChecklistItem[] = [
      {
        id: "inspect",
        text: "Inspect existing code",
        status: "completed",
        note: `Read fixture at ${store.state.baseCommit}`,
      },
      { id: "change", text: "Implement the change", status: "in_progress" },
      {
        id: "verify",
        text: "Verify behavior",
        status: "blocked",
        note: "Waiting for implementation evidence",
      },
      { id: "deliver", text: "Create the PR", status: "pending" },
    ];
    await tool.execute(
      "plan-1",
      { expected_revision: 0, items },
      undefined,
      undefined,
      first.runner.createContext(),
    );
    expect(store.state.plan?.revision).toBe(1);
    expect(first.widgets.get("openamp-progress")?.join("\n")).toContain(
      "Plan 1/4 done",
    );
    expect(first.widgets.get("openamp-progress")?.join("\n")).toContain(
      "[>] Implement the change",
    );
    expect(first.widgets.get("openamp-progress")?.join("\n")).toContain(
      "Waiting for implementation evidence",
    );
    expect(store.state.phase).toBe(initialPhase);
    expect(store.state.review).toBeNull();
    expect(store.state.publication).toBeNull();

    const before = await readChange(store.path);
    await expect(
      tool.execute(
        "stale-plan",
        { expected_revision: 0, items: [] },
        undefined,
        undefined,
        first.runner.createContext(),
      ),
    ).rejects.toThrow("Checklist changed");
    await expect(
      tool.execute(
        "false-completion",
        {
          expected_revision: 1,
          items: [{ id: "bad", text: "No evidence", status: "completed" }],
        },
        undefined,
        undefined,
        first.runner.createContext(),
      ),
    ).rejects.toThrow("need evidence");
    expect((await readChange(store.path)).plan).toEqual(before.plan);

    await first.runner.emit({ type: "agent_start" });
    await first.runner.emit({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md", secret: "DO_NOT_PERSIST_TOOL_ARGUMENTS" },
    });
    expect(first.widgets.get("openamp-progress")?.join("\n")).toContain(
      "Main working",
    );
    expect(first.widgets.get("openamp-progress")?.join("\n")).toContain(
      "Last: main · read · running",
    );
    expect(JSON.stringify(await readChange(store.path))).not.toContain(
      "DO_NOT_PERSIST_TOOL_ARGUMENTS",
    );
    await first.runner.emit({ type: "agent_settled" });
    expect(store.state.activity?.status).toBe("interrupted");
    expect(store.state.plan?.items[1]?.status).toBe("in_progress");

    const planCommand = first.runner.getCommand("plan");
    if (!planCommand) throw new Error("Plan command not registered");
    await planCommand.handler("", first.runner.createCommandContext());
    expect(first.widgets.get("openamp-progress")?.join("\n")).toContain(
      "[x] Inspect existing code",
    );

    const second = await boot(store, join(root, "pi-config"));
    sessions.push(second);
    await first.runner.emit({ type: "session_shutdown", reason: "resume" });
    const current = second.runner.getToolDefinition("update_plan");
    if (!current) throw new Error("Reloaded checklist tool missing");
    const writes = await Promise.allSettled([
      current.execute(
        "revision-a",
        { expected_revision: 1, items },
        undefined,
        undefined,
        second.runner.createContext(),
      ),
      current.execute(
        "revision-b",
        { expected_revision: 1, items: [] },
        undefined,
        undefined,
        second.runner.createContext(),
      ),
    ]);
    expect(
      writes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(second.widgets.get("openamp-progress")?.join("\n")).toContain("r2");

    const reloaded = new ChangeStore(store.path, await readChange(store.path));
    const third = await boot(reloaded, join(root, "pi-config"));
    sessions.push(third);
    expect(third.widgets.get("openamp-progress")?.join("\n")).toContain(
      "Plan 1/4 done · r2",
    );
    expect(reloaded.state.plan?.items).toEqual(items);
    expect(reloaded.state.phase).toBe(initialPhase);
  } finally {
    for (const active of sessions) {
      await active.supervisor.shutdown();
      active.session.dispose();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi coding and checklist tools share Oracle results without granting review approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "openamp-tools-integration-"));
  let active: Awaited<ReturnType<typeof boot>> | undefined;
  let restoreDispatch: (() => void) | undefined;
  const listeners = new Set<(event: { type: string }) => void>();
  const prompted = Promise.withResolvers<void>();
  let childCount = 0;
  let stopped = 0;
  let options: RpcClientOptions | undefined;
  try {
    const source = join(root, "source");
    await runGit(root, ["init", "-b", "main", source]);
    await writeFile(
      join(source, "greet.js"),
      'export const greet = (name) => "Hello, " + name;\n',
    );
    await runGit(source, ["add", "."]);
    await runGit(source, ["commit", "-m", "baseline"]);
    const store = await createChange(source, {
      id: "change-tools-integration",
      base: "main",
    });
    await store.update((state) => {
      state.oracleModel = "openamp-fixture/oracle";
    });
    active = await boot(store, join(root, "pi-config"), {
      clientFactory: (input) => {
        childCount += 1;
        options = input;
        return {
          async start() {},
          async getState(): Promise<RpcSessionState> {
            const model = active?.runner
              .getModelRegistry()
              .find("openamp-fixture", "oracle");
            if (!model) throw new Error("Fixture model missing");
            return {
              model,
              thinkingLevel: "high",
              sessionId: "fixture-oracle",
              sessionFile: "/fixture/oracle.jsonl",
              isStreaming: true,
              isCompacting: false,
              steeringMode: "one-at-a-time",
              followUpMode: "one-at-a-time",
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          onEvent(listener) {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          async prompt() {
            for (const listener of listeners) listener({ type: "agent_start" });
            prompted.resolve();
          },
          async waitForIdle() {
            throw new Error("Unexpected legacy wait");
          },
          async getLastAssistantText() {
            return "Trim whitespace before interpolation; keep the exported signature.";
          },
          async steer() {},
          async abort() {
            for (const listener of listeners)
              listener({ type: "agent_settled" });
          },
          async stop() {
            stopped += 1;
          },
        };
      },
    });
    active.runner.getModelRegistry().registerProvider("openamp-fixture", {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture-only",
      models: [
        {
          id: "oracle",
          name: "Controlled Oracle",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 1000,
        },
      ],
    });
    // Keep Pi's real session insertion, but stop at the next model-request boundary.
    const dispatch = active.session.sendCustomMessage.bind(active.session);
    const messageDispatch = spyOn(
      active.session,
      "sendCustomMessage",
    ).mockImplementation((message, messageOptions) =>
      dispatch(message, { ...messageOptions, triggerTurn: false }),
    );
    restoreDispatch = () => messageDispatch.mockRestore();
    const session = active.session;
    const runner = active.runner;
    const tool = (name: string) => {
      const found = session.agent.state.tools.find(
        (item) => item.name === name,
      );
      if (!found) throw new Error(`Missing native session tool: ${name}`);
      return found;
    };
    const items: [ChecklistItem, ChecklistItem] = [
      {
        id: "consult",
        text: "Check whitespace handling",
        status: "in_progress",
      },
      { id: "edit", text: "Apply the focused edit", status: "pending" },
    ];
    await tool("update_plan").execute("plan-1", {
      expected_revision: 0,
      items,
    });
    const consultation = tool("ask_oracle").execute("oracle-1", {
      question: "How should greet handle whitespace around a name?",
      context:
        "greet.js exports greet(name), currently interpolating name unchanged.",
    });
    await prompted.promise;
    const started = await consultation;
    const run = active.supervisor.list()[0];
    if (!run) throw new Error("Oracle run missing");
    expect(JSON.stringify(started)).toContain(run.id);
    expect(store.state.runs[run.id]?.status).toBe("running");
    await tool("agent_wait").execute("wait-1", { run_id: run.id, wait_ms: 1 });
    expect(childCount).toBe(1);
    expect(stopped).toBe(0);
    expect(options?.provider).toBe("openamp-fixture");
    expect(options?.model).toBe("oracle");
    expect(options?.args).toContain("read,grep,find,ls");
    expect(active.widgets.get("openamp-progress")?.join("\n")).toContain(
      "oracle",
    );
    for (const listener of listeners) listener({ type: "agent_settled" });
    const result = await active.supervisor.wait(run.id);
    const messages = runner
      .createContext()
      .sessionManager.getBranch()
      .filter(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "openamp-result",
      );
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain(result.id);
    expect(JSON.stringify(messages)).toContain("Trim whitespace");
    expect(JSON.stringify(messages)).toContain("not a publication approval");
    await active.supervisor.wait(run.id);
    expect(messageDispatch).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(1);
    expect(store.state.plan?.items[0]?.status).toBe("in_progress");
    items[0] = {
      ...items[0],
      status: "completed",
      note: `Oracle advice ${result.id}`,
    };
    items[1] = { ...items[1], status: "in_progress" };
    await tool("update_plan").execute("plan-2", {
      expected_revision: 1,
      items,
    });
    await tool("edit").execute("edit-1", {
      path: "greet.js",
      edits: [{ oldText: " + name;", newText: " + name.trim();" }],
    });
    const edited = await tool("read").execute("read-1", { path: "greet.js" });
    expect(JSON.stringify(edited)).toContain("name.trim()");
    expect(await readFile(join(source, "greet.js"), "utf8")).not.toContain(
      "trim",
    );
    expect(
      (await runGit(store.state.workspace, ["diff", "--name-only"])).stdout,
    ).toContain("greet.js");
    items[1] = {
      ...items[1],
      status: "completed",
      note: "Pi edit and read confirmed name.trim() in feature worktree",
    };
    await tool("update_plan").execute("plan-3", {
      expected_revision: 2,
      items,
    });
    const beforeTurn = await runner.emitBeforeAgentStart(
      "Continue",
      undefined,
      "Fixture prompt",
      { cwd: store.state.workspace },
    );
    expect(JSON.stringify(beforeTurn)).toContain("Oracle advice");
    expect(JSON.stringify(beforeTurn)).toContain(result.id);
    const saved = await readChange(store.path);
    expect(saved.plan?.revision).toBe(3);
    expect(saved.review).toBeNull();
    expect(saved.publication).toBeNull();
    expect(active.widgets.get("openamp-progress")?.join("\n")).toContain(
      "Plan 2/2 done",
    );
  } finally {
    for (const listener of listeners) listener({ type: "agent_settled" });
    await active?.supervisor.shutdown();
    restoreDispatch?.();
    active?.session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
