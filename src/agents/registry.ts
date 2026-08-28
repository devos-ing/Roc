import { startCodexBackend } from "./codex";

/**
 * The backend registry: adding a backend means one factory here plus one CLI
 * flag, with no new branches in the scheduler, store, or run loop.
 */
export const backends = {
  codex: startCodexBackend,
} as const;

export type BackendName = keyof typeof backends;
