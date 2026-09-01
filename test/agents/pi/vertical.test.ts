import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPiBackendFactory } from "../../../src/agents/pi/backend";
import { runBackendSession } from "../../../src/cli/runtime";
import { openDatabase } from "../../../src/store/database";
import { PlanningRepository } from "../../../src/store/planning-repository";
import { git } from "../../helpers/git";
import { messageEnd, RecordedPiClient, ScriptedProbeClient } from "./fixtures";

const probeDefaultModel = {
  id: "claude-sonnet-4-6",
  provider: "anthropic",
  name: "Claude Sonnet 4.6",
  reasoning: true,
  thinkingLevelMap: { medium: 1, high: 2, xhigh: 3 },
};

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
        throw new Error(`pi vertical task reached ${status}`);
      }
      await Bun.sleep(10);
    }
    throw new Error("Timed out waiting for the pi vertical task");
  } finally {
    db.close();
  }
}

test("vertical: the pi factory routes every role through the shared runtime and reaches done with monotonic deliveries", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-pi-factory-"));
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
      goal: "Exercise the pi factory through the shared runtime",
      nonGoals: [],
      tokenBudget: 100_000,
      ticketIds: ["T1"],
    });
    planning.createTask({
      id: "T1",
      cycleId: "2026-W35",
      title: "Pi factory routing",
      spec: {
        problem: "The shared advisor cannot drive the Pi backend end to end",
        desiredOutcome: "Every role attempt runs its own Pi child process",
        scope: ["src/agents/pi"],
        nonGoals: [],
        acceptanceCriteria: [
          "task reaches done through runBackendSession",
          "deliveries publish strictly increasing sequences",
        ],
        validation: ["bun test test/agents/pi/vertical.test.ts"],
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

  // One scripted turn per role; the scheduler drives scout, implement, and
  // the detached review in order, each in its own child process.
  const turns = [
    {
      text: JSON.stringify({
        kind: "scout",
        summary: "The factory catalog routes through the shared advisor",
        files: ["src/agents/pi/backend.ts"],
        tests: ["test/agents/pi/vertical.test.ts"],
        risks: [],
      }),
      implements: false,
    },
    {
      text: JSON.stringify({
        kind: "implement",
        validation: ["bun test"],
        risks: [],
        limitations: [],
      }),
      implements: true,
    },
    {
      text: JSON.stringify({
        kind: "review",
        decision: "accepted",
        findings: [],
        remainingGaps: [],
      }),
      implements: false,
    },
  ];
  const probe = new ScriptedProbeClient([probeDefaultModel], probeDefaultModel);
  const clients: RecordedPiClient[] = [];
  const previous = process.env.ROC_PI_EXPERIMENTAL;
  process.env.ROC_PI_EXPERIMENTAL = "1";
  let failure: unknown;
  let publicationCount = 0;
  try {
    const running = runBackendSession(
      buildPiBackendFactory({
        startProbeClient: async () => probe,
        startAttemptClient: async (cwd) => {
          const turn = turns.at(clients.length);
          if (turn === undefined) {
            throw new Error("unexpected extra Pi role attempt");
          }
          const client = new RecordedPiClient(
            [messageEnd({ text: turn.text }), { type: "agent_settled" }],
            {},
            turn.implements
              ? async () => {
                  // A real implement agent edits the prepared workspace
                  // during its turn; the scripted client writes one file so
                  // the trusted commit finds a dirty tree.
                  await writeFile(
                    join(cwd, "AGILE_IMPL.md"),
                    "scripted implementation\n",
                  );
                }
              : undefined,
          );
          clients.push(client);
          return client;
        },
      }),
      { backend: "pi", dbPath, repoPath: projectRoot, baseRef: "HEAD" },
      "run-pi-vertical",
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
    // One detached child process per role attempt, every turn re-asserting
    // the attributed default model and the routed effort before prompting.
    expect(clients).toHaveLength(3);
    for (const client of clients) {
      expect(client.requests).toContainEqual({
        command: "set_model",
        params: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      });
      expect(client.requests).toContainEqual({
        command: "set_thinking_level",
        params: { level: "high" },
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
        const previous = sequences[index - 1]?.seq;
        const current = sequences[index]?.seq;
        if (previous === undefined || current === undefined) {
          throw new Error("unreachable");
        }
        expect(current).toBeGreaterThan(previous);
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
    if (previous === undefined) delete process.env.ROC_PI_EXPERIMENTAL;
    else process.env.ROC_PI_EXPERIMENTAL = previous;
    await rm(projectRoot, { recursive: true, force: true });
    await rm(`${projectRoot}.agile-checkout`, { recursive: true, force: true });
  }
});
