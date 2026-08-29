import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { activeAgileCycle } from "../domain/agile-cycle";
import { normalizeError } from "../runtime/errors";
import { loadRocSettings } from "../settings";
import { resolveProjectRoot } from "./project-root";
import type { CliCommandContext, CliRuntime } from "./types";

export type OperationalErrorFallback = {
  code: string;
  category: "startup" | "protocol" | "infra" | "policy" | "domain";
  retryable: boolean;
  component: string;
  message: string;
};

/** Converts an unknown thrown value into a displayable error message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loads settings and calculates the active Agile cycle for the CLI clock. */
export async function currentCycle(runtime: CliRuntime) {
  const settings = await loadRocSettings(runtime.homeRoot ?? homedir());
  return activeAgileCycle(settings.cycle, runtime.now?.() ?? new Date());
}

/** Resolves an injected project or discovers the project that owns this invocation. */
export async function commandProjectRoot(
  context: CliCommandContext,
  options: { allowCurrentDirectory?: boolean } = {},
): Promise<string> {
  if (context.runtime.projectRoot !== undefined) {
    return resolve(context.runtime.projectRoot);
  }
  return resolveProjectRoot(process.cwd(), options);
}

/** Returns the fixed scheduler database path beneath a project root. */
export function projectDatabasePath(projectRoot: string): string {
  return join(projectRoot, ".agile", "runtime", "agile.db");
}

/** Safely reports an operational failure to structured logging and standard error. */
export async function reportOperationalError(
  error: unknown,
  context: CliCommandContext,
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
    await context.runtime.logError?.(safe, input);
  } catch {
    // The operational error remains authoritative if safe logging itself fails.
  }
  context.io.err(`${safe.code}: ${safe.message}`);
  return 1;
}
