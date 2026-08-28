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
import { saveRocSettings } from "../../src/settings";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";

const ansiSgrPattern = "\\u001B\\[[0-9;]*m";
const onboardingNextSteps = [
  "Next:",
  "  Install the grilling skill if needed:",
  "    npx skills add mattpocock/skills --skill grilling --global --agent codex --agent claude-code --agent cursor",
  "  Create your first backlog in Claude Code or Cursor:",
  "    /roc-create-tasks <requirement>",
  "  Create your first backlog in Codex:",
  "    $roc-create-tasks <requirement>",
  "  Inspect the resulting tasks:",
  "    npx roc-it@latest task list",
].join("\n");

/** Creates deterministic interactive CLI I/O from queued answers. */
function interactiveIo(answers: string[]) {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      out: (text: string) => output.push(text),
      err: (text: string) => errors.push(text),
      ask: async () => answers.shift() ?? "",
    },
    output,
    errors,
  };
}

test("onboard installs identical project skill copies without overwriting changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const output: string[] = [];
  const io = {
    out: (text: string) => output.push(text),
    err: (text: string) => output.push(text),
    ask: async () => "2",
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

test("project onboarding reports completed steps, configuration, and next commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = join(root, "agile.db");
  const { io, output, errors } = interactiveIo(["2"]);

  try {
    expect(
      await runCli(["onboard", "--db", dbPath], io, {
        runScheduler: async () => {},
        projectRoot: root,
        homeRoot: home,
      }),
    ).toBe(0);

    const transcript = output.join("\n");
    expect(transcript).toContain("Roc onboarding");
    expect(transcript).toContain(`Scope: Project (${root})`);
    expect(transcript).toContain(`1. Database: Ready (${dbPath})`);
    expect(transcript).toContain("2. Skills:");
    expect(transcript).toContain("Installed:");
    expect(transcript).toContain("3. Selected cycle: Weekly");
    expect(transcript).toContain("4. Settings: Saved ");
    expect(transcript).toContain(".config/roc/settings.json");
    expect(transcript).toContain("Result: Complete");
    expect(transcript).toContain(onboardingNextSteps);
    expect(errors).toEqual([]);
    expect(
      new TextEncoder()
        .encode(transcript)
        .every((byte) => byte === 10 || (byte >= 32 && byte <= 126)),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
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
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
          ask: async () => "1",
        },
        { runScheduler: async () => {}, projectRoot: root, homeRoot: home },
      ),
    ).toBe(0);
    expect(output.join("\n")).toContain(`Scope: Global user account (${home})`);
    expect(output.join("\n")).toContain(
      "1. Database: Not created (global scope)",
    );
    expect(output.join("\n")).not.toContain("Project database");
    expect(output.join("\n")).toContain(onboardingNextSteps);
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

test("repeat onboarding reports identical skills as already installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = join(root, "agile.db");
  const first = interactiveIo(["1"]);
  const repeated = interactiveIo(["1"]);

  try {
    expect(
      await runCli(["onboard", "--db", dbPath], first.io, {
        runScheduler: async () => {},
        projectRoot: root,
        homeRoot: home,
      }),
    ).toBe(0);
    expect(
      await runCli(["onboard", "--db", dbPath], repeated.io, {
        runScheduler: async () => {},
        projectRoot: root,
        homeRoot: home,
      }),
    ).toBe(0);
    expect(repeated.output.join("\n")).toContain("Already installed:");
    expect(repeated.errors).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("onboard saves each selected Agile cycle globally", async () => {
  const cases = [
    {
      name: "Daily",
      answers: ["1"],
      expected: { cycle: { type: "daily" } },
    },
    {
      name: "Weekly",
      answers: ["2"],
      expected: { cycle: { type: "weekly" } },
    },
    {
      name: "Custom",
      answers: ["3", "14"],
      expected: {
        cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" },
      },
    },
  ];

  for (const scenario of cases) {
    const projectRoot = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
    const { io, errors } = interactiveIo(scenario.answers);
    try {
      expect(
        await runCli(["onboard", "--global"], io, {
          runScheduler: async () => {},
          projectRoot,
          homeRoot,
          now: () => new Date(2026, 7, 28, 12),
        }),
        scenario.name,
      ).toBe(0);
      expect(
        JSON.parse(
          await readFile(
            join(homeRoot, ".config", "roc", "settings.json"),
            "utf8",
          ),
        ),
        scenario.name,
      ).toEqual(scenario.expected);
      expect(errors, scenario.name).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(homeRoot, { recursive: true, force: true });
    }
  }
});

test("onboard rejects an invalid Custom duration without writing settings", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const { io, errors } = interactiveIo(["3", "0"]);

  try {
    expect(
      await runCli(["onboard", "--global"], io, {
        runScheduler: async () => {},
        projectRoot,
        homeRoot,
        now: () => new Date(2026, 7, 28, 12),
      }),
    ).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Onboarding stopped");
    expect(errors[0]).toContain(
      "Custom duration must be a whole number greater than zero",
    );
    expect(errors[0]).toContain("Retry:");
    await expect(
      lstat(join(homeRoot, ".config", "roc", "settings.json")),
    ).rejects.toThrow();
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
  }
});

test("onboard requires interactive input", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const errors: string[] = [];

  try {
    expect(
      await runCli(
        ["onboard", "--global"],
        { out: () => {}, err: (text) => errors.push(text) },
        { runScheduler: async () => {}, projectRoot, homeRoot },
      ),
    ).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Onboarding stopped");
    expect(errors[0]).toContain("Interactive input is required for onboard");
    expect(errors[0]).toContain("Retry:");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
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
    expect(errors[0]).toContain("Retry:");
    await expect(lstat(join(redirected, "skills"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("onboarding discloses the installed skill when a later target conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = join(root, "agile.db");
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
  const { io, output, errors } = interactiveIo(["1"]);

  try {
    await mkdir(join(root, ".claude", "skills", "roc-create-tasks"), {
      recursive: true,
    });
    await writeFile(claudeSkill, "conflicting skill");

    expect(
      await runCli(["onboard", "--db", dbPath], io, {
        runScheduler: async () => {},
        projectRoot: root,
        homeRoot: home,
      }),
    ).toBe(1);
    expect(await lstat(agentsSkill)).toMatchObject({
      isFile: expect.any(Function),
    });
    expect(await readFile(claudeSkill, "utf8")).toBe("conflicting skill");
    expect(output.join("\n")).not.toContain("Result: Complete");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Completed work:");
    expect(errors[0]).toContain(`Installed: ${agentsSkill}`);
    expect(errors[0]).toContain(`Skill destination differs: ${claudeSkill}`);
    expect(errors[0]).not.toContain("Result: Complete");
    expect(errors[0]).not.toContain("Next:");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("onboarding retry quotes a literal database path for zsh", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = "$HOME/roc db 'quoted' `backtick` $(substitution)";
  const errors: string[] = [];

  try {
    expect(
      await runCli(
        ["onboard", "--db", dbPath],
        { out: () => {}, err: (text) => errors.push(text) },
        { runScheduler: async () => {}, projectRoot: root, homeRoot: home },
      ),
    ).toBe(1);
    const retryCommand = errors.at(0)?.split("Retry:\n  ").at(1);
    expect(retryCommand).toBeDefined();
    if (retryCommand === undefined) throw new Error("Expected a retry command");
    const shell = Bun.spawn(
      ["zsh", "-fc", `npx() { printf '%s\\n' "$@"; }\n${retryCommand}`],
      { stdout: "pipe" },
    );
    expect(await shell.exited).toBe(0);
    expect(
      (await new Response(shell.stdout).text()).trimEnd().split("\n"),
    ).toEqual(["roc-it@latest", "onboard", "--db", dbPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("onboarding stops truthfully after prior work when a later step fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = join(root, "agile.db");
  const { io, output, errors } = interactiveIo(["3", "0"]);

  try {
    expect(
      await runCli(["onboard", "--db", dbPath], io, {
        runScheduler: async () => {},
        projectRoot: root,
        homeRoot: home,
      }),
    ).toBe(1);
    const completed = output.join("\n");
    expect(completed).toContain(`1. Database: Ready (${dbPath})`);
    expect(completed).toContain("2. Skills:");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Onboarding stopped");
    expect(errors[0]).toContain("Completed work:");
    expect(errors[0]).toContain("1. Database: Ready");
    expect(errors[0]).toContain("2. Skills:");
    expect(errors[0]).toContain("Failed:");
    expect(errors[0]).toContain("Retry:");
    expect(errors[0]).not.toContain("Result: Complete");
    expect(errors[0]).not.toContain("Next:");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
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
    cycleId: "2026-W35",
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

test("task import validates before creating a database, explains weekId, and keeps --global onboard-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const manifestPath = join(root, "invalid-backlog.json");
  const dbPath = join(root, "agile.db");
  const errors: string[] = [];
  const io = { out: () => {}, err: (text: string) => errors.push(text) };

  try {
    await writeFile(
      manifestPath,
      JSON.stringify({ cycleId: "2026-W35", goal: "Invalid", tasks: [] }),
    );
    expect(
      await runCli(["task", "import", manifestPath, "--db", dbPath], io),
    ).toBe(1);
    await expect(lstat(dbPath)).rejects.toThrow();

    await writeFile(
      manifestPath,
      JSON.stringify({
        weekId: "2026-W35",
        cycleId: "2026-W35",
        goal: "Legacy",
        tasks: [{}],
      }),
    );
    expect(
      await runCli(["task", "import", manifestPath, "--db", dbPath], io),
    ).toBe(1);
    expect(errors.at(-1)).toBe("Manifest uses weekId; replace it with cycleId");
    await expect(lstat(dbPath)).rejects.toThrow();

    expect(await runCli(["tokens", "--global"], io)).toBe(2);
    expect(errors.at(-1)).toBe("--global is only supported by onboard");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational database failures report an error, return 1, and close the database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "future.db");
  const future = new Database(dbPath, { create: true });
  future.exec("PRAGMA user_version = 5");
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
      "Database version 5 is newer than supported version 4",
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
  expect(await runCli(["onboard", "--backend", "fake"], io)).toBe(2);
  expect(output).toEqual([]);
  expect(errors).toHaveLength(4);
  expect(errors[1]).toBe("Unknown command: unknown");
  expect(errors[3]).toContain("onboard accepts only --global and --db PATH");
  expect(errors[3]).toContain("Retry:");
});

test("cycle current prints the configured active cycle", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const output: string[] = [];
  try {
    await saveRocSettings(
      {
        cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" },
      },
      homeRoot,
    );
    expect(
      await runCli(
        ["cycle", "current"],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        {
          runScheduler: async () => {},
          homeRoot,
          now: () => new Date(2026, 7, 28, 12),
        },
      ),
    ).toBe(0);
    expect(output).toEqual(["2026-08-28-P14D"]);
    expect(
      await runCli(
        ["cycle"],
        { out: () => {}, err: () => {} },
        {
          runScheduler: async () => {},
          homeRoot,
        },
      ),
    ).toBe(2);
    expect(
      await runCli(
        ["cycle", "current", "--db", "other.db"],
        { out: () => {}, err: () => {} },
        { runScheduler: async () => {}, homeRoot },
      ),
    ).toBe(2);
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

test("cycle current explains how to create missing settings", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const errors: string[] = [];
  try {
    expect(
      await runCli(
        ["cycle", "current"],
        { out: () => {}, err: (text) => errors.push(text) },
        { runScheduler: async () => {}, homeRoot },
      ),
    ).toBe(1);
    expect(errors).toEqual([
      "Run npx roc-it@latest onboard to configure an Agile cycle",
    ]);
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

test("tokens prints the current-cycle report", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const cycleId = "2026-08-28-P14D";
  await saveRocSettings(
    { cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" } },
    root,
  );
  const db = openDatabase(dbPath);
  new PlanningRepository(db).createCycle({
    id: cycleId,
    goal: "See token usage",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: [],
  });
  db.query(`
    INSERT INTO usage(
      id, cycle_id, category,
      input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
    ) VALUES('cli-usage', ?, 'implement', 100, 80, 50, 30)
  `).run(cycleId);
  db.close();
  const output: string[] = [];

  try {
    expect(
      await runCli(
        ["tokens", "--db", dbPath],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        {
          runScheduler: async () => {},
          homeRoot: root,
          now: () => new Date(2026, 7, 28, 12),
        },
      ),
    ).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("Token usage · 2026-08-28-P14D");
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
  const cycleId = "2026-08-28-P14D";
  await saveRocSettings(
    { cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" } },
    root,
  );
  const db = openDatabase(dbPath);
  new PlanningRepository(db).createCycle({
    id: cycleId,
    goal: "See token usage",
    nonGoals: [],
    tokenBudget: 100_000,
    ticketIds: [],
  });
  db.query(`
    INSERT INTO usage(
      id, cycle_id, category,
      input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens
    ) VALUES('cli-plain-usage', ?, 'implement', 100, 80, 50, 30)
  `).run(cycleId);
  db.close();
  const output: string[] = [];

  try {
    expect(
      await runCli(
        ["tokens", "--db", dbPath, "--no-color"],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        {
          runScheduler: async () => {},
          homeRoot: root,
          now: () => new Date(2026, 7, 28, 12),
        },
      ),
    ).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]!).not.toContain("\u001B[");
    expect(output[0]!).toContain("Implement  150 tokens  100%  █");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tokens reports a missing current cycle as an empty state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, "agile.db");
  const output: string[] = [];

  try {
    await saveRocSettings(
      { cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" } },
      root,
    );
    expect(
      await runCli(
        ["tokens", "--db", dbPath],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        {
          runScheduler: async () => {},
          homeRoot: root,
          now: () => new Date(2026, 7, 28, 12),
        },
      ),
    ).toBe(0);
    expect(output).toEqual(["No active cycle: 2026-08-28-P14D"]);
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
  await saveRocSettings({ cycle: { type: "weekly" } }, root);
  const future = new Database(dbPath, { create: true });
  future.exec("PRAGMA user_version = 5");
  future.close();
  try {
    expect(
      await runCli(
        ["tokens", "--db", dbPath],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        { ...runtime, homeRoot: root, now: () => new Date(2026, 7, 28, 12) },
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
