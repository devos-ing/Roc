import { expect, test } from "bun:test";
import { importApprovedGitHubIssues } from "../../src/github/import-service";
import type { GitHubIssueCandidate } from "../../src/github/import-source";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";

const validBody = `## Problem

Issue work is not planned.

## Desired outcome

Create a ready Roc task.

## Scope

- import the Issue

## Non-goals

- None

## Acceptance criteria

- the task is ready

## Validation

- bun test`;

/** Creates a raw GitHub candidate with deterministic defaults. */
function candidate(
  number: number,
  body: string | null = validBody,
): GitHubIssueCandidate {
  return {
    number,
    title: `Issue ${number}`,
    body,
    url: `https://github.com/owner/repository/issues/${number}`,
  };
}

/** Reads one table's row count for rollback assertions. */
function countRows(
  db: ReturnType<typeof openDatabase>,
  table: "cycles" | "tasks" | "events",
): number {
  return (
    db
      .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
      .get()?.count ?? 0
  );
}

test("imports mapped ready tasks and skips repeated IDs before parsing", async () => {
  const db = openDatabase(":memory:");
  const repository = new PlanningRepository(
    db,
    () => "2026-08-28T00:00:00.000Z",
  );
  try {
    expect(
      await importApprovedGitHubIssues({
        repository,
        cycleId: "2026-08-28-P14D",
        readIssues: async () => [candidate(4), candidate(8)],
      }),
    ).toEqual({ created: 2, skipped: 0, total: 2 });
    expect(
      db
        .query<{ goal: string; token_budget: number }, []>(
          "SELECT goal, token_budget FROM cycles",
        )
        .get(),
    ).toEqual({
      goal: "Deliver approved GitHub Issues",
      token_budget: 24_000,
    });
    expect(repository.listTasks()).toMatchObject([
      {
        id: "github-4",
        cycleId: "2026-08-28-P14D",
        title: "Issue 4",
        status: "ready",
        priority: 4,
        approvalRequired: true,
        approved: true,
        spec: {
          problem:
            "GitHub source: https://github.com/owner/repository/issues/4\n\nIssue work is not planned.",
          desiredOutcome: "Create a ready Roc task.",
          scope: ["import the Issue"],
          nonGoals: [],
          acceptanceCriteria: ["the task is ready"],
          validation: ["bun test"],
          dependencies: [],
          risk: "medium",
          contextCandidates: [],
          tokenCeiling: 12_000,
        },
      },
      { id: "github-8", status: "ready", priority: 8 },
    ]);

    expect(
      await importApprovedGitHubIssues({
        repository,
        cycleId: "2026-08-28-P14D",
        readIssues: async () => [candidate(4, null)],
      }),
    ).toEqual({ created: 0, skipped: 1, total: 1 });
    expect(repository.listTasks()[0]?.title).toBe("Issue 4");
    expect(countRows(db, "events")).toBe(2);
  } finally {
    db.close();
  }
});

test("aggregates all pending validation failures before writing", async () => {
  const db = openDatabase(":memory:");
  const repository = new PlanningRepository(db);
  try {
    const error = await importApprovedGitHubIssues({
      repository,
      cycleId: "2026-W35",
      readIssues: async () => [candidate(3, ""), candidate(9, "invalid")],
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("Issue #3");
    expect((error as Error).message).toContain("Issue #9");
    expect(countRows(db, "cycles")).toBe(0);
    expect(countRows(db, "tasks")).toBe(0);
  } finally {
    db.close();
  }
});

test("rolls back the cycle and tasks when an audit event fails", async () => {
  const db = openDatabase(":memory:");
  const repository = new PlanningRepository(db);
  db.exec(`
    CREATE TRIGGER reject_import_event
    BEFORE INSERT ON events
    BEGIN
      SELECT RAISE(ABORT, 'event failure');
    END;
  `);
  try {
    await expect(
      importApprovedGitHubIssues({
        repository,
        cycleId: "2026-W35",
        readIssues: async () => [candidate(5)],
      }),
    ).rejects.toThrow("event failure");
    expect(countRows(db, "cycles")).toBe(0);
    expect(countRows(db, "tasks")).toBe(0);
    expect(countRows(db, "events")).toBe(0);
  } finally {
    db.close();
  }
});

test("reuses the active cycle without changing its goal or budget", async () => {
  const db = openDatabase(":memory:");
  const repository = new PlanningRepository(db);
  repository.createCycle({
    id: "2026-W35",
    goal: "Keep the existing goal",
    nonGoals: [],
    tokenBudget: 7_000,
    ticketIds: [],
  });
  try {
    expect(
      await importApprovedGitHubIssues({
        repository,
        cycleId: "2026-W35",
        readIssues: async () => [candidate(6)],
      }),
    ).toEqual({ created: 1, skipped: 0, total: 1 });
    expect(
      db
        .query<{ goal: string; token_budget: number }, []>(
          "SELECT goal, token_budget FROM cycles WHERE id = '2026-W35'",
        )
        .get(),
    ).toEqual({ goal: "Keep the existing goal", token_budget: 7_000 });
  } finally {
    db.close();
  }
});
