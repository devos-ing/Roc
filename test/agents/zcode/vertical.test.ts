import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendFactory } from "../../../src/agents/types";
import { startZcodeBackendWith } from "../../../src/agents/zcode/backend";
import type { ZcodeClientApi } from "../../../src/agents/zcode/client";
import { createZcodeHarness } from "../../../src/agents/zcode/harness";
import { runBackendSession } from "../../../src/cli/runtime";
import { Scheduler } from "../../../src/scheduler/scheduler";
import { openDatabase } from "../../../src/store/database";
import { OrchestrationRepository } from "../../../src/store/orchestration-repository";
import { PlanningRepository } from "../../../src/store/planning-repository";
import type { TaskBranchManager } from "../../../src/workspace/task-branch";
import { git } from "../../helpers/git";

type ServerMessage = Awaited<ReturnType<ZcodeClientApi["nextServerMessage"]>>;

class RecordedZcodeClient implements ZcodeClientApi {
  readonly sessionModel = Object.freeze({
    providerId: "bigmodel",
    modelId: "GLM-5.3",
  });
  readonly createParams: unknown[] = [];
  private readonly messages: ServerMessage[];
  private sessionCounter = 0;
  private currentSession = "";

  constructor(messages: ServerMessage[] = []) {
    this.messages = messages;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (method === "session/create") {
      this.sessionCounter += 1;
      this.currentSession = `sess-${this.sessionCounter}`;
      this.createParams.push(params);
      return { session: { sessionId: this.currentSession } };
    }
    if (method === "session/subscribe") return { eventSeq: 0 };
    if (method === "session/send") {
      // A real Implement agent edits the prepared workspace during its
      // turn; the scripted client writes one file on the second (implement)
      // session so the trusted commit finds a dirty tree.
      if (this.sessionCounter === 2) {
        const create = this.createParams[1] as {
          workspace?: { workspacePath?: string };
        };
        const workspacePath = create?.workspace?.workspacePath;
        if (workspacePath !== undefined) {
          await writeFile(
            join(workspacePath, "AGILE_IMPL.md"),
            "scripted implementation\n",
          );
        }
      }
      return { accepted: true };
    }
    if (method === "session/stop") return { stopped: true };
    throw new Error(`Unexpected request: ${method}`);
  }

  notify(): void {}
  respond(): void {}
  respondError(): void {}

  async nextServerMessage(): Promise<ServerMessage> {
    const message = this.messages.shift();
    if (!message) throw new Error("Recorded ZCode messages exhausted");
    // The harness ignores events for any session other than the active one,
    // so scripted events are retargeted to the session the client handed out.
    if (message.method === "session/event") {
      return {
        ...message,
        params: {
          ...(message.params as Record<string, unknown>),
          sessionId: this.currentSession,
        },
      } as ServerMessage;
    }
    return message;
  }

  async close(): Promise<void> {}
}

function memoryBranches(): TaskBranchManager {
  return {
    async prepare(taskId) {
      return {
        taskId,
        path: `/tmp/agile-zcode-${taskId}`,
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
      return "clean";
    },
  };
}

function turnCompleted(output: unknown): ServerMessage {
  return {
    method: "session/event",
    params: {
      sessionId: "retargeted-by-client",
      type: "turn.completed",
      payload: {
        response: JSON.stringify(output),
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          reasoningTokens: 20,
          cacheReadTokens: 400,
        },
        resultType: "success",
        toolCallCount: 0,
      },
    },
  };
}

test("vertical: scripted ZCode turns stay monotonic through Scheduler and Repository and reach done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roc-zcode-vertical-"));
  const db = openDatabase(join(dir, "agile.db"));
  try {
    const planning = new PlanningRepository(db);
    planning.createCycle({
      id: "2026-W35",
      goal: "Vertical ZCode flow",
      nonGoals: [],
      tokenBudget: 100_000,
      ticketIds: ["T1"],
    });
    planning.createTask({
      id: "T1",
      cycleId: "2026-W35",
      title: "Vertical ZCode flow",
      spec: {
        problem: "Sequence monotonicity is untested end to end",
        desiredOutcome: "The repository accepts every delivery",
        scope: ["src/agents/zcode"],
        nonGoals: [],
        acceptanceCriteria: ["Task reaches done"],
        validation: ["bun test test/agents/zcode/vertical.test.ts"],
        dependencies: [],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 10_000,
      },
      priority: 0,
      approvalRequired: false,
      approved: true,
    });
    planning.transitionTask("T1", "ready", "T1:ready");

    const repo = new OrchestrationRepository(db);
    const client = new RecordedZcodeClient([
      // Non-zero usage on every role turn makes each completion emit a
      // usage_delta delivery immediately followed by an output delivery —
      // the pair that previously published duplicate sequence numbers.
      turnCompleted({
        kind: "scout",
        summary: "The provider seam is AgentHarness",
        files: ["src/agents/zcode/harness.ts"],
        tests: ["test/agents/zcode/vertical.test.ts"],
        risks: [],
      }),
      turnCompleted({
        kind: "implement",
        validation: ["bun test"],
        risks: [],
        limitations: [],
      }),
      turnCompleted({
        kind: "review",
        decision: "accepted",
        findings: [],
        remainingGaps: [],
      }),
    ]);
    const harness = createZcodeHarness({
      client,
      branches: memoryBranches(),
    });
    const scheduler = new Scheduler(repo, harness);
    await scheduler.runUntilIdle(40);

    const sequences = db.query("SELECT seq FROM events ORDER BY seq").all() as {
      seq: number;
    }[];
    expect(sequences.length).toBeGreaterThan(0);
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]!.seq).toBeGreaterThan(sequences[index - 1]!.seq);
    }

    const usageDeltas = db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE type = 'attempt.usage_delta'",
      )
      .get() as { n: number };
    expect(usageDeltas.n).toBe(3);

    const task = planning.listTasks().find((entry) => entry.id === "T1");
    expect(task?.status).toBe("done");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Waits until the seeded task finishes, surfacing any session failure. */
async function waitForTaskDone(
  dbPath: string,
  taskId: string,
  failure: () => unknown,
): Promise<void> {
  const db = openDatabase(dbPath);
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const failed = failure();
      if (failed !== undefined) throw failed;
      const status = db
        .query<{ status: string }, [string]>(
          "SELECT status FROM tasks WHERE id = ?",
        )
        .get(taskId)?.status;
      if (status === "done") return;
      if (status === "rejected" || status?.startsWith("failed")) {
        throw new Error(`zcode vertical task reached ${status}`);
      }
      await Bun.sleep(10);
    }
    throw new Error("Timed out waiting for the zcode vertical task");
  } finally {
    db.close();
  }
}

test("vertical: the zcode factory routes every role through the shared advisor and reaches done", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-zcode-factory-"));
  await git(["init"], root);
  await git(["config", "user.name", "Agile Tests"], root);
  await git(["config", "user.email", "agile@example.test"], root);
  await writeFile(join(root, "README.md"), "seed\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: seed"], root);
  const projectRoot = await realpath(root);
  const dbPath = join(projectRoot, ".agile", "runtime", "agile.db");

  const seedDb = openDatabase(dbPath);
  try {
    const planning = new PlanningRepository(seedDb);
    planning.createCycle({
      id: "2026-W35",
      goal: "Exercise the zcode factory through the shared runtime",
      nonGoals: [],
      tokenBudget: 100_000,
      ticketIds: ["T1"],
    });
    planning.createTask({
      id: "T1",
      cycleId: "2026-W35",
      title: "Zcode factory routing",
      spec: {
        problem: "The shared advisor cannot route a bare zcode model id",
        desiredOutcome: "Every role attempt receives the routed model",
        scope: ["src/agents/zcode"],
        nonGoals: [],
        acceptanceCriteria: ["task reaches done through runBackendSession"],
        validation: ["bun test test/agents/zcode/vertical.test.ts"],
        dependencies: [],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 10_000,
      },
      priority: 0,
      approvalRequired: false,
      approved: true,
    });
    planning.transitionTask("T1", "ready", "T1:ready");
  } finally {
    seedDb.close();
  }

  const client = new RecordedZcodeClient([
    turnCompleted({
      kind: "scout",
      summary: "The factory catalog must route through the shared advisor",
      files: ["src/agents/zcode/backend.ts"],
      tests: ["test/agents/zcode/vertical.test.ts"],
      risks: [],
    }),
    turnCompleted({
      kind: "implement",
      validation: ["bun test"],
      risks: [],
      limitations: [],
    }),
    turnCompleted({
      kind: "review",
      decision: "accepted",
      findings: [],
      remainingGaps: [],
    }),
  ]);
  const previous = process.env.ROC_ZCODE_EXPERIMENTAL;
  process.env.ROC_ZCODE_EXPERIMENTAL = "1";
  let failure: unknown;
  try {
    const factory: BackendFactory = ({ branches }) =>
      startZcodeBackendWith({ branches, startClient: async () => client });
    const running = runBackendSession(
      factory,
      { backend: "zcode", dbPath, repoPath: projectRoot, baseRef: "HEAD" },
      "run-zcode-vertical",
    ).catch((error: unknown) => {
      failure = error;
    });

    await waitForTaskDone(dbPath, "T1", () => failure);
    process.emit("SIGTERM");
    await running;

    expect(failure).toBeUndefined();
    // One session per role: scout, implement, review.
    expect(client.createParams.length).toBe(3);
    for (const params of client.createParams) {
      expect(params).toMatchObject({
        mode: "yolo",
        model: { providerId: "bigmodel", modelId: "GLM-5.3" },
      });
    }
  } finally {
    if (previous === undefined) delete process.env.ROC_ZCODE_EXPERIMENTAL;
    else process.env.ROC_ZCODE_EXPERIMENTAL = previous;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(`${projectRoot}.agile-checkout`, { recursive: true, force: true });
  }
});
