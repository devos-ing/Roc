import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertRealDirectory(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error(`Runtime path component is a symbolic link: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Runtime path component is not a directory: ${path}`);
  }
}

export function prepareSafeFilePath(inputPath: string): string {
  const absolute = resolve(inputPath);
  const missing: string[] = [];
  let existing = dirname(absolute);
  while (true) {
    try {
      assertRealDirectory(existing);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }

  let safeParent = realpathSync(existing);
  for (const component of missing) {
    safeParent = join(safeParent, component);
    try {
      mkdirSync(safeParent, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
    assertRealDirectory(safeParent);
  }

  const safePath = join(safeParent, basename(absolute));
  try {
    const target = lstatSync(safePath);
    if (target.isSymbolicLink()) {
      throw new Error(`Runtime file is a symbolic link: ${safePath}`);
    }
    if (!target.isFile()) {
      throw new Error(`Runtime file is not a regular file: ${safePath}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return safePath;
}
