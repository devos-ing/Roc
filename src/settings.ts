import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
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

// Only fixed public schema names may appear in diagnostics, never arbitrary keys.
const publicFieldNames = new Set([
  "cycle",
  "type",
  "days",
  "anchorDate",
  "skills",
  "allowlist",
  "name",
  "source",
  "execution",
  "allowUnsandboxed",
  "models",
  "luna",
  "terra",
  "sol",
  "efforts",
  "scout",
  "implement",
  "review",
  "publicationMode",
]);
const repairGuidance =
  "Back up this file, then repair it manually using the supported settings format in README.details.md (Progress and recovery) and retry; onboarding reads the same file and cannot repair it.";

/** Wraps a safe location-specific diagnostic in Roc's stable startup error. */
function invalidSettings(path: string, diagnostic: string): AgileError {
  return new AgileError({
    code: "ROC_SETTINGS_INVALID",
    category: "startup",
    retryable: false,
    component: "settings",
    message: `Roc settings at ${path}: ${diagnostic}`,
  });
}

/** Summarizes schema failures with bounded public names and no values or raw errors. */
function validationDiagnostic(error: unknown): string {
  if (!(error instanceof ZodError))
    return "Invalid settings data; check cycle data, including calendar dates.";
  const names = new Set<string>();
  let hidden = 0;
  let invalidCycle = false;
  let invalidOther = false;
  for (const issue of error.issues) {
    const keys =
      issue.code === "unrecognized_keys"
        ? issue.keys
        : issue.code === "invalid_key"
          ? [issue.path.at(-1)]
          : undefined;
    if (keys) {
      for (const key of keys) {
        if (typeof key === "string" && publicFieldNames.has(key))
          names.add(key);
        else hidden++;
      }
    } else if (issue.path[0] === "cycle") invalidCycle = true;
    else invalidOther = true;
  }
  const shown = [...names].sort().slice(0, 3);
  hidden += names.size - shown.length;
  if (hidden) shown.push(`${hidden} other field name(s) hidden`);
  return [
    shown.length ? `Unsupported fields: ${shown.join(", ")}.` : "",
    invalidCycle
      ? "Invalid cycle data; use daily, weekly, or custom with positive whole days and a valid anchorDate (YYYY-MM-DD)."
      : "",
    invalidOther
      ? "Invalid settings data; check the supported settings types and structure."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Loads strict settings for repeat onboarding, returning undefined only when absent. */
export async function loadRocSettingsIfPresent(
  homeRoot = homedir(),
): Promise<RocSettings | undefined> {
  const path = rocSettingsPath(homeRoot);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingSettings(error)) return undefined;
    throw invalidSettings(
      path,
      "Could not read settings. Check that the path is a regular file and that your account has file and parent-directory permissions; retry after fixing access.",
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    throw invalidSettings(path, `Invalid JSON. ${repairGuidance}`);
  }
  try {
    return RocSettingsSchema.parse(input);
  } catch (error) {
    throw invalidSettings(
      path,
      `${validationDiagnostic(error)} ${repairGuidance}`,
    );
  }
}

/** Loads and strictly validates Roc's global settings. */
export async function loadRocSettings(
  homeRoot = homedir(),
): Promise<RocSettings> {
  const settings = await loadRocSettingsIfPresent(homeRoot);
  if (settings !== undefined) return settings;
  throw invalidSettings(
    rocSettingsPath(homeRoot),
    "Settings file is missing. Run npx roc-it@latest onboard to configure an Agile cycle",
  );
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
