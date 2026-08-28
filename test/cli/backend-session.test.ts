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

/** A catalog whose single model routes every role at medium risk. */
const compatibleCatalog = [
  { id: "fake-terra", supportedReasoningEfforts: ["high", "xhigh"] },
];

/** Records the branch manager and close calls without touching real agents. */
function fakeBackend(catalog: typeof compatibleCatalog): {
  factory: BackendFactory;
  closed: () => boolean;
  branchSeen: () => boolean;
} {
  let isClosed = false;
  let sawBranches = false;
  const factory: BackendFactory = async ({ branches }) => {
    sawBranches = branches !== undefined;
    const runtime: BackendRuntime = {
      catalog,
      harness: {
        async step() {
          throw new Error("no task is scheduled in this session");
        },
        async cancel() {},
      },
      // BackendRuntime.close is an idempotent handle: shutdown and the
      // session finally block may both reach it.
      close: async () => {
        isClosed = true;
      },
    };
    return runtime;
  };
  return { factory, closed: () => isClosed, branchSeen: () => sawBranches };
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

test("runBackendSession hands the branch manager and catalog to the run and closes the backend after shutdown", async () => {
  const root = await createRepository();
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const logFile = join(root, ".agile", "runtime", "agile.log");
  const { factory, closed, branchSeen } = fakeBackend(compatibleCatalog);
  try {
    const running = runBackendSession(
      factory,
      sessionInput(root, dbPath),
      "run-session-startup",
    );
    await waitForRunStarted(logFile);
    process.emit("SIGTERM");
    await running;

    expect(branchSeen()).toBe(true);
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
