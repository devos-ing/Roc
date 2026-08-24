import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTicketArtifact } from "../../src/artifacts/writer";

test("writes deterministic ticket Markdown and returns its SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-artifact-"));
  try {
    const result = await writeTicketArtifact(root, {
      id: "F6",
      weekId: "2026-W35",
      title: "Artifact writer",
      priority: 0,
      approvalRequired: false,
      approved: true,
      spec: {
        problem: "No readable ticket", desiredOutcome: "Markdown ticket",
        scope: ["render"], nonGoals: [], acceptanceCriteria: ["stable output"],
        validation: ["bun test"], dependencies: [], risk: "low",
        contextCandidates: [], tokenCeiling: 10_000,
      },
    });
    expect(result.path.endsWith(".agile/tickets/F6.md")).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(result.path, "utf8")).toContain("# F6 — Artifact writer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
