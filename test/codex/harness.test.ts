import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexClientApi } from "../../src/codex/client";
import { createCodexHarness } from "../../src/codex/harness";
import {
  ImplementOutputJsonSchema,
  ScoutOutputJsonSchema,
  implementPrompt,
  scoutPrompt,
} from "../../src/codex/prompts";
import type {
  AgentHarness,
  HarnessEvent,
  HarnessStepRequest,
} from "../../src/harness/contracts";
import {
  createTaskWorktreeManager,
  type TaskWorktreeManager,
} from "../../src/workspace/task-worktree";

type ServerMessage = Awaited<ReturnType<CodexClientApi["nextServerMessage"]>>;

async function git(args: string[], cwd: string): Promise<string> {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function createRepository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agile-codex-harness-")));
  await git(["init"], root);
  await git(["config", "user.name", "Agile Tests"], root);
  await git(["config", "user.email", "agile@example.test"], root);
  await writeFile(join(root, "README.md"), "seed\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: seed"], root);
  return root;
}

class RecordedCodexClient implements CodexClientApi {
  readonly requests: { method: string; params: unknown }[] = [];
  private readonly threadIds = ["thread-scout", "thread-implement"];
  private readonly turnIds = ["turn-scout", "turn-implement"];

  constructor(private readonly messages: ServerMessage[]) {}

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      const id = this.threadIds.shift();
      if (!id) throw new Error("Unexpected thread/start");
      return { thread: { id } };
    }
    if (method === "turn/start") {
      const id = this.turnIds.shift();
      if (!id) throw new Error("Unexpected turn/start");
      return { turn: { id } };
    }
    if (method === "turn/interrupt") return {};
    throw new Error(`Unexpected request: ${method}`);
  }

  notify(): void {}
  respond(): void {}
  respondError(): void {}

  async nextServerMessage(): Promise<ServerMessage> {
    const message = this.messages.shift();
    if (!message) throw new Error("Recorded Codex messages exhausted");
    return message;
  }

  enqueue(...messages: ServerMessage[]): void {
    this.messages.push(...messages);
  }

  async close(): Promise<void> {}
}

const ticket = {
  id: "T1",
  weekId: "2026-W35",
  title: "Add a real Codex harness",
  spec: {
    problem: "The scheduler only has a fake provider",
    desiredOutcome: "Scout and Implement run through Codex",
    scope: ["src/codex"],
    nonGoals: ["Review"],
    acceptanceCriteria: ["Structured outputs are validated"],
    validation: ["bun test test/codex/harness.test.ts"],
    dependencies: [],
    risk: "medium" as const,
    contextCandidates: [],
    tokenCeiling: 10_000,
  },
  priority: 0,
  approvalRequired: false,
  approved: true,
  status: "scouting" as const,
};

const scoutOutput = {
  kind: "scout" as const,
  summary: "The provider seam is AgentHarness",
  files: ["src/codex/harness.ts"],
  tests: ["test/codex/harness.test.ts"],
  risks: ["Cumulative usage can be replayed"],
};

const totals = {
  inputTokens: 10,
  cachedInputTokens: 2,
  outputTokens: 4,
  reasoningOutputTokens: 1,
};

function makeScoutRequest(attemptId = "attempt-scout"): HarnessStepRequest {
  return {
    mode: "dispatch",
    attempt: {
      attemptId,
      taskId: ticket.id,
      role: "scout",
      retryIndex: 0,
      modelProfile: "luna",
      model: "gpt-5.6-luna",
      effort: "high",
    },
    input: { role: "scout", ticket },
  };
}

function memoryWorktrees(): TaskWorktreeManager {
  return {
    async prepare(taskId) {
      return {
        taskId,
        path: `/tmp/agile-harness-${taskId}`,
        branch: `agile/${taskId}`,
        baseCommit: "a".repeat(40),
      };
    },
    async assertCommit() {},
    async status() {
      return "";
    },
  };
}

function usage(threadId: string, turnId: string): ServerMessage {
  return {
    method: "thread/tokenUsage/updated",
    params: { threadId, turnId, tokenUsage: { total: totals } },
  };
}

function completedItem(
  threadId: string,
  turnId: string,
  itemId: string,
  output: unknown,
): ServerMessage {
  return {
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { type: "agentMessage", id: itemId, text: JSON.stringify(output) },
    },
  };
}

function completedTurn(threadId: string, turnId: string): ServerMessage {
  return {
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed" } },
  };
}

async function collect(
  harness: AgentHarness,
  request: HarnessStepRequest,
): Promise<{ events: HarnessEvent[]; cursors: string[] }> {
  const events: HarnessEvent[] = [];
  const cursors: string[] = [];
  let backendCursor: string | undefined;
  while (events.at(-1)?.type !== "attempt.completed") {
    const delivery = await harness.step({ ...request, backendCursor });
    if (delivery.kind !== "event") throw new Error(`Unexpected ${delivery.kind} delivery`);
    events.push(delivery.event);
    cursors.push(delivery.nextCursor);
    backendCursor = delivery.nextCursor;
  }
  return { events, cursors };
}

function observed(events: HarnessEvent[]): unknown[] {
  return events.map((event) => {
    switch (event.type) {
      case "attempt.started":
        return {
          type: event.type,
          threadId: event.threadId,
          turnId: event.turnId,
        };
      case "attempt.usage_delta":
        return {
          type: event.type,
          inputTokens: event.inputTokens,
          cachedInputTokens: event.cachedInputTokens,
          outputTokens: event.outputTokens,
          reasoningOutputTokens: event.reasoningOutputTokens,
        };
      case "attempt.output":
        return { type: event.type, output: event.output };
      default:
        return { type: event.type };
    }
  });
}

test("dispatches fresh Scout and Implement turns with normalized cumulative usage", async () => {
  const root = await createRepository();
  try {
    const worktrees = await createTaskWorktreeManager(root, "HEAD");
    const workspace = await worktrees.prepare(ticket.id);
    const client = new RecordedCodexClient([
      usage("thread-scout", "turn-scout"),
      completedItem("thread-scout", "turn-scout", "item-scout", scoutOutput),
      completedTurn("thread-scout", "turn-scout"),
    ]);
    const harness = createCodexHarness({
      client,
      worktrees,
      now: () => "2026-08-26T00:00:00.000Z",
    });
    const scoutInput = { role: "scout" as const, ticket };
    const scoutRequest = { ...makeScoutRequest(), input: scoutInput };

    const scout = await collect(harness, scoutRequest);
    expect(observed(scout.events)).toEqual([
      { type: "attempt.started", threadId: "thread-scout", turnId: "turn-scout" },
      { type: "attempt.usage_delta", ...totals },
      { type: "attempt.output", output: scoutOutput },
      { type: "attempt.completed" },
    ]);
    expect(scout.events[0]).toMatchObject({ baseCommit: workspace.baseCommit, sequence: 1 });
    expect(scout.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(scout.events.map((event) => event.eventId)).toEqual([
      "attempt-scout:turn-scout:started",
      expect.stringMatching(/^attempt-scout:turn-scout:usage:[0-9a-f]{64}$/),
      "attempt-scout:item-scout:output",
      "attempt-scout:turn-scout:completed",
    ]);
    expect(JSON.parse(scout.cursors.at(-1)!)).toEqual({
      version: 1,
      nextSequence: 5,
      threadId: "thread-scout",
      turnId: "turn-scout",
      usage: totals,
    });
    expect(scoutPrompt(scoutInput)).toContain("Do not create, edit, rename, or delete files");
    expect(scoutPrompt(scoutInput)).toContain(JSON.stringify(ticket, null, 2));

    await writeFile(join(workspace.path, "implementation.txt"), "implemented\n");
    await git(["add", "implementation.txt"], workspace.path);
    await git(["commit", "-m", "feat: implement ticket"], workspace.path);
    const commitSha = await git(["rev-parse", "HEAD"], workspace.path);
    const implementOutput = {
      kind: "implement" as const,
      commitSha,
      validation: ["bun test test/codex/harness.test.ts"],
      risks: [],
      limitations: [],
    };
    client.enqueue(
      usage("thread-implement", "turn-implement"),
      usage("thread-implement", "turn-implement"),
      completedItem("thread-implement", "turn-implement", "item-implement", implementOutput),
      completedTurn("thread-implement", "turn-implement"),
    );
    const implementInput = {
      role: "implement" as const,
      ticket: { ...ticket, status: "implementing" as const },
      scout: scoutOutput,
    };
    const implementRequest: HarnessStepRequest = {
      mode: "dispatch",
      attempt: {
        attemptId: "attempt-implement",
        taskId: ticket.id,
        role: "implement",
        retryIndex: 0,
        modelProfile: "terra",
        model: "gpt-5.6-terra",
        effort: "xhigh",
      },
      input: implementInput,
    };

    const implement = await collect(harness, implementRequest);
    expect(observed(implement.events)).toEqual([
      { type: "attempt.started", threadId: "thread-implement", turnId: "turn-implement" },
      { type: "attempt.usage_delta", ...totals },
      { type: "attempt.output", output: implementOutput },
      { type: "attempt.completed" },
    ]);
    expect(implement.events.filter((event) => event.type === "attempt.usage_delta")).toHaveLength(1);
    expect(implement.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    await expect(worktrees.assertCommit(ticket.id, commitSha)).resolves.toBeUndefined();
    expect(implementPrompt(implementInput)).toContain("Create exactly one Git commit");
    expect(implementPrompt(implementInput)).toContain(JSON.stringify(implementInput.scout, null, 2));

    expect(client.requests).toEqual([
      {
        method: "thread/start",
        params: {
          model: "gpt-5.6-luna",
          cwd: workspace.path,
          approvalPolicy: "never",
          sandbox: "read-only",
          serviceName: "agile_agents",
        },
      },
      {
        method: "turn/start",
        params: {
          threadId: "thread-scout",
          input: [{ type: "text", text: scoutPrompt(scoutInput) }],
          model: "gpt-5.6-luna",
          effort: "high",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          outputSchema: ScoutOutputJsonSchema,
        },
      },
      {
        method: "thread/start",
        params: {
          model: "gpt-5.6-terra",
          cwd: workspace.path,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          serviceName: "agile_agents",
        },
      },
      {
        method: "turn/start",
        params: {
          threadId: "thread-implement",
          input: [{ type: "text", text: implementPrompt(implementInput) }],
          model: "gpt-5.6-terra",
          effort: "xhigh",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [workspace.path],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          outputSchema: ImplementOutputJsonSchema,
        },
      },
    ]);
    const requestCount = client.requests.length;
    await harness.cancel("attempt-implement");
    expect(client.requests).toHaveLength(requestCount);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects output that does not exactly match the role schema", async () => {
  const client = new RecordedCodexClient([
    completedItem("thread-scout", "turn-scout", "item-invalid", {
      ...scoutOutput,
      unexpected: true,
    }),
  ]);
  const harness = createCodexHarness({
    client,
    worktrees: memoryWorktrees(),
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const request = makeScoutRequest("attempt-invalid-output");
  const started = await harness.step(request);
  if (started.kind !== "event") throw new Error(`Unexpected ${started.kind} delivery`);

  await expect(harness.step({ ...request, backendCursor: started.nextCursor })).rejects.toMatchObject({
    code: "invalid_structured_output",
    category: "protocol",
    retryable: true,
    component: "codex-harness",
    attemptId: "attempt-invalid-output",
  });
});

test("rejects an Implement output until its reported commit is verified", async () => {
  const commitSha = "b".repeat(40);
  const client = new RecordedCodexClient([
    completedItem("thread-scout", "turn-scout", "item-invalid-commit", {
      kind: "implement",
      commitSha,
      validation: ["bun test"],
      risks: [],
      limitations: [],
    }),
  ]);
  const worktrees = memoryWorktrees();
  worktrees.assertCommit = async () => {
    throw new Error("Commit is not reachable from agile/T1");
  };
  const harness = createCodexHarness({
    client,
    worktrees,
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const request: HarnessStepRequest = {
    mode: "dispatch",
    attempt: {
      attemptId: "attempt-invalid-commit",
      taskId: ticket.id,
      role: "implement",
      retryIndex: 0,
      modelProfile: "terra",
      model: "gpt-5.6-terra",
      effort: "high",
    },
    input: {
      role: "implement",
      ticket: { ...ticket, status: "implementing" },
      scout: scoutOutput,
    },
  };
  const started = await harness.step(request);
  if (started.kind !== "event") throw new Error(`Unexpected ${started.kind} delivery`);

  await expect(harness.step({ ...request, backendCursor: started.nextCursor })).rejects.toMatchObject({
    code: "invalid_implementation_commit",
    category: "protocol",
    retryable: true,
    attemptId: "attempt-invalid-commit",
  });
});

test("interrupts an active turn and only treats terminal attempts as cancellation no-ops", async () => {
  const client = new RecordedCodexClient([]);
  const harness = createCodexHarness({
    client,
    worktrees: memoryWorktrees(),
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const request = makeScoutRequest("attempt-cancel");
  await harness.step(request);

  await harness.cancel("attempt-cancel");
  expect(client.requests.at(-1)).toEqual({
    method: "turn/interrupt",
    params: { threadId: "thread-scout", turnId: "turn-scout" },
  });
  await expect(harness.cancel("attempt-unknown")).rejects.toThrow(
    "Unknown active Codex attempt: attempt-unknown",
  );
});
