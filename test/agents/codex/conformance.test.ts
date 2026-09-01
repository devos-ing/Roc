import { describe, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexClientApi } from "../../../src/agents/codex/client";
import { createCodexHarness } from "../../../src/agents/codex/harness";
import { createTaskBranchManager } from "../../../src/workspace/task-branch";
import { git } from "../../helpers/git";
import type { ConformanceRole, ScriptedUsage } from "../conformance";
import {
  type AdapterConformanceFixture,
  defineAdapterConformance,
  defineNormalizedConformance,
  type MintCursorInput,
  normalizedUsage,
  type ProtocolDriver,
  roleOutputs,
} from "../conformance";

type ServerMessage = Awaited<ReturnType<CodexClientApi["nextServerMessage"]>>;

type QueuedMessage = {
  message: ServerMessage;
  sideEffect?: () => Promise<void>;
};

class ScriptedCodexClient implements CodexClientApi {
  readonly requests: { method: string; params: unknown }[] = [];
  readonly responses: { id: string | number; result: unknown }[] = [];
  readonly responseErrors: {
    id: string | number;
    code: number;
    message: string;
  }[] = [];
  readonly roleStarts: {
    role: ConformanceRole;
    model: unknown;
    effort: unknown;
  }[] = [];
  private readonly queue: QueuedMessage[] = [];
  private readonly threadReads: unknown[] = [];
  private lastThreadRead: unknown;
  private pendingRole: ConformanceRole | undefined;
  private threadCounter = 0;
  private turnCounter = 0;

  setPendingRole(role: ConformanceRole | undefined): void {
    this.pendingRole = role;
  }

  enqueue(entry: QueuedMessage): void {
    this.queue.push(entry);
  }

  enqueueThreadRead(response: unknown): void {
    this.threadReads.push(response);
  }

  peekNextPair(): { threadId: string; turnId: string } {
    return {
      threadId: `thread-${this.threadCounter + 1}`,
      turnId: `turn-${this.turnCounter + 1}`,
    };
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      this.threadCounter += 1;
      if (this.pendingRole !== undefined) {
        const start = params as {
          model?: unknown;
          config?: { model_reasoning_effort?: unknown };
        };
        this.roleStarts.push({
          role: this.pendingRole,
          model: start.model,
          effort: start.config?.model_reasoning_effort,
        });
      }
      return { thread: { id: `thread-${this.threadCounter}` } };
    }
    if (method === "turn/start") {
      this.turnCounter += 1;
      const last = this.roleStarts.at(-1);
      if (last !== undefined && last.effort === undefined) {
        last.effort = (params as { effort?: unknown }).effort;
      }
      return { turn: { id: `turn-${this.turnCounter}` } };
    }
    if (method === "review/start") {
      this.pendingRole = undefined;
      return { reviewThreadId: "thread-review", turn: { id: "turn-review" } };
    }
    if (method === "thread/resume") return {};
    if (method === "thread/read") {
      const response = this.threadReads.shift();
      if (response !== undefined) this.lastThreadRead = response;
      if (this.lastThreadRead === undefined)
        throw new Error("Unexpected thread/read");
      return this.lastThreadRead;
    }
    if (method === "turn/interrupt") return {};
    throw new Error(`Unexpected request: ${method}`);
  }

  notify(): void {}
  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }
  respondError(id: string | number, code: number, message: string): void {
    this.responseErrors.push({ id, code, message });
  }

  async nextServerMessage(): Promise<ServerMessage> {
    const entry = this.queue.shift();
    if (!entry) throw new Error("Scripted Codex messages exhausted");
    if (entry.sideEffect !== undefined) await entry.sideEffect();
    return entry.message;
  }

  async close(): Promise<void> {}
}

class CodexProtocolDriver implements ProtocolDriver {
  constructor(
    private readonly client: ScriptedCodexClient,
    private readonly workspacePath: string,
  ) {}

  peekNextRef(role: ConformanceRole): string {
    if (role === "review") return "thread-review:turn-review";
    const pair = this.client.peekNextPair();
    return `${pair.threadId}:${pair.turnId}`;
  }

  scriptSuccessfulTurn(
    role: ConformanceRole,
    options?: {
      usage?: ScriptedUsage;
      mutateWorkspace?: boolean;
      invalidOutput?: boolean;
    },
  ): string {
    const mutation = async () => {
      await writeFile(
        join(this.workspacePath, `conformance-mutation-${role}.txt`),
        "mutated during the turn\n",
      );
    };
    this.client.setPendingRole(role);
    if (role === "review") {
      this.client.enqueue({
        message: {
          method: "item/completed",
          params: {
            threadId: "thread-review",
            turnId: "turn-review",
            item: {
              type: "exitedReviewMode",
              id: "item-review",
              review: JSON.stringify(roleOutputs.review),
            },
          },
        },
        ...(options?.mutateWorkspace === true ? { sideEffect: mutation } : {}),
      });
      this.client.enqueue({
        message: {
          method: "turn/completed",
          params: {
            threadId: "thread-review",
            turn: { id: "turn-review", status: "completed" },
          },
        },
      });
      return this.peekNextRef(role);
    }
    const { threadId, turnId } = this.client.peekNextPair();
    if (options?.invalidOutput === true) {
      this.client.enqueue({
        message: {
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: {
              type: "agentMessage",
              id: `item-${role}`,
              text: JSON.stringify({ ...roleOutputs.scout, unexpected: true }),
            },
          },
        },
      });
      return this.peekNextRef(role);
    }
    this.client.enqueue({
      message: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: { total: normalizedUsage(options?.usage) },
        },
      },
      ...(options?.mutateWorkspace === true ? { sideEffect: mutation } : {}),
    });
    this.client.enqueue({
      message: {
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: `item-${role}`,
            text: JSON.stringify(roleOutputs[role]),
          },
        },
      },
    });
    this.client.enqueue({
      message: {
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turnId, status: "completed" },
        },
      },
    });
    return `${threadId}:${turnId}`;
  }

  scriptInteractionRequest(ref: string): void {
    const [threadId, turnId] = ref.split(":");
    this.client.enqueue({
      message: {
        method: "item/fileChange/requestApproval",
        id: "conformance-approval-1",
        params: {
          threadId,
          turnId,
          itemId: "file-conformance",
          startedAtMs: 1_777_000_000_000,
        },
      },
    });
  }

  scriptForeignTurnNotification(ref: string): void {
    const [threadId, turnId] = ref.split(":");
    this.client.enqueue({
      message: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            total: {
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
            },
          },
        },
      },
    });
  }

  mintCursor(input: MintCursorInput): string {
    const [threadId, turnId] = input.ref.split(":");
    if (
      input.outputDelivered === true ||
      input.recoveredCompletedTurn === true
    ) {
      // Reconciling still recovers and validates the authoritative history;
      // script a completed turn carrying the structured output for this ref.
      this.client.enqueueThreadRead({
        thread: {
          id: threadId,
          turns: [
            {
              id: turnId,
              items: [
                {
                  type: "agentMessage",
                  id: `item-${turnId}`,
                  text: JSON.stringify(roleOutputs.scout),
                },
              ],
              status: "completed" as const,
            },
          ],
        },
      });
    }
    return JSON.stringify({
      version: 1,
      nextSequence: input.nextSequence ?? 2,
      threadId,
      turnId,
      ...(input.outputDelivered === true ? { outputDelivered: true } : {}),
      usage: normalizedUsage(input.usage),
    });
  }

  roleStartRequests() {
    return this.client.roleStarts.map((entry) => ({
      role: entry.role,
      model: String(entry.model),
      effort: String(entry.effort),
    }));
  }

  interactionRejections(): number {
    return this.client.responses.length;
  }

  interruptionRequestCount(): number {
    return this.client.requests.filter(
      (request) => request.method === "turn/interrupt",
    ).length;
  }

  cursorNextSequence(cursor: string): number {
    const parsed = JSON.parse(cursor) as { nextSequence?: unknown };
    if (typeof parsed.nextSequence !== "number") {
      throw new Error(`codex cursor has no nextSequence: ${cursor}`);
    }
    return parsed.nextSequence;
  }

  cursorUsage(cursor: string) {
    const parsed = JSON.parse(cursor) as {
      usage?: ReturnType<typeof normalizedUsage>;
    };
    if (parsed.usage === undefined) {
      throw new Error(`codex cursor has no usage: ${cursor}`);
    }
    return parsed.usage;
  }
}

async function createFixture(): Promise<AdapterConformanceFixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agile-codex-conformance-")),
  );
  await git(["init"], root);
  await git(["config", "user.name", "Agile Tests"], root);
  await git(["config", "user.email", "agile@example.test"], root);
  await writeFile(join(root, "README.md"), "seed\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: seed"], root);
  const branches = await createTaskBranchManager(root, "HEAD");
  const workspace = await branches.prepare("T1");
  const client = new ScriptedCodexClient();
  const driver = new CodexProtocolDriver(client, workspace.path);
  const harness = createCodexHarness({
    client,
    branches,
    now: () => "2026-08-31T00:00:00.000Z",
  });
  return {
    harness,
    branches,
    driver,
    sourceRoot: root,
    workspace,
    async dispose() {
      await rm(`${root}.agile-checkout`, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

const cases = [
  ...defineNormalizedConformance({ createFixture }),
  ...defineAdapterConformance({ reconcileInFlight: "history", createFixture }),
];

describe("codex backend conformance", () => {
  for (const group of new Set(cases.map((entry) => entry.group))) {
    describe(group, () => {
      for (const entry of cases.filter((item) => item.group === group)) {
        test(entry.name, () => entry.run());
      }
    });
  }
});
