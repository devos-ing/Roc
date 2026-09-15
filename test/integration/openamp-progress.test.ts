import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
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
import { AgentSupervisor } from "../../src/openamp/supervisor.ts";
import { ChangeWorkspace, createChange } from "../../src/openamp/workspace.ts";

/** Loads the real Pi extension with a captured UI boundary and an on-disk task store. */
async function boot(store: ChangeStore, agentDir: string) {
  const workspace = new ChangeWorkspace(store);
  const supervisor = new AgentSupervisor(store, workspace);
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
