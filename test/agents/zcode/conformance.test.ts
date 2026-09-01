import { describe, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZcodeClientApi } from "../../../src/agents/zcode/client";
import { createZcodeHarness } from "../../../src/agents/zcode/harness";
import { createTaskBranchManager } from "../../../src/workspace/task-branch";
import { git } from "../../helpers/git";
import type { ConformanceRole } from "../conformance";
import {
  type AdapterConformanceFixture,
  defineAdapterConformance,
  defineNormalizedConformance,
  type MintCursorInput,
  normalizedUsage,
  type ProtocolDriver,
  roleOutputs,
  type ScriptedUsage,
} from "../conformance";

type ServerMessage = Awaited<ReturnType<ZcodeClientApi["nextServerMessage"]>>;

type QueuedMessage = {
  message: ServerMessage;
  sideEffect?: () => Promise<void>;
};

class ScriptedZcodeClient implements ZcodeClientApi {
  readonly sessionModel = Object.freeze({
    providerId: "bigmodel",
    modelId: "GLM-5.3",
  });
  readonly requests: { method: string; params: unknown }[] = [];
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
  private sessionCounter = 0;
  private pendingRole: ConformanceRole | undefined;
  private mutateOnSend: string | undefined;

  constructor(private readonly messages: QueuedMessage[] = []) {}

  setPendingRole(role: ConformanceRole | undefined): void {
    this.pendingRole = role;
  }

  setMutation(path: string | undefined): void {
    this.mutateOnSend = path;
  }

  peekNextSessionId(): string {
    return `sess-${this.sessionCounter + 1}`;
  }

  enqueue(entry: QueuedMessage): void {
    this.messages.push(entry);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "session/create") {
      this.sessionCounter += 1;
      if (this.pendingRole !== undefined) {
        const create = params as {
          model?: { modelId?: unknown };
          thoughtLevel?: unknown;
        };
        this.roleStarts.push({
          role: this.pendingRole,
          model: create.model?.modelId,
          effort: create.thoughtLevel,
        });
        this.pendingRole = undefined;
      }
      return { session: { sessionId: `sess-${this.sessionCounter}` } };
    }
    if (method === "session/subscribe") return { eventSeq: 0 };
    if (method === "session/send") {
      if (this.mutateOnSend !== undefined) {
        await writeFile(
          join(this.mutateOnSend, "conformance-mutation.txt"),
          "mutated during the turn\n",
        );
        this.mutateOnSend = undefined;
      }
      return { accepted: true };
    }
    if (method === "session/stop") return { stopped: true };
    throw new Error(`Unexpected request: ${method}`);
  }

  notify(): void {}
  respond(): void {}
  respondError(id: string | number, code: number, message: string): void {
    this.responseErrors.push({ id, code, message });
  }

  async nextServerMessage(): Promise<ServerMessage> {
    const entry = this.messages.shift();
    if (!entry) throw new Error("Scripted ZCode messages exhausted");
    if (entry.sideEffect !== undefined) await entry.sideEffect();
    return entry.message;
  }

  async close(): Promise<void> {}
}

function turnCompleted(
  sessionId: string,
  role: ConformanceRole,
  options: { usage?: ScriptedUsage; invalidOutput?: boolean },
): ServerMessage {
  const output =
    options.invalidOutput === true
      ? { ...roleOutputs.scout, unexpected: true }
      : roleOutputs[role];
  return {
    method: "session/event",
    params: {
      sessionId,
      type: "turn.completed",
      payload: {
        response: JSON.stringify(output),
        usage: {
          inputTokens: options.usage?.inputTokens ?? 0,
          outputTokens: options.usage?.outputTokens ?? 0,
          reasoningTokens: options.usage?.reasoningTokens ?? 0,
          cacheReadTokens: options.usage?.cachedInputTokens ?? 0,
        },
        resultType: "success",
        toolCallCount: 0,
      },
    },
  };
}

class ZcodeProtocolDriver implements ProtocolDriver {
  constructor(
    private readonly client: ScriptedZcodeClient,
    private readonly workspacePath: string,
  ) {}

  peekNextRef(): string {
    return this.client.peekNextSessionId();
  }

  scriptSuccessfulTurn(
    role: ConformanceRole,
    options?: {
      usage?: ScriptedUsage;
      mutateWorkspace?: boolean;
      invalidOutput?: boolean;
    },
  ): string {
    const sessionId = this.client.peekNextSessionId();
    this.client.setPendingRole(role);
    // Implement turns mutate while the prompt is being sent; review turns
    // mutate between the read-only baseline snapshot and the completion pull.
    if (options?.mutateWorkspace === true && role === "implement") {
      this.client.setMutation(this.workspacePath);
    }
    const mutation =
      options?.mutateWorkspace === true && role !== "implement"
        ? async () => {
            await writeFile(
              join(this.workspacePath, `conformance-mutation-${role}.txt`),
              "mutated during the turn\n",
            );
          }
        : undefined;
    this.client.enqueue({
      message: turnCompleted(sessionId, role, {
        usage: options?.usage,
        invalidOutput: options?.invalidOutput,
      }),
      ...(mutation === undefined ? {} : { sideEffect: mutation }),
    });
    return sessionId;
  }

  scriptInteractionRequest(ref: string): void {
    this.client.enqueue({
      message: {
        id: "server-conformance-1",
        method: "interaction/requestPermission",
        params: { sessionId: ref },
      },
    });
  }

  scriptForeignTurnNotification(): void {
    this.client.enqueue({
      message: turnCompleted("sess-foreign", "scout", {
        usage: { inputTokens: 1 },
      }),
    });
  }

  mintCursor(input: MintCursorInput): string {
    return JSON.stringify({
      version: 1,
      nextSequence: input.nextSequence ?? 2,
      sessionId: input.ref,
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
    return this.client.responseErrors.length;
  }

  interruptionRequestCount(): number {
    return this.client.requests.filter(
      (request) => request.method === "session/stop",
    ).length;
  }

  cursorNextSequence(cursor: string): number {
    const parsed = JSON.parse(cursor) as { nextSequence?: unknown };
    if (typeof parsed.nextSequence !== "number") {
      throw new Error(`zcode cursor has no nextSequence: ${cursor}`);
    }
    return parsed.nextSequence;
  }

  cursorUsage(cursor: string) {
    const parsed = JSON.parse(cursor) as {
      usage?: ReturnType<typeof normalizedUsage>;
    };
    if (parsed.usage === undefined) {
      throw new Error(`zcode cursor has no usage: ${cursor}`);
    }
    return parsed.usage;
  }
}

async function createFixture(): Promise<AdapterConformanceFixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agile-zcode-conformance-")),
  );
  await git(["init"], root);
  await git(["config", "user.name", "Agile Tests"], root);
  await git(["config", "user.email", "agile@example.test"], root);
  await writeFile(join(root, "README.md"), "seed\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: seed"], root);
  const branches = await createTaskBranchManager(root, "HEAD");
  const workspace = await branches.prepare("T1");
  const client = new ScriptedZcodeClient();
  const driver = new ZcodeProtocolDriver(client, workspace.path);
  const harness = createZcodeHarness({
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
  ...defineAdapterConformance({ reconcileInFlight: "orphan", createFixture }),
];

describe("zcode backend conformance", () => {
  for (const group of new Set(cases.map((entry) => entry.group))) {
    describe(group, () => {
      for (const entry of cases.filter((item) => item.group === group)) {
        test(entry.name, () => entry.run());
      }
    });
  }
});
