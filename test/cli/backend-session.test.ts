import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendFactory, BackendRuntime } from "../../src/agents/types";
import { runBackendSession } from "../../src/cli/runtime";
import type { RealSchedulerRunInput } from "../../src/cli/types";
import type { HarnessStepRequest } from "../../src/harness/contracts";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";
import { git } from "../helpers/git";

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agile-backend-session-"));
  await git(["init"], root);
  await git(["config", "user.name", "Agile Tests"], root);
  await git(["config", "user.email", "agile@example.test"], root);
  await writeFile(join(root, "README.md"), "seed\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "chore: seed"], root);
  return realpath(root);
}

/** Seeds one approved, ready task so the daemon dispatches a real attempt. */
async function seedReadyTask(dbPath: string): Promise<void> {
  const db = openDatabase(dbPath);
  try {
    const planning = new PlanningRepository(
      db,
      () => "2026-08-29T00:00:00.000Z",
    );
    planning.createCycle({
      id: "2026-W35",
      goal: "Exercise the backend session boundary",
      nonGoals: [],
      tokenBudget: 100_000,
      ticketIds: ["T1"],
    });
    planning.createTask({
      id: "T1",
      cycleId: "2026-W35",
      title: "Backend session boundary",
      spec: {
        problem: "The daemon must drive the factory-provided harness",
        desiredOutcome: "The harness step receives the dispatched attempt",
        scope: ["cli runtime"],
        nonGoals: [],
        acceptanceCriteria: ["the harness observes the attempt"],
        validation: ["bun test"],
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
    db.close();
  }
}

/** A catalog whose single model routes every role at medium risk. */
const compatibleCatalog = [
  { id: "fake-terra", supportedReasoningEfforts: ["high", "xhigh"] },
];

/**
 * Records harness step requests and close bookkeeping without touching real
 * agents. `close` mirrors an idempotent BackendRuntime close: every caller
 * advances `closeCalls`, but the underlying cleanup runs exactly once.
 */
function fakeBackend(catalog: typeof compatibleCatalog): {
  factory: BackendFactory;
  closed: () => boolean;
  branchSeen: () => boolean;
  closeCounts: () => { closeCalls: number; cleanupCalls: number };
  stepRequests: () => HarnessStepRequest[];
} {
  let closeCalls = 0;
  let cleanupCalls = 0;
  let closePromise: Promise<void> | undefined;
  let sawBranches = false;
  const requests: HarnessStepRequest[] = [];
  const factory: BackendFactory = async ({ branches }) => {
    sawBranches = branches !== undefined;
    const runtime: BackendRuntime = {
      catalog,
      harness: {
        async step(request) {
          requests.push(request);
          return { kind: "idle" };
        },
        async cancel() {},
      },
      close: () => {
        closeCalls += 1;
        closePromise ??= Promise.resolve().then(() => {
          cleanupCalls += 1;
        });
        return closePromise;
      },
    };
    return runtime;
  };
  return {
    factory,
    closed: () => cleanupCalls > 0,
    branchSeen: () => sawBranches,
    closeCounts: () => ({ closeCalls, cleanupCalls }),
    stepRequests: () => requests,
  };
}

function sessionInput(repoPath: string, dbPath: string): RealSchedulerRunInput {
  return { backend: "codex", dbPath, repoPath, baseRef: "HEAD" };
}

/** Waits until the run log records the daemon start, so SIGTERM lands late enough. */
async function waitForRunStarted(logFile: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const logged = await readFile(logFile, "utf8");
      if (logged.includes("SCHEDULER_RUN_STARTED")) return;
    } catch {
      // The logger creates the file on the first write.
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for SCHEDULER_RUN_STARTED");
}

/** Waits until the daemon has driven the factory-provided harness once. */
async function waitForFirstStep(
  stepRequests: () => HarnessStepRequest[],
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (stepRequests().length > 0) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for the first harness step");
}

test("runBackendSession dispatches a ready task through the factory harness and closes it exactly once", async () => {
  const root = await createRepository();
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const logFile = join(root, ".agile", "runtime", "agile.log");
  await seedReadyTask(dbPath);
  const { factory, closed, branchSeen, closeCounts, stepRequests } =
    fakeBackend(compatibleCatalog);
  try {
    const running = runBackendSession(
      factory,
      sessionInput(root, dbPath),
      "run-session-startup",
    );
    await waitForRunStarted(logFile);
    await waitForFirstStep(stepRequests);
    process.emit("SIGTERM");
    await running;

    expect(branchSeen()).toBe(true);
    const [request] = stepRequests();
    expect(request).toBeDefined();
    expect(request?.attempt.taskId).toBe("T1");
    expect(request?.attempt.role).toBe("scout");
    // The advisor picked the model from the catalog the factory returned.
    expect(request?.attempt.model).toBe("fake-terra");
    // Signal shutdown and the session finally block both request a close,
    // but the idempotent handle cleans the backend up only once.
    expect(closeCounts().closeCalls).toBe(2);
    expect(closeCounts().cleanupCalls).toBe(1);
    expect(closed()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.agile-checkout`, { recursive: true, force: true });
  }
});

test("runBackendSession closes the backend when no catalog model is compatible", async () => {
  const root = await createRepository();
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const { factory, closed } = fakeBackend([]);
  try {
    await expect(
      runBackendSession(
        factory,
        sessionInput(root, dbPath),
        "run-session-catalog",
      ),
    ).rejects.toMatchObject({ code: "BACKEND_MODEL_CATALOG_INCOMPATIBLE" });
    expect(closed()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.agile-checkout`, { recursive: true, force: true });
  }
});

test("runBackendSession closes the backend when the scheduler database cannot open", async () => {
  const root = await createRepository();
  // A directory cannot back a SQLite database file.
  const dbPath = join(root, "unwritable.db");
  await mkdir(dbPath);
  const { factory, closed } = fakeBackend(compatibleCatalog);
  try {
    await expect(
      runBackendSession(
        factory,
        sessionInput(root, dbPath),
        "run-session-database",
      ),
    ).rejects.toMatchObject({ code: "SCHEDULER_DATABASE_OPEN_FAILED" });
    expect(closed()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.agile-checkout`, { recursive: true, force: true });
  }
});
