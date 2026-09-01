import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZcodeBackendFactory } from "../../../src/agents/zcode/backend";
import type { ZcodeClientApi } from "../../../src/agents/zcode/client";
import { runBackendSession } from "../../../src/cli/runtime";
import { openDatabase } from "../../../src/store/database";
import { PlanningRepository } from "../../../src/store/planning-repository";
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

/** Waits until the seeded task finishes, surfacing any session failure. */
async function waitForTaskDone(
  dbPath: string,
  taskId: string,
  failure: () => unknown,
): Promise<void> {
  const db = openDatabase(dbPath);
  try {
    const deadline = Date.now() + 30_000;
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

test("vertical: the zcode factory routes every role through the shared runtime and reaches done with monotonic deliveries", async () => {
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
        acceptanceCriteria: [
          "task reaches done through runBackendSession",
          "deliveries publish strictly increasing sequences",
        ],
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
    // Non-zero usage on every role turn makes each completion emit a
    // usage_delta delivery immediately followed by an output delivery —
    // the pair that previously published duplicate sequence numbers.
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
  let publicationCount = 0;
  try {
    const running = runBackendSession(
      buildZcodeBackendFactory(async () => client),
      { backend: "zcode", dbPath, repoPath: projectRoot, baseRef: "HEAD" },
      "run-zcode-vertical",
      {
        publisherFactory: () => ({
          baseBranch: "main",
          async publish() {
            publicationCount += 1;
            return {
              number: publicationCount,
              url: `https://example.test/pull/${publicationCount}`,
              state: "OPEN",
            };
          },
        }),
      },
    ).catch((error: unknown) => {
      failure = error;
    });

    await waitForTaskDone(dbPath, "T1", () => failure);
    process.emit("SIGTERM");
    await running;

    expect(failure).toBeUndefined();
    expect(publicationCount).toBe(1);
    // One session per role: scout, implement, review, each carrying the
    // routed provider/model pair resolved at startup.
    expect(client.createParams.length).toBe(3);
    for (const params of client.createParams) {
      expect(params).toMatchObject({
        mode: "yolo",
        model: { providerId: "bigmodel", modelId: "GLM-5.3" },
      });
    }

    const db = openDatabase(dbPath);
    try {
      const sequences = db
        .query("SELECT seq FROM events ORDER BY seq")
        .all() as {
        seq: number;
      }[];
      expect(sequences.length).toBeGreaterThan(0);
      for (let index = 1; index < sequences.length; index += 1) {
        expect(sequences[index]!.seq).toBeGreaterThan(
          sequences[index - 1]!.seq,
        );
      }

      const usageDeltas = db
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE type = 'attempt.usage_delta'",
        )
        .get() as { n: number };
      expect(usageDeltas.n).toBe(3);

      const task = db
        .query<{ status: string }, [string]>(
          "SELECT status FROM tasks WHERE id = ?",
        )
        .get("T1");
      expect(task?.status).toBe("done");
    } finally {
      db.close();
    }
  } finally {
    if (previous === undefined) delete process.env.ROC_ZCODE_EXPERIMENTAL;
    else process.env.ROC_ZCODE_EXPERIMENTAL = previous;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(`${projectRoot}.agile-checkout`, { recursive: true, force: true });
  }
});
