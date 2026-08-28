import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CodexClient } from "../codex/client";
import { createCodexHarness } from "../codex/harness";
import { ModelListResponseSchema } from "../codex/protocol";
import { loadDefaultSkillPolicy } from "../codex/skill-policy";
import {
  type AgileCycleSetting,
  AgileCycleSettingSchema,
  activeAgileCycle,
} from "../domain/agile-cycle";
import { BacklogManifestSchema } from "../domain/schemas";
import { safeTaskPathComponent } from "../domain/task-path";
import { type AgentHarness, FakeScenarioSchema } from "../harness/contracts";
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
import { loadRocSettings, saveRocSettings } from "../settings";
import {
  installRocCreateTasksSkill,
  SkillInstallError,
} from "../skills/install";
import { openDatabase } from "../store/database";
import { OrchestrationRepository } from "../store/orchestration-repository";
import { PlanningRepository } from "../store/planning-repository";
import { createTaskBranchManager } from "../workspace/task-branch";
import { helpText } from "./help";
import {
  renderCycleStep,
  renderDatabaseStep,
  renderEmptyTaskList,
  renderOnboardingComplete,
  renderOnboardingHeader,
  renderOnboardingStopped,
  renderOnboardingUsageError,
  renderSettingsStep,
  renderSkillsStep,
} from "./presentation";
import { renderTokenUsageChart } from "./token-chart";

export type CliIo = {
  out(text: string): void;
  err(text: string): void;
  ask?(question: string): Promise<string>;
};
export type SchedulerRunInput =
  | { backend: "fake"; dbPath: string; scenario: unknown }
  | { backend: "codex"; dbPath: string; repoPath: string; baseRef: string };
export type CliRuntime = {
  runScheduler(input: SchedulerRunInput): Promise<void>;
  logError?(
    error: AgileError,
    input: { dbPath: string; repoPath?: string },
  ): Promise<void>;
  projectRoot?: string;
  homeRoot?: string;
  now?: () => Date;
};

/** Prompts for and validates one global Agile cycle setting. */
async function promptCycleSetting(
  io: CliIo,
  now: Date,
): Promise<AgileCycleSetting> {
  if (!io.ask) throw new Error("Interactive input is required for onboard");
  const choice = (
    await io.ask("Agile cycle: 1) Daily 2) Weekly 3) Custom")
  ).trim();
  if (choice === "1") return { type: "daily" };
  if (choice === "2") return { type: "weekly" };
  if (choice !== "3") throw new Error("Choose Daily, Weekly, or Custom");
  const days = Number((await io.ask("Custom cycle duration in days")).trim());
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("Custom duration must be a whole number greater than zero");
  }
  return AgileCycleSettingSchema.parse({
    type: "custom",
    days,
    anchorDate: activeAgileCycle({ type: "daily" }, now).id,
  });
}

/** Converts an unknown thrown value into a displayable error message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds the copyable onboarding retry command from the accepted onboarding options. */
function onboardingRetryCommand(input: {
  dbPath?: string;
  global?: boolean;
}): string {
  if (input.global) return "npx roc-it@latest onboard --global";
  return input.dbPath === undefined
    ? "npx roc-it@latest onboard"
    : `npx roc-it@latest onboard --db ${shellLiteral(input.dbPath)}`;
}

/** Quotes a value as one literal argument for the supported POSIX-compatible shell. */
function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Returns whether a backlog manifest still uses the removed weekId field. */
function usesLegacyWeekId(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "weekId" in value
  );
}

/** Loads settings and calculates the active Agile cycle for the CLI clock. */
async function currentCycle(runtime: CliRuntime) {
  const settings = await loadRocSettings(runtime.homeRoot ?? homedir());
  return activeAgileCycle(settings.cycle, runtime.now?.() ?? new Date());
}

/** Parses supported CLI options and positional commands under strict validation. */
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
      "no-color": { type: "boolean" },
      global: { type: "boolean" },
    },
  });
}

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
  shutdownTimeoutMs?: number;
}): Promise<void> {
  const stop = new AbortController();
  let shutdown: Promise<void> | undefined;
  /** Starts idempotent shutdown and bounds cancellation before closing the backend. */
  const onSignal = () => {
    stop.abort();
    shutdown ??= (async () => {
      const active = input.repo.getRunningAttempt();
      const cancellation =
        active === undefined
          ? Promise.resolve()
          : input.harness
              .cancel(active.descriptor.attemptId)
              .catch(() => undefined);
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
): SchedulerDaemon {
  return new SchedulerDaemon(new Scheduler(repo, harness), repo, {
    ownerId: runId,
    now: () => new Date(),
    sleep: schedulerSleep,
  });
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
    await runDaemon({
      daemon: daemonFor(repo, harness, runId),
      repo,
      harness,
      logger: loggerFor({ dbPath: input.dbPath, repoPath: input.repoPath }),
      runId,
      closeBackend: () => client.close(),
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

type OperationalErrorFallback = {
  code: string;
  category: "startup" | "protocol" | "infra" | "policy" | "domain";
  retryable: boolean;
  component: string;
  message: string;
};

/** Safely reports an operational failure to structured logging and standard error. */
async function reportOperationalError(
  error: unknown,
  io: CliIo,
  runtime: CliRuntime,
  input: { dbPath: string; repoPath?: string },
  fallback: OperationalErrorFallback = {
    code: "SCHEDULER_RUN_FAILED",
    category: "infra",
    retryable: false,
    component: "cli",
    message: "Scheduler run failed",
  },
): Promise<number> {
  const safe = normalizeError(error, fallback);
  try {
    await runtime.logError?.(safe, input);
  } catch {
    // The operational error remains authoritative if safe logging itself fails.
  }
  io.err(`${safe.code}: ${safe.message}`);
  return 1;
}

/** Executes a CLI command and returns its process exit code. */
export async function runCli(
  args: string[],
  io: CliIo,
  runtime: CliRuntime = defaultRuntime,
): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    io.err(errorMessage(error));
    return 2;
  }

  const [command, subcommand] = parsed.positionals;
  if (parsed.values.global !== undefined && command !== "onboard") {
    io.err("--global is only supported by onboard");
    return 2;
  }
  if (!command || command === "help") {
    io.out(helpText.trimEnd());
    return 0;
  }

  const projectRoot = runtime.projectRoot ?? process.cwd();
  const requestedDb = parsed.values.db ?? ".agile/runtime/agile.db";
  const dbPath =
    requestedDb === ":memory:" ? ":memory:" : resolve(projectRoot, requestedDb);
  if (command === "onboard") {
    const retryCommand = onboardingRetryCommand({
      dbPath: parsed.values.db,
      global: parsed.values.global,
    });
    if (subcommand !== undefined || parsed.positionals.length !== 1) {
      io.err(
        renderOnboardingUsageError(
          "onboard does not accept positional arguments",
          retryCommand,
        ),
      );
      return 2;
    }
    if (
      parsed.values.backend !== undefined ||
      parsed.values.repo !== undefined ||
      parsed.values.base !== undefined ||
      parsed.values["fake-script"] !== undefined ||
      parsed.values["no-color"] !== undefined
    ) {
      io.err(
        renderOnboardingUsageError(
          "onboard accepts only --global and --db PATH",
          retryCommand,
        ),
      );
      return 2;
    }
    if (parsed.values.global && parsed.values.db !== undefined) {
      io.err(
        renderOnboardingUsageError(
          "onboard --global does not accept --db PATH",
          retryCommand,
        ),
      );
      return 2;
    }
    const sourcePath = resolve(
      import.meta.dir,
      "..",
      "..",
      "skills",
      "roc-create-tasks",
      "SKILL.md",
    );
    const root = parsed.values.global
      ? (runtime.homeRoot ?? homedir())
      : projectRoot;
    const scope = parsed.values.global
      ? { kind: "global" as const, root }
      : { kind: "project" as const, root };
    const completedSteps: string[] = [];
    io.out(renderOnboardingHeader(scope));
    try {
      let installed: Awaited<ReturnType<typeof installRocCreateTasksSkill>>;
      if (parsed.values.global) {
        const databaseStep = renderDatabaseStep({ scope });
        completedSteps.push(databaseStep);
        io.out(databaseStep);
        installed = await installRocCreateTasksSkill({ sourcePath, root });
      } else {
        const db = openDatabase(dbPath);
        try {
          const databaseStep = renderDatabaseStep({ dbPath, scope });
          completedSteps.push(databaseStep);
          io.out(databaseStep);
          installed = await installRocCreateTasksSkill({ sourcePath, root });
        } finally {
          db.close();
        }
      }
      const skillsStep = renderSkillsStep(installed);
      completedSteps.push(skillsStep);
      io.out(skillsStep);
      const setting = await promptCycleSetting(
        io,
        runtime.now?.() ?? new Date(),
      );
      const cycleStep = renderCycleStep(setting);
      completedSteps.push(cycleStep);
      io.out(cycleStep);
      const settingsPath = await saveRocSettings(
        { cycle: setting },
        runtime.homeRoot ?? homedir(),
      );
      const settingsStep = renderSettingsStep(settingsPath);
      completedSteps.push(settingsStep);
      io.out(settingsStep);
      io.out(renderOnboardingComplete());
      return 0;
    } catch (error) {
      const partialSkills =
        error instanceof SkillInstallError &&
        (error.completed.created.length > 0 ||
          error.completed.skipped.length > 0)
          ? renderSkillsStep(error.completed)
          : undefined;
      io.err(
        renderOnboardingStopped({
          completedSteps:
            partialSkills === undefined
              ? completedSteps
              : [...completedSteps, partialSkills],
          failure: errorMessage(error),
          retryCommand,
        }),
      );
      return 1;
    }
  }

  if (command === "cycle") {
    if (subcommand !== "current" || parsed.positionals.length !== 2) {
      io.err("cycle requires current");
      return 2;
    }
    if (
      parsed.values.db !== undefined ||
      parsed.values.backend !== undefined ||
      parsed.values.repo !== undefined ||
      parsed.values.base !== undefined ||
      parsed.values["fake-script"] !== undefined ||
      parsed.values["no-color"] !== undefined
    ) {
      io.err("cycle current does not accept options");
      return 2;
    }
    try {
      io.out((await currentCycle(runtime)).id);
      return 0;
    } catch (error) {
      io.err(errorMessage(error));
      return 1;
    }
  }

  if (command === "task" && subcommand === "import") {
    const manifestPath = parsed.positionals.at(2);
    if (parsed.positionals.length !== 3 || manifestPath === undefined) {
      io.err("task import requires FILE");
      return 2;
    }
    if (
      parsed.values.backend !== undefined ||
      parsed.values.repo !== undefined ||
      parsed.values.base !== undefined ||
      parsed.values["fake-script"] !== undefined ||
      parsed.values["no-color"] !== undefined ||
      parsed.values.global !== undefined
    ) {
      io.err("task import accepts only FILE and --db PATH");
      return 2;
    }
    try {
      const input: unknown = await Bun.file(resolve(manifestPath)).json();
      if (usesLegacyWeekId(input)) {
        throw new Error("Manifest uses weekId; replace it with cycleId");
      }
      const manifest = BacklogManifestSchema.parse(input);
      for (const task of manifest.tasks) safeTaskPathComponent(task.id);
      const db = openDatabase(dbPath);
      try {
        const result = new PlanningRepository(db).importBacklog(manifest);
        io.out(
          [
            `Created: ${result.created}`,
            `Already present: ${result.skipped}`,
            `Total: ${result.total}`,
            "Next:",
            `  npx roc-it@latest task list${
              parsed.values.db === undefined
                ? ""
                : ` --db ${shellLiteral(parsed.values.db)}`
            }`,
          ].join("\n"),
        );
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
        io.out(
          tasks.length
            ? tasks
                .map(
                  (task) =>
                    `- ${JSON.stringify(task.id)} [${task.status}] ${JSON.stringify(task.title)}`,
                )
                .join("\n")
            : renderEmptyTaskList(),
        );
        return 0;
      } finally {
        db.close();
      }
    } catch (error) {
      io.err(errorMessage(error));
      return 1;
    }
  }

  if (command === "tokens") {
    if (subcommand !== undefined || parsed.positionals.length !== 1) {
      io.err("tokens does not accept positional arguments");
      return 2;
    }
    if (
      parsed.values.backend !== undefined ||
      parsed.values.repo !== undefined ||
      parsed.values.base !== undefined ||
      parsed.values["fake-script"] !== undefined
    ) {
      io.err("tokens accepts only --db PATH and --no-color");
      return 2;
    }
    try {
      const cycle = await currentCycle(runtime);
      const db = openDatabase(dbPath);
      try {
        const usage = new OrchestrationRepository(db).getCycleCategoryUsage(
          cycle.id,
        );
        if (usage === undefined) {
          io.out(`No token usage recorded for cycle: ${cycle.id}`);
          return 0;
        }
        io.out(
          renderTokenUsageChart(cycle.id, usage.categories, {
            color: !parsed.values["no-color"],
            width: process.stdout.columns ?? 80,
          }),
        );
        return 0;
      } finally {
        db.close();
      }
    } catch (error) {
      return reportOperationalError(
        error,
        io,
        runtime,
        { dbPath },
        {
          code: "TOKEN_USAGE_READ_FAILED",
          category: "infra",
          retryable: false,
          component: "cli",
          message: "Could not read token usage",
        },
      );
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
      const codexDbPath =
        parsed.values.db === undefined
          ? join(repoPath, ".agile", "runtime", "agile.db")
          : dbPath;
      const input: SchedulerRunInput = {
        backend,
        dbPath: codexDbPath,
        repoPath,
        baseRef: parsed.values.base ?? "HEAD",
      };
      try {
        io.out("Status: Starting");
        await runtime.runScheduler(input);
        io.out("Result: Stopped");
        return 0;
      } catch (error) {
        return reportOperationalError(error, io, runtime, {
          dbPath: codexDbPath,
          repoPath,
        });
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
      scenario = FakeScenarioSchema.parse(
        await Bun.file(resolve(fakeScript)).json(),
      );
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
        io.out(
          JSON.stringify(new OrchestrationRepository(db).inspect(), null, 2),
        );
        return 0;
      } finally {
        db.close();
      }
    } catch (error) {
      io.err(errorMessage(error));
      return 1;
    }
  }

  io.err(
    `Unknown command: ${parsed.positionals.join(" ")}\nRun npx roc-it@latest help`,
  );
  return 2;
}
