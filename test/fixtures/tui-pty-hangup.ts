import { appendFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import { runBackendSession } from "../../src/cli/runtime";
import type { CliRuntime } from "../../src/cli/types";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { BunGitHubCommandRunner } from "../../src/github/pr-publisher";
import { createFakeHarness } from "../../src/harness/fake";
import { saveRocSettings } from "../../src/settings";
import { git } from "../helpers/git";
import { barrier, memoryPlan } from "../helpers/github-plan";

const temp = process.argv[2] ?? "";
if (temp === "") throw new Error("expected test-owned temporary root");
const uncertainCleanup = process.argv[3] === "uncertain";
const root = join(temp, "repo");
const markers = join(temp, "events.jsonl");
const lock = `${root}.agile-checkout.lock`;

/** Persists lifecycle evidence independently of the controlling terminal. */
function mark(type: string, details: Record<string, unknown> = {}): void {
  appendFileSync(markers, `${JSON.stringify({ type, ...details })}\n`);
}

/** Runs a real TUI/backend session until its controlling terminal hangs up. */
async function main(): Promise<void> {
  await git(["init", root], temp);
  await git(["config", "user.name", "Test"], root);
  await git(["config", "user.email", "test@example.test"], root);
  await writeFile(join(root, "README.md"), "fixture\n");
  await git(["add", "."], root);
  await git(["commit", "-m", "seed"], root);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"], root);
  await saveRocSettings(
    { cycle: { type: "weekly" }, execution: { allowUnsandboxed: true } },
    temp,
  );

  const remote = memoryPlan([["answer.ts"]]);
  const released = barrier();
  const real = new BunGitHubCommandRunner();
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "issue-41",
        role: "scout",
        retryIndex: 0,
        expect: { model: "luna", effort: "high" },
        deliveries: [
          {
            nextCursor: "started",
            event: {
              type: "attempt.started",
              eventId: "start",
              attemptId: "fixture",
              sequence: 1,
              occurredAt: new Date().toISOString(),
            },
          },
          {
            nextCursor: "blocked",
            event: {
              type: "attempt.blocked_policy",
              eventId: "blocked",
              attemptId: "fixture",
              sequence: 2,
              occurredAt: new Date().toISOString(),
              code: "cancelled",
              message: "Stopped",
            },
          },
        ],
      },
    ],
  });
  let starts = 0;
  let steps = 0;
  const runtime: CliRuntime = {
    projectRoot: root,
    homeRoot: temp,
    async schedulerMetadata() {
      return { repository: "acme/test", baseBranch: "main" };
    },
    async readTasks() {
      const { tasks, diagnostics } = await remote.store.list();
      return githubTaskSnapshot(tasks, diagnostics);
    },
    async runScheduler(options) {
      starts++;
      mark("start");
      options.signal?.addEventListener("abort", () => mark("abort"), {
        once: true,
      });
      try {
        await runBackendSession(
          async () => ({
            catalog: ["luna", "terra", "sol"].map((id) => ({
              id,
              supportedReasoningEfforts: ["medium", "high"],
            })),
            harness: {
              async step(request) {
                steps++;
                if (request.backendCursor !== undefined) {
                  mark("active", { lockExists: existsSync(lock) });
                  await released.promise;
                }
                return fake.harness.step(request);
              },
              async cancel(attemptId) {
                mark("cancel", { attemptId });
                released.release();
                await fake.harness.cancel(attemptId);
                if (uncertainCleanup) throw new Error("cleanup unconfirmed");
              },
            },
            async close() {
              mark("close", { lockExists: existsSync(lock) });
              released.release();
            },
          }),
          options,
          "tui-pty-hangup",
          {
            store: remote.store,
            command: {
              async run(input) {
                if (input.command[0] === "gh" || input.command[1] === "fetch")
                  return {
                    exitCode: 0,
                    stdout: '{"nameWithOwner":"acme/test"}',
                    stderr: "",
                  };
                return real.run(input);
              },
            },
            onActivity: () => {},
          },
        );
        mark("backend-return", { lockExists: existsSync(lock) });
      } catch (error) {
        mark("backend-error", {
          code:
            error instanceof Error && "code" in error ? error.code : undefined,
          lockExists: existsSync(lock),
        });
        throw error;
      }
    },
  };

  const setRawMode = process.stdin.setRawMode.bind(process.stdin);
  process.stdin.setRawMode = (mode) => {
    if (!mode) mark("restore", { lockExists: existsSync(lock) });
    return setRawMode(mode);
  };
  setTimeout(() => process.stdin.emit("data", "s"), 20);
  const code = await runCli(
    ["tui"],
    { input: process.stdin, output: process.stdout, out() {}, err() {} },
    runtime,
  );
  const execution = (await remote.store.get(41)).execution;
  mark("outcome", {
    code,
    starts,
    steps,
    phase: execution?.phase,
    running: execution?.attempts.some(
      (attempt) => attempt.status === "running",
    ),
    lockExists: existsSync(lock),
    signalListeners: process.listenerCount("SIGHUP"),
  });
  fake.assertComplete();
  process.exitCode = code;
}

await main().catch((error: unknown) => {
  mark("error", {
    message: error instanceof Error ? error.message : String(error),
    lockExists: existsSync(lock),
  });
  process.exitCode = 1;
});
