import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

/** Reports whether an error represents a missing filesystem entry. */
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Verifies that a path exists as a real directory rather than a symbolic link. */
function assertRealDirectory(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error(`Runtime path component is a symbolic link: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Runtime path component is not a directory: ${path}`);
  }
}

/** Creates a private directory when absent and verifies its canonical identity. */
function ensureRealDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EEXIST")
    ) {
      throw error;
    }
  }
  assertRealDirectory(path);
  if (realpathSync(path) !== path) {
    throw new Error(
      `Runtime path component changed during validation: ${path}`,
    );
  }
}

/** Builds and validates the runtime parent beneath the first `.agile` directory. */
function agileRuntimeParent(absolute: string): string | undefined {
  const directory = dirname(absolute);
  const root = parse(directory).root;
  const components = relative(root, directory).split(sep).filter(Boolean);
  const agileIndex = components.indexOf(".agile");
  if (agileIndex < 0) return undefined;

  const anchor = join(root, ...components.slice(0, agileIndex));
  let safeParent = realpathSync(anchor);
  for (const component of components.slice(agileIndex)) {
    safeParent = join(safeParent, component);
    ensureRealDirectory(safeParent);
  }
  return safeParent;
}

/** Resolves a safe writable file path while creating only validated real directories. */
export function prepareSafeFilePath(inputPath: string): string {
  const absolute = resolve(inputPath);
  const validatedAgileParent = agileRuntimeParent(absolute);
  if (validatedAgileParent !== undefined) {
    return validateTarget(join(validatedAgileParent, basename(absolute)));
  }
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
    ensureRealDirectory(safeParent);
  }

  return validateTarget(join(safeParent, basename(absolute)));
}

/** Rejects a target that already exists as a symlink or non-file entry. */
function validateTarget(safePath: string): string {
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
