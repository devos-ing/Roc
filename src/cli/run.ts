import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { helpText } from "./help";
import { openDatabase } from "../store/database";
import { PlanningRepository } from "../store/planning-repository";
import { FakeScenarioSchema } from "../harness/contracts";
import { createFakeHarness } from "../harness/fake";
import { SchedulerDaemon } from "../scheduler/daemon";
import { Scheduler } from "../scheduler/scheduler";
import { OrchestrationRepository } from "../store/orchestration-repository";

export type CliIo = { out(text: string): void; err(text: string): void };
type SchedulerRunInput = { dbPath: string; scenario: unknown };
type CliRuntime = { runScheduler(input: SchedulerRunInput): Promise<void> };

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

const defaultRuntime: CliRuntime = {
  async runScheduler({ dbPath, scenario }) {
    const db = openDatabase(dbPath);
    const stop = new AbortController();
    const onSignal = () => stop.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      const fake = createFakeHarness(scenario);
      const repo = new OrchestrationRepository(db);
      const scheduler = new Scheduler(repo, fake.harness);
      const daemon = new SchedulerDaemon(scheduler, repo, {
        ownerId: `scheduler-${crypto.randomUUID()}`,
        now: () => new Date(),
        sleep: schedulerSleep,
      });
      await daemon.run(() => stop.signal.aborted);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      db.close();
    }
  },
};

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
    const fakeScript = parsed.values["fake-script"];
    if (!fakeScript) {
      io.err("scheduler run requires --fake-script PATH");
      return 2;
    }
    let scenario: unknown;
    try {
      scenario = FakeScenarioSchema.parse(await Bun.file(resolve(fakeScript)).json());
    } catch (error) {
      io.err(errorMessage(error));
      return 2;
    }
    try {
      await runtime.runScheduler({ dbPath, scenario });
      return 0;
    } catch (error) {
      io.err(errorMessage(error));
      return 1;
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
