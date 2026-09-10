import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { backends } from "../agents/registry";
import type { BackendFactory } from "../agents/types";
import {
  BunGitHubCommandRunner,
  GitHubCliPreflight,
  type GitHubPreflight,
  GitHubPullRequestPublisher,
  type TaskPublisher,
} from "../github/pr-publisher";
import { GitHubRemoteDependencyGate } from "../github/remote-dependencies";
import {
  GitHubRemoteIssueReader,
  GitHubRemoteTaskSource,
  RemoteSchedulerSource,
  trustedGitHubPublishers,
} from "../github/remote-source";
import { GitHubTaskPublisher } from "../github/remote-tasks";
import {
  GitHubRemoteTaskWriter,
  sanitizeRemoteDiagnostic,
} from "../github/remote-writeback";
import type { AgentHarness } from "../harness/contracts";
import { createFakeHarness } from "../harness/fake";
import { AgileError, normalizeError } from "../runtime/errors";
import { createJsonlLogger, type Logger } from "../runtime/logger";
import { SchedulerDaemon, type SchedulerSource } from "../scheduler/daemon";
import {
  createModelAdvisor,
  createStaticModelAdvisor,
} from "../scheduler/model-routing";
import { Scheduler } from "../scheduler/scheduler";
import { TaskHookService } from "../scheduler/task-hooks";
import {
  discoverTrustedSkills,
  loadDefaultSkillPolicy,
  loadSchedulerSkillPolicy,
} from "../skills/policy";
import { openDatabase } from "../store/database";
import { OrchestrationRepository } from "../store/orchestration-repository";
import { PlanningRepository } from "../store/planning-repository";
import { RemoteTaskRepository } from "../store/remote-task-repository";
import { acquireCheckoutOwnership } from "../workspace/checkout-ownership";
import {
  createParallelTaskBranchManager,
  createTaskBranchManager,
  type TaskBranchManager,
} from "../workspace/task-branch";
import {
  closeBackendEffect,
  reportCleanup,
  runSession,
} from "./session-lifecycle";
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
  source?: SchedulerSource,
  concurrency = 1,
): SchedulerDaemon {
  return new SchedulerDaemon(
    new Scheduler(
      repo,
      harness,
      () => {},
      hooks,
      publisher,
      source !== undefined,
      source === undefined,
      concurrency,
    ),
    repo,
    {
      ownerId: runId,
    },
    source,
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
  const concurrency = input.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    return Promise.reject(
      new Error("Concurrency must be an integer from 1 through 8"),
    );
  return runSession((stop) =>
    Effect.gen(function* () {
      const backendLabel = input.backend;
      const logger = loggerFor({
        dbPath: input.dbPath,
        repoPath: input.repoPath,
      });
      let backendStarted = false;
      let backendClosed = false;
      let incompleteWork = false;
      /** Retains ownership because old work can still mutate the checkout. */
      const retainCheckout = (): void => {
        incompleteWork = true;
      };
      const ownership = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => acquireCheckoutOwnership(input.repoPath, runId),
          catch: (error) =>
            attachRunId(error, runId, {
              code: "BACKEND_BRANCH_STARTUP_FAILED",
              category: "startup",
              retryable: false,
              component: "cli",
              message: `Could not validate the ${backendLabel} repository and base ref`,
            }),
        }),
        (owner, exit) =>
          Effect.gen(function* () {
            if (incompleteWork || (backendStarted && !backendClosed)) {
              yield* reportCleanup(
                logger,
                runId,
                "SCHEDULER_CHECKOUT_RETAINED",
              );
              return;
            }
            const released = yield* Effect.exit(
              Effect.tryPromise({
                try: () => owner.release(),
                catch: (error) => error,
              }),
            );
            if (Exit.isFailure(released)) {
              yield* reportCleanup(
                logger,
                runId,
                "SCHEDULER_CHECKOUT_RETAINED",
              );
              if (Exit.isSuccess(exit))
                yield* Effect.die(Cause.squash(released.cause));
            }
          }),
      );
      const branches = yield* Effect.tryPromise({
        try: () =>
          concurrency > 1 || existsSync(`${ownership.repoPath}.agile-checkouts`)
            ? createParallelTaskBranchManager(
                ownership.repoPath,
                input.baseRef,
                concurrency === 1,
              )
            : createTaskBranchManager(ownership.repoPath, input.baseRef),
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
      let db: ReturnType<typeof openDatabase> | undefined;
      // Register first so the later-acquired backend closes before SQLite on every exit.
      yield* Effect.addFinalizer(() => Effect.sync(() => db?.close()));
      const backend = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => {
            backendStarted = true;
            return startBackend({ branches });
          },
          catch: (error) => error,
        }),
        (resource, exit) =>
          closeBackendEffect(
            () => resource.close(),
            exit,
            logger,
            runId,
            retainCheckout,
          ).pipe(
            Effect.tap((closed) =>
              Effect.sync(() => {
                backendClosed = closed;
              }),
            ),
          ),
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
        if (input.source !== "github" && repo.hasActiveRemoteTask()) {
          throw new AgileError({
            code: "REMOTE_TASK_SOURCE_REQUIRED",
            category: "startup",
            retryable: false,
            component: "cli",
            message:
              "An active remote task requires scheduler run --source github for approval recovery",
            runId,
          });
        }
        if (input.source === "github" && repo.hasActiveLocalTask()) {
          throw new AgileError({
            code: "LOCAL_TASK_SOURCE_REQUIRED",
            category: "startup",
            retryable: false,
            component: "cli",
            message:
              "An active local task requires scheduler run --source local for recovery",
            runId,
          });
        }
        return {
          repo,
          hooks: new TaskHookService(repo, branches),
          publisher: options.publisherFactory?.(branches),
        };
      });
      if (concurrency > 1) {
        yield* Effect.tryPromise({
          try: async () => {
            // Validate retained work before starting any role in the new layout.
            for (const taskId of repo.activeTaskIds()) {
              if (stop.aborted) return;
              await branches.prepare(taskId, repo.getTask(taskId)?.baseCommit);
            }
          },
          catch: (error) => error,
        });
      }
      const source = yield* Effect.tryPromise({
        try: async () => {
          let source: SchedulerSource | undefined;
          if (input.source === "github") {
            const runner = new BunGitHubCommandRunner();
            const reader = new GitHubRemoteIssueReader(input.repoPath, runner);
            const repositoryName = await reader.repository();
            const daemonLogin = await reader.authenticatedLogin();
            const trusted = trustedGitHubPublishers(
              process.env.ROC_GITHUB_PUBLISHERS,
            );
            const remote = new RemoteTaskRepository(database);
            const writer = new GitHubRemoteTaskWriter(
              input.repoPath,
              repositoryName,
              daemonLogin,
              remote,
              () => reader.read(repositoryName),
              runner,
            );
            const taskSource = new GitHubRemoteTaskSource(
              repositoryName,
              trusted,
              new PlanningRepository(database),
              remote,
              () => reader.read(repositoryName),
            );
            const dependencies = new GitHubRemoteDependencyGate(
              input.repoPath,
              repositoryName,
              input.baseBranch ?? "",
              remote,
              runner,
              concurrency,
            );
            source = new RemoteSchedulerSource(
              {
                /** Refreshes remote authority before pinning any dependency-safe task bases. */
                async poll() {
                  const result = await taskSource.poll();
                  await dependencies.prepare();
                  return result;
                },
              },
              repo,
              Date.now,
              async (kind, error) => {
                await logger.write({
                  level: "warn",
                  code:
                    kind === "network"
                      ? "REMOTE_TASK_SOURCE_UNAVAILABLE"
                      : "REMOTE_TASK_SOURCE_INVALID",
                  category: kind === "network" ? "infra" : "domain",
                  component: "github-task-source",
                  retryable: kind === "network",
                  message: sanitizeRemoteDiagnostic(
                    error instanceof Error ? error.message : String(error),
                  ),
                  runId,
                });
              },
              () => writer.sync(),
            );
          }
          return source;
        },
        catch: (error) => error,
      });
      if (stop.aborted) return;
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
        source,
        concurrency,
      ).runEffect({
        stop,
        onDrainTimeout: retainCheckout,
        /** Requests both agent and hook cancellation while recording only safe diagnostics. */
        async cancel() {
          const active = repo.getRunningAttempts();
          await Promise.allSettled(
            [
              ...active.map((attempt) =>
                Promise.resolve().then(() =>
                  backend.harness.cancel(attempt.descriptor.attemptId),
                ),
              ),
              Promise.resolve().then(() => hooks.stop()),
            ].map((action) =>
              action.catch(() => {
                retainCheckout();
                return logger.write({
                  level: "warn",
                  code: "SCHEDULER_CANCELLATION_FAILED",
                  category: "infra",
                  component: "cli",
                  retryable: false,
                  runId,
                  message: "Scheduler cancellation did not finish normally",
                });
              }),
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
  /** Loads Pi's onboarding support only when the user configures a model. */
  async configureModel(io, cwd) {
    const { configureCodex } = await import("../agents/pi/onboard");
    return configureCodex(io, cwd);
  },
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
  /** Publishes a validated task manifest through the explicit project checkout. */
  async publishGitHubTasks(manifest, cwd) {
    return new GitHubTaskPublisher(cwd).publish(manifest);
  },
  /** Discovers trusted installed skills without requiring a provider CLI or authentication. */
  async listWorkspaceSkills(_cwd) {
    return discoverTrustedSkills(await loadDefaultSkillPolicy());
  },
};
