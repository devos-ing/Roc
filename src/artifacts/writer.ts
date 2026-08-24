import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TaskCreateSchema, type TaskCreate } from "../domain/schemas";

// Artifact filenames use a portable task-ID subset: an ASCII letter/digit first,
// followed by ASCII letters, digits, underscores, or hyphens.
const SafeArtifactTaskId = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function renderTicketArtifact(input: TaskCreate): string {
  const task = TaskCreateSchema.parse(input);
  const bullets = (values: string[]) => values.length ? values.map((v) => `- ${v}`).join("\n") : "- None";
  const contexts = task.spec.contextCandidates.length
    ? task.spec.contextCandidates.map((ref) => [
      `- Thread: ${ref.threadId}; Anchor: ${ref.anchorId}; Source task: ${ref.sourceTaskId}; Git commit: ${ref.gitCommit}; Summary artifact: ${ref.summaryArtifact ?? "None"}`,
    ]).join("\n")
    : "- None";
  return [
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
  ].join("\n\n") + "\n";
}

export async function writeTicketArtifact(
  projectRoot: string,
  input: TaskCreate,
): Promise<{ path: string; sha256: string }> {
  const task = TaskCreateSchema.parse(input);
  const directory = join(projectRoot, ".agile", "tickets");
  if (!SafeArtifactTaskId.test(task.id)) {
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
  await mkdir(directory, { recursive: true });
  const content = renderTicketArtifact(task);
  await Bun.write(path, content);
  const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  return { path, sha256 };
}
