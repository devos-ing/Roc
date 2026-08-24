import { expect, test } from "bun:test";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";

const spec = {
  problem: "No task store",
  desiredOutcome: "Persist tasks",
  scope: ["repository"],
  nonGoals: [],
  acceptanceCriteria: ["task can transition"],
  validation: ["bun test"],
  dependencies: [],
  risk: "medium" as const,
  contextCandidates: [],
  tokenCeiling: 20_000,
};

test("creates a week and task and audits a valid transition", () => {
  const db = openDatabase(":memory:");
  const repo = new PlanningRepository(db, () => "2026-08-24T00:00:00.000Z");
  try {
    repo.createWeek({
      id: "2026-W35", goal: "Foundation", nonGoals: [], tokenBudget: 100_000, ticketIds: ["F1"],
    });
    repo.createTask({
      id: "F1", weekId: "2026-W35", title: "Repository", spec,
      priority: 0, approvalRequired: false, approved: true,
    });
    repo.transitionTask("F1", "ready", "test:F1:ready");

    expect(repo.listTasks()).toMatchObject([{ id: "F1", status: "ready", spec }]);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count).toBe(1);
    expect(() => repo.transitionTask("F1", "done", "test:F1:done")).toThrow(
      "Invalid task transition: ready -> done",
    );
  } finally {
    db.close();
  }
});
