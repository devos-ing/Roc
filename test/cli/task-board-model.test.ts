import { expect, test } from "bun:test";
import { buildTaskBoardSnapshot } from "../../src/cli/task-board-model";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

const spec = {
  problem: "Show task state",
  desiredOutcome: "A deterministic board",
  scope: ["task board"],
  nonGoals: [],
  acceptanceCriteria: ["tasks are visible"],
  validation: ["bun test"],
  dependencies: [],
  risk: "medium" as const,
  contextCandidates: [],
  tokenCeiling: 1_000,
};

/** Creates a task-board model backed by an in-memory project database. */
function setup() {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db, () => "2026-08-24T00:00:00.000Z");
  const counters: Record<string, number> = {};
  const orchestration = new OrchestrationRepository(
    db,
    () => "2026-08-24T00:00:01.000Z",
    (kind) => {
      counters[kind] = (counters[kind] ?? 0) + 1;
      return `${kind}-${counters[kind]}`;
    },
  );
  return { db, planning, orchestration };
}

/** Creates a task with the supplied board-relevant fields. */
function createTask(
  planning: PlanningRepository,
  input: {
    id: string;
    cycleId?: string;
    priority: number;
    dependencies?: string[];
    approved?: boolean;
  },
): void {
  planning.createTask({
    id: input.id,
    cycleId: input.cycleId ?? "2026-W35",
    title: `${input.id} title`,
    spec: { ...spec, dependencies: input.dependencies ?? [] },
    priority: input.priority,
    approvalRequired: false,
    approved: input.approved ?? false,
  });
}

/** Builds a board snapshot from the two repository read models. */
function snapshot(input: {
  planning: PlanningRepository;
  orchestration: OrchestrationRepository;
  allCycles?: boolean;
}) {
  return buildTaskBoardSnapshot({
    tasks: input.planning.listTasks(),
    inspection: input.orchestration.inspect(),
    currentCycleId: "2026-W35",
    ...(input.allCycles === undefined ? {} : { allCycles: input.allCycles }),
  });
}

test("returns an empty valid snapshot for an empty project", () => {
  const { db, planning, orchestration } = setup();
  try {
    expect(snapshot({ planning, orchestration })).toEqual({
      currentCycleId: "2026-W35",
      scheduler: {},
      cycles: [],
      tasks: [],
      columns: { ready: [], inProgress: [], attention: [], done: [] },
    });
  } finally {
    db.close();
  }
});

test("maps every raw status to one board column while retaining it", () => {
  const { db, planning, orchestration } = setup();
  try {
    planning.createCycle({
      id: "2026-W35",
      goal: "Board states",
      nonGoals: [],
      tokenBudget: 10_000,
      ticketIds: [],
    });
    const statuses = [
      "draft",
      "needs_input",
      "needs_replan",
      "ready",
      "claimed",
      "scouting",
      "implementing",
      "reviewing",
      "done",
      "rejected",
      "failed_infra",
    ] as const;
    for (const [priority, status] of statuses.entries()) {
      createTask(planning, { id: status, priority });
      db.query("UPDATE tasks SET status = ? WHERE id = ?").run(status, status);
    }

    const board = snapshot({ planning, orchestration });
    expect(board.columns.ready.map((task) => task.rawStatus)).toEqual([
      "draft",
      "ready",
    ]);
    expect(board.columns.inProgress.map((task) => task.rawStatus)).toEqual([
      "claimed",
      "scouting",
      "implementing",
      "reviewing",
    ]);
    expect(board.columns.attention.map((task) => task.rawStatus)).toEqual([
      "needs_input",
      "needs_replan",
      "rejected",
      "failed_infra",
    ]);
    expect(board.columns.done.map((task) => task.rawStatus)).toEqual(["done"]);
    expect(board.tasks.map((task) => task.id).sort()).toEqual([...statuses].sort());
  } finally {
    db.close();
  }
});

test("keeps dependency-blocked ready tasks ready and filters cycles on request", () => {
  const { db, planning, orchestration } = setup();
  try {
    for (const cycleId of ["2026-W35", "2026-W36"]) {
      planning.createCycle({
        id: cycleId,
        goal: cycleId,
        nonGoals: [],
        tokenBudget: 10_000,
        ticketIds: [],
      });
    }
    createTask(planning, { id: "done", priority: 0 });
    createTask(planning, {
      id: "blocked",
      priority: 1,
      dependencies: ["done", "unfinished"],
    });
    createTask(planning, { id: "unfinished", priority: 2 });
    createTask(planning, { id: "other-cycle", cycleId: "2026-W36", priority: 0 });
    for (const id of ["done", "blocked", "unfinished", "other-cycle"])
      db.query("UPDATE tasks SET status = 'ready' WHERE id = ?").run(id);
    db.query("UPDATE tasks SET status = 'done' WHERE id = 'done'").run();

    const current = snapshot({ planning, orchestration });
    expect(current.tasks.map((task) => task.id)).toEqual([
      "done",
      "blocked",
      "unfinished",
    ]);
    expect(current.columns.ready.find((task) => task.id === "blocked")).toMatchObject({
      rawStatus: "ready",
      blockingDependencyIds: ["unfinished"],
    });
    expect(snapshot({ planning, orchestration, allCycles: true }).tasks.map((task) => task.id)).toEqual([
      "done",
      "other-cycle",
      "blocked",
      "unfinished",
    ]);
  } finally {
    db.close();
  }
});

test("places the active task first with its attempt, model, retry, and token totals", () => {
  const { db, planning, orchestration } = setup();
  try {
    planning.createCycle({
      id: "2026-W35",
      goal: "Active task",
      nonGoals: [],
      tokenBudget: 10_000,
      ticketIds: [],
    });
    createTask(planning, { id: "first-ready", priority: 0 });
    createTask(planning, { id: "active", priority: 2, approved: true });
    db.query("UPDATE tasks SET status = 'ready' WHERE id IN ('first-ready', 'active')").run();
    const claim = orchestration.claimNext();
    expect(claim).toEqual({ taskId: "active" });
    const attempt = orchestration.beginNextAttempt();
    if (attempt === undefined) throw new Error("Expected an active attempt");
    db.query(`
      INSERT INTO usage(
        id, cycle_id, task_id, attempt_id, category,
        input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "usage-1",
      "2026-W35",
      "active",
      attempt.attemptId,
      "scout",
      100,
      20,
      30,
      40,
    );

    const board = snapshot({ planning, orchestration });
    expect(board.tasks.map((task) => task.id)).toEqual(["active", "first-ready"]);
    expect(board.active).toMatchObject({
      taskId: "active",
      attemptId: attempt.attemptId,
      role: "scout",
      retryCount: 0,
    });
    expect(board.active?.model).toBe(board.tasks[0]?.attempts[0]?.model);
    expect(board.tasks[0]?.tokenTotals).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 40,
    });
  } finally {
    db.close();
  }
});
