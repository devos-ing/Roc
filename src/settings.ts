import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type RocSettings, RocSettingsSchema } from "./domain/agile-cycle";
import { AgileError } from "./runtime/errors";
import { prepareSafeFilePath } from "./runtime/safe-file";

/** Resolves Roc's global settings file beneath an injectable home directory. */
export function rocSettingsPath(homeRoot = homedir()): string {
  return join(homeRoot, ".config", "roc", "settings.json");
}

/** Reports whether a settings read failed because the file does not exist. */
function isMissingSettings(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Wraps one settings read or validation failure in Roc's stable startup error. */
function invalidSettings(error: unknown): AgileError {
  return new AgileError({
    code: "ROC_SETTINGS_INVALID",
    category: "startup",
    retryable: false,
    component: "settings",
    message: "Run npx roc-it@latest onboard to configure an Agile cycle",
    cause: error,
  });
}

/** Loads strict settings for repeat onboarding, returning undefined only when absent. */
export async function loadRocSettingsIfPresent(
  homeRoot = homedir(),
): Promise<RocSettings | undefined> {
  try {
    return RocSettingsSchema.parse(
      JSON.parse(await readFile(rocSettingsPath(homeRoot), "utf8")),
    );
  } catch (error) {
    if (isMissingSettings(error)) return undefined;
    throw invalidSettings(error);
  }
}

/** Loads and strictly validates Roc's global settings. */
export async function loadRocSettings(
  homeRoot = homedir(),
): Promise<RocSettings> {
  const settings = await loadRocSettingsIfPresent(homeRoot);
  if (settings !== undefined) return settings;
  throw invalidSettings(new Error("Roc settings do not exist"));
}

/** Validates and safely writes Roc's global settings. */
export async function saveRocSettings(
  input: RocSettings,
  homeRoot = homedir(),
): Promise<string> {
  const settings = RocSettingsSchema.parse(input);
  const path = prepareSafeFilePath(rocSettingsPath(homeRoot));
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}
