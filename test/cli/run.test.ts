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
import type { CliRuntime } from "../../src/cli/types";
import type { DefaultSkillCandidate } from "../../src/codex/skill-policy";
import { taskHookConfigHash } from "../../src/scheduler/task-hooks";
import {
  loadRocSettings,
  rocSettingsPath,
  saveRocSettings,
} from "../../src/settings";
import { openDatabase } from "../../src/store/database";
import { OrchestrationRepository } from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";

const ansiSgrPattern = "\\u001B\\[[0-9;]*m";
const onboardingNextSteps = [
  "Next:",
  "  Install unslop from pstack if needed:",
  "    npx skills add backnotprop/pstack --skill unslop --global --agent codex --agent claude-code --agent cursor",
  "  Then choose it:",
  "    npx roc-it@latest onboard",
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
function interactiveIo(
  answers: string[],
  selectedNames: string[] | "cancel" = [],
) {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      out: (text: string) => output.push(text),
      err: (text: string) => errors.push(text),
      ask: async () => answers.shift() ?? "",
      selectSkills: async (candidates: DefaultSkillCandidate[]) =>
        selectedNames === "cancel"
          ? { kind: "cancelled" as const }
          : {
              kind: "selected" as const,
              identities: candidates
                .filter(
                  ({ identity, installed }) =>
                    installed && selectedNames.includes(identity.name),
                )
                .map(({ identity }) => identity),
            },
    },
    output,
    errors,
  };
}

/** Creates the deterministic runtime used by onboarding CLI tests. */
function onboardingRuntime(overrides: Partial<CliRuntime> = {}): CliRuntime {
  return {
    runScheduler: async () => {},
    listWorkspaceSkills: async () => [],
    ...overrides,
  };
}

test("onboard installs identical project skill copies without overwriting changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const { io } = interactiveIo(["2", "2", "2"]);

  try {
    expect(
      await runCli(
        ["onboard"],
        io,
        onboardingRuntime({
          projectRoot: root,
          homeRoot: home,
        }),
      ),
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
      await runCli(
        ["onboard"],
        io,
        onboardingRuntime({
          projectRoot: root,
          homeRoot: home,
        }),
      ),
    ).toBe(0);
    await writeFile(agentsSkill, "changed skill");
    expect(
      await runCli(
        ["onboard"],
        io,
        onboardingRuntime({
          projectRoot: root,
          homeRoot: home,
        }),
      ),
    ).toBe(1);
    expect(await readFile(agentsSkill, "utf8")).toBe("changed skill");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("project onboarding reports completed steps, configuration, and next commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const { io, output, errors } = interactiveIo(["2"]);

  try {
    expect(
      await runCli(
        ["onboard"],
        io,
        onboardingRuntime({
          projectRoot: root,
          homeRoot: home,
        }),
      ),
    ).toBe(0);

    const transcript = output.join("\n");
    expect(transcript).toContain("Roc onboarding");
    expect(transcript).toContain(`Scope: Project (${root})`);
    expect(transcript).toContain(`1. Database: Ready (${dbPath})`);
    expect(transcript).toContain("2. Skills:");
    expect(transcript).toContain("Installed:");
    expect(transcript).toContain("3. Agent skills: 0 allowed");
    expect(transcript).toContain("4. Selected cycle: Weekly");
    expect(transcript).toContain("5. Settings: Saved ");
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
  const { io, output } = interactiveIo(["1"]);

  try {
    expect(
      await runCli(
        ["onboard", "--global"],
        io,
        onboardingRuntime({ projectRoot: root, homeRoot: home }),
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
  const first = interactiveIo(["1"]);
  const repeated = interactiveIo(["1"]);

  try {
    expect(
      await runCli(
        ["onboard"],
        first.io,
        onboardingRuntime({
          projectRoot: root,
          homeRoot: home,
        }),
      ),
    ).toBe(0);
    expect(
      await runCli(
        ["onboard"],
        repeated.io,
        onboardingRuntime({
          projectRoot: root,
          homeRoot: home,
        }),
      ),
    ).toBe(0);
    expect(repeated.output.join("\n")).toContain("Already installed:");
    expect(repeated.errors).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("onboard saves the selected global skill allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-onboard-root-"));
  const home = await mkdtemp(join(tmpdir(), "roc-onboard-home-"));
  await mkdir(join(home, ".agents"), { recursive: true });
  await writeFile(
    join(home, ".agents", ".skill-lock.json"),
    JSON.stringify({ skills: { tdd: { source: "mattpocock/skills" } } }),
  );
  const { io, output } = interactiveIo(["2"], ["tdd"]);

  expect(
    await runCli(
      ["onboard", "--global"],
      io,
      onboardingRuntime({
        projectRoot: root,
        homeRoot: home,
        listWorkspaceSkills: async () => [
          {
            name: "tdd",
            path: join(home, ".agents", "skills", "tdd", "SKILL.md"),
            enabled: true,
          },
        ],
      }),
    ),
  ).toBe(0);
  expect(await loadRocSettings(home)).toMatchObject({
    skills: {
      allowlist: [{ name: "tdd", source: "mattpocock/skills" }],
    },
  });
  expect(output.join("\n")).toContain("3. Agent skills: 1 allowed");
});

test("onboard cancellation preserves the prior allowlist", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-onboard-cancel-"));
  await saveRocSettings(
    {
      cycle: { type: "weekly" },
      skills: { allowlist: [{ name: "tdd", source: "mattpocock/skills" }] },
    },
    home,
  );
  const before = await readFile(rocSettingsPath(home), "utf8");
  const { io, errors } = interactiveIo([], "cancel");

  expect(
    await runCli(
      ["onboard", "--global"],
      io,
      onboardingRuntime({
        homeRoot: home,
        listWorkspaceSkills: async () => [],
      }),
    ),
  ).toBe(1);
  expect(await readFile(rocSettingsPath(home), "utf8")).toBe(before);
  expect(errors.join("\n")).toContain("Onboarding cancelled");
});

test("missing unslop is disabled and only produces manual install guidance", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-onboard-unslop-"));
  let seen: DefaultSkillCandidate[] = [];
  const io = {
    out: () => {},
    err: () => {},
    ask: async () => "1",
    selectSkills: async (candidates: DefaultSkillCandidate[]) => {
      seen = candidates;
      return { kind: "selected" as const, identities: [] };
    },
  };
  expect(
    await runCli(
      ["onboard", "--global"],
      io,
      onboardingRuntime({
        homeRoot: home,
        listWorkspaceSkills: async () => [],
      }),
    ),
  ).toBe(0);
  expect(seen).toContainEqual({
    identity: { name: "unslop", source: "backnotprop/pstack" },
    installed: false,
    initiallySelected: false,
  });
  await expect(
    lstat(join(home, ".agents", "skills", "unslop")),
  ).rejects.toThrow();
});

test("repeat onboarding preselects only the saved identities", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-onboard-repeat-selection-"));
  await mkdir(join(home, ".agents"), { recursive: true });
  await writeFile(
    join(home, ".agents", ".skill-lock.json"),
    JSON.stringify({
      skills: {
        tdd: { source: "mattpocock/skills" },
        grilling: { source: "mattpocock/skills" },
      },
    }),
  );
  await saveRocSettings(
    {
      cycle: { type: "weekly" },
      skills: { allowlist: [{ name: "tdd", source: "mattpocock/skills" }] },
    },
    home,
  );
  let seen: DefaultSkillCandidate[] = [];
  const { io } = interactiveIo(["2"], ["tdd"]);
  io.selectSkills = async (candidates) => {
    seen = candidates;
    return {
      kind: "selected",
      identities: candidates
        .filter(({ identity }) => identity.name === "tdd")
        .map(({ identity }) => identity),
    };
  };
  const discovered = ["tdd", "grilling"].map((name) => ({
    name,
    path: join(home, ".agents", "skills", name, "SKILL.md"),
    enabled: true,
  }));

  expect(
    await runCli(
      ["onboard", "--global"],
      io,
      onboardingRuntime({
        homeRoot: home,
        listWorkspaceSkills: async () => discovered,
      }),
    ),
  ).toBe(0);
  expect(
    seen
      .filter(({ installed }) => installed)
      .map(({ identity, initiallySelected }) => ({
        name: identity.name,
        initiallySelected,
      })),
  ).toEqual([
    { name: "grilling", initiallySelected: false },
    { name: "tdd", initiallySelected: true },
  ]);
});

test("catalog failure preserves the prior allowlist", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-onboard-catalog-failure-"));
  await saveRocSettings(
    {
      cycle: { type: "weekly" },
      skills: { allowlist: [{ name: "tdd", source: "mattpocock/skills" }] },
    },
    home,
  );
  const before = await readFile(rocSettingsPath(home), "utf8");
  const { io, errors } = interactiveIo(["2"], ["tdd"]);

  expect(
    await runCli(
      ["onboard", "--global"],
      io,
      onboardingRuntime({
        homeRoot: home,
        listWorkspaceSkills: async () => {
          throw new Error(
            "Codex did not return a complete workspace skill catalog",
          );
        },
      }),
    ),
  ).toBe(1);
  expect(await readFile(rocSettingsPath(home), "utf8")).toBe(before);
  expect(errors.join("\n")).toContain("complete workspace skill catalog");
});

test("onboard saves each selected Agile cycle globally", async () => {
  const cases = [
    {
      name: "Daily",
      answers: ["1"],
      expected: { cycle: { type: "daily" }, skills: { allowlist: [] } },
    },
    {
      name: "Weekly",
      answers: ["2"],
      expected: { cycle: { type: "weekly" }, skills: { allowlist: [] } },
    },
    {
      name: "Custom",
      answers: ["3", "14"],
      expected: {
        cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" },
        skills: { allowlist: [] },
      },
    },
  ];

  for (const scenario of cases) {
    const projectRoot = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
    const homeRoot = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
    const { io, errors } = interactiveIo(scenario.answers);
    try {
      expect(
        await runCli(
          ["onboard", "--global"],
          io,
          onboardingRuntime({
            projectRoot,
            homeRoot,
            now: () => new Date(2026, 7, 28, 12),
          }),
        ),
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
      await runCli(
        ["onboard", "--global"],
        io,
        onboardingRuntime({
          projectRoot,
          homeRoot,
          now: () => new Date(2026, 7, 28, 12),
        }),
      ),
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

test("onboarding reports only durable work when cycle validation rejects a new allowlist", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = join(projectRoot, ".agile", "runtime", "agile.db");
  await mkdir(join(homeRoot, ".agents"), { recursive: true });
  await writeFile(
    join(homeRoot, ".agents", ".skill-lock.json"),
    JSON.stringify({
      skills: {
        tdd: { source: "mattpocock/skills" },
        grilling: { source: "mattpocock/skills" },
      },
    }),
  );
  await saveRocSettings(
    {
      cycle: { type: "weekly" },
      skills: { allowlist: [{ name: "tdd", source: "mattpocock/skills" }] },
    },
    homeRoot,
  );
  const before = await readFile(rocSettingsPath(homeRoot));
  const output: string[] = [];
  const errors: string[] = [];
  const interactions: string[] = [];
  const answers = ["3", "0"];
  const io = {
    out: (text: string) => {
      output.push(text);
      if (text.startsWith("1. Database:")) interactions.push("database");
      if (text.startsWith("2. Skills:")) interactions.push("packaged skills");
    },
    err: (text: string) => errors.push(text),
    ask: async () => {
      interactions.push("cycle");
      return answers.shift() ?? "";
    },
    selectSkills: async (candidates: DefaultSkillCandidate[]) => {
      interactions.push("checklist");
      return {
        kind: "selected" as const,
        identities: candidates
          .filter(({ identity }) => identity.name === "grilling")
          .map(({ identity }) => identity),
      };
    },
  };

  try {
    expect(
      await runCli(
        ["onboard"],
        io,
        onboardingRuntime({
          projectRoot,
          homeRoot,
          listWorkspaceSkills: async () => [
            {
              name: "grilling",
              path: join(homeRoot, ".agents", "skills", "grilling", "SKILL.md"),
              enabled: true,
            },
          ],
        }),
      ),
    ).toBe(1);
    expect(interactions).toEqual([
      "database",
      "packaged skills",
      "checklist",
      "cycle",
      "cycle",
    ]);
    expect(await readFile(rocSettingsPath(homeRoot))).toEqual(before);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`1. Database: Ready (${dbPath})`);
    expect(errors[0]).toContain("2. Skills:");
    expect(errors[0]).not.toContain("3. Agent skills:");
    expect(errors[0]).not.toContain("4. Selected cycle:");
    expect(output.join("\n")).not.toContain("3. Agent skills:");
    expect(output.join("\n")).not.toContain("4. Selected cycle:");
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
        {
          out: () => {},
          err: (text) => errors.push(text),
          selectSkills: async () => ({
            kind: "selected" as const,
            identities: [],
          }),
        },
        onboardingRuntime({ projectRoot, homeRoot }),
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
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const redirected = join(root, "redirected");
  await mkdir(redirected);
  await symlink(redirected, join(root, ".agents"));
  const errors: string[] = [];

  try {
    expect(
      await runCli(
        ["onboard"],
        { out: () => {}, err: (text) => errors.push(text) },
        onboardingRuntime({ projectRoot: root, homeRoot: home }),
      ),
    ).toBe(1);
    expect(errors[0]).toContain("symbolic link");
    expect(errors[0]).toContain("Retry:");
    await expect(lstat(join(redirected, "skills"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("onboarding discloses the installed skill when a later target conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
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
      await runCli(
        ["onboard"],
        io,
        onboardingRuntime({
          projectRoot: root,
          homeRoot: home,
        }),
      ),
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

test("onboarding retry prints a copyable canonical command", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const errors: string[] = [];

  try {
    expect(
      await runCli(
        ["onboard"],
        { out: () => {}, err: (text) => errors.push(text) },
        onboardingRuntime({ projectRoot: root, homeRoot: home }),
      ),
    ).toBe(1);
    const retryCommand = errors.at(0)?.split("Retry:\n  ").at(1);
    expect(retryCommand).toBeDefined();
    if (retryCommand === undefined) throw new Error("Expected a retry command");
    const shell = Bun.spawn(
      ["/bin/sh", "-fc", `npx() { printf '%s\\n' "$@"; }\n${retryCommand}`],
      { stdout: "pipe" },
    );
    expect(await shell.exited).toBe(0);
    expect(
      (await new Response(shell.stdout).text()).trimEnd().split("\n"),
    ).toEqual(["roc-it@latest", "onboard"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("onboarding stops truthfully after prior work when a later step fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-project-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const { io, output, errors } = interactiveIo(["3", "0"]);

  try {
    expect(
      await runCli(
        ["onboard"],
        io,
        onboardingRuntime({
          projectRoot: root,
          homeRoot: home,
        }),
      ),
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
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const manifestPath = join(root, "backlog.json");
  const malformedPath = join(root, "malformed.json");
  const firstTask = {
    id: "cli-import-01",
    title: "First imported task\n\t\u001B\\",
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
  const runtime = { runScheduler: async () => {}, projectRoot: root };

  try {
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(malformedPath, "not JSON");
    expect(await runCli(["task", "import", manifestPath], io, runtime)).toBe(0);
    const importResult = output.at(-1);
    expect(importResult).toContain("Created: 2");
    expect(importResult).toContain("Already present: 0");
    expect(importResult).toContain("Total: 2");
    const nextCommand = importResult?.split("Next:\n  ").at(1);
    expect(nextCommand).toBeDefined();
    if (nextCommand === undefined) throw new Error("Expected a next command");
    const shell = Bun.spawn(
      ["/bin/sh", "-fc", `npx() { printf '%s\\n' "$@"; }\n${nextCommand}`],
      { stdout: "pipe" },
    );
    expect(await shell.exited).toBe(0);
    expect(
      (await new Response(shell.stdout).text()).trimEnd().split("\n"),
    ).toEqual(["roc-it@latest", "task", "list"]);
    const db = openDatabase(dbPath);
    try {
      expect(new PlanningRepository(db).listTasks()).toMatchObject([
        { id: "cli-import-01", status: "ready" },
        { id: "cli-import-02", status: "ready" },
      ]);
    } finally {
      db.close();
    }
    expect(await runCli(["task", "list"], io, runtime)).toBe(0);
    const listed = output.at(-1) ?? "";
    expect(listed).toBe(
      [
        `- ${JSON.stringify(firstTask.id)} [ready] ${JSON.stringify(firstTask.title)}`,
        `- ${JSON.stringify(secondTask.id)} [ready] ${JSON.stringify(secondTask.title)}`,
      ].join("\n"),
    );
    expect(listed.split("\n")).toHaveLength(2);
    expect(listed).not.toContain("\u001B");
    expect(await runCli(["task", "import", manifestPath], io, runtime)).toBe(0);
    expect(output.at(-1)).toContain("Created: 0");
    expect(output.at(-1)).toContain("Already present: 2");
    expect(output.at(-1)).toContain("Total: 2");
    expect(await runCli(["task", "import", malformedPath], io, runtime)).toBe(
      1,
    );

    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        tasks: [{ ...firstTask, title: "Conflicting title" }],
      }),
    );
    expect(await runCli(["task", "import", manifestPath], io, runtime)).toBe(1);
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
    const usageErrors = errors.join("\n");
    expect(usageErrors).toContain("missing required argument 'file'");
    expect(usageErrors).toContain("too many arguments");
    expect(usageErrors).toContain("unknown option '--global'");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task list reuses create-backlog guidance when empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const output: string[] = [];
  try {
    expect(
      await runCli(
        ["task", "list"],
        {
          out: (text) => output.push(text),
          err: () => {},
        },
        { runScheduler: async () => {}, projectRoot: root },
      ),
    ).toBe(0);
    const empty = output.at(0) ?? "";
    expect(empty).toContain("No tasks.");
    expect(empty).toContain("/roc-create-tasks <requirement>");
    expect(empty).toContain("$roc-create-tasks <requirement>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task board prints an unchanged, plain current-cycle snapshot and supports --all", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-board-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const output: string[] = [];
  const errors: string[] = [];
  const taskSpec = {
    problem: "See the board",
    desiredOutcome: "A plain task snapshot",
    scope: ["task board"],
    nonGoals: [],
    acceptanceCriteria: ["task appears"],
    validation: ["bun test"],
    dependencies: [],
    risk: "low" as const,
    contextCandidates: [],
    tokenCeiling: 1_000,
  };

  try {
    await saveRocSettings({ cycle: { type: "daily" } }, home);
    const db = openDatabase(dbPath);
    const planning = new PlanningRepository(db);
    planning.createCycle({
      id: "2026-08-30",
      goal: "Current board",
      nonGoals: [],
      tokenBudget: 1_000,
      ticketIds: [],
    });
    planning.createCycle({
      id: "other-cycle",
      goal: "Other board",
      nonGoals: [],
      tokenBudget: 1_000,
      ticketIds: [],
    });
    for (const [id, cycleId] of [
      ["current-task", "2026-08-30"],
      ["other-task", "other-cycle"],
    ] as const)
      planning.createTask({
        id,
        cycleId,
        title: id,
        spec: taskSpec,
        priority: 0,
        approvalRequired: false,
        approved: false,
      });
    const before = ["tasks", "attempts", "events", "scheduler_lease"].map(
      (table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all(),
    );
    db.close();

    const close = spyOn(Database.prototype, "close");
    try {
      expect(
        await runCli(
          ["task", "board"],
          {
            out: (text) => output.push(text),
            err: (text) => errors.push(text),
          },
          {
            runScheduler: async () => {},
            projectRoot: root,
            homeRoot: home,
            now: () => new Date(2026, 7, 30),
          },
        ),
      ).toBe(0);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
    expect(errors).toEqual([]);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("current-task");
    expect(output[0]).not.toContain("other-task");
    expect(output[0]).not.toMatch(new RegExp(ansiSgrPattern));

    expect(
      await runCli(
        ["task", "board", "--all"],
        { out: (text) => output.push(text), err: (text) => errors.push(text) },
        {
          runScheduler: async () => {},
          projectRoot: root,
          homeRoot: home,
          now: () => new Date(2026, 7, 30),
        },
      ),
    ).toBe(0);
    expect(output.at(-1)).toContain("other-task");

    const afterDb = openDatabase(dbPath);
    try {
      expect(
        ["tasks", "attempts", "events", "scheduler_lease"].map((table) =>
          afterDb.query(`SELECT * FROM ${table} ORDER BY 1`).all(),
        ),
      ).toEqual(before);
    } finally {
      afterDb.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("task board shows backlog guidance for an empty project", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-board-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const output: string[] = [];

  try {
    await saveRocSettings({ cycle: { type: "daily" } }, home);
    expect(
      await runCli(
        ["task", "board"],
        { out: (text) => output.push(text), err: () => {} },
        {
          runScheduler: async () => {},
          projectRoot: root,
          homeRoot: home,
          now: () => new Date(2026, 7, 30),
        },
      ),
    ).toBe(0);
    expect(output.at(0)).toContain("No tasks.");
    expect(output.at(0)).toContain("/roc-create-tasks <requirement>");
    expect(output.at(0)).toContain("$roc-create-tasks <requirement>");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("task import validates before creating a database, explains weekId, and keeps --global onboard-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const manifestPath = join(root, "invalid-backlog.json");
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const errors: string[] = [];
  const io = { out: () => {}, err: (text: string) => errors.push(text) };
  const runtime = { runScheduler: async () => {}, projectRoot: root };

  try {
    await writeFile(
      manifestPath,
      JSON.stringify({ cycleId: "2026-W35", goal: "Invalid", tasks: [] }),
    );
    expect(await runCli(["task", "import", manifestPath], io, runtime)).toBe(1);
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
    expect(await runCli(["task", "import", manifestPath], io, runtime)).toBe(1);
    expect(errors.at(-1)).toBe("Manifest uses weekId; replace it with cycleId");
    await expect(lstat(dbPath)).rejects.toThrow();

    expect(await runCli(["tokens", "--global"], io)).toBe(2);
    expect(errors.join("\n")).toContain("unknown option '--global'");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operational database failures report an error, return 1, and close the database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const future = openDatabase(dbPath);
  future.exec("PRAGMA user_version = 6");
  future.close();
  const output: string[] = [];
  const errors: string[] = [];
  const close = spyOn(Database.prototype, "close");

  try {
    expect(
      await runCli(
        ["task", "list"],
        {
          out: (text) => output.push(text),
          err: (text) => errors.push(text),
        },
        { runScheduler: async () => {}, projectRoot: root },
      ),
    ).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual([
      "Database version 6 is newer than supported version 5",
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    close.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("task board reports database failures without emitting a snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-board-"));
  const home = await mkdtemp(join(tmpdir(), "agile-cli-home-"));
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const output: string[] = [];
  const errors: string[] = [];

  try {
    await saveRocSettings({ cycle: { type: "daily" } }, home);
    const future = openDatabase(dbPath);
    future.exec("PRAGMA user_version = 6");
    future.close();
    expect(
      await runCli(
        ["task", "board"],
        {
          out: (text) => output.push(text),
          err: (text) => errors.push(text),
        },
        {
          runScheduler: async () => {},
          projectRoot: root,
          homeRoot: home,
          now: () => new Date(2026, 7, 30),
        },
      ),
    ).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual([
      "TASK_BOARD_FAILED: Database version 6 is newer than supported version 5",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("argument and unknown-command errors keep exit code 2", async () => {
  for (const args of [
    ["--unknown-option"],
    ["unknown"],
    ["init"],
    ["onboard", "--backend", "fake"],
  ]) {
    const output: string[] = [];
    const errors: string[] = [];
    expect(
      await runCli(args, {
        out: (text) => output.push(text),
        err: (text) => errors.push(text),
      }),
    ).toBe(2);
    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain("error:");
  }
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
  const dbPath = join(root, ".agile", "runtime", "agile.db");
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
        ["tokens"],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        {
          runScheduler: async () => {},
          projectRoot: root,
          homeRoot: root,
          now: () => new Date(2026, 7, 28, 12),
        },
      ),
    ).toBe(0);
    expect(output).toHaveLength(1);
    const chart = output.at(0) ?? "";
    expect(chart).toContain("Token usage · 2026-08-28-P14D");
    expect(chart).toContain("\u001B[32m");
    expect(chart.replace(new RegExp(ansiSgrPattern, "g"), "")).toContain(
      "Implement  150 tokens  100%  █",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tokens supports explicit plain output", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, ".agile", "runtime", "agile.db");
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
        ["tokens", "--no-color"],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        {
          runScheduler: async () => {},
          projectRoot: root,
          homeRoot: root,
          now: () => new Date(2026, 7, 28, 12),
        },
      ),
    ).toBe(0);
    expect(output).toHaveLength(1);
    const chart = output.at(0) ?? "";
    expect(chart).not.toContain("\u001B[");
    expect(chart).toContain("Implement  150 tokens  100%  █");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tokens reports a missing current cycle as an empty state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const output: string[] = [];

  try {
    await saveRocSettings(
      { cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" } },
      root,
    );
    expect(
      await runCli(
        ["tokens"],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        {
          runScheduler: async () => {},
          projectRoot: root,
          homeRoot: root,
          now: () => new Date(2026, 7, 28, 12),
        },
      ),
    ).toBe(0);
    expect(output).toEqual([
      "No token usage recorded for cycle: 2026-08-28-P14D",
    ]);
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
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  await saveRocSettings({ cycle: { type: "weekly" } }, root);
  const future = openDatabase(dbPath);
  future.exec("PRAGMA user_version = 6");
  future.close();
  try {
    expect(
      await runCli(
        ["tokens"],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        {
          ...runtime,
          projectRoot: root,
          homeRoot: root,
          now: () => new Date(2026, 7, 28, 12),
        },
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

test("task hook trust records only the current task-scoped configuration hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "agile-cli-"));
  const dbPath = join(root, ".agile", "runtime", "agile.db");
  const hook = {
    command: "codegraph",
    args: ["init", "-i"],
    timeoutSeconds: 120,
  };
  const db = openDatabase(dbPath);
  const planning = new PlanningRepository(db);
  planning.createCycle({
    id: "2026-W35",
    goal: "Trust a task hook",
    nonGoals: [],
    tokenBudget: 10_000,
    ticketIds: ["H1"],
  });
  planning.createTask({
    id: "H1",
    cycleId: "2026-W35",
    title: "Trusted hook",
    spec: {
      problem: "A hook needs explicit approval",
      desiredOutcome: "Persist task-scoped trust",
      scope: ["hooks"],
      nonGoals: [],
      acceptanceCriteria: ["trust remains task scoped"],
      validation: ["bun test"],
      dependencies: [],
      risk: "low",
      contextCandidates: [],
      tokenCeiling: 1_000,
      prehook: hook,
    },
    priority: 0,
    approvalRequired: false,
    approved: true,
  });
  db.close();
  const output: string[] = [];

  try {
    expect(
      await runCli(
        ["task", "hook", "trust", "H1", "prehook"],
        {
          out: (text) => output.push(text),
          err: (text) => output.push(text),
        },
        { runScheduler: async () => {}, projectRoot: root },
      ),
    ).toBe(0);
    expect(output).toEqual([
      `Trusted prehook for H1: ${taskHookConfigHash(hook)}`,
    ]);
    const reopened = openDatabase(dbPath);
    try {
      expect(
        new OrchestrationRepository(reopened).getTaskHook("H1", "prehook"),
      ).toMatchObject({
        configHash: taskHookConfigHash(hook),
        trustedHash: taskHookConfigHash(hook),
        status: "pending",
      });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
