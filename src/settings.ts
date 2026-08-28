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

/** Loads and strictly validates Roc's global settings. */
export async function loadRocSettings(
  homeRoot = homedir(),
): Promise<RocSettings> {
  try {
    return RocSettingsSchema.parse(
      JSON.parse(await readFile(rocSettingsPath(homeRoot), "utf8")),
    );
  } catch (error) {
    throw new AgileError({
      code: "ROC_SETTINGS_INVALID",
      category: "startup",
      retryable: false,
      component: "settings",
      message: "Run npx roc-it@latest onboard to configure an Agile cycle",
      cause: error,
    });
  }
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
