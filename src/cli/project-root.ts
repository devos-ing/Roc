import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { AgileError } from "../runtime/errors";

const gitRepositoryEnvironmentVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const;

/** Returns a process environment without repository-local Git overrides. */
function gitPathResolutionEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const variable of gitRepositoryEnvironmentVariables) {
    delete environment[variable];
  }
  return environment;
}

/** Runs a local Git command without inheriting repository-local Git overrides. */
async function gitOutput(
  projectRoot: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["git", "-C", projectRoot, ...args], {
      env: gitPathResolutionEnvironment(),
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    const value = output.trim();
    return exitCode === 0 && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Returns whether a path names an existing directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Finds the nearest ancestor that contains Roc's project-state directory. */
async function findRocRoot(startPath: string): Promise<string | undefined> {
  let current = startPath;
  while (true) {
    if (await isDirectory(join(current, ".agile"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Resolves the containing Git checkout root or returns undefined outside Git. */
async function findGitRoot(startPath: string): Promise<string | undefined> {
  const root = await gitOutput(startPath, ["rev-parse", "--show-toplevel"]);
  if (root === undefined) return undefined;
  try {
    return await realpath(root);
  } catch {
    return undefined;
  }
}

/** Normalizes a repository or directory name into a stable display slug. */
export function normalizeProjectSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** Extracts the final repository path component from a Git remote origin. */
function originRepositoryName(origin: string): string | undefined {
  const path = origin.trim().replace(/\/+$/gu, "");
  if (path.length === 0) return undefined;
  const slash = path.lastIndexOf("/");
  const firstColon = path.indexOf(":");
  const bracketedHostStart = path.startsWith("[") ? 0 : path.indexOf("@[");
  const closingBracket =
    bracketedHostStart === -1 ? -1 : path.indexOf("]", bracketedHostStart);
  const hasBracketedIpv6Host =
    bracketedHostStart !== -1 &&
    closingBracket !== -1 &&
    firstColon > bracketedHostStart &&
    firstColon < closingBracket;
  const bracketedHostSeparator = hasBracketedIpv6Host
    ? path.indexOf(":", closingBracket)
    : -1;
  if (slash === -1 && hasBracketedIpv6Host && bracketedHostSeparator === -1)
    return undefined;
  const separator =
    slash === -1
      ? hasBracketedIpv6Host
        ? bracketedHostSeparator
        : firstColon
      : slash;
  const name = path.slice(separator + 1).replace(/\.git$/u, "");
  return name.length === 0 ? undefined : name;
}

/** Chooses a display-safe project slug from an origin or local project directory. */
export function projectDisplaySlug(
  origin: string | undefined,
  projectRoot: string,
): string {
  const originSlug = normalizeProjectSlug(
    originRepositoryName(origin ?? "") ?? "",
  );
  const rootSlug = normalizeProjectSlug(basename(projectRoot));
  return originSlug || rootSlug || "project";
}

/** Resolves a display-safe project slug from origin or the local project directory without network access. */
export async function resolveProjectDisplaySlug(
  projectRoot: string,
): Promise<string> {
  const origin = await gitOutput(projectRoot, ["remote", "get-url", "origin"]);
  return projectDisplaySlug(origin, projectRoot);
}

/** Resolves the Roc project that owns a command invocation. */
export async function resolveProjectRoot(
  startPath: string,
  options: { allowCurrentDirectory?: boolean } = {},
): Promise<string> {
  const start = await realpath(resolve(startPath));
  const rocRoot = await findRocRoot(start);
  if (rocRoot !== undefined) return rocRoot;
  const gitRoot = await findGitRoot(start);
  if (gitRoot !== undefined) return gitRoot;
  if (options.allowCurrentDirectory) return start;
  throw new AgileError({
    code: "PROJECT_ROOT_NOT_FOUND",
    category: "startup",
    retryable: false,
    component: "cli",
    message: "Run this command inside a Roc or Git project",
  });
}
