import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDefaultSkillCandidates,
  buildDefaultSkillConfig,
  loadDefaultSkillPolicy,
} from "../../src/codex/skill-policy";
import { skillIdentityKey } from "../../src/domain/skill-allowlist";

test("trusts only the exact pstack unslop identity and path", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-unslop-policy-"));
  await mkdir(join(home, ".agents"), { recursive: true });
  await writeFile(
    join(home, ".agents", ".skill-lock.json"),
    JSON.stringify({
      version: 3,
      skills: {
        unslop: { source: "backnotprop/pstack" },
        "pstack-other": { source: "backnotprop/pstack" },
      },
    }),
  );

  try {
    const policy = await loadDefaultSkillPolicy(home);
    expect([...policy.standaloneSkillSources]).toEqual([
      ["unslop", "backnotprop/pstack"],
    ]);

    const root = join(home, ".agents", "skills");
    const skills = [
      { name: "unslop", path: join(root, "unslop", "SKILL.md"), enabled: true },
      {
        name: "unslop",
        path: join(home, ".codex", "skills", "unslop", "SKILL.md"),
        enabled: true,
      },
      {
        name: "pstack-other",
        path: join(root, "pstack-other", "SKILL.md"),
        enabled: true,
      },
    ];

    expect(buildDefaultSkillConfig(skills, policy)).toEqual([
      { path: skills[0]!.path, enabled: true },
      { path: skills[1]!.path, enabled: false },
      { path: skills[2]!.path, enabled: false },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("distinguishes legacy, empty, and subset selections", () => {
  const skills = [
    {
      name: "tdd",
      path: "/Users/test/.agents/skills/tdd/SKILL.md",
      enabled: true,
    },
    {
      name: "ponytail:ponytail",
      path: "/plugin/ponytail/SKILL.md",
      enabled: true,
    },
  ];
  const base = {
    agentsSkillsRoot: "/Users/test/.agents/skills",
    standaloneSkillSources: new Map([["tdd", "mattpocock/skills"]]),
  };

  expect(
    buildDefaultSkillConfig(skills, base).map((entry) => entry.enabled),
  ).toEqual([true, true]);
  expect(
    buildDefaultSkillConfig(skills, {
      ...base,
      selectedSkillKeys: new Set(),
    }).map((entry) => entry.enabled),
  ).toEqual([false, false]);
  expect(
    buildDefaultSkillConfig(skills, {
      ...base,
      selectedSkillKeys: new Set([
        skillIdentityKey({ name: "tdd", source: "mattpocock/skills" }),
      ]),
    }).map((entry) => entry.enabled),
  ).toEqual([true, false]);
});

test("builds deterministic checklist candidates with missing unslop disabled", () => {
  const policy = {
    agentsSkillsRoot: "/Users/test/.agents/skills",
    standaloneSkillSources: new Map([["tdd", "mattpocock/skills"]]),
  };
  expect(
    buildDefaultSkillCandidates(
      [
        {
          name: "tdd",
          path: "/Users/test/.agents/skills/tdd/SKILL.md",
          enabled: true,
        },
      ],
      policy,
    ),
  ).toEqual([
    {
      identity: { name: "tdd", source: "mattpocock/skills" },
      installed: true,
      initiallySelected: true,
    },
    {
      identity: { name: "unslop", source: "backnotprop/pstack" },
      installed: false,
      initiallySelected: false,
    },
  ]);

  const repeatPolicy = {
    ...policy,
    selectedSkillKeys: new Set([
      skillIdentityKey({ name: "tdd", source: "mattpocock/skills" }),
    ]),
  };
  expect(
    buildDefaultSkillCandidates(
      [
        {
          name: "tdd",
          path: "/Users/test/.agents/skills/tdd/SKILL.md",
          enabled: true,
        },
        {
          name: "grilling",
          path: "/Users/test/.agents/skills/grilling/SKILL.md",
          enabled: true,
        },
      ],
      {
        ...repeatPolicy,
        standaloneSkillSources: new Map([
          ["tdd", "mattpocock/skills"],
          ["grilling", "mattpocock/skills"],
        ]),
      },
    ).filter(({ installed }) => installed),
  ).toMatchObject([
    { identity: { name: "grilling" }, initiallySelected: false },
    { identity: { name: "tdd" }, initiallySelected: true },
  ]);
});
