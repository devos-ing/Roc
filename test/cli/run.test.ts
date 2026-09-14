import { expect, test } from "bun:test";
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
import { stripVTControlCharacters } from "node:util";
import { runCli } from "../../src/cli/run";
import type { CliRuntime } from "../../src/cli/types";
import {
  loadRocSettings,
  rocSettingsPath,
  saveRocSettings,
} from "../../src/settings";
import type { DefaultSkillCandidate } from "../../src/skills/policy";

const onboardingNextSteps = [
  "Next:",
  "  Connect GitHub if needed:",
  "    gh auth login",
  "  Install the grilling skill if needed:",
  "    npx skills add mattpocock/skills --skill grilling --global --agent pi",
  "  Ask your coding assistant to create a backlog:",
  "    Use roc-create-tasks: <requirement>",
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
      ask: async (question: string) =>
        question.startsWith("Roc's coding tools")
          ? "yes"
          : (answers.shift() ?? ""),
      selectCycle: async () => {
        const choices = { "1": "daily", "2": "weekly", "3": "custom" } as const;
        return choices[answers.shift() as keyof typeof choices];
      },
      selectSkills: async (candidates: DefaultSkillCandidate[]) =>
        selectedNames === "cancel"
          ? { kind: "cancelled" as const }
          : {
              kind: "selected" as const,
              identities: candidates
                .filter(({ identity }) => selectedNames.includes(identity.name))
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
    configureModel: async () => "openai-codex/gpt-5.5",
    listWorkspaceSkills: async () => [],
    ...overrides,
  };
}

test("onboard installs complete project skill packages without overwriting changes", async () => {
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
    for (const directory of [".agents", ".claude"]) {
      await expect(
        lstat(join(root, directory, "skills", "pr-review-to-closure")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(lstat(dbPath)).rejects.toMatchObject({ code: "ENOENT" });

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
    expect(transcript).toContain("Welcome to Roc");
    expect(transcript).toContain(`Scope: Project (${root})`);
    expect(transcript).toContain("1. Task source: GitHub Issues");
    expect(transcript).toContain("2. Skills:");
    expect(transcript).toContain("Installed:");
    expect(transcript).toContain("3. Agent skills: 0 allowed");
    expect(transcript).toContain("4. Selected cycle: Weekly");
    expect(transcript).toContain("5. Settings: Saved ");
    expect(transcript).toContain(".config/roc/settings.json");
    expect(transcript).toContain("Result: Complete");
    for (const line of onboardingNextSteps.split("\n"))
      expect(transcript).toContain(line.trim());
    expect(transcript).toContain("╭─Next:");
    expect(errors).toEqual([]);
    expect(stripVTControlCharacters(transcript)).toBe(transcript);
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
    expect(output.join("\n")).toContain("1. Task source: GitHub Issues");
    expect(output.join("\n")).not.toContain("Project database");
    for (const line of onboardingNextSteps.split("\n"))
      expect(output.join("\n")).toContain(line.trim());
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

test.each(["skills", "cycle"] as const)(
  "onboard %s cancellation preserves the prior allowlist",
  async (step) => {
    const home = await mkdtemp(join(tmpdir(), "roc-onboard-cancel-"));
    await saveRocSettings(
      {
        cycle: { type: "weekly" },
        skills: { allowlist: [{ name: "tdd", source: "mattpocock/skills" }] },
      },
      home,
    );
    const before = await readFile(rocSettingsPath(home), "utf8");
    const { io, errors } = interactiveIo([], step === "skills" ? "cancel" : []);

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
  },
);

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
    seen.map(({ identity, initiallySelected }) => ({
      name: identity.name,
      initiallySelected,
    })),
  ).toEqual([
    { name: "grilling", initiallySelected: false },
    { name: "tdd", initiallySelected: true },
  ]);
});

test("local skill discovery failure preserves the prior allowlist", async () => {
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
          throw new Error("Local skill discovery failed");
        },
      }),
    ),
  ).toBe(1);
  expect(await readFile(rocSettingsPath(home), "utf8")).toBe(before);
  expect(errors.join("\n")).toContain("Local skill discovery failed");
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
      ).toEqual({
        ...scenario.expected,
        execution: { allowUnsandboxed: true },
      });
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
      if (text.startsWith("1. Task source:")) interactions.push("task source");
      if (text.startsWith("2. Skills:")) interactions.push("packaged skills");
    },
    err: (text: string) => errors.push(text),
    ask: async () => {
      interactions.push("cycle");
      return answers.shift() ?? "";
    },
    selectCycle: async () => {
      interactions.push("cycle");
      answers.shift();
      return "custom" as const;
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
      "task source",
      "packaged skills",
      "checklist",
      "cycle",
      "cycle",
    ]);
    expect(await readFile(rocSettingsPath(homeRoot))).toEqual(before);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("1. Task source: GitHub Issues");
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

test("onboard requires interactive cycle selection", async () => {
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
    expect(errors[0]).toContain(
      "Interactive cycle selection is required for onboard",
    );
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
    const retryCommand = errors
      .at(0)
      ?.split("\n")
      .find((line) => line.includes("npx roc-it@latest onboard"))
      ?.replace(/^│\s*|\s*│$/g, "");
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
    expect(completed).toContain("1. Task source: GitHub Issues");
    expect(completed).toContain("2. Skills:");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Onboarding stopped");
    expect(errors[0]).toContain("Completed work:");
    expect(errors[0]).toContain("1. Task source: GitHub Issues");
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
      `Roc settings at ${rocSettingsPath(homeRoot)}: Settings file is missing. Run npx roc-it@latest onboard to configure an Agile cycle`,
    ]);
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

test("onboarding preserves invalid settings and requests manual repair before model setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-onboard-invalid-"));
  const home = await mkdtemp(join(tmpdir(), "roc-onboard-invalid-home-"));
  let modelCalls = 0;
  try {
    const path = await saveRocSettings({ cycle: { type: "weekly" } }, home);
    for (const source of [
      '{"cycle":{"type":"weekly"},"type":"SECRET_VALUE"}\n',
      '{"cycle":{"type":"SECRET_VALUE",',
    ]) {
      const before = Buffer.from(source);
      await writeFile(path, before);
      const { io, output, errors } = interactiveIo(["2"]);
      expect(
        await runCli(
          ["onboard"],
          io,
          onboardingRuntime({
            projectRoot: root,
            homeRoot: home,
            configureModel: async () => {
              modelCalls++;
              return "provider/model";
            },
          }),
        ),
      ).toBe(1);
      expect(modelCalls).toBe(0);
      expect(await readFile(path)).toEqual(before);
      expect(errors.join("\n")).toContain(rocSettingsPath(home));
      expect(errors.join("\n")).toContain("Back up this file");
      expect(errors.join("\n")).toContain(
        "onboarding reads the same file and cannot repair it",
      );
      expect(errors.join("\n")).not.toContain("SECRET_VALUE");
      expect(output.join("\n")).not.toContain("Result: Complete");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("execution refusal and model failure preserve Roc settings and never report ready", async () => {
  for (const allow of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "roc-onboard-failed-"));
    const home = await mkdtemp(join(tmpdir(), "roc-onboard-home-"));
    try {
      await saveRocSettings(
        { cycle: { type: "daily" }, skills: { allowlist: [] } },
        home,
      );
      const before = await readFile(rocSettingsPath(home), "utf8");
      const { io, output, errors } = interactiveIo(["2"]);
      let modelCalls = 0;
      expect(
        await runCli(
          ["onboard"],
          {
            ...io,
            ask: async (question) =>
              question.startsWith("Roc's coding tools")
                ? allow
                  ? "yes"
                  : "no"
                : "2",
          },
          onboardingRuntime({
            projectRoot: root,
            homeRoot: home,
            configureModel: async () => {
              modelCalls++;
              throw new Error("Model setup failed");
            },
          }),
        ),
      ).toBe(1);
      expect(modelCalls).toBe(allow ? 1 : 0);
      expect(await readFile(rocSettingsPath(home), "utf8")).toBe(before);
      expect(output.join("\n")).not.toContain("Result: Complete");
      expect(errors.join("\n")).toContain(
        allow ? "Model setup failed" : "Execution was not authorized",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }
});
