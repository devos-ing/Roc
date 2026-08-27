import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import { CodexClient } from "../../src/codex/client";
import { ModelListResponseSchema } from "../../src/codex/protocol";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

const sentinel = "AGILE_SECRET_SENTINEL_DO_NOT_LOG";
const realTest = process.env.AGILE_REAL_CODEX === "1" ? test : test.skip;

async function git(
  args: string[],
  cwd: string,
  allowFailure = false,
): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

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
      lastState = JSON.stringify({ status, attempts });
    } finally {
      db.close();
    }
    const result = runtimeResult();
    if (result !== undefined) {
      const checkoutPath = `${repoRoot}.agile-checkout`;
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

async function stopRuntime(running: Promise<number>): Promise<number> {
  process.emit("SIGTERM");
  return Promise.race([
    running,
    Bun.sleep(15_000).then(() => {
      throw new Error("Timed out stopping the real Codex runtime");
    }),
  ]);
}

realTest(
  "completes one ticket through Scout, Implement, and detached Review",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agile-real-codex-"));
    const databasePath = join(root, ".agile", "runtime", "agile.db");
    const logFile = join(root, ".agile", "runtime", "agile.log");
    const checkoutPath = `${root}.agile-checkout`;
    const priorSecret = process.env.AGILE_TEST_SECRET;
    let running: Promise<number> | undefined;
    let runtimeSettled: { code: number } | undefined;
    const errors: string[] = [];
    let baseCommit = "";
    try {
      await git(["init"], root);
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
        JSON.stringify(
          {
            name: "agile-real-codex-smoke",
            private: true,
            type: "module",
            scripts: { test: "bun test" },
          },
          null,
          2,
        ) + "\n",
      );
      await git(["add", "answer.ts", "answer.test.ts", "package.json"], root);
      await git(["commit", "-m", "test: seed failing answer"], root);
      baseCommit = await git(["rev-parse", "HEAD"], root);

      const db = openDatabase(databasePath);
      try {
        const planning = new PlanningRepository(db);
        planning.createWeek({
          id: "2026-W35",
          goal: "Prove the real Codex vertical integration",
          nonGoals: [],
          tokenBudget: 100_000,
          ticketIds: ["T1"],
        });
        planning.createTask({
          id: "T1",
          weekId: "2026-W35",
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
          "--repo",
          root,
          "--base",
          baseCommit,
          "--db",
          databasePath,
        ],
        { out: () => {}, err: (text) => errors.push(text) },
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
      try {
        snapshot = new OrchestrationRepository(inspectedDb).inspect();
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

      const catalogClient = await CodexClient.start();
      try {
        const catalog = ModelListResponseSchema.parse(
          await catalogClient.request("model/list", {
            limit: 100,
            includeHidden: false,
          }),
        ).data.map((model) => model.id);
        expect(
          task?.attempts.every((attempt) => catalog.includes(attempt.model)),
        ).toBeTrue();
      } finally {
        await catalogClient.close();
      }

      const implement = task?.attempts.find(
        (attempt) => attempt.role === "implement",
      );
      if (implement?.gitCommit === undefined)
        throw new Error("Implement did not record a Git commit");
      expect(implement.gitCommit).toMatch(/^[0-9a-f]{40}$/);
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
    } finally {
      if (priorSecret === undefined) delete process.env.AGILE_TEST_SECRET;
      else process.env.AGILE_TEST_SECRET = priorSecret;
      if (running !== undefined) {
        await stopRuntime(running).catch(() => undefined);
      }
      await rm(checkoutPath, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
  600_000,
);
