import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Effect } from "effect";
import { backends } from "../agents/registry";
import type { BackendFactory, BackendRuntime } from "../agents/types";
import { GitHubExecutionStore } from "../github/execution-store";
import { githubTaskSnapshot } from "../github/execution-view";
import {
  GitHubRemoteIssueReader,
  trustedGitHubPublishers,
} from "../github/issue-reader";
import {
  BunGitHubCommandRunner,
  GitHubCliPreflight,
  type GitHubCommandRunner,
  GitHubPullRequestPublisher,
  type TaskPublisher,
} from "../github/pr-publisher";
import { GitHubTaskPublisher } from "../github/remote-tasks";
import { AgileError, normalizeError } from "../runtime/errors";
import { createJsonlLogger } from "../runtime/logger";
import { GitHubTaskPool } from "../scheduler/github-pool";
import { createModelAdvisor } from "../scheduler/model-routing";
import {
  discoverTrustedSkills,
  loadDefaultSkillPolicy,
} from "../skills/policy";
import { acquireCheckoutOwnership } from "../workspace/checkout-ownership";
import {
  createTaskBranchManager,
  type TaskBranchManager,
} from "../workspace/task-branch";
import { runSession } from "./session-lifecycle";
import type { CliRuntime, RealSchedulerRunInput } from "./types";

export {
  loadDefaultSkillPolicy,
  loadSchedulerSkillPolicy,
} from "../skills/policy";

/** Connects GitHub checkpoints to an explicit repository and configured executor identity. */
export async function connectGitHub(
  cwd: string,
  command: GitHubCommandRunner = new BunGitHubCommandRunner(),
) {
  const api = new GitHubRemoteIssueReader(cwd, command);
  const repository = await api.repository();
  const login = await api.authenticatedLogin();
  const executor = process.env.ROC_GITHUB_EXECUTOR ?? login;
  return {
    store: new GitHubExecutionStore(
      repository,
      executor,
      trustedGitHubPublishers(process.env.ROC_GITHUB_PUBLISHERS ?? login),
      api,
    ),
    api,
    login,
    executor,
  };
}

/** Waits for work to complete within a deadline without treating a rejection as success. */
async function completesWithin(
  work: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owns one GitHub-backed daemon, its task worktrees and confirmed child cleanup. */
export async function runBackendSession(
  factory: BackendFactory,
  input: RealSchedulerRunInput,
  runId: string = randomUUID(),
  options: {
    store?: GitHubExecutionStore;
    command?: GitHubCommandRunner;
    publisherFactory?: (branches: TaskBranchManager) => TaskPublisher;
    onActivity?: (taskId: string, summary: string) => void;
  } = {},
): Promise<void> {
  const logger = createJsonlLogger({
    path: join(input.repoPath, ".agile/runtime/agile.log"),
    err: () => {},
  });
  await runSession((stop) =>
    Effect.tryPromise({
      try: async () => {
        const ownership = await acquireCheckoutOwnership(input.repoPath, runId);
        let backend: BackendRuntime | undefined;
        let loopSettled = true;
        let retain = false;
        let failure: unknown;
        try {
          const command = options.command ?? new BunGitHubCommandRunner();
          let baseBranch = input.baseBranch;
          if (!baseBranch) {
            const result = await command.run({
              command: [
                "gh",
                "repo",
                "view",
                "--json",
                "defaultBranchRef",
                "--jq",
                ".defaultBranchRef.name",
              ],
              cwd: input.repoPath,
            });
            if (result.exitCode !== 0)
              throw Error("Could not resolve GitHub target branch");
            baseBranch = result.stdout.trim();
          }
          await new GitHubCliPreflight(
            input.repoPath,
            baseBranch,
            command,
          ).assertReady();
          const connected = options.store
            ? undefined
            : await connectGitHub(input.repoPath, command);
          if (connected && connected.login !== connected.executor)
            throw Error("Run the daemon as ROC_GITHUB_EXECUTOR");
          const store = options.store ?? connected?.store;
          if (!store) throw Error("GitHub state is unavailable");
          const fetched = await command.run({
            command: ["git", "fetch", "origin", baseBranch],
            cwd: input.repoPath,
          });
          if (fetched.exitCode !== 0)
            throw Error("Could not fetch the GitHub target branch");
          stop.throwIfAborted();
          const branches = await createTaskBranchManager(
            input.repoPath,
            `refs/remotes/origin/${baseBranch}`,
          );
          // Until the factory returns, it may own processes that only it can close.
          retain = true;
          backend = await factory({ branches });
          retain = false;
          stop.throwIfAborted();
          const runner = new GitHubTaskPool({
            concurrency: input.concurrency,
            autoMerge: input.autoMerge,
            store,
            branches,
            harness: backend.harness,
            advisor: createModelAdvisor(backend.catalog, backend.modelMapping),
            publisher:
              options.publisherFactory?.(branches) ??
              new GitHubPullRequestPublisher(baseBranch, branches, command),
            command,
            cwd: input.repoPath,
            baseBranch,
            diagnostic: (message) => process.stderr.write(`${message}\n`),
            activity: (taskId, event) => {
              const summary =
                event.type === "attempt.activity"
                  ? event.activity.summary
                  : event.type;
              if (options.onActivity) options.onActivity(taskId, summary);
              else process.stdout.write(`${taskId}: ${summary}\n`);
            },
          });
          loopSettled = false;
          const loop = runner
            .run(stop, input.once)
            .catch((error) => {
              failure = error;
            })
            .finally(() => {
              loopSettled = true;
            });
          let wake: (() => void) | undefined;
          const stopped = new Promise<void>((resolve) => {
            /** Wakes the session cleanup path when admission is stopped. */
            const onAbort = () => resolve();
            wake = onAbort;
            stop.addEventListener("abort", onAbort, { once: true });
            if (stop.aborted) resolve();
          });
          try {
            await Promise.race([loop, stopped]);
            if (stop.aborted || failure) {
              const drain = Promise.allSettled([loop, runner.cancel()]).then(
                (results) => {
                  if (results.some((result) => result.status === "rejected"))
                    throw Error("Cancellation was not confirmed");
                },
              );
              try {
                if (!(await completesWithin(drain, 5_000))) retain = true;
              } catch {
                retain = true;
              }
            }
          } finally {
            if (wake) stop.removeEventListener("abort", wake);
          }
          if (failure) throw failure;
        } catch (error) {
          failure = error;
          if (
            error instanceof AgileError &&
            [
              "GITHUB_CHECKPOINT_UNCONFIRMED",
              "TASK_CLEANUP_UNCONFIRMED",
            ].includes(error.code)
          )
            retain = true;
        } finally {
          if (backend) {
            try {
              if (!(await completesWithin(backend.close(), 250))) retain = true;
            } catch (error) {
              retain = true;
              failure ??= error;
            }
          }
          if (!loopSettled) retain = true;
          if (retain) {
            await completesWithin(
              logger.write({
                level: "warn",
                code: "SCHEDULER_CHECKOUT_RETAINED",
                category: "infra",
                component: "cli",
                retryable: false,
                runId,
                message:
                  "Execution ownership retained because work or cleanup could not be confirmed",
              }),
              100,
            ).catch(() => false);
            failure ??= new AgileError({
              code: "SCHEDULER_CHECKOUT_RETAINED",
              category: "infra",
              component: "cli",
              retryable: false,
              message:
                "Execution ownership retained; confirm cleanup before restarting",
            });
          } else {
            try {
              await ownership.release();
            } catch (error) {
              failure ??= error;
            }
          }
        }
        if (failure && !(stop.aborted && !retain))
          throw normalizeError(failure, {
            code: "SCHEDULER_RUN_FAILED",
            category: "infra",
            retryable: false,
            component: "cli",
            message:
              "GitHub task execution stopped; inspect remote checkpoints and local diagnostics",
            runId,
          });
      },
      catch: (error) => error,
    }),
  );
}

export const defaultRuntime: CliRuntime = {
  /** Loads Pi's model setup only when onboarding connects the provider. */
  async configureModel(io, cwd) {
    const { configureCodex } = await import("../agents/pi/onboard");
    return configureCodex(io, cwd);
  },
  /** Runs the Pi backend against GitHub Issues without opening local task storage. */
  async runScheduler(input) {
    await runBackendSession(backends[input.backend], input);
  },
  /** Reads GitHub checkpoints for task and token inspection. */
  async readTasks(cwd) {
    const { store } = await connectGitHub(cwd);
    const result = await store.list();
    return githubTaskSnapshot(result.tasks, result.diagnostics);
  },
  /** Writes only sanitized operational diagnostics to the project log. */
  async logError(error, input) {
    await createJsonlLogger({
      path: join(input.repoPath, ".agile/runtime/agile.log"),
      err: () => {},
    }).error(error);
  },
  /** Publishes approved task envelopes to GitHub without importing a local backlog. */
  async publishGitHubTasks(manifest, cwd) {
    return new GitHubTaskPublisher(cwd).publish(manifest);
  },
  /** Discovers installed trusted skills without starting a model. */
  async listWorkspaceSkills() {
    return discoverTrustedSkills(await loadDefaultSkillPolicy());
  },
};
