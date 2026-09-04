import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadSchedulerSkillPolicy } from "../agents/codex/backend";
import { CodexClient } from "../agents/codex/client";
import { listWorkspaceSkills as readWorkspaceSkills } from "../agents/codex/skill-catalog";
import { backends } from "../agents/registry";
import type { BackendFactory } from "../agents/types";
import {
  GitHubCliPreflight,
  type GitHubPreflight,
  GitHubPullRequestPublisher,
  type TaskPublisher,
} from "../github/pr-publisher";
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
import {
  createTaskBranchManager,
  type TaskBranchManager,
} from "../workspace/task-branch";
import { closeBackendEffect, runSession } from "./session-lifecycle";
import type {
  CliRuntime,
  RealSchedulerRunInput,
  SchedulerRunInput,
} from "./types";

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

/** Composes a scheduler daemon with production timing and ownership dependencies. */
function daemonFor(
  repo: OrchestrationRepository,
  harness: AgentHarness,
  runId: string,
  hooks?: TaskHookService,
  publisher?: TaskPublisher,
): SchedulerDaemon {
  return new SchedulerDaemon(
    new Scheduler(repo, harness, () => {}, hooks, publisher),
    repo,
    {
      ownerId: runId,
    },
  );
}

/** Supplies the current local directory as the deterministic fake-backend task workspace. */
async function fakeTaskWorkspace(): Promise<{ path: string }> {
  return { path: process.cwd() };
}

/** Provides deterministic pull-request receipts for the isolated fake scheduler backend. */
function fakePublisher(): TaskPublisher {
  let pullRequestNumber = 0;
  return {
    baseBranch: "main",
    /** Returns a distinct deterministic pull-request receipt for each fake publication. */
    async publish(_input) {
      pullRequestNumber += 1;
      return {
        number: pullRequestNumber,
        url: `https://example.test/pull/${pullRequestNumber}`,
        state: "OPEN",
      };
    },
  };
}

/** Runs a scheduler session against the deterministic fake harness. */
function runFake(
  input: Extract<SchedulerRunInput, { backend: "fake" }>,
  runId: string,
): Promise<void> {
  return runSession((stop) =>
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => openDatabase(input.dbPath),
          catch: (error) => error,
        }),
        (resource) => Effect.sync(() => resource.close()),
      );
      const { fake, repo, hooks, logger, publisher } = yield* Effect.sync(
        () => {
          const fake = createFakeHarness(input.scenario);
          const repo = new OrchestrationRepository(
            db,
            () => new Date().toISOString(),
            (kind) => `${kind}-${crypto.randomUUID()}`,
            () => {},
            createStaticModelAdvisor(),
          );
          return {
            fake,
            repo,
            hooks: new TaskHookService(repo, { prepare: fakeTaskWorkspace }),
            logger: loggerFor({ dbPath: input.dbPath }),
            publisher: fakePublisher(),
          };
        },
      );
      yield* Effect.tryPromise({
        try: () =>
          logger.write({
            level: "info",
            code: "SCHEDULER_RUN_STARTED",
            category: "domain",
            component: "cli",
            retryable: false,
            message: "Scheduler run started",
            runId,
          }),
        catch: (error) => error,
      });
      yield* daemonFor(repo, fake.harness, runId, hooks, publisher).runEffect({
        stop,
        /** Requests both agent and hook cancellation while recording only safe diagnostics. */
        async cancel() {
          const active = repo.getRunningAttempt();
          await Promise.allSettled(
            [
              Promise.resolve().then(() =>
                active === undefined
                  ? undefined
                  : fake.harness.cancel(active.descriptor.attemptId),
              ),
              Promise.resolve().then(() => hooks.stop()),
            ].map((action) =>
              action.catch(() =>
                logger.write({
                  level: "warn",
                  code: "SCHEDULER_CANCELLATION_FAILED",
                  category: "infra",
                  component: "cli",
                  retryable: false,
                  runId,
                  message: "Scheduler cancellation did not finish normally",
                }),
              ),
            ),
          );
        },
      });
      yield* Effect.tryPromise({
        try: () =>
          logger.write({
            level: "info",
            code: "SCHEDULER_RUN_STOPPED",
            category: "domain",
            component: "cli",
            retryable: false,
            message: "Scheduler run stopped",
            runId,
          }),
        catch: (error) => error,
      });
    }),
  );
}

export { loadSchedulerSkillPolicy };

/** Runs a scheduler session against any registered backend factory. */
async function runRealBackend(
  input: RealSchedulerRunInput,
  runId: string,
): Promise<void> {
  if (input.baseBranch === undefined) {
    throw new AgileError({
      code: "GITHUB_BASE_BRANCH_REQUIRED",
      category: "startup",
      retryable: false,
      component: "cli",
      message: "scheduler run requires --base-branch <GitHub branch>",
      runId,
    });
  }
  const baseBranch = input.baseBranch;
  await runBackendSession(backends[input.backend], input, runId, {
    preflight: new GitHubCliPreflight(input.repoPath, baseBranch),
    publisherFactory: (branches) =>
      new GitHubPullRequestPublisher(baseBranch, branches),
  });
}

/** Supplies optional external publication collaborators to a directly tested backend session. */
export type BackendSessionOptions = {
  preflight?: GitHubPreflight;
  publisherFactory?: (branches: TaskBranchManager) => TaskPublisher;
};

/** Runs one scheduler session against a started backend factory. */
export function runBackendSession(
  startBackend: BackendFactory,
  input: RealSchedulerRunInput,
  runId: string,
  options: BackendSessionOptions = {},
): Promise<void> {
  return runSession((stop) =>
    Effect.gen(function* () {
      const backendLabel = input.backend;
      const branches = yield* Effect.tryPromise({
        try: () => createTaskBranchManager(input.repoPath, input.baseRef),
        catch: (error) =>
          attachRunId(error, runId, {
            code: "BACKEND_BRANCH_STARTUP_FAILED",
            category: "startup",
            retryable: false,
            component: "cli",
            message: `Could not validate the ${backendLabel} repository and base ref`,
          }),
      });
      if (stop.aborted) return;
      yield* Effect.tryPromise({
        try: async () => {
          await options.preflight?.assertReady();
        },
        catch: (error) =>
          attachRunId(error, runId, {
            code: "GITHUB_PREFLIGHT_FAILED",
            category: "startup",
            retryable: false,
            component: "cli",
            message:
              "GitHub authentication or repository access is unavailable",
          }),
      });
      if (stop.aborted) return;
      const logger = loggerFor({
        dbPath: input.dbPath,
        repoPath: input.repoPath,
      });
      let db: ReturnType<typeof openDatabase> | undefined;
      // Register first so the later-acquired backend closes before SQLite on every exit.
      yield* Effect.addFinalizer(() => Effect.sync(() => db?.close()));
      const backend = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => startBackend({ branches }),
          catch: (error) => error,
        }),
        (resource, exit) =>
          closeBackendEffect(() => resource.close(), exit, logger, runId),
      );
      if (stop.aborted) return;
      const advisor = yield* Effect.try({
        try: () => {
          const advisor = createModelAdvisor(
            backend.catalog,
            backend.modelMapping,
          );
          const compatible = (["scout", "implement", "review"] as const).some(
            (role) =>
              advisor.decide({ role, risk: "medium", retryIndex: 0 }) !==
                undefined ||
              advisor.decide({ role, risk: "high", retryIndex: 0 }) !==
                undefined,
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
          return advisor;
        },
        catch: (error) => error,
      });
      db = yield* Effect.try({
        try: () => openDatabase(input.dbPath),
        catch: (error) =>
          attachRunId(error, runId, {
            code: "SCHEDULER_DATABASE_OPEN_FAILED",
            category: "startup",
            retryable: false,
            component: "cli",
            message: "Could not open the scheduler database",
          }),
      });
      const database = db;
      const { repo, hooks, publisher } = yield* Effect.sync(() => {
        const repo = new OrchestrationRepository(
          database,
          () => new Date().toISOString(),
          (kind) => `${kind}-${crypto.randomUUID()}`,
          () => {},
          advisor,
        );
        return {
          repo,
          hooks: new TaskHookService(repo, branches),
          publisher: options.publisherFactory?.(branches),
        };
      });
      yield* Effect.tryPromise({
        try: () =>
          logger.write({
            level: "info",
            code: "SCHEDULER_RUN_STARTED",
            category: "domain",
            component: "cli",
            retryable: false,
            message: "Scheduler run started",
            runId,
          }),
        catch: (error) => error,
      });
      yield* daemonFor(
        repo,
        backend.harness,
        runId,
        hooks,
        publisher,
      ).runEffect({
        stop,
        /** Requests both agent and hook cancellation while recording only safe diagnostics. */
        async cancel() {
          const active = repo.getRunningAttempt();
          await Promise.allSettled(
            [
              Promise.resolve().then(() =>
                active === undefined
                  ? undefined
                  : backend.harness.cancel(active.descriptor.attemptId),
              ),
              Promise.resolve().then(() => hooks.stop()),
            ].map((action) =>
              action.catch(() =>
                logger.write({
                  level: "warn",
                  code: "SCHEDULER_CANCELLATION_FAILED",
                  category: "infra",
                  component: "cli",
                  retryable: false,
                  runId,
                  message: "Scheduler cancellation did not finish normally",
                }),
              ),
            ),
          );
        },
      });
      yield* Effect.tryPromise({
        try: () =>
          logger.write({
            level: "info",
            code: "SCHEDULER_RUN_STOPPED",
            category: "domain",
            component: "cli",
            retryable: false,
            message: "Scheduler run stopped",
            runId,
          }),
        catch: (error) => error,
      });
    }),
  );
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
