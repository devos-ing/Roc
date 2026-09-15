import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type {
  RpcClientOptions,
  RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { runGit } from "../../src/openamp/command.ts";
import { readChange } from "../../src/openamp/state.ts";
import { AgentSupervisor } from "../../src/openamp/supervisor.ts";
import { ChangeWorkspace, createChange } from "../../src/openamp/workspace.ts";

class ControlledOracle {
  readonly prompted = Promise.withResolvers<void>();
  readonly listeners = new Set<(event: { type: string }) => void>();
  promptCount = 0;
  stopCount = 0;
  mismatch = false;
  finishImmediately = false;
  cleanupFails = false;
  preflightRejected = false;

  constructor(readonly options: RpcClientOptions) {}
  async start() {}
  async getState(): Promise<RpcSessionState> {
    const model = getBuiltinModel("openai-codex", "gpt-5.3-codex-spark");
    if (!model) throw new Error("Fixture model metadata missing");
    return {
      model: {
        ...model,
        provider: this.options.provider ?? model.provider,
        id: this.options.model ?? model.id,
      },
      thinkingLevel: this.mismatch ? "medium" : "high",
      sessionId: "controlled-oracle-session",
      sessionFile: "/controlled/oracle-session.jsonl",
      isStreaming: !this.preflightRejected,
      isCompacting: false,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    };
  }
  onEvent(listener: (event: { type: string }) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  finish() {
    for (const listener of this.listeners) listener({ type: "agent_settled" });
  }
  async prompt() {
    this.promptCount += 1;
    this.prompted.resolve();
    if (this.finishImmediately) this.finish();
  }
  async waitForIdle() {
    throw new Error(
      "Oracle must observe completion before prompt rather than use an execution deadline",
    );
  }
  async getLastAssistantText() {
    return "Read the caller before changing this interface.";
  }
  async steer() {}
  async abort() {
    this.finish();
  }
  async stop() {
    this.stopCount += 1;
    if (this.cleanupFails) throw new Error("controlled cleanup failure");
  }
}

test("Oracle keeps its selected route across wait expiry and delivers once, with rejection and cancellation boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "openamp-oracle-integration-"));
  let supervisor: AgentSupervisor | undefined;
  const clients: ControlledOracle[] = [];
  try {
    const source = join(root, "source");
    await runGit(root, ["init", "-b", "main", source]);
    await writeFile(join(source, "module.txt"), "inspect this source\n");
    await runGit(source, ["add", "."]);
    await runGit(source, ["commit", "-m", "baseline"]);
    const store = await createChange(source, {
      id: "change-oracle-integration",
      base: "main",
    });
    await store.update((state) => {
      state.oracleModel = "openai-codex/gpt-6-astra";
      state.sessionId = "parent-session";
    });
    let nextMismatch = false;
    let nextFast = false;
    let nextCleanupFailure = false;
    let nextPreflightRejection = false;
    const created = Promise.withResolvers<void>();
    supervisor = new AgentSupervisor(store, new ChangeWorkspace(store), {
      maxActive: 1,
      agentDir: "/controlled/pi-config",
      clientFactory: (options) => {
        const client = new ControlledOracle(options);
        client.mismatch = nextMismatch;
        client.finishImmediately = nextFast;
        client.cleanupFails = nextCleanupFailure;
        client.preflightRejected = nextPreflightRejection;
        clients.push(client);
        created.resolve();
        return client;
      },
    });
    const delivered: string[] = [];
    supervisor.setDeliveryHandler((result) => {
      delivered.push(result.id);
    });
    const first = await supervisor.delegate({
      role: "oracle",
      prompt: "Inspect the interface",
    });
    await created.promise;
    const client = clients[0];
    if (!client) throw new Error("Oracle client not created");
    await client.prompted.promise;
    const firstWait = await supervisor.waitForStatus(first.id, 1);
    expect(firstWait.status).toBe("running");
    expect((await supervisor.waitForStatus(first.id, 1)).id).toBe(first.id);
    expect(clients).toHaveLength(1);
    expect(client.stopCount).toBe(0);
    expect(client.options.provider).toBe("openai-codex");
    expect(client.options.model).toBe("gpt-6-astra");
    expect(client.options.env?.PI_CODING_AGENT_DIR).toBe(
      "/controlled/pi-config",
    );
    const argv = client.options.args ?? [];
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("high");
    await store.update((state) => {
      state.oracleModel = "openai-codex/gpt-5.6-sol";
    });
    client.finish();
    const result = await supervisor.wait(first.id);
    expect(delivered).toEqual([result.id]);
    const persisted = await readChange(store.path);
    expect(persisted.runs[first.id]?.requestedModel).toBe(
      "openai-codex/gpt-6-astra",
    );
    expect(persisted.runs[first.id]?.model).toBe("openai-codex/gpt-6-astra");
    expect(persisted.runs[first.id]?.effort).toBe("high");
    expect(persisted.runs[first.id]?.parentSessionId).toBe("parent-session");
    expect(client.stopCount).toBe(1);

    nextMismatch = true;
    const mismatch = await supervisor.delegate({
      role: "oracle",
      prompt: "Reject a clamped effort",
    });
    await expect(supervisor.wait(mismatch.id)).rejects.toThrow(
      "no prompt was sent",
    );
    expect(clients[1]?.promptCount).toBe(0);
    expect(delivered).toHaveLength(1);

    nextMismatch = false;
    nextFast = true;
    const fast = await supervisor.delegate({
      role: "oracle",
      prompt: "Finish inside prompt",
    });
    await supervisor.wait(fast.id);
    expect(delivered).toHaveLength(2);

    nextFast = false;
    nextPreflightRejection = true;
    const rejectedPrompt = await supervisor.delegate({
      role: "oracle",
      prompt: "Rejected preflight stays idle",
    });
    await expect(supervisor.wait(rejectedPrompt.id)).rejects.toThrow(
      "did not start the prompt",
    );
    expect(store.state.runs[rejectedPrompt.id]?.status).toBe("failed");
    expect(delivered).toHaveLength(2);
    nextPreflightRejection = false;
    const cancelled = await supervisor.delegate({
      role: "oracle",
      prompt: "Cancel this advice",
    });
    await supervisor.waitForStatus(cancelled.id, 10);
    await supervisor.cancel(cancelled.id);
    await expect(supervisor.wait(cancelled.id)).rejects.toThrow();
    expect(store.state.runs[cancelled.id]?.status).toBe("cancelled");
    expect(delivered).toHaveLength(2);

    nextFast = true;
    nextCleanupFailure = true;
    const cleanup = await supervisor.delegate({
      role: "oracle",
      prompt: "Preserve ownership on cleanup failure",
    });
    await supervisor.waitForStatus(cleanup.id, 300);
    expect(store.state.runs[cleanup.id]?.status).toBe("cancelling");
    expect(delivered).toHaveLength(2);
    await expect(supervisor.shutdown()).rejects.toThrow(
      "could not confirm all child cleanup",
    );
    const retained = clients.at(-1);
    if (!retained) throw new Error("Cleanup fixture missing");
    retained.cleanupFails = false;
    await supervisor.cancel(cleanup.id);
    expect(store.state.runs[cleanup.id]?.status).toBe("cancelled");
  } finally {
    for (const client of clients) {
      client.cleanupFails = false;
      client.finish();
    }
    await supervisor?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
