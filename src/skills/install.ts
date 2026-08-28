import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

export type SkillInstallResult = {
  created: string[];
  skipped: string[];
};

/** Carries the known completed skill targets when installation stops at one destination. */
export class SkillInstallError extends Error {
  readonly completed: SkillInstallResult;
  readonly destination: string;

  /** Creates an installation error with the completed targets and destination that stopped. */
  constructor(input: {
    cause: unknown;
    completed: SkillInstallResult;
    destination: string;
  }) {
    super(
      input.cause instanceof Error ? input.cause.message : String(input.cause),
    );
    this.name = "SkillInstallError";
    this.completed = {
      created: [...input.completed.created],
      skipped: [...input.completed.skipped],
    };
    this.destination = input.destination;
  }
}

/** Reports whether an error means a filesystem path does not exist. */
function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Verifies that a path exists as a real directory rather than a symbolic link. */
async function assertRealDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink())
    throw new Error(`Skill path component is a symbolic link: ${path}`);
  if (!stats.isDirectory())
    throw new Error(`Skill path component is not a directory: ${path}`);
}

/** Creates a missing directory and verifies it is a real directory. */
async function ensureRealDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EEXIST")
    ) {
      throw error;
    }
  }
  await assertRealDirectory(path);
}

/** Installs the canonical Roc skill below one root without following symbolic links. */
export async function installRocCreateTasksSkill(input: {
  sourcePath: string;
  root: string;
}): Promise<SkillInstallResult> {
  const source = await readFile(input.sourcePath);
  const targets = [
    {
      directory: [".agents", "skills", "roc-create-tasks"],
      file: "SKILL.md",
    },
    {
      directory: [".claude", "skills", "roc-create-tasks"],
      file: "SKILL.md",
    },
  ];
  const result: SkillInstallResult = { created: [], skipped: [] };

  await assertRealDirectory(input.root);
  for (const target of targets) {
    const destination = join(input.root, ...target.directory, target.file);
    try {
      let directory = input.root;
      for (const component of target.directory) {
        directory = join(directory, component);
        await ensureRealDirectory(directory);
      }
      try {
        const stats = await lstat(destination);
        if (stats.isSymbolicLink()) {
          throw new Error(
            `Skill destination is a symbolic link: ${destination}`,
          );
        }
        if (!stats.isFile()) {
          throw new Error(`Skill destination is not a file: ${destination}`);
        }
        if (!(await readFile(destination)).equals(source)) {
          throw new Error(`Skill destination differs: ${destination}`);
        }
        result.skipped.push(destination);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        const file = await open(
          destination,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o644,
        );
        try {
          await file.writeFile(source);
        } finally {
          await file.close();
        }
        result.created.push(destination);
      }
    } catch (error) {
      throw new SkillInstallError({
        cause: error,
        completed: result,
        destination,
      });
    }
  }
  return result;
}
