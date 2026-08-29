import { dirname, join } from "node:path";
import { CodexClient } from "../codex/client";
import { createCodexHarness } from "../codex/harness";
import { ModelListResponseSchema } from "../codex/protocol";
import { loadDefaultSkillPolicy } from "../codex/skill-policy";
import type { AgentHarness } from "../harness/contracts";
import { createFakeHarness } from "../harness/fake";
import { AgileError, normalizeError } from "../runtime/errors";
import { createJsonlLogger, type Logger } from "../runtime/logger";
import { SchedulerDaemon } from "../scheduler/daemon";
import {
  type CatalogModel,
  createModelAdvisor,
  createStaticModelAdvisor,
} from "../scheduler/model-routing";
import { Scheduler } from "../scheduler/scheduler";
import { TaskHookService } from "../scheduler/task-hooks";
import { openDatabase } from "../store/database";
import { OrchestrationRepository } from "../store/orchestration-repository";
import { createTaskBranchManager } from "../workspace/task-branch";
import type { CliRuntime, SchedulerRunInput } from "./types";

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

/** Runs a scheduler session against Codex with validated models and isolated branches. */
async function runCodex(
  input: Extract<SchedulerRunInput, { backend: "codex" }>,
  runId: string,
): Promise<void> {
  let branches: Awaited<ReturnType<typeof createTaskBranchManager>>;
  try {
    branches = await createTaskBranchManager(input.repoPath, input.baseRef);
  } catch (error) {
    throw attachRunId(error, runId, {
      code: "CODEX_BRANCH_STARTUP_FAILED",
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
      const response = ModelListResponseSchema.parse(
        await client.request("model/list", {
          limit: 100,
          includeHidden: false,
        }),
      );
      catalog = response.data
        .filter((model) => !model.hidden)
        .map((model) => ({
          id: model.id,
          supportedReasoningEfforts: model.supportedReasoningEfforts.map(
            (effort) => effort.reasoningEffort,
          ),
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
    const compatible = (["scout", "implement", "review"] as const).some(
      (role) =>
        advisor.decide({ role, risk: "medium", retryIndex: 0 }) !== undefined ||
        advisor.decide({ role, risk: "high", retryIndex: 0 }) !== undefined,
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
    const harness = createCodexHarness({
      client,
      branches,
      skillPolicy: await loadDefaultSkillPolicy(),
    });
    const hooks = new TaskHookService(repo, branches);
    await runDaemon({
      daemon: daemonFor(repo, harness, runId, hooks),
      repo,
      harness,
      logger: loggerFor({ dbPath: input.dbPath, repoPath: input.repoPath }),
      runId,
      closeBackend: () => client.close(),
      cancelHooks: () => hooks.stop(),
    });
  } finally {
    try {
      await client.close();
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
  /** Writes an operational error through the logger associated with its runtime paths. */
  async logError(error, input) {
    await loggerFor(input).error(error);
  },
};
