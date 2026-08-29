import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import type { GitHubIssueCandidate } from "../../src/github/import-source";
import { saveRocSettings } from "../../src/settings";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";

const cycleId = "2026-08-28-P14D";
const validBody = `## Problem

Approved work is not in Roc.

## Desired outcome

Create a ready task.

## Scope

- import the Issue

## Non-goals

- None

## Acceptance criteria

- the task is claimable

## Validation

- bun test`;

/** Creates one deterministic ready GitHub Issue candidate. */
function candidate(body: string | null = validBody): GitHubIssueCandidate {
  return {
    number: 12,
    title: "Import approved work",
    body,
    url: "https://github.com/owner/repository/issues/12",
  };
}

/** Creates the fixed cycle settings used by CLI import tests. */
async function configureCycle(root: string): Promise<void> {
  await saveRocSettings(
    { cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" } },
    root,
  );
}

test("imports through the CLI and skips the unchanged task on repeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-github-command-"));
  const dbPath = join(root, "agile.db");
  const output: string[] = [];
  let reads = 0;
  await configureCycle(root);
  const runtime = {
    runScheduler: async () => {},
    homeRoot: root,
    now: () => new Date(2026, 7, 28, 12),
    readGitHubIssues: async () => {
      reads += 1;
      return [candidate(reads === 1 ? validBody : null)];
    },
  };
  const io = {
    out: (text: string) => output.push(text),
    err: (text: string) => output.push(text),
  };

  try {
    expect(
      await runCli(["task", "import-github", "--db", dbPath], io, runtime),
    ).toBe(0);
    const firstDb = openDatabase(dbPath);
    const firstTask = firstDb
      .query<
        {
          status: string;
          approved: number;
          spec_json: string;
          updated_at: string;
        },
        []
      >(
        "SELECT status, approved, spec_json, updated_at FROM tasks WHERE id = 'github-12'",
      )
      .get();
    expect(new PlanningRepository(firstDb).listTasks()).toMatchObject([
      { id: "github-12", cycleId, status: "ready", approved: true },
    ]);
    firstDb.close();

    expect(
      await runCli(["task", "import-github", "--db", dbPath], io, runtime),
    ).toBe(0);
    const secondDb = openDatabase(dbPath);
    expect(
      secondDb
        .query<
          {
            status: string;
            approved: number;
            spec_json: string;
            updated_at: string;
          },
          []
        >(
          "SELECT status, approved, spec_json, updated_at FROM tasks WHERE id = 'github-12'",
        )
        .get(),
    ).toEqual(firstTask);
    secondDb.close();
    expect(output).toEqual([
      "created=1 skipped=0 total=1",
      "created=0 skipped=1 total=1",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an empty successful import", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-github-command-"));
  const output: string[] = [];
  await configureCycle(root);
  try {
    expect(
      await runCli(
        ["task", "import-github", "--db", ":memory:"],
        { out: (text) => output.push(text), err: (text) => output.push(text) },
        {
          runScheduler: async () => {},
          homeRoot: root,
          now: () => new Date(2026, 7, 28, 12),
          readGitHubIssues: async () => [],
        },
      ),
    ).toBe(0);
    expect(output).toEqual(["created=0 skipped=0 total=0"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unapproved arguments before GitHub or database access", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-github-command-"));
  const dbPath = join(root, "not-created.db");
  const errors: string[] = [];
  let contactedGitHub = false;
  try {
    expect(
      await runCli(
        ["task", "import-github", "--db", dbPath, "--backend", "fake"],
        { out: () => {}, err: (text) => errors.push(text) },
        {
          runScheduler: async () => {},
          readGitHubIssues: async () => {
            contactedGitHub = true;
            return [];
          },
        },
      ),
    ).toBe(2);
    expect(contactedGitHub).toBeFalse();
    expect(existsSync(dbPath)).toBeFalse();
    expect(errors).toEqual(["task import-github accepts only --db PATH"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports prerequisite and atomic database failures with exit code 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-github-command-"));
  const dbPath = join(root, "agile.db");
  const unopenedDbPath = join(root, "not-created.db");
  const errors: string[] = [];
  await configureCycle(root);
  const runtime = {
    runScheduler: async () => {},
    homeRoot: root,
    now: () => new Date(2026, 7, 28, 12),
  };
  try {
    expect(
      await runCli(
        ["task", "import-github", "--db", unopenedDbPath],
        { out: () => {}, err: (text) => errors.push(text) },
        {
          ...runtime,
          readGitHubIssues: async () => {
            throw new Error(
              "GitHub CLI is not installed. Install it with: brew install gh",
            );
          },
        },
      ),
    ).toBe(1);
    expect(existsSync(unopenedDbPath)).toBeFalse();

    const db = openDatabase(dbPath);
    db.exec(`
      CREATE TRIGGER reject_import_event
      BEFORE INSERT ON events
      BEGIN
        SELECT RAISE(ABORT, 'event failure');
      END;
    `);
    db.close();
    expect(
      await runCli(
        ["task", "import-github", "--db", dbPath],
        { out: () => {}, err: (text) => errors.push(text) },
        { ...runtime, readGitHubIssues: async () => [candidate()] },
      ),
    ).toBe(1);
    const stored = openDatabase(dbPath);
    expect(
      stored
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM cycles")
        .get()?.count,
    ).toBe(0);
    expect(
      stored
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM tasks")
        .get()?.count,
    ).toBe(0);
    stored.close();
    expect(errors).toEqual([
      "GitHub CLI is not installed. Install it with: brew install gh",
      expect.stringContaining("event failure"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
