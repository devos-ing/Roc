import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import { AgileError } from "../runtime/errors";

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
  try {
    const root = (
      await simpleGit({ baseDir: startPath }).revparse("--show-toplevel")
    ).trim();
    return root.length === 0 ? undefined : await realpath(root);
  } catch {
    return undefined;
  }
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
