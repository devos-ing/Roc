import { expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPiBackend } from "../../src/agents/pi/backend";
import { PiClient } from "../../src/agents/pi/client";
import {
  PiGetStateDataSchema,
  PiModelSchema,
} from "../../src/agents/pi/protocol";
import { runBackendSession } from "../../src/cli/runtime";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";
import { git } from "../helpers/git";

const liveTest = process.env.ROC_LIVE_CODEX === "1" ? test : test.skip;

liveTest(
  "Pi calls Codex for Scout, Implement and independent Review",
  async () => {
    // Check credentials/default before creating tasks or spending model tokens.
    const probe = await PiClient.start({ cwd: process.cwd() });
    let model: string;
    try {
      const state = PiGetStateDataSchema.parse(
        await probe.request("get_state"),
      );
      const selected = PiModelSchema.parse(state.model);
      expect(
        selected.provider,
        "Run Roc onboard to connect and verify an openai-codex model",
      ).toBe("openai-codex");
      model = `${selected.provider}/${selected.id}`;
    } finally {
      await probe.close();
    }

    const root = await realpath(
      await mkdtemp(join(tmpdir(), "roc-live-pi-codex-")),
    );
    console.info(`Pi Codex evidence directory: ${root}`);
    await git(["init", "--initial-branch=main"], root);
    await git(["config", "user.name", "Roc Smoke Test"], root);
    await git(["config", "user.email", "roc@example.test"], root);
    await writeFile(
      join(root, "answer.ts"),
      "export const answer = () => 0;\n",
    );
    await writeFile(
      join(root, "answer.test.ts"),
      'import { expect, test } from "bun:test";\nimport { answer } from "./answer";\ntest("answer", () => expect(answer()).toBe(42));\n',
    );
    await git(["add", "."], root);
    await git(["commit", "-m", "Seed live Pi task"], root);
    const base = await git(["rev-parse", "HEAD"], root);
    const dbPath = join(root, ".agile/runtime/agile.db");
    const db = openDatabase(dbPath);
    const planning = new PlanningRepository(db);
    planning.createCycle({
      id: "live-pi-codex",
      goal: "Verify Pi Codex execution",
      nonGoals: [],
      tokenBudget: 30000,
      ticketIds: ["T1"],
    });
    planning.createTask({
      id: "T1",
      cycleId: "live-pi-codex",
      title: "Return the expected answer",
      spec: {
        problem: "answer() returns 0 instead of 42",
        desiredOutcome: "answer() returns 42 and the existing test passes",
        scope: ["answer.ts"],
        nonGoals: ["Changing tests", "Adding dependencies"],
        acceptanceCriteria: [
          "answer() returns 42",
          "answer.test.ts remains unchanged",
          "bun test passes",
        ],
        validation: ["bun test"],
        dependencies: [],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 10000,
      },
      priority: 0,
      approvalRequired: false,
      approved: true,
    });
    planning.transitionTask("T1", "ready", "T1:ready");
    const previousAcknowledgement = process.env.ROC_ALLOW_UNSANDBOXED;
    process.env.ROC_ALLOW_UNSANDBOXED = "1";
    let failure: unknown;
    let settled = false;
    let publications = 0;
    const running = runBackendSession(
      async (context) => {
        const backend = await startPiBackend(context);
        try {
          expect(backend.modelMapping?.terra).toBe(model);
          return backend;
        } catch (error) {
          await backend.close();
          throw error;
        }
      },
      { backend: "pi", dbPath, repoPath: root, baseRef: base },
      "live-pi-codex",
      {
        // Only publication is stubbed: this test never pushes or opens a GitHub PR.
        publisherFactory: () => ({
          baseBranch: "main",
          async publish() {
            publications += 1;
            return {
              number: 1,
              url: "https://example.test/pull/1",
              state: "OPEN",
            };
          },
        }),
      },
    )
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        settled = true;
      });
    try {
      const deadline = Date.now() + 10 * 60_000;
      let status: string | undefined;
      while (Date.now() < deadline) {
        if (failure !== undefined) throw failure;
        status = db
          .query<{ status: string }, []>(
            "SELECT status FROM tasks WHERE id = 'T1'",
          )
          .get()?.status;
        if (status === "done") break;
        if (
          settled ||
          ["rejected", "failed_infra", "needs_input", "needs_replan"].includes(
            status ?? "",
          )
        ) {
          throw new Error(`Pi Codex stopped at ${status}; inspect ${dbPath}`);
        }
        await Bun.sleep(250);
      }
      expect(status).toBe("done");
      process.emit("SIGINT");
      await running;
      if (failure !== undefined) throw failure;
      const attempts = db
        .query<
          {
            role: string;
            model: string;
            effort: string;
            status: string;
            thread_id: string;
          },
          []
        >(
          "SELECT role, model, effort, status, thread_id FROM attempts ORDER BY started_at",
        )
        .all();
      expect(attempts.map((attempt) => attempt.role)).toEqual([
        "scout",
        "implement",
        "review",
      ]);
      for (const attempt of attempts) {
        expect(attempt.model).toBe(model);
        expect(attempt.effort).toBe("high");
        expect(attempt.status).toBe("succeeded");
      }
      expect(new Set(attempts.map((attempt) => attempt.thread_id)).size).toBe(
        3,
      );
      const usage = db
        .query<{ tokens: number }, []>(
          "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM usage WHERE task_id = 'T1'",
        )
        .get();
      expect(usage?.tokens).toBeGreaterThan(0);
      const checkout = `${root}.agile-checkout`;
      const validation = Bun.spawn([process.execPath, "test"], {
        cwd: checkout,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await validation.exited).toBe(0);
      expect(
        await git(["diff", base, "HEAD", "--", "answer.test.ts"], checkout),
      ).toBe("");
      expect(await git(["status", "--porcelain"], checkout)).toBe("");
      expect(
        await git(["rev-list", "--count", `${base}..HEAD`], checkout),
      ).toBe("1");
      expect(
        await git(["status", "--porcelain", "--untracked-files=no"], root),
      ).toBe("");
      expect(publications).toBe(1);
      console.info(
        JSON.stringify({
          model,
          roles: attempts.map((attempt) => attempt.role),
          efforts: attempts.map((attempt) => attempt.effort),
          tokens: usage?.tokens,
          commit: await git(["rev-parse", "HEAD"], checkout),
          publication: "stubbed",
          root,
        }),
      );
    } finally {
      process.emit("SIGINT");
      await running;
      db.close();
      if (previousAcknowledgement === undefined)
        delete process.env.ROC_ALLOW_UNSANDBOXED;
      else process.env.ROC_ALLOW_UNSANDBOXED = previousAcknowledgement;
      // Retain the isolated checkout, database and logs as evidence, including failures.
    }
  },
  12 * 60_000,
);
