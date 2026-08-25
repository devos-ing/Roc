import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CodexClient } from "../codex/client";
import { createCodexHarness } from "../codex/harness";
import { ModelListResponseSchema } from "../codex/protocol";
import { FakeScenarioSchema, type AgentHarness } from "../harness/contracts";
import { createFakeHarness } from "../harness/fake";
import { AgileError, normalizeError } from "../runtime/errors";
import { createJsonlLogger, type Logger } from "../runtime/logger";
import { SchedulerDaemon } from "../scheduler/daemon";
import { createModelAdvisor, createStaticModelAdvisor, type CatalogModel } from "../scheduler/model-routing";
import { Scheduler } from "../scheduler/scheduler";
import { openDatabase } from "../store/database";
import { OrchestrationRepository } from "../store/orchestration-repository";
import { PlanningRepository } from "../store/planning-repository";
import { createTaskWorktreeManager } from "../workspace/task-worktree";
import { helpText } from "./help";

export type CliIo = { out(text: string): void; err(text: string): void };
export type SchedulerRunInput =
  | { backend: "fake"; dbPath: string; scenario: unknown }
  | { backend: "codex"; dbPath: string; repoPath: string; baseRef: string };
export type CliRuntime = {
  runScheduler(input: SchedulerRunInput): Promise<void>;
  logError?(error: AgileError, input: { dbPath: string; repoPath?: string }): Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCliArgs(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      db: { type: "string" },
      backend: { type: "string" },
      repo: { type: "string" },
      base: { type: "string" },
      "fake-script": { type: "string" },
    },
  });
}

export function schedulerSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function logPath(input: { dbPath: string; repoPath?: string }): string {
  return input.repoPath === undefined
    ? join(dirname(input.dbPath), "agile.log")
    : join(input.repoPath, ".agile", "runtime", "agile.log");
}

function loggerFor(input: { dbPath: string; repoPath?: string }): Logger {
  return createJsonlLogger({ path: logPath(input), err: () => {} });
}

function attachRunId(error: unknown, runId: string, fallback: {
  code: string;
  category: "startup" | "protocol" | "infra" | "policy" | "domain";
  retryable: boolean;
  component: string;
  message: string;
}): AgileError {
  const normalized = normalizeError(error, { ...fallback, runId });
  if (normalized.runId !== undefined) return normalized;
  return new AgileError({
    code: normalized.code,
    category: normalized.category,
    retryable: normalized.retryable,
    component: normalized.component,
    message: normalized.message,
    runId,
    ...(normalized.taskId === undefined ? {} : { taskId: normalized.taskId }),
    ...(normalized.attemptId === undefined ? {} : { attemptId: normalized.attemptId }),
    ...(normalized.threadId === undefined ? {} : { threadId: normalized.threadId }),
    ...(normalized.requestId === undefined ? {} : { requestId: normalized.requestId }),
    cause: error,
  });
}

async function runDaemon(input: {
  daemon: SchedulerDaemon;
  repo: OrchestrationRepository;
  harness: AgentHarness;
  logger: Logger;
  runId: string;
}): Promise<void> {
  const stop = new AbortController();
  let interrupt = Promise.resolve();
  const onSignal = () => {
    stop.abort();
    const active = input.repo.getRunningAttempt();
    if (active !== undefined) {
      interrupt = interrupt.then(() => input.harness.cancel(active.descriptor.attemptId));
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await input.logger.write({
      level: "info",
      code: "SCHEDULER_RUN_STARTED",
      category: "domain",
      component: "cli",
      retryable: false,
      message: "Scheduler run started",
      runId: input.runId,
    });
    await input.daemon.run(() => stop.signal.aborted);
    await interrupt;
    await input.logger.write({
      level: "info",
      code: "SCHEDULER_RUN_STOPPED",
      category: "domain",
      component: "cli",
      retryable: false,
      message: "Scheduler run stopped",
      runId: input.runId,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function daemonFor(repo: OrchestrationRepository, harness: AgentHarness, runId: string): SchedulerDaemon {
  return new SchedulerDaemon(new Scheduler(repo, harness), repo, {
    ownerId: runId,
    now: () => new Date(),
    sleep: schedulerSleep,
  });
}

async function runFake(input: Extract<SchedulerRunInput, { backend: "fake" }>, runId: string): Promise<void> {
  const db = openDatabase(input.dbPath);
  try {
    const fake = createFakeHarness(input.scenario);
    const repo = new OrchestrationRepository(
      db,
      () => new Date().toISOString(),
      (kind) => `${kind}-${crypto.randomUUID()}`,
      () => {},
      createStaticModelAdvisor(),
    );
    await runDaemon({
      daemon: daemonFor(repo, fake.harness, runId),
      repo,
      harness: fake.harness,
      logger: loggerFor({ dbPath: input.dbPath }),
      runId,
    });
  } finally {
    db.close();
  }
}

async function runCodex(input: Extract<SchedulerRunInput, { backend: "codex" }>, runId: string): Promise<void> {
  let worktrees: Awaited<ReturnType<typeof createTaskWorktreeManager>>;
  try {
    worktrees = await createTaskWorktreeManager(input.repoPath, input.baseRef);
  } catch (error) {
    throw attachRunId(error, runId, {
      code: "CODEX_WORKTREE_STARTUP_FAILED",
      category: "startup",
      retryable: false,
      component: "cli",
      message: "Could not validate the Codex repository and base ref",
    });
  }

  const client = await CodexClient.start();
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    let catalog: CatalogModel[];
    try {
      const response = ModelListResponseSchema.parse(await client.request("model/list", {
        limit: 100,
        includeHidden: false,
      }));
      catalog = response.data
        .filter((model) => !model.hidden)
        .map((model) => ({
          id: model.id,
          supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
        }));
    } catch (error) {
      throw attachRunId(error, runId, {
        code: "CODEX_MODEL_CATALOG_FAILED",
        category: "startup",
        retryable: false,
        component: "cli",
        message: "Could not load the Codex model catalog",
      });
    }
    const advisor = createModelAdvisor(catalog);
    const compatible = (["scout", "implement", "review"] as const).some((role) =>
      advisor.decide({ role, risk: "medium", retryIndex: 0 }) !== undefined
      || advisor.decide({ role, risk: "high", retryIndex: 0 }) !== undefined
    );
    if (!compatible) {
      throw new AgileError({
        code: "CODEX_MODEL_CATALOG_INCOMPATIBLE",
        category: "startup",
        retryable: false,
        component: "cli",
        message: "No compatible high or xhigh Codex model profile is available",
        runId,
      });
    }

    try {
      db = openDatabase(input.dbPath);
    } catch (error) {
      throw attachRunId(error, runId, {
        code: "SCHEDULER_DATABASE_OPEN_FAILED",
        category: "startup",
        retryable: false,
        component: "cli",
        message: "Could not open the scheduler database",
      });
    }
    const repo = new OrchestrationRepository(
      db,
      () => new Date().toISOString(),
      (kind) => `${kind}-${crypto.randomUUID()}`,
      () => {},
      advisor,
    );
    const harness = createCodexHarness({ client, worktrees });
    await runDaemon({
      daemon: daemonFor(repo, harness, runId),
      repo,
      harness,
      logger: loggerFor({ dbPath: input.dbPath, repoPath: input.repoPath }),
      runId,
    });
  } finally {
    try {
      await client.close();
    } finally {
      db?.close();
    }
  }
}

const defaultRuntime: CliRuntime = {
  async runScheduler(input) {
    const runId = crypto.randomUUID();
    try {
      if (input.backend === "fake") await runFake(input, runId);
      else await runCodex(input, runId);
    } catch (error) {
      throw attachRunId(error, runId, {
        code: "SCHEDULER_RUN_FAILED",
        category: "infra",
        retryable: false,
        component: "cli",
        message: "Scheduler run failed",
      });
    }
  },
  async logError(error, input) {
    await loggerFor(input).error(error);
  },
};

async function reportOperationalError(
  error: unknown,
  io: CliIo,
  runtime: CliRuntime,
  input: { dbPath: string; repoPath?: string },
): Promise<number> {
  const safe = normalizeError(error, {
    code: "SCHEDULER_RUN_FAILED",
    category: "infra",
    retryable: false,
    component: "cli",
    message: "Scheduler run failed",
  });
  try {
    await runtime.logError?.(safe, input);
  } catch {
    // The operational error remains authoritative if safe logging itself fails.
  }
  io.err(`${safe.code}: ${safe.message}`);
  return 1;
}

export async function runCli(args: string[], io: CliIo, runtime: CliRuntime = defaultRuntime): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    io.err(errorMessage(error));
    return 2;
  }

  const [command, subcommand] = parsed.positionals;
  if (!command || command === "help") {
    io.out(helpText.trimEnd());
    return 0;
  }

  const requestedDb = parsed.values.db ?? ".agile/runtime/agile.db";
  const dbPath = requestedDb === ":memory:" ? ":memory:" : resolve(requestedDb);
  if (command === "init") {
    try {
      const db = openDatabase(dbPath);
      try {
        io.out(`Initialized ${dbPath}`);
        return 0;
      } finally {
        db.close();
      }
    } catch (error) {
      io.err(errorMessage(error));
      return 1;
    }
  }

  if (command === "task" && subcommand === "list") {
    try {
      const db = openDatabase(dbPath);
      try {
        const tasks = new PlanningRepository(db).listTasks();
        io.out(tasks.length ? tasks.map((task) => `${task.id}\t${task.status}\t${task.title}`).join("\n") : "No tasks.");
        return 0;
      } finally {
        db.close();
      }
    } catch (error) {
      io.err(errorMessage(error));
      return 1;
    }
  }

  if (command === "scheduler" && subcommand === "run") {
    const backend = parsed.values.backend;
    if (backend !== "fake" && backend !== "codex") {
      io.err("scheduler run requires --backend fake|codex");
      return 2;
    }
    const fakeScript = parsed.values["fake-script"];
    if (backend === "codex") {
      if (fakeScript !== undefined) {
        io.err("scheduler run --backend codex does not accept --fake-script");
        return 2;
      }
      const repo = parsed.values.repo;
      if (repo === undefined) {
        io.err("scheduler run --backend codex requires --repo PATH");
        return 2;
      }
      const repoPath = resolve(repo);
      const codexDbPath = parsed.values.db === undefined
        ? join(repoPath, ".agile", "runtime", "agile.db")
        : dbPath;
      const input: SchedulerRunInput = {
        backend,
        dbPath: codexDbPath,
        repoPath,
        baseRef: parsed.values.base ?? "HEAD",
      };
      try {
        await runtime.runScheduler(input);
        return 0;
      } catch (error) {
        return reportOperationalError(error, io, runtime, { dbPath: codexDbPath, repoPath });
      }
    }

    if (parsed.values.repo !== undefined) {
      io.err("scheduler run --backend fake does not accept --repo");
      return 2;
    }
    if (parsed.values.base !== undefined) {
      io.err("scheduler run --backend fake does not accept --base");
      return 2;
    }
    if (fakeScript === undefined) {
      io.err("scheduler run --backend fake requires --fake-script PATH");
      return 2;
    }
    let scenario: unknown;
    try {
      scenario = FakeScenarioSchema.parse(await Bun.file(resolve(fakeScript)).json());
    } catch (error) {
      io.err(errorMessage(error));
      return 2;
    }
    const input: SchedulerRunInput = { backend, dbPath, scenario };
    try {
      await runtime.runScheduler(input);
      return 0;
    } catch (error) {
      return reportOperationalError(error, io, runtime, { dbPath });
    }
  }

  if (command === "scheduler" && subcommand === "inspect") {
    try {
      const db = openDatabase(dbPath);
      try {
        io.out(JSON.stringify(new OrchestrationRepository(db).inspect(), null, 2));
        return 0;
      } finally {
        db.close();
      }
    } catch (error) {
      io.err(errorMessage(error));
      return 1;
    }
  }

  io.err(`Unknown command: ${parsed.positionals.join(" ")}`);
  return 2;
}
