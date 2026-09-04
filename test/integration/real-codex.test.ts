import { expect, test } from "bun:test";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCodexBackend } from "../../src/agents/codex/backend";
import type { BackendRuntime } from "../../src/agents/types";
import { runCli } from "../../src/cli/run";
import { defaultRuntime, runBackendSession } from "../../src/cli/runtime";
import { openDatabase } from "../../src/store/database";
import {
  OrchestrationRepository,
  type TaskPublicationRecord,
} from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";
import { git } from "../helpers/git";

const sentinel = "AGILE_SECRET_SENTINEL_DO_NOT_LOG";
const realTest = process.env.AGILE_REAL_CODEX === "1" ? test : test.skip;

/** Observes durable role progress and reports startup failures without masking them. */
async function waitForDone(
  repoRoot: string,
  baseCommit: string,
  databasePath: string,
  runtimeResult: () => { code: number } | undefined,
  errors: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 9 * 60_000;
  let lastState = "task missing";
  while (Date.now() < deadline) {
    const db = openDatabase(databasePath);
    try {
      const status = db
        .query<{ status: string }, []>(
          "SELECT status FROM tasks WHERE id = 'T1'",
        )
        .get()?.status;
      if (status === "done") return;
      const attempts = db
        .query<{ role: string; status: string }, []>(
          "SELECT role, status FROM attempts WHERE task_id = 'T1' ORDER BY started_at, id",
        )
        .all();
      const currentState = JSON.stringify({ status, attempts });
      if (currentState !== lastState)
        console.info(`Real Codex: ${currentState}`);
      lastState = currentState;
      if (status === "needs_replan" || status === "rejected") {
        throw new Error(`Real Codex task stopped (${lastState})`);
      }
    } finally {
      db.close();
    }
    const result = runtimeResult();
    if (result !== undefined) {
      const checkoutPath = `${repoRoot}.agile-checkout`;
      const checkoutExists = await access(checkoutPath).then(
        () => true,
        () => false,
      );
      if (!checkoutExists) {
        throw new Error(
          `Real Codex runtime exited ${result.code} before checkout creation (${lastState}): ${errors.join(" | ")}`,
        );
      }
      const branchHead = await git(
        ["rev-parse", "--verify", "agile/T1"],
        checkoutPath,
        true,
      );
      const commitCount = await git(
        ["rev-list", "--count", `${baseCommit}..agile/T1`],
        checkoutPath,
        true,
      );
      const checkoutStatus = await git(
        ["status", "--porcelain"],
        checkoutPath,
        true,
      );
      throw new Error(
        `Real Codex runtime exited ${result.code} before T1 reached done (${lastState}; ` +
          `branchHead=${branchHead || "none"}; commitCount=${commitCount || "none"}; ` +
          `checkoutClean=${checkoutStatus === ""}): ${errors.join(" | ")}`,
      );
    }
    await Bun.sleep(500);
  }
  throw new Error(
    `Timed out waiting for T1 to reach done (${lastState}): ${errors.join(" | ")}`,
  );
}

/** Stops the test session and cancels its diagnostic deadline once it settles. */
async function stopRuntime(running: Promise<number>): Promise<number> {
  process.emit("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out stopping the real Codex runtime")),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

realTest(
  "completes one ticket through Scout, Implement, and detached Review",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "agile-real-codex-")),
    );
    const databasePath = join(root, ".agile", "runtime", "agile.db");
    const logFile = join(root, ".agile", "runtime", "agile.log");
    const checkoutPath = `${root}.agile-checkout`;
    const priorSecret = process.env.AGILE_TEST_SECRET;
    let running: Promise<number> | undefined;
    let runtimeSettled: { code: number } | undefined;
    const errors: string[] = [];
    let baseCommit = "";
    let backend: BackendRuntime | undefined;
    let completed = false;
    let closed = false;
    try {
      await git(["init", "--initial-branch=main"], root);
      await git(["config", "user.name", "Agile Real Codex Test"], root);
      await git(["config", "user.email", "agile-real@example.test"], root);
      await writeFile(
        join(root, "answer.ts"),
        "export function answer(): number { return 0; }\n",
      );
      await writeFile(
        join(root, "answer.test.ts"),
        [
          'import { expect, test } from "bun:test";',
          'import { answer } from "./answer";',
          'test("returns the accepted answer", () => expect(answer()).toBe(42));',
          "",
        ].join("\n"),
      );
      await writeFile(
        join(root, "package.json"),
        `${JSON.stringify(
          {
            name: "agile-real-codex-smoke",
            private: true,
            type: "module",
            scripts: { test: "bun test" },
          },
          null,
          2,
        )}\n`,
      );
      await git(["add", "answer.ts", "answer.test.ts", "package.json"], root);
      await git(["commit", "-m", "test: seed failing answer"], root);
      baseCommit = await git(["rev-parse", "HEAD"], root);

      const db = openDatabase(databasePath);
      try {
        const planning = new PlanningRepository(db);
        planning.createCycle({
          id: "2026-W35",
          goal: "Prove the real Codex vertical integration",
          nonGoals: [],
          tokenBudget: 100_000,
          ticketIds: ["T1"],
        });
        planning.createTask({
          id: "T1",
          cycleId: "2026-W35",
          title: "Return the accepted answer",
          spec: {
            problem:
              "answer.ts currently returns 0 while its committed Bun test expects 42",
            desiredOutcome:
              "Change the return literal in answer.ts from 0 to 42 and pass the committed test; the trusted Harness records the implementation as exactly one task commit",
            scope: ["answer.ts"],
            nonGoals: [
              "change the test",
              "add dependencies",
              "change orchestration files",
            ],
            acceptanceCriteria: [
              "answer() returns the number 42",
              "bun test passes",
              "the completed system outcome contains exactly one trusted implementation commit",
            ],
            validation: ["bun test"],
            dependencies: [],
            risk: "high",
            contextCandidates: [],
            tokenCeiling: 30_000,
          },
          priority: 0,
          approvalRequired: false,
          approved: true,
        });
        planning.transitionTask("T1", "ready", "T1:ready");
      } finally {
        db.close();
      }

      process.env.AGILE_TEST_SECRET = sentinel;
      running = runCli(
        [
          "scheduler",
          "run",
          "--backend",
          "codex",
          "--base",
          baseCommit,
          "--base-branch",
          "main",
        ],
        { out: () => {}, err: (text) => errors.push(text) },
        {
          ...defaultRuntime,
          projectRoot: root,
          /** Runs the real backend and session while replacing only GitHub publication. */
          async runScheduler(input) {
            if (input.backend !== "codex")
              throw new Error("Expected Codex backend");
            await runBackendSession(
              async (context) => {
                backend = await startCodexBackend(context);
                return backend;
              },
              input,
              crypto.randomUUID(),
              {
                publisherFactory: (branches) => ({
                  baseBranch: "main",
                  /** Validates the real task commit and returns an isolated publication receipt. */
                  async publish({ task, implementation }) {
                    await branches.assertReviewReady(
                      task.id,
                      implementation.commitSha,
                      task.baseCommit,
                    );
                    return {
                      number: 1,
                      url: "https://example.test/pull/1",
                      state: "OPEN",
                    };
                  },
                }),
              },
            );
          },
        },
      );
      void running.then((code) => {
        runtimeSettled = { code };
      });
      await waitForDone(
        root,
        baseCommit,
        databasePath,
        () => runtimeSettled,
        errors,
      );
      expect(await stopRuntime(running)).toBe(0);
      running = undefined;

      const inspectedDb = openDatabase(databasePath);
      let snapshot: ReturnType<OrchestrationRepository["inspect"]>;
      let acceptedReviews = 0;
      let publication: TaskPublicationRecord | undefined;
      try {
        const repo = new OrchestrationRepository(inspectedDb);
        snapshot = repo.inspect();
        publication = repo.getTaskPublication("T1");
        acceptedReviews =
          inspectedDb
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM reviews WHERE task_id = 'T1' AND decision = 'accepted'",
            )
            .get()?.count ?? 0;
      } finally {
        inspectedDb.close();
      }
      const task = snapshot.tasks.find((candidate) => candidate.id === "T1");
      expect(task?.status).toBe("done");
      expect(
        task?.attempts.map((attempt) => [attempt.role, attempt.status]),
      ).toEqual([
        ["scout", "succeeded"],
        ["implement", "succeeded"],
        ["review", "succeeded"],
      ]);
      expect(task?.attempts.map((attempt) => attempt.modelProfile)).toEqual([
        "luna",
        "terra",
        "sol",
      ]);
      expect(
        task?.attempts.every(
          (attempt) => attempt.effort === "high" || attempt.effort === "xhigh",
        ),
      ).toBeTrue();
      expect(
        new Set(task?.attempts.map((attempt) => attempt.threadId)).size,
      ).toBe(3);
      expect(
        task?.attempts.every(
          (attempt) => Boolean(attempt.threadId) && Boolean(attempt.turnId),
        ),
      ).toBeTrue();
      expect(acceptedReviews).toBe(1);
      expect(
        (task?.actual.inputTokens ?? 0) + (task?.actual.outputTokens ?? 0),
      ).toBeGreaterThan(0);

      const catalog = backend?.catalog.map((model) => model.id) ?? [];
      expect(
        task?.attempts.every((attempt) => catalog.includes(attempt.model)),
      ).toBeTrue();

      const implement = task?.attempts.find(
        (attempt) => attempt.role === "implement",
      );
      if (implement?.gitCommit === undefined)
        throw new Error("Implement did not record a Git commit");
      expect(implement.gitCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(publication).toMatchObject({
        taskId: "T1",
        branch: "agile/T1",
        baseBranch: "main",
        commitSha: implement.gitCommit,
        status: "published",
        pullRequestNumber: 1,
        pullRequestUrl: "https://example.test/pull/1",
        pullRequestState: "OPEN",
      });
      expect(
        await git(
          ["rev-list", "--count", `${baseCommit}..agile/T1`],
          checkoutPath,
        ),
      ).toBe("1");
      expect(await git(["rev-parse", "agile/T1"], checkoutPath)).toBe(
        implement.gitCommit,
      );
      expect(await git(["status", "--porcelain"], checkoutPath)).toBe("");
      expect(await readFile(join(checkoutPath, "answer.ts"), "utf8")).toContain(
        "return 42",
      );
      const validation = Bun.spawn([process.execPath, "test"], {
        cwd: checkoutPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [validationCode, validationOut, validationErr] = await Promise.all([
        validation.exited,
        new Response(validation.stdout).text(),
        new Response(validation.stderr).text(),
      ]);
      expect(validationCode, validationOut + validationErr).toBe(0);
      expect(await git(["rev-parse", "HEAD"], root)).toBe(baseCommit);
      expect(await readFile(join(root, "answer.ts"), "utf8")).toContain(
        "return 0",
      );
      expect(await git(["remote"], root)).toBe("");

      const log = await readFile(logFile, "utf8");
      const lifecycle = log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { code: string; runId?: string })
        .filter(
          (record) =>
            record.code === "SCHEDULER_RUN_STARTED" ||
            record.code === "SCHEDULER_RUN_STOPPED",
        );
      expect(lifecycle.map((record) => record.code)).toEqual([
        "SCHEDULER_RUN_STARTED",
        "SCHEDULER_RUN_STOPPED",
      ]);
      expect(lifecycle[0]?.runId).toBeTruthy();
      expect(lifecycle[1]?.runId).toBe(lifecycle[0]?.runId);
      expect(log).not.toContain(sentinel);
      console.info(
        `Real Codex accepted: ${JSON.stringify({
          roles: task?.attempts.map(({ role, model, effort }) => ({
            role,
            model,
            effort,
          })),
          usage: task?.actual,
          commit: implement.gitCommit,
        })}`,
      );
      completed = true;
    } finally {
      if (priorSecret === undefined) delete process.env.AGILE_TEST_SECRET;
      else process.env.AGILE_TEST_SECRET = priorSecret;
      if (running !== undefined) {
        await stopRuntime(running).catch(() => undefined);
      }
      try {
        await backend?.close();
        closed = true;
      } catch {
        console.warn("Real Codex backend exit remains unconfirmed");
      }
      if (completed && closed) {
        await rm(checkoutPath, { recursive: true, force: true });
        await rm(`${root}.agile-checkout.lock`, { force: true });
        await rm(root, { recursive: true, force: true });
      } else {
        console.warn(`Real Codex test artifacts retained at ${root}`);
      }
    }
    expect(closed, "Real Codex backend cleanup failed").toBe(true);
  },
  600_000,
);
