import { dirname, join } from "node:path";
import { loadSchedulerSkillPolicy } from "../agents/codex/backend";
import { CodexClient } from "../agents/codex/client";
import { listWorkspaceSkills as readWorkspaceSkills } from "../agents/codex/skill-catalog";
import { backends } from "../agents/registry";
import type { BackendFactory } from "../agents/types";
import type { AgentHarness } from "../harness/contracts";
import { createFakeHarness } from "../harness/fake";
import { AgileError, normalizeError } from "../runtime/errors";
import { createJsonlLogger, type Logger } from "../runtime/logger";
import { SchedulerDaemon } from "../scheduler/daemon";
import {
  createModelAdvisor,
  createStaticModelAdvisor,
} from "../scheduler/model-routing";
import { Scheduler } from "../scheduler/scheduler";
import { TaskHookService } from "../scheduler/task-hooks";
import { openDatabase } from "../store/database";
import { OrchestrationRepository } from "../store/orchestration-repository";
import { createTaskBranchManager } from "../workspace/task-branch";
import type {
  CliRuntime,
  RealSchedulerRunInput,
  SchedulerRunInput,
} from "./types";

/** Sleeps until the requested delay elapses or an optional abort signal fires. */
export function schedulerSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** Removes the abort listener after the sleep promise settles. */
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, milliseconds);
    /** Cancels the timer and rejects the sleep promise exactly once. */
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(
        signal?.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Selects the runtime log path from the database and optional repository paths. */
function logPath(input: { dbPath: string; repoPath?: string }): string {
  return input.repoPath === undefined
    ? join(dirname(input.dbPath), "agile.log")
    : join(input.repoPath, ".agile", "runtime", "agile.log");
}

/** Creates the CLI's silent-console structured logger for a runtime location. */
function loggerFor(input: { dbPath: string; repoPath?: string }): Logger {
  return createJsonlLogger({ path: logPath(input), err: () => {} });
}

/** Normalizes an operational error while ensuring it carries the current run identifier. */
function attachRunId(
  error: unknown,
  runId: string,
  fallback: {
    code: string;
    category: "startup" | "protocol" | "infra" | "policy" | "domain";
    retryable: boolean;
    component: string;
    message: string;
  },
): AgileError {
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
    ...(normalized.attemptId === undefined
      ? {}
      : { attemptId: normalized.attemptId }),
    ...(normalized.threadId === undefined
      ? {}
      : { threadId: normalized.threadId }),
    ...(normalized.requestId === undefined
      ? {}
      : { requestId: normalized.requestId }),
    cause: error,
  });
}

/** Runs the scheduler daemon with signal-driven cancellation, logging, and backend cleanup. */
export async function runDaemon(input: {
  daemon: Pick<SchedulerDaemon, "run">;
  repo: Pick<OrchestrationRepository, "getRunningAttempt">;
  harness: AgentHarness;
  logger: Logger;
  runId: string;
  closeBackend?: () => Promise<void>;
  cancelHooks?: () => Promise<void>;
  shutdownTimeoutMs?: number;
}): Promise<void> {
  const stop = new AbortController();
  let shutdown: Promise<void> | undefined;
  /** Starts idempotent shutdown and bounds cancellation before closing the backend. */
  const onSignal = () => {
    stop.abort();
    shutdown ??= (async () => {
      const active = input.repo.getRunningAttempt();
      const cancellation = Promise.all([
        active === undefined
          ? Promise.resolve()
          : input.harness
              .cancel(active.descriptor.attemptId)
              .catch(() => undefined),
        input.cancelHooks?.().catch(() => undefined) ?? Promise.resolve(),
      ]).then(() => undefined);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        cancellation,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, input.shutdownTimeoutMs ?? 250);
        }),
      ]);
      if (deadline !== undefined) clearTimeout(deadline);
      await input.closeBackend?.();
    })();
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
    await shutdown;
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

/** Composes a scheduler daemon with production timing and ownership dependencies. */
function daemonFor(
  repo: OrchestrationRepository,
  harness: AgentHarness,
  runId: string,
  hooks?: TaskHookService,
): SchedulerDaemon {
  return new SchedulerDaemon(
    new Scheduler(repo, harness, () => {}, hooks),
    repo,
    {
      ownerId: runId,
      now: () => new Date(),
      sleep: schedulerSleep,
    },
  );
}

/** Supplies the current local directory as the deterministic fake-backend task workspace. */
async function fakeTaskWorkspace(): Promise<{ path: string }> {
  return { path: process.cwd() };
}

/** Runs a scheduler session against the deterministic fake harness. */
async function runFake(
  input: Extract<SchedulerRunInput, { backend: "fake" }>,
  runId: string,
): Promise<void> {
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
    const hooks = new TaskHookService(repo, { prepare: fakeTaskWorkspace });
    await runDaemon({
      daemon: daemonFor(repo, fake.harness, runId, hooks),
      repo,
      harness: fake.harness,
      logger: loggerFor({ dbPath: input.dbPath }),
      runId,
      cancelHooks: () => hooks.stop(),
    });
  } finally {
    db.close();
  }
}

export { loadSchedulerSkillPolicy };

/** Runs a scheduler session against any registered backend factory. */
async function runRealBackend(
  input: RealSchedulerRunInput,
  runId: string,
): Promise<void> {
  await runBackendSession(backends[input.backend], input, runId);
}

/** Runs one scheduler session against a started backend factory. */
export async function runBackendSession(
  startBackend: BackendFactory,
  input: RealSchedulerRunInput,
  runId: string,
): Promise<void> {
  const backendLabel = input.backend;
  let branches: Awaited<ReturnType<typeof createTaskBranchManager>>;
  try {
    branches = await createTaskBranchManager(input.repoPath, input.baseRef);
  } catch (error) {
    throw attachRunId(error, runId, {
      code: "BACKEND_BRANCH_STARTUP_FAILED",
      category: "startup",
      retryable: false,
      component: "cli",
      message: `Could not validate the ${backendLabel} repository and base ref`,
    });
  }

  const backend = await startBackend({ branches });
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const advisor = createModelAdvisor(backend.catalog);
    const compatible = (["scout", "implement", "review"] as const).some(
      (role) =>
        advisor.decide({ role, risk: "medium", retryIndex: 0 }) !== undefined ||
        advisor.decide({ role, risk: "high", retryIndex: 0 }) !== undefined,
    );
    if (!compatible) {
      throw new AgileError({
        code: "BACKEND_MODEL_CATALOG_INCOMPATIBLE",
        category: "startup",
        retryable: false,
        component: "cli",
        message: `No compatible high or xhigh ${backendLabel} model profile is available`,
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
    const hooks = new TaskHookService(repo, branches);
    await runDaemon({
      daemon: daemonFor(repo, backend.harness, runId, hooks),
      repo,
      harness: backend.harness,
      logger: loggerFor({ dbPath: input.dbPath, repoPath: input.repoPath }),
      runId,
      closeBackend: () => backend.close(),
      cancelHooks: () => hooks.stop(),
    });
  } finally {
    try {
      await backend.close();
    } finally {
      db?.close();
    }
  }
}

export const defaultRuntime: CliRuntime = {
  /** Runs the selected scheduler backend under a fresh structured run identifier. */
  async runScheduler(input) {
    const runId = crypto.randomUUID();
    try {
      if (input.backend === "fake") await runFake(input, runId);
      else await runRealBackend(input, runId);
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
  /** Writes an operational error through the logger associated with its runtime paths. */
  async logError(error, input) {
    await loggerFor(input).error(error);
  },
  /** Reads one workspace skill catalog through a short-lived Codex client. */
  async listWorkspaceSkills(cwd) {
    const client = await CodexClient.start();
    try {
      return await readWorkspaceSkills(client, cwd);
    } finally {
      await client.close();
    }
  },
};
