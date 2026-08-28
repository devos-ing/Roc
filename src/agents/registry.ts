import { startCodexBackend } from "./codex/backend";

/**
 * The backend registry: adding a backend means one factory plus one entry
 * here, with no new branches in the CLI, scheduler, store, or run loop.
 */
export const backends = {
  codex: startCodexBackend,
} as const;

export type RealBackendName = keyof typeof backends;

/** Narrows a parsed CLI backend flag to a registered real backend name. */
export function isRealBackendName(value: unknown): value is RealBackendName {
  return typeof value === "string" && value in backends;
}
