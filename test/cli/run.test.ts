import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import { currentIsoWeekId } from "../../src/cli/token-chart";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";

const ansiSgrPattern = "\\u001B\\[[0-9;]*m";

test("onboard installs identical project skill copies without overwriting changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const output: string[] = [];
  const io = {
    out: (text: string) => output.push(text),
    err: (text: string) => output.push(text),
  };

  try {
    expect(
      await runCli(["onboard", "--db", dbPath], io, {
        runScheduler: async () => {},
        projectRoot: root,
      }),
    ).toBe(0);
    const source = await readFile(
      join(
        import.meta.dir,
        "..",
        "..",
        "skills",
        "roc-create-tasks",
        "SKILL.md",
      ),
    );
    const agentsSkill = join(
      root,
      ".agents",
      "skills",
      "roc-create-tasks",
      "SKILL.md",
    );
    const claudeSkill = join(
      root,
      ".claude",
      "skills",
      "roc-create-tasks",
      "SKILL.md",
    );
    expect(await readFile(agentsSkill)).toEqual(source);
    expect(await readFile(claudeSkill)).toEqual(source);
    expect(await lstat(dbPath)).toMatchObject({ isFile: expect.any(Function) });

    expect(
      await runCli(["onboard", "--db", dbPath], io, {
        runScheduler: async () => {},
        projectRoot: root,
      }),
    ).toBe(0);
    await writeFile(agentsSkill, "changed skill");
    expect(
      await runCli(["onboard", "--db", dbPath], io, {
        runScheduler: async () => {},
        projectRoot: root,
      }),
    ).toBe(1);
    expect(await readFile(agentsSkill, "utf8")).toBe("changed skill");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global onboarding installs skills without creating a project database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const output: string[] = [];

  try {
    expect(
      await runCli(
        ["onboard", "--global"],
        { out: (text) => output.push(text), err: (text) => output.push(text) },
        { runScheduler: async () => {}, projectRoot: root, homeRoot: home },
      ),
    ).toBe(0);
    expect(
      await readFile(
        join(home, ".agents", "skills", "roc-create-tasks", "SKILL.md"),
      ),
    ).toEqual(
      await readFile(
        join(home, ".claude", "skills", "roc-create-tasks", "SKILL.md"),
      ),
    );
    await expect(lstat(join(root, ".agile"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("onboarding refuses a symbolic-link path component", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const redirected = join(root, "redirected");
  await mkdir(redirected);
  await symlink(redirected, join(root, ".agents"));
  const errors: string[] = [];

  try {
    expect(
      await runCli(
        ["onboard", "--db", dbPath],
        { out: () => {}, err: (text) => errors.push(text) },
        { runScheduler: async () => {}, projectRoot: root },
      ),
    ).toBe(1);
    expect(errors[0]).toContain("symbolic link");
    await expect(lstat(join(redirected, "skills"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task import creates ready tasks, replays them, and rejects invalid input", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const manifestPath = join(root, "backlog.json");
  const malformedPath = join(root, "malformed.json");
  const firstTask = {
    id: "cli-import-01",
    title: "First imported task",
    priority: 0,
    spec: {
      problem: "No importer",
      desiredOutcome: "Imported work is ready",
      scope: ["import a backlog"],
      nonGoals: [],
      acceptanceCriteria: ["tasks are ready"],
      validation: ["bun test"],
      dependencies: [],
      risk: "medium",
      contextCandidates: [],
      tokenCeiling: 10_000,
    },
  };
  const secondTask = {
    id: "cli-import-02",
    title: "Second imported task",
    priority: 1,
    spec: { ...firstTask.spec, dependencies: ["cli-import-01"] },
  };
  const manifest = {
    weekId: "2026-W35",
    goal: "Import tasks from the CLI",
    tasks: [firstTask, secondTask],
  };
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    out: (text: string) => output.push(text),
    err: (text: string) => errors.push(text),
  };

  try {
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(malformedPath, "not JSON");
    expect(
      await runCli(["task", "import", manifestPath, "--db", dbPath], io),
    ).toBe(0);
    expect(output).toEqual(["Created 2, skipped 0, total 2."]);
    const db = openDatabase(dbPath);
    try {
      expect(new PlanningRepository(db).listTasks()).toMatchObject([
        { id: "cli-import-01", status: "ready" },
        { id: "cli-import-02", status: "ready" },
      ]);
    } finally {
      db.close();
    }
    expect(
      await runCli(["task", "import", manifestPath, "--db", dbPath], io),
    ).toBe(0);
    expect(output.at(-1)).toBe("Created 0, skipped 2, total 2.");
    expect(
      await runCli(["task", "import", malformedPath, "--db", dbPath], io),
    ).toBe(1);

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        tasks: [{ ...firstTask, title: "Conflicting title" }],
      }),
    );
    expect(
      await runCli(["task", "import", manifestPath, "--db", dbPath], io),
    ).toBe(1);
    const replayDb = openDatabase(dbPath);
    try {
      expect(new PlanningRepository(replayDb).listTasks()).toHaveLength(2);
    } finally {
      replayDb.close();
    }
    expect(await runCli(["task", "import"], io)).toBe(2);
    expect(await runCli(["task", "import", manifestPath, "extra"], io)).toBe(2);
    expect(await runCli(["task", "import", manifestPath, "--global"], io)).toBe(
      2,
    );
    expect(errors).toHaveLength(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational database failures report an error, return 1, and close the database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "future.db");
  const future = new Database(dbPath, { create: true });
  future.exec("PRAGMA user_version = 4");
  future.close();
  const output: string[] = [];
  const errors: string[] = [];
  const close = spyOn(Database.prototype, "close");

  try {
    expect(
      await runCli(["task", "list", "--db", dbPath], {
        out: (text) => output.push(text),
        err: (text) => errors.push(text),
      }),
    ).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual([
      "Database version 4 is newer than supported version 3",
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("argument and unknown-command errors keep exit code 2", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const io = {
    out: (text: string) => output.push(text),
    err: (text: string) => errors.push(text),
  };

  expect(await runCli(["--unknown-option"], io)).toBe(2);
  expect(await runCli(["unknown"], io)).toBe(2);
  expect(await runCli(["init"], io)).toBe(2);
  expect(output).toEqual([]);
  expect(errors).toHaveLength(3);
  expect(errors[1]).toBe("Unknown command: unknown");
});

test("tokens prints the current-week report", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const weekId = currentIsoWeekId();
  const db = openDatabase(dbPath);
  new PlanningRepository(db).createWeek({
    id: weekId,
    goal: "See token usage",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: [],
  });
  db.query(`
    INSERT INTO usage(
      id, week_id, category,
      input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
    ) VALUES('cli-usage', ?, 'implement', 100, 80, 50, 30)
  `).run(weekId);
  db.close();
  const output: string[] = [];

  try {
    expect(
      await runCli(["tokens", "--db", dbPath], {
        out: (text) => output.push(text),
        err: (text) => output.push(text),
      }),
    ).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]!).toContain("\u001B[32m");
    expect(output[0]!.replace(new RegExp(ansiSgrPattern, "g"), "")).toContain(
      "Implement  150 tokens  100%  █",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tokens supports explicit plain output", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const weekId = currentIsoWeekId();
  const db = openDatabase(dbPath);
  new PlanningRepository(db).createWeek({
    id: weekId,
    goal: "See token usage",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: [],
  });
  db.query(`
    INSERT INTO usage(
      id, week_id, category,
      input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
    ) VALUES('cli-plain-usage', ?, 'implement', 100, 80, 50, 30)
  `).run(weekId);
  db.close();
  const output: string[] = [];

  try {
    expect(
      await runCli(["tokens", "--db", dbPath, "--no-color"], {
        out: (text) => output.push(text),
        err: (text) => output.push(text),
      }),
    ).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]!).not.toContain("\u001B[");
    expect(output[0]!).toContain("Implement  150 tokens  100%  █");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tokens reports a missing current week as an empty state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const output: string[] = [];

  try {
    expect(
      await runCli(["tokens", "--db", dbPath], {
        out: (text) => output.push(text),
        err: (text) => output.push(text),
      }),
    ).toBe(0);
    expect(output).toEqual([`No active week: ${currentIsoWeekId()}`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tokens rejects scheduler-only options and reports read failures through the runtime", async () => {
  const output: string[] = [];
  const logged: string[] = [];
  const runtime = {
    runScheduler: async () => {},
    logError: async (error: { code: string }) => {
      logged.push(error.code);
    },
  };

  expect(
    await runCli(
      ["tokens", "--backend", "fake"],
      {
        out: (text) => output.push(text),
        err: (text) => output.push(text),
      },
      runtime,
    ),
  ).toBe(2);

  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "future.db");
  const future = new Database(dbPath, { create: true });
  future.exec("PRAGMA user_version = 4");
  future.close();
  try {
    expect(
      await runCli(
        ["tokens", "--db", dbPath],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        runtime,
      ),
    ).toBe(1);
    expect(logged).toEqual(["TOKEN_USAGE_READ_FAILED"]);
    expect(output.at(-1)).toBe(
      "TOKEN_USAGE_READ_FAILED: Could not read token usage",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
