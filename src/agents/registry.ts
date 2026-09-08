import { startPiBackend } from "./pi/backend";

/** Pi is the sole public execution backend; model providers are configured in Pi. */
export const backends = { pi: startPiBackend } as const;

export type RealBackendName = keyof typeof backends;

/** Narrows a parsed CLI backend flag to the supported Pi backend. */
export function isRealBackendName(value: unknown): value is RealBackendName {
  return typeof value === "string" && Object.hasOwn(backends, value);
}
