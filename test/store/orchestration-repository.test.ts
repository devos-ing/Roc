import { expect, test } from "bun:test";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

const ticketSpec = {
  problem: "Need deterministic scheduling",
  desiredOutcome: "One task is claimed",
  scope: ["scheduler"],
  nonGoals: [],
  acceptanceCriteria: ["only one task is claimed"],
  validation: ["bun test"],
  dependencies: [],
  risk: "medium" as const,
  contextCandidates: [],
  tokenCeiling: 10_000,
};

function setup() {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db, () => "2026-08-25T00:00:00.000Z");
  planning.createWeek({
    id: "2026-W35",
    goal: "Deterministic scheduler",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: ["T1", "T2"],
  });
  for (const [id, priority] of [["T1", 0], ["T2", 1]] as const) {
    planning.createTask({
      id,
      weekId: "2026-W35",
      title: id,
      spec: ticketSpec,
      priority,
      approvalRequired: false,
      approved: true,
    });
    planning.transitionTask(id, "ready", `${id}:ready`);
  }
  const repo = new OrchestrationRepository(
    db,
    () => "2026-08-25T00:00:01.000Z",
    (kind) => `${kind}-1`,
  );
  return { db, repo };
}

test("claims the first approved ready task once", () => {
  const { db, repo } = setup();
  try {
    expect(repo.claimNext()).toEqual({ taskId: "T1" });
    expect(repo.claimNext()).toBeUndefined();
    expect(db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get("T1")?.status).toBe("claimed");
    expect(db.query<{ status: string }, [string]>("SELECT status FROM tasks WHERE id = ?").get("T2")?.status).toBe("ready");
  } finally {
    db.close();
  }
});

test("skips a task with an unfinished dependency", () => {
  const { db, repo } = setup();
  try {
    db.exec("INSERT INTO task_deps(task_id, depends_on_task_id, kind) VALUES ('T1', 'T2', 'blocks')");
    expect(repo.claimNext()).toEqual({ taskId: "T2" });
  } finally {
    db.close();
  }
});
