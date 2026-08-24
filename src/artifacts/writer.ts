import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TaskCreateSchema, type TaskCreate } from "../domain/schemas";

export function renderTicketArtifact(input: TaskCreate): string {
  const task = TaskCreateSchema.parse(input);
  const bullets = (values: string[]) => values.length ? values.map((v) => `- ${v}`).join("\n") : "- None";
  return [
    `# ${task.id} — ${task.title}`,
    "",
    `Week: ${task.weekId}`,
    `Risk: ${task.spec.risk}`,
    `Token ceiling: ${task.spec.tokenCeiling}`,
    "",
    "## Problem",
    "",
    task.spec.problem,
    "",
    "## Desired outcome",
    "",
    task.spec.desiredOutcome,
    "",
    "## Scope",
    "",
    bullets(task.spec.scope),
    "",
    "## Non-goals",
    "",
    bullets(task.spec.nonGoals),
    "",
    "## Acceptance criteria",
    "",
    bullets(task.spec.acceptanceCriteria),
    "",
    "## Validation",
    "",
    bullets(task.spec.validation),
    "",
  ].join("\n");
}

export async function writeTicketArtifact(
  projectRoot: string,
  input: TaskCreate,
): Promise<{ path: string; sha256: string }> {
  const task = TaskCreateSchema.parse(input);
  const directory = join(projectRoot, ".agile", "tickets");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${task.id}.md`);
  const content = renderTicketArtifact(task);
  await Bun.write(path, content);
  const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  return { path, sha256 };
}
