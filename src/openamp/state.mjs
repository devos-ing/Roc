import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export const STATE_VERSION = 1;

/** Rejects symbolic links at a durable state target. */
async function assertSafeTarget(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`OpenAmp state target is not a regular file: ${path}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** Rejects symbolic-link directories in an absolute durable-state path. */
async function assertSafeParents(path) {
  const absolute = resolve(path);
  if (!isAbsolute(absolute))
    throw new Error("OpenAmp state path must be absolute");
  const root = parse(absolute).root;
  const relativeParts = dirname(absolute)
    .slice(root.length)
    .split(/[\\/]/u)
    .filter(Boolean);
  let current = root;
  for (const part of relativeParts) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `OpenAmp state parent is not a real directory: ${current}`,
      );
    }
  }
}

/** Writes JSON through an exclusive temporary file and atomic rename. */
export async function writeJsonAtomic(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertSafeParents(path);
  await assertSafeTarget(path);
  const temporary = join(parent, `.${process.pid}-${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Loads and minimally validates one versioned OpenAmp change record. */
export async function readChange(path) {
  await assertSafeTarget(path);
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    value?.version !== STATE_VERSION ||
    typeof value?.id !== "string" ||
    typeof value?.workspace !== "string" ||
    typeof value?.runs !== "object" ||
    typeof value?.results !== "object"
  ) {
    throw new Error(`Invalid OpenAmp change state: ${path}`);
  }
  return value;
}

/** Serializes state updates so one process remains the sole metadata writer. */
export class ChangeStore {
  #pending = Promise.resolve();

  /** Creates a store for one durable change file and initial state. */
  constructor(path, state) {
    this.path = path;
    this.state = state;
  }

  /** Persists the current state after applying one synchronous mutation. */
  async update(mutate) {
    const operation = this.#pending.then(async () => {
      mutate(this.state);
      this.state.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.path, this.state);
      return this.state;
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  /** Waits until all queued state writes have settled successfully. */
  async flush() {
    await this.#pending;
  }
}
