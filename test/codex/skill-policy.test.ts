import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDefaultSkillConfig,
  loadDefaultSkillPolicy,
} from "../../src/codex/skill-policy";

test("loads allowed standalone skill identities from the installed skill lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "agile-skill-policy-"));
  try {
    await mkdir(join(home, ".agents"));
    await writeFile(join(home, ".agents", ".skill-lock.json"), JSON.stringify({
      version: 3,
      skills: {
        tdd: { source: "mattpocock/skills" },
        "i-have-adhd": { source: "ayghri/i-have-adhd" },
        ponytail: { source: "DietrichGebert/ponytail" },
        animate: { source: "emilkowalski/skills" },
      },
    }));

    const policy = await loadDefaultSkillPolicy(home);

    expect(policy.agentsSkillsRoot).toBe(join(home, ".agents", "skills"));
    expect([...policy.allowedStandaloneSkillNames]).toEqual(["tdd", "i-have-adhd", "ponytail"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("default policy only enables installed Matt Pocock, i-have-adhd, and Ponytail skills", () => {
  const skills = [
    {
      name: "tdd",
      path: "/Users/test/.agents/skills/tdd/SKILL.md",
      enabled: true,
    },
    {
      name: "tdd",
      path: "/Users/test/.codex/skills/tdd/SKILL.md",
      enabled: true,
    },
    {
      name: "ponytail:ponytail",
      path: "/Users/test/.codex/plugins/cache/ponytail/ponytail/4.9.0/skills/ponytail/SKILL.md",
      enabled: true,
    },
    {
      name: "i-have-adhd:focus",
      path: "/Users/test/.codex/plugins/cache/i-have-adhd/i-have-adhd/1.0.0/skills/focus/SKILL.md",
      enabled: true,
    },
    {
      name: "ponytail:ponytail-review",
      path: "/Users/test/.codex/plugins/cache/ponytail/ponytail/4.9.0/skills/ponytail-review/SKILL.md",
      enabled: false,
    },
    {
      name: "i-have-adhd",
      path: "/Users/test/.agents/skills/i-have-adhd/SKILL.md",
      enabled: true,
    },
    {
      name: "openai-docs",
      path: "/Users/test/.codex/skills/.system/openai-docs/SKILL.md",
      enabled: true,
    },
  ];

  expect(buildDefaultSkillConfig(skills, {
    agentsSkillsRoot: "/Users/test/.agents/skills",
    allowedStandaloneSkillNames: new Set(["tdd", "i-have-adhd"]),
  })).toEqual([
    { path: skills[0]!.path, enabled: true },
    { path: skills[1]!.path, enabled: false },
    { path: skills[2]!.path, enabled: true },
    { path: skills[3]!.path, enabled: true },
    { path: skills[4]!.path, enabled: false },
    { path: skills[5]!.path, enabled: true },
    { path: skills[6]!.path, enabled: false },
  ]);
});
