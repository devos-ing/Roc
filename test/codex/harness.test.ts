import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexClientApi } from "../../src/codex/client";
import { createCodexHarness } from "../../src/codex/harness";
import {
  ImplementDraftOutputJsonSchema,
  ReviewOutputJsonSchema,
  ScoutOutputJsonSchema,
  implementPrompt,
  reviewPrompt,
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
  readonly responses: { id: string | number; result: unknown }[] = [];
  readonly responseErrors: {
    id: string | number;
    code: number;
    message: string;
  }[] = [];
  private readonly threadIds: string[];
  private readonly turnIds: string[];
  private readonly threadReads: unknown[];

  constructor(
    private readonly messages: ServerMessage[],
    options: {
      threadIds?: string[];
      turnIds?: string[];
      threadReads?: unknown[];
    } = {},
  ) {
    this.threadIds = options.threadIds ?? [
      "thread-scout",
      "thread-implement",
      "thread-review-anchor",
    ];
    this.turnIds = options.turnIds ?? ["turn-scout", "turn-implement"];
    this.threadReads = options.threadReads ?? [];
  }

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
    if (method === "review/start") {
      return {
        reviewThreadId: "thread-review",
        turn: { id: "turn-review" },
      };
    }
    if (method === "thread/resume") {
      return { thread: { id: (params as { threadId: string }).threadId } };
    }
    if (method === "thread/read") {
      const response = this.threadReads.shift();
      if (!response) throw new Error("Unexpected thread/read");
      return response;
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

function makeImplementRequest(attemptId = "attempt-implement"): HarnessStepRequest {
  return {
    mode: "dispatch",
    attempt: {
      attemptId,
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
}

function backendCursor(
  threadId: string,
  turnId: string,
  nextSequence = 2,
): string {
  return JSON.stringify({
    version: 1,
    nextSequence,
    threadId,
    turnId,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
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
    async commitChanges() {
      return "b".repeat(40);
    },
    async assertCommit() {},
    async assertReviewReady() {},
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

function interruptedTurn(threadId: string, turnId: string): ServerMessage {
  return {
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "interrupted" } },
  };
}

function completedReviewItem(
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
      item: { type: "exitedReviewMode", id: itemId, review: JSON.stringify(output) },
    },
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

test("dispatches fresh Scout, Implement, and detached Review with normalized usage", async () => {
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
    const implementDraft = {
      kind: "implement" as const,
      validation: ["bun test test/codex/harness.test.ts"],
      risks: [],
      limitations: [],
    };
    client.enqueue(
      usage("thread-implement", "turn-implement"),
      usage("thread-implement", "turn-implement"),
      completedItem("thread-implement", "turn-implement", "item-implement", implementDraft),
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
    const commitSha = await git(["rev-parse", "HEAD"], workspace.path);
    const implementOutput = { ...implementDraft, commitSha };
    expect(observed(implement.events)).toEqual([
      { type: "attempt.started", threadId: "thread-implement", turnId: "turn-implement" },
      { type: "attempt.usage_delta", ...totals },
      { type: "attempt.output", output: implementOutput },
      { type: "attempt.completed" },
    ]);
    expect(implement.events.filter((event) => event.type === "attempt.usage_delta")).toHaveLength(1);
    expect(implement.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    await expect(worktrees.assertCommit(ticket.id, commitSha)).resolves.toBeUndefined();
    expect(await git([
      "rev-list",
      "--count",
      `${workspace.baseCommit}..refs/heads/${workspace.branch}`,
    ], root)).toBe("1");
    expect(implementPrompt(implementInput)).toContain("Do not run Git metadata commands");
    expect(implementPrompt(implementInput)).toContain("trusted Harness will create the commit");
    expect(implementPrompt(implementInput)).toContain(JSON.stringify(implementInput.scout, null, 2));

    const reviewOutput = {
      kind: "review" as const,
      decision: "accepted" as const,
      findings: [],
      remainingGaps: [],
    };
    client.enqueue(
      completedReviewItem("thread-review", "turn-review", "item-review", reviewOutput),
      completedTurn("thread-review", "turn-review"),
    );
    const reviewInput = {
      role: "review" as const,
      ticket: { ...ticket, status: "reviewing" as const, baseCommit: workspace.baseCommit },
      scout: scoutOutput,
      implementation: implementOutput,
    };
    const reviewRequest: HarnessStepRequest = {
      mode: "dispatch",
      attempt: {
        attemptId: "attempt-review",
        taskId: ticket.id,
        role: "review",
        retryIndex: 0,
        modelProfile: "sol",
        model: "gpt-5.6-sol",
        effort: "xhigh",
      },
      input: reviewInput,
    };
    const statusBeforeReview = await worktrees.status(ticket.id);
    const review = await collect(harness, reviewRequest);
    const statusAfterReview = await worktrees.status(ticket.id);

    expect(observed(review.events)).toEqual([
      { type: "attempt.started", threadId: "thread-review", turnId: "turn-review" },
      { type: "attempt.output", output: reviewOutput },
      { type: "attempt.completed" },
    ]);
    expect(review.events.map((event) => event.eventId)).toEqual([
      "attempt-review:turn-review:started",
      "attempt-review:item-review:output",
      "attempt-review:turn-review:completed",
    ]);
    expect(statusAfterReview).toBe(statusBeforeReview);
    expect(reviewPrompt(reviewInput)).toContain(commitSha);
    expect(reviewPrompt(reviewInput)).toContain(JSON.stringify(ReviewOutputJsonSchema));

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
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
          outputSchema: ImplementDraftOutputJsonSchema,
        },
      },
      {
        method: "thread/start",
        params: {
          model: "gpt-5.6-sol",
          cwd: workspace.path,
          approvalPolicy: "never",
          sandbox: "read-only",
          serviceName: "agile_agents",
          config: { model_reasoning_effort: "xhigh" },
        },
      },
      {
        method: "review/start",
        params: {
          threadId: "thread-review-anchor",
          target: { type: "custom", instructions: reviewPrompt(reviewInput) },
          delivery: "detached",
        },
      },
    ]);
    const reviewStart = client.requests.at(-1);
    expect(JSON.stringify(reviewStart)).not.toContain("thread-implement");
    expect(reviewStart?.params).not.toHaveProperty("history");
    expect(client.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    const requestCount = client.requests.length;
    await harness.cancel("attempt-review");
    expect(client.requests).toHaveLength(requestCount);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes invalid structured output into a durable retryable failure", async () => {
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

  const failed = await harness.step({ ...request, backendCursor: started.nextCursor });

  expect(failed).toMatchObject({
    kind: "event",
    nextCursor: expect.any(String),
    event: {
      type: "attempt.failed_infra",
      code: "invalid_structured_output",
      retryable: true,
      attemptId: "attempt-invalid-output",
      sequence: 2,
    },
  });
});

test("normalizes an attempt/input role mismatch instead of rejecting the task step", async () => {
  const client = new RecordedCodexClient([]);
  const harness = createCodexHarness({
    client,
    worktrees: memoryWorktrees(),
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const scoutRequest = makeScoutRequest("attempt-role-mismatch");

  const failed = await harness.step({
    ...scoutRequest,
    attempt: { ...scoutRequest.attempt, role: "implement" },
  });

  expect(failed).toMatchObject({
    kind: "event",
    nextCursor: expect.any(String),
    event: {
      type: "attempt.failed_infra",
      code: "codex_role_mismatch",
      retryable: true,
      attemptId: "attempt-role-mismatch",
      sequence: 1,
    },
  });
  expect(client.requests).toEqual([]);
});

test("fails Review closed when the read-only turn mutates the worktree", async () => {
  const reviewOutput = {
    kind: "review" as const,
    decision: "accepted" as const,
    findings: [],
    remainingGaps: [],
  };
  const client = new RecordedCodexClient([
    completedReviewItem("thread-review", "turn-review", "item-review", reviewOutput),
  ], {
    threadIds: ["thread-review-anchor"],
  });
  const worktrees = memoryWorktrees();
  const statuses = ["", " M src/codex/harness.ts"];
  worktrees.status = async () => statuses.shift() ?? " M src/codex/harness.ts";
  const harness = createCodexHarness({
    client,
    worktrees,
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const request: HarnessStepRequest = {
    mode: "dispatch",
    attempt: {
      attemptId: "attempt-review-mutated",
      taskId: ticket.id,
      role: "review",
      retryIndex: 0,
      modelProfile: "sol",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    },
    input: {
      role: "review",
      ticket: { ...ticket, status: "reviewing", baseCommit: "a".repeat(40) },
      scout: scoutOutput,
      implementation: {
        kind: "implement",
        commitSha: "b".repeat(40),
        validation: ["bun test"],
        risks: [],
        limitations: [],
      },
    },
  };
  const started = await harness.step(request);
  if (started.kind !== "event") throw new Error(`Unexpected ${started.kind} delivery`);

  const failed = await harness.step({ ...request, backendCursor: started.nextCursor });

  expect(failed).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.failed_infra",
      code: "review_mutated_workspace",
      retryable: true,
    },
  });
  expect(JSON.stringify(failed)).not.toContain('"type":"attempt.output"');
});

test("preserves the clean Review status baseline across start redispatch and reconciliation", async () => {
  const baseline = "";
  const reviewOutput = {
    kind: "review" as const,
    decision: "accepted" as const,
    findings: [],
    remainingGaps: [],
  };
  const worktrees = memoryWorktrees();
  worktrees.status = async () => baseline;
  const client = new RecordedCodexClient([], {
    threadIds: ["thread-review-anchor"],
  });
  const harness = createCodexHarness({
    client,
    worktrees,
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const request: HarnessStepRequest = {
    mode: "dispatch",
    attempt: {
      attemptId: "attempt-review-redispatch",
      taskId: ticket.id,
      role: "review",
      retryIndex: 0,
      modelProfile: "sol",
      model: "gpt-5.6-sol",
      effort: "xhigh",
    },
    input: {
      role: "review",
      ticket: { ...ticket, status: "reviewing", baseCommit: "a".repeat(40) },
      scout: scoutOutput,
      implementation: {
        kind: "implement",
        commitSha: "b".repeat(40),
        validation: ["bun test"],
        risks: [],
        limitations: [],
      },
    },
  };

  const first = await harness.step(request);
  const redispatched = await harness.step(request);
  if (first.kind !== "event" || redispatched.kind !== "event") {
    throw new Error("Expected Review start deliveries");
  }

  expect(JSON.parse(first.nextCursor)).toMatchObject({ reviewStatusBefore: baseline });
  expect(JSON.parse(redispatched.nextCursor)).toMatchObject({ reviewStatusBefore: baseline });

  const reconcileClient = new RecordedCodexClient([], {
    threadReads: [{
      thread: {
        id: "thread-review",
        turns: [{
          id: "turn-review",
          status: "completed",
          error: null,
          completedAt: 1_777_000_000,
          items: [{
            type: "exitedReviewMode",
            id: "item-review-recovered",
            review: JSON.stringify(reviewOutput),
          }],
        }],
      },
    }],
  });
  const reconciled = await createCodexHarness({
    client: reconcileClient,
    worktrees,
    now: () => "2026-08-26T00:00:00.000Z",
  }).step({
    ...request,
    mode: "reconcile",
    backendCursor: redispatched.nextCursor,
  });

  expect(reconciled).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.output",
      attemptId: "attempt-review-redispatch",
      output: reviewOutput,
    },
  });
});

test("fails Review dispatch and reconciliation before Codex when the commit invariant is invalid", async () => {
  for (const mode of ["dispatch", "reconcile"] as const) {
    const client = new RecordedCodexClient([]);
    const worktrees = memoryWorktrees();
    worktrees.assertReviewReady = async () => {
      throw new Error("Task worktree must be clean");
    };
    const harness = createCodexHarness({ client, worktrees });
    const request: HarnessStepRequest = {
      mode,
      attempt: {
        attemptId: `attempt-invalid-review-${mode}`,
        taskId: ticket.id,
        role: "review",
        retryIndex: 0,
        modelProfile: "sol",
        model: "gpt-5.6-sol",
        effort: "xhigh",
      },
      input: {
        role: "review",
        ticket: { ...ticket, status: "reviewing", baseCommit: "a".repeat(40) },
        scout: scoutOutput,
        implementation: {
          kind: "implement",
          commitSha: "b".repeat(40),
          validation: ["bun test"],
          risks: [],
          limitations: [],
        },
      },
      ...(mode === "reconcile"
        ? { backendCursor: backendCursor("thread-review", "turn-review") }
        : {}),
    };

    await expect(harness.step(request)).resolves.toMatchObject({
      kind: "event",
      event: {
        type: "attempt.failed_infra",
        code: "invalid_review_commit",
        retryable: false,
      },
    });
    expect(client.requests).toEqual([]);
  }
});

test("normalizes an invalid trusted Implement commit into task failure", async () => {
  const client = new RecordedCodexClient([
    completedItem("thread-scout", "turn-scout", "item-invalid-commit", {
      kind: "implement",
      validation: ["bun test"],
      risks: [],
      limitations: [],
    }),
  ]);
  const worktrees = memoryWorktrees();
  worktrees.commitChanges = async () => {
    throw new Error("Task worktree has no uncommitted changes");
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

  await expect(harness.step({ ...request, backendCursor: started.nextCursor })).resolves.toMatchObject({
    kind: "event",
    event: {
      type: "attempt.failed_infra",
      code: "invalid_implementation_commit",
      retryable: true,
      attemptId: "attempt-invalid-commit",
    },
  });
});

test("drains a policy-interrupted terminal before progressing the next fresh attempt", async () => {
  const client = new RecordedCodexClient([
    {
      method: "item/commandExecution/requestApproval",
      id: 91,
      params: {
        threadId: "thread-implement",
        turnId: "turn-implement",
        itemId: "command-1",
        startedAtMs: 1_777_000_000_000,
        environmentId: null,
      },
    },
    interruptedTurn("thread-implement", "turn-implement"),
    completedItem("thread-scout-next", "turn-scout-next", "item-scout-next", scoutOutput),
    completedTurn("thread-scout-next", "turn-scout-next"),
  ], {
    threadIds: ["thread-implement", "thread-scout-next", "thread-scout-third"],
    turnIds: ["turn-implement", "turn-scout-next", "turn-scout-third"],
  });
  const harness = createCodexHarness({
    client,
    worktrees: memoryWorktrees(),
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const request = makeImplementRequest();
  const started = await harness.step(request);
  if (started.kind !== "event") throw new Error(`Unexpected ${started.kind} delivery`);

  const delivery = await harness.step({ ...request, backendCursor: started.nextCursor });
  if (delivery.kind !== "event") throw new Error(`Unexpected ${delivery.kind} delivery`);

  expect(client.responses).toContainEqual({ id: 91, result: { decision: "decline" } });
  expect(client.requests).toContainEqual({
    method: "turn/interrupt",
    params: { threadId: "thread-implement", turnId: "turn-implement" },
  });
  expect(delivery.event).toMatchObject({
    type: "attempt.blocked_policy",
    code: "approval_required",
    attemptId: "attempt-implement",
  });
  expect(delivery.event.eventId).toBe(
    "attempt-implement:turn-implement:blocked_policy:approval_required:91",
  );
  await expect(harness.cancel("attempt-implement")).resolves.toBeUndefined();

  const nextRequest = makeScoutRequest("attempt-scout-next");
  const nextStarted = await harness.step(nextRequest);
  if (nextStarted.kind !== "event") {
    throw new Error(`Unexpected ${nextStarted.kind} delivery`);
  }
  const nextOutput = await harness.step({
    ...nextRequest,
    backendCursor: nextStarted.nextCursor,
  });
  if (nextOutput.kind !== "event") throw new Error(`Unexpected ${nextOutput.kind} delivery`);
  const nextCompleted = await harness.step({
    ...nextRequest,
    backendCursor: nextOutput.nextCursor,
  });

  expect(nextOutput.event).toMatchObject({
    type: "attempt.output",
    attemptId: "attempt-scout-next",
    output: scoutOutput,
  });
  expect(nextCompleted).toMatchObject({
    kind: "event",
    event: { type: "attempt.completed", attemptId: "attempt-scout-next" },
  });

  client.enqueue(interruptedTurn("thread-unrelated", "turn-unrelated"));
  const thirdRequest = makeScoutRequest("attempt-scout-third");
  const thirdStarted = await harness.step(thirdRequest);
  if (thirdStarted.kind !== "event") {
    throw new Error(`Unexpected ${thirdStarted.kind} delivery`);
  }
  await expect(harness.step({
    ...thirdRequest,
    backendCursor: thirdStarted.nextCursor,
  })).resolves.toMatchObject({
    kind: "event",
    event: {
      type: "attempt.failed_infra",
      code: "codex_notification_identity_mismatch",
      attemptId: "attempt-scout-third",
    },
  });
});

test("declines and drains a stale known server request without poisoning the active turn", async () => {
  const client = new RecordedCodexClient([
    {
      method: "item/commandExecution/requestApproval",
      id: "stale-approval",
      params: {
        threadId: "thread-old",
        turnId: "turn-old",
        itemId: "command-old",
        startedAtMs: 1_777_000_000_000,
        environmentId: null,
      },
    },
    completedItem("thread-scout", "turn-scout", "item-scout", scoutOutput),
  ]);
  const harness = createCodexHarness({ client, worktrees: memoryWorktrees() });
  const request = makeScoutRequest("attempt-stale-request");
  const started = await harness.step(request);
  if (started.kind !== "event") throw new Error(`Unexpected ${started.kind} delivery`);

  const output = await harness.step({ ...request, backendCursor: started.nextCursor });

  expect(client.responses).toEqual([{
    id: "stale-approval",
    result: { decision: "decline" },
  }]);
  expect(client.requests).not.toContainEqual({
    method: "turn/interrupt",
    params: { threadId: "thread-scout", turnId: "turn-scout" },
  });
  expect(output).toMatchObject({
    kind: "event",
    event: { type: "attempt.output", output: scoutOutput },
  });
});

test("uses the exact fail-closed response for every supported server request", async () => {
  const cases: {
    method: string;
    params: Record<string, unknown>;
    expected: unknown;
  }[] = [
    {
      method: "item/fileChange/requestApproval",
      params: { itemId: "file-1", startedAtMs: 1_777_000_000_000 },
      expected: { decision: "decline" },
    },
    {
      method: "item/permissions/requestApproval",
      params: {
        itemId: "permission-1",
        environmentId: null,
        startedAtMs: 1_777_000_000_000,
        cwd: "/tmp/agile-harness-T1",
        reason: null,
        permissions: {},
      },
      expected: { permissions: {}, scope: "turn" },
    },
    {
      method: "item/tool/requestUserInput",
      params: { itemId: "input-1", questions: [], autoResolutionMs: null },
      expected: { answers: {} },
    },
    {
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "recorded",
        mode: "form",
        _meta: null,
        message: "Choose",
        requestedSchema: { type: "object", properties: {} },
      },
      expected: { action: "decline", content: null, _meta: null },
    },
  ];

  for (const [index, item] of cases.entries()) {
    const id = 100 + index;
    const client = new RecordedCodexClient([{
      method: item.method,
      id,
      params: {
        threadId: "thread-implement",
        turnId: "turn-implement",
        ...item.params,
      },
    }], {
      threadIds: ["thread-implement"],
      turnIds: ["turn-implement"],
    });
    const harness = createCodexHarness({
      client,
      worktrees: memoryWorktrees(),
      now: () => "2026-08-26T00:00:00.000Z",
    });
    const request = makeImplementRequest(`attempt-policy-${index}`);
    const started = await harness.step(request);
    if (started.kind !== "event") throw new Error(`Unexpected ${started.kind} delivery`);
    const blocked = await harness.step({ ...request, backendCursor: started.nextCursor });

    expect(client.responses).toEqual([{ id, result: item.expected }]);
    expect(blocked).toMatchObject({
      kind: "event",
      event: { type: "attempt.blocked_policy", code: "approval_required" },
    });
  }
});

test("rejects an unknown server request with method-not-found and still blocks", async () => {
  const client = new RecordedCodexClient([{
    method: "plugin/unknownApproval",
    id: "unknown-1",
    params: { any: "payload" },
  }], {
    threadIds: ["thread-implement"],
    turnIds: ["turn-implement"],
  });
  const harness = createCodexHarness({
    client,
    worktrees: memoryWorktrees(),
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const request = makeImplementRequest("attempt-unknown-request");
  const started = await harness.step(request);
  if (started.kind !== "event") throw new Error(`Unexpected ${started.kind} delivery`);

  const blocked = await harness.step({ ...request, backendCursor: started.nextCursor });

  expect(client.responseErrors).toEqual([{
    id: "unknown-1",
    code: -32601,
    message: "Method not found",
  }]);
  expect(blocked).toMatchObject({
    kind: "event",
    event: { type: "attempt.blocked_policy", code: "approval_required" },
  });
  expect(client.requests.at(-1)).toEqual({
    method: "turn/interrupt",
    params: { threadId: "thread-implement", turnId: "turn-implement" },
  });
});

test("reconciles authoritative structured output and terminal completion", async () => {
  const history = {
    thread: {
      id: "thread-scout",
      turns: [{
        id: "turn-scout",
        status: "completed",
        error: null,
        completedAt: 1_777_000_000,
        items: [{
          type: "agentMessage",
          id: "item-scout-recovered",
          text: JSON.stringify(scoutOutput),
          phase: "final_answer",
        }],
      }],
    },
  };
  const client = new RecordedCodexClient([], {
    threadReads: [history],
  });
  const harness = createCodexHarness({
    client,
    worktrees: memoryWorktrees(),
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const request: HarnessStepRequest = {
    ...makeScoutRequest("attempt-reconcile"),
    mode: "reconcile",
    backendCursor: backendCursor("thread-scout", "turn-scout"),
  };

  const output = await harness.step(request);
  if (output.kind !== "event") throw new Error(`Unexpected ${output.kind} delivery`);
  const resumedClient = new RecordedCodexClient([], { threadReads: [history] });
  const resumedHarness = createCodexHarness({
    client: resumedClient,
    worktrees: memoryWorktrees(),
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const completed = await resumedHarness.step({
    ...request,
    backendCursor: output.nextCursor,
  });

  expect(output.event).toMatchObject({
    type: "attempt.output",
    eventId: "attempt-reconcile:item-scout-recovered:output",
    sequence: 2,
    output: scoutOutput,
  });
  expect(completed).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.completed",
      eventId: "attempt-reconcile:turn-scout:completed",
      sequence: 3,
    },
  });
  expect(client.requests).toEqual([
    { method: "thread/resume", params: { threadId: "thread-scout" } },
    { method: "thread/read", params: { threadId: "thread-scout", includeTurns: true } },
  ]);
  expect(resumedClient.requests).toEqual(client.requests);
});

test("reconciles an Implement draft to the stable normalized output", async () => {
  const implementDraft = {
    kind: "implement" as const,
    validation: ["bun test"],
    risks: [],
    limitations: [],
  };
  const commitSha = "c".repeat(40);
  let commitCalls = 0;
  const worktrees = memoryWorktrees();
  worktrees.commitChanges = async (taskId) => {
    expect(taskId).toBe("T1");
    commitCalls += 1;
    return commitSha;
  };
  const history = {
    thread: {
      id: "thread-implement",
      turns: [{
        id: "turn-implement",
        status: "completed",
        error: null,
        completedAt: 1_777_000_000,
        items: [{
          type: "agentMessage",
          id: "item-implement-recovered",
          text: JSON.stringify(implementDraft),
          phase: "final_answer",
        }],
      }],
    },
  };
  const request: HarnessStepRequest = {
    ...makeImplementRequest("attempt-implement-reconcile"),
    mode: "reconcile",
    backendCursor: backendCursor("thread-implement", "turn-implement"),
  };
  const client = new RecordedCodexClient([], { threadReads: [history] });
  const output = await createCodexHarness({
    client,
    worktrees,
    now: () => "2026-08-26T00:00:00.000Z",
  }).step(request);

  expect(output).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.output",
      eventId: "attempt-implement-reconcile:item-implement-recovered:output",
      output: { ...implementDraft, commitSha },
    },
  });
  expect(commitCalls).toBe(1);

  if (output.kind !== "event") throw new Error(`Unexpected ${output.kind} delivery`);
  const resumedClient = new RecordedCodexClient([], { threadReads: [history] });
  const completed = await createCodexHarness({
    client: resumedClient,
    worktrees,
    now: () => "2026-08-26T00:00:00.000Z",
  }).step({ ...request, backendCursor: output.nextCursor });

  expect(completed).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.completed",
      eventId: "attempt-implement-reconcile:turn-implement:completed",
    },
  });
  expect(commitCalls).toBe(2);
});

test("classifies reconciliation without persisted turn identity as orphaned", async () => {
  const client = new RecordedCodexClient([]);
  const harness = createCodexHarness({
    client,
    worktrees: memoryWorktrees(),
    now: () => "2026-08-26T00:00:00.000Z",
  });

  const delivery = await harness.step({
    ...makeScoutRequest("attempt-no-cursor"),
    mode: "reconcile",
  });

  expect(delivery).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.failed_infra",
      eventId: "attempt-no-cursor:reconcile:failed_infra:orphaned_turn",
      sequence: 1,
      code: "orphaned_turn",
      retryable: true,
    },
  });
  expect(client.requests).toEqual([]);
});

for (const status of ["failed", "interrupted"] as const) {
  test(`reconciles a ${status} turn as retryable infrastructure failure`, async () => {
    const client = new RecordedCodexClient([], {
      threadReads: [{
        thread: {
          id: "thread-scout",
          turns: [{
            id: "turn-scout",
            status,
            error: status === "failed" ? { message: "provider stopped" } : null,
            completedAt: 1_777_000_000,
            items: [],
          }],
        },
      }],
    });
    const harness = createCodexHarness({ client, worktrees: memoryWorktrees() });
    const delivery = await harness.step({
      ...makeScoutRequest(`attempt-${status}`),
      mode: "reconcile",
      backendCursor: backendCursor("thread-scout", "turn-scout"),
    });

    expect(delivery).toMatchObject({
      kind: "event",
      event: {
        type: "attempt.failed_infra",
        eventId: `attempt-${status}:turn-scout:failed_infra:turn_${status}`,
        code: `turn_${status}`,
        retryable: true,
      },
    });
  });
}

test("does not infer Implement success from a commit without structured history", async () => {
  let commitAttempts = 0;
  const worktrees = memoryWorktrees();
  worktrees.commitChanges = async () => {
    commitAttempts += 1;
    return "b".repeat(40);
  };
  const client = new RecordedCodexClient([], {
    threadReads: [{
      thread: {
        id: "thread-implement",
        turns: [{
          id: "turn-implement",
          status: "completed",
          error: null,
          completedAt: 1_777_000_000,
          items: [{ type: "commandExecution", id: "commit-command" }],
        }],
      },
    }],
  });
  const harness = createCodexHarness({ client, worktrees });
  const delivery = await harness.step({
    ...makeImplementRequest("attempt-orphaned"),
    mode: "reconcile",
    backendCursor: backendCursor("thread-implement", "turn-implement"),
  });

  expect(delivery).toMatchObject({
    kind: "event",
    event: {
      type: "attempt.failed_infra",
      eventId: "attempt-orphaned:turn-implement:failed_infra:orphaned_turn",
      code: "orphaned_turn",
      retryable: true,
    },
  });
  expect(commitAttempts).toBe(0);
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
