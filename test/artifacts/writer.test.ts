import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTicketArtifact } from "../../src/artifacts/writer";

const task = {
  id: "F6",
  cycleId: "2026-W35",
  title: "Artifact writer",
  priority: 0,
  approvalRequired: false,
  approved: true,
  spec: {
    problem: "No readable ticket",
    desiredOutcome: "Markdown ticket",
    scope: ["render"],
    nonGoals: [],
    acceptanceCriteria: ["stable output"],
    validation: ["bun test"],
    dependencies: [],
    risk: "low" as const,
    contextCandidates: [],
    tokenCeiling: 10_000,
  },
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("writes exact deterministic Markdown and returns the hash of its bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-artifact-"));
  try {
    const input = {
      ...task,
      spec: {
        ...task.spec,
        dependencies: ["F2 schemas", "filesystem"],
        contextCandidates: [
          {
            threadId: "thread-1",
            anchorId: "anchor-1",
            sourceTaskId: "F1",
            gitCommit: "abc123",
            summaryArtifact: ".agile/evidence/F1.md",
          },
        ],
      },
    };
    const expected = [
      "# F6 — Artifact writer",
      "",
      "Cycle: 2026-W35",
      "Risk: low",
      "Token ceiling: 10000",
      "",
      "## Problem",
      "",
      "No readable ticket",
      "",
      "## Desired outcome",
      "",
      "Markdown ticket",
      "",
      "## Scope",
      "",
      "- render",
      "",
      "## Non-goals",
      "",
      "- None",
      "",
      "## Acceptance criteria",
      "",
      "- stable output",
      "",
      "## Validation",
      "",
      "- bun test",
      "",
      "## Dependencies",
      "",
      "- F2 schemas",
      "- filesystem",
      "",
      "## Context candidates",
      "",
      "- Thread: thread-1; Anchor: anchor-1; Source task: F1; Git commit: abc123; Summary artifact: .agile/evidence/F1.md",
      "",
    ].join("\n");

    const first = await writeTicketArtifact(root, input);
    const bytes = await readFile(first.path);
    expect(bytes.toString("utf8")).toBe(expected);
    expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const second = await writeTicketArtifact(root, input);
    expect(await readFile(second.path)).toEqual(bytes);
    expect(second).toEqual(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changes content and hash when dependencies or contexts change", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-artifact-"));
  try {
    const first = await writeTicketArtifact(root, task);
    const firstContent = await readFile(first.path, "utf8");
    const second = await writeTicketArtifact(root, {
      ...task,
      spec: {
        ...task.spec,
        dependencies: ["new dependency"],
        contextCandidates: [
          {
            threadId: "thread-2",
            anchorId: "anchor-2",
            sourceTaskId: "F2",
            gitCommit: "def456",
          },
        ],
      },
    });
    const secondContent = await readFile(second.path, "utf8");
    expect(firstContent).not.toContain("new dependency");
    expect(secondContent).toContain("new dependency");
    expect(secondContent).toContain("thread-2");
    expect(second.sha256).not.toBe(first.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid Zod input without creating a partial artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-artifact-"));
  try {
    await expect(
      writeTicketArtifact(root, {
        ...task,
        spec: { ...task.spec, acceptanceCriteria: [] },
      }),
    ).rejects.toThrow();
    expect(await pathExists(join(root, ".agile"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects traversal and unsafe task IDs before creating artifact directories", async () => {
  for (const id of [
    "../escaped",
    "nested/F6",
    "F6.md",
    "F6 with spaces",
    "F6\\nested",
  ]) {
    const root = await mkdtemp(join(tmpdir(), "agile-artifact-"));
    try {
      await expect(writeTicketArtifact(root, { ...task, id })).rejects.toThrow(
        `Unsafe artifact task ID: ${id}`,
      );
      expect(await pathExists(join(root, ".agile"))).toBe(false);
      expect(await pathExists(join(root, "escaped.md"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects a symlinked ticket directory without writing outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-artifact-root-"));
  const external = await mkdtemp(join(tmpdir(), "agile-artifact-external-"));
  try {
    await mkdir(join(root, ".agile"));
    await writeFile(join(external, "sentinel.txt"), "unchanged");
    await symlink(external, join(root, ".agile", "tickets"), "dir");

    await expect(writeTicketArtifact(root, task)).rejects.toThrow(
      /symbolic link/,
    );

    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
      "unchanged",
    );
    expect(await pathExists(join(external, "F6.md"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("rejects a symlinked destination without changing its external target", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-artifact-root-"));
  const external = await mkdtemp(join(tmpdir(), "agile-artifact-external-"));
  const externalTarget = join(external, "outside.md");
  const tickets = join(root, ".agile", "tickets");
  try {
    await mkdir(tickets, { recursive: true });
    await writeFile(externalTarget, "unchanged");
    await symlink(externalTarget, join(tickets, "F6.md"), "file");

    await expect(writeTicketArtifact(root, task)).rejects.toThrow(
      /symbolic link/,
    );

    expect(await readFile(externalTarget, "utf8")).toBe("unchanged");
    expect(await readdir(tickets)).toEqual(["F6.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
