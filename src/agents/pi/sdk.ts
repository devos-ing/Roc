// Pi 0.82.1's SDK barrel loads a native clipboard addon that hangs during
// Bun/macOS shutdown. Load only the model/settings modules for onboarding.
// These paths are tied to the pinned Pi dependency; recheck them on upgrades.
type PiSdk = typeof import("@earendil-works/pi-coding-agent");
const entrypoint = import.meta.resolve("@earendil-works/pi-coding-agent");
const [models, settings, config] = await Promise.all([
  import(new URL("./core/model-runtime.js", entrypoint).href),
  import(new URL("./core/settings-manager.js", entrypoint).href),
  import(new URL("./config.js", entrypoint).href),
]);

/** Resolves providers and credentials through Pi without loading its terminal UI. */
export const ModelRuntime: PiSdk["ModelRuntime"] = models.ModelRuntime;
export type ModelRuntime =
  import("@earendil-works/pi-coding-agent").ModelRuntime;
/** Persists Pi's user settings with its existing locking and merge behavior. */
export const SettingsManager: PiSdk["SettingsManager"] =
  settings.SettingsManager;
export type SettingsManager =
  import("@earendil-works/pi-coding-agent").SettingsManager;
/** Resolves Pi's credential and settings directory using its native configuration. */
export const getAgentDir: PiSdk["getAgentDir"] = config.getAgentDir;
