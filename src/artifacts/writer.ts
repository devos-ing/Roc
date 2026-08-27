import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type TaskCreate, TaskCreateSchema } from "../domain/schemas";
import { safeTaskPathComponent } from "../domain/task-path";

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function assertRealDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink())
    throw new Error(`Artifact path component is a symbolic link: ${path}`);
  if (!stats.isDirectory())
    throw new Error(`Artifact path component is not a directory: ${path}`);
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  await assertRealDirectory(path);
}

function assertContained(root: string, candidate: string): void {
  const candidateRelative = relative(root, candidate);
  if (
    candidateRelative === "" ||
    candidateRelative === ".." ||
    candidateRelative.startsWith(`..${sep}`) ||
    isAbsolute(candidateRelative)
  ) {
    throw new Error(
      `Artifact directory is outside the project root: ${candidate}`,
    );
  }
}

async function rejectDestinationSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Artifact destination is a symbolic link: ${path}`);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export function renderTicketArtifact(input: TaskCreate): string {
  const task = TaskCreateSchema.parse(input);
  const bullets = (values: string[]) =>
    values.length ? values.map((v) => `- ${v}`).join("\n") : "- None";
  const contexts = task.spec.contextCandidates.length
    ? task.spec.contextCandidates
        .map((ref) => [
          `- Thread: ${ref.threadId}; Anchor: ${ref.anchorId}; Source task: ${ref.sourceTaskId}; Git commit: ${ref.gitCommit}; Summary artifact: ${ref.summaryArtifact ?? "None"}`,
        ])
        .join("\n")
    : "- None";
  return (
    [
      `# ${task.id} — ${task.title}`,
      `Week: ${task.weekId}\nRisk: ${task.spec.risk}\nToken ceiling: ${task.spec.tokenCeiling}`,
      "## Problem",
      task.spec.problem,
      "## Desired outcome",
      task.spec.desiredOutcome,
      "## Scope",
      bullets(task.spec.scope),
      "## Non-goals",
      bullets(task.spec.nonGoals),
      "## Acceptance criteria",
      bullets(task.spec.acceptanceCriteria),
      "## Validation",
      bullets(task.spec.validation),
      "## Dependencies",
      bullets(task.spec.dependencies),
      "## Context candidates",
      contexts,
    ].join("\n\n") + "\n"
  );
}

export async function writeTicketArtifact(
  projectRoot: string,
  input: TaskCreate,
): Promise<{ path: string; sha256: string }> {
  const task = TaskCreateSchema.parse(input);
  const directory = join(projectRoot, ".agile", "tickets");
  try {
    safeTaskPathComponent(task.id);
  } catch {
    throw new Error(`Unsafe artifact task ID: ${task.id}`);
  }
  const path = join(directory, `${task.id}.md`);
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(path);
  const outputRelative = relative(resolvedDirectory, resolvedPath);
  if (
    outputRelative === "" ||
    outputRelative === ".." ||
    outputRelative.startsWith(`..${sep}`) ||
    isAbsolute(outputRelative)
  ) {
    throw new Error(`Unsafe artifact task ID: ${task.id}`);
  }
  const canonicalRoot = await realpath(projectRoot);
  const agileDirectory = join(canonicalRoot, ".agile");
  const ticketDirectory = join(agileDirectory, "tickets");
  await ensureRealDirectory(agileDirectory);
  await ensureRealDirectory(ticketDirectory);
  const canonicalTicketDirectory = await realpath(ticketDirectory);
  assertContained(canonicalRoot, canonicalTicketDirectory);
  if (canonicalTicketDirectory !== ticketDirectory) {
    throw new Error(
      `Artifact ticket directory changed during validation: ${ticketDirectory}`,
    );
  }

  const destination = join(canonicalTicketDirectory, `${task.id}.md`);
  await rejectDestinationSymlink(destination);

  const content = renderTicketArtifact(task);
  const temporary = join(
    canonicalTicketDirectory,
    `.${task.id}.${randomUUID()}.tmp`,
  );
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const canonicalTemporary = await realpath(temporary);
    if (dirname(canonicalTemporary) !== canonicalTicketDirectory) {
      throw new Error(
        `Artifact temporary file is outside the ticket directory: ${temporary}`,
      );
    }
    await temporaryHandle.writeFile(content, "utf8");
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await assertRealDirectory(agileDirectory);
    await assertRealDirectory(ticketDirectory);
    if ((await realpath(ticketDirectory)) !== canonicalTicketDirectory) {
      throw new Error(
        `Artifact ticket directory changed before persistence: ${ticketDirectory}`,
      );
    }
    await rename(temporary, destination);
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  return { path, sha256 };
}
