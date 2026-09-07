import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillIdentityKey } from "../../src/domain/skill-allowlist";
import {
  buildDefaultSkillCandidates,
  buildDefaultSkillConfig,
  discoverTrustedSkills,
  loadDefaultSkillPolicy,
} from "../../src/skills/policy";

test("limits Matt Pocock skills in onboarding and ignores obsolete saved selections", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-curated-skills-"));
  const names = ["grilling", "tdd", "teach", "to-spec"];
  const selected = names.map((name) => ({ name, source: "mattpocock/skills" }));
  const skills = names.map((name) => ({
    name,
    path: join(home, ".agents", "skills", name, "SKILL.md"),
    enabled: true,
  }));
  try {
    for (const skill of skills) {
      await mkdir(join(home, ".agents", "skills", skill.name), {
        recursive: true,
      });
      await writeFile(skill.path, "fixture skill");
    }
    await writeFile(
      join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({
        skills: Object.fromEntries(
          selected.map(({ name, source }) => [name, { source }]),
        ),
      }),
    );
    const policy = await loadDefaultSkillPolicy(home, selected);
    const discovered = await discoverTrustedSkills(policy);
    expect(discovered.map(({ name }) => name).sort()).toEqual([
      "grilling",
      "tdd",
    ]);
    expect(
      buildDefaultSkillCandidates(discovered, policy)
        .filter(({ installed }) => installed)
        .map(({ identity }) => identity.name),
    ).toEqual(["grilling", "tdd"]);
    expect(
      buildDefaultSkillConfig(skills, policy).map(({ enabled }) => enabled),
    ).toEqual([true, true, false, false]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

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
    expect(policy.codexPluginCacheRoot).toBe(
      join(home, ".codex", "plugins", "cache"),
    );
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
  const codexPluginCacheRoot = "/Users/test/.codex/plugins/cache";
  const skills = [
    {
      name: "tdd",
      path: "/Users/test/.agents/skills/tdd/SKILL.md",
      enabled: true,
    },
    {
      name: "ponytail:ponytail",
      path: join(
        codexPluginCacheRoot,
        "ponytail",
        "ponytail",
        "4.9.0",
        "skills",
        "ponytail",
        "SKILL.md",
      ),
      enabled: true,
    },
  ];
  const base = {
    agentsSkillsRoot: "/Users/test/.agents/skills",
    codexPluginCacheRoot,
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

test("requires exact plugin cache provenance and safe standalone names", () => {
  const agentsSkillsRoot = "/Users/test/.agents/skills";
  const codexPluginCacheRoot = "/Users/test/.codex/plugins/cache";
  const skills = [
    {
      name: "ponytail:ponytail",
      path: join(
        codexPluginCacheRoot,
        "ponytail",
        "ponytail",
        "4.9.0",
        "skills",
        "ponytail",
        "SKILL.md",
      ),
      enabled: true,
    },
    {
      name: "i-have-adhd:focus",
      path: join(
        codexPluginCacheRoot,
        "i-have-adhd",
        "i-have-adhd",
        "1.0.0",
        "skills",
        "focus",
        "SKILL.md",
      ),
      enabled: true,
    },
    { name: "ponytail:evil", path: "/tmp/evil/SKILL.md", enabled: true },
    {
      name: "ponytail:evil",
      path: join(agentsSkillsRoot, "ponytail:evil", "SKILL.md"),
      enabled: true,
    },
    {
      name: "../evil",
      path: "/Users/test/.agents/evil/SKILL.md",
      enabled: true,
    },
  ];

  expect(
    buildDefaultSkillConfig(skills, {
      agentsSkillsRoot,
      codexPluginCacheRoot,
      standaloneSkillSources: new Map([
        ["../evil", "mattpocock/skills"],
        ["ponytail:evil", "mattpocock/skills"],
      ]),
    }).map((entry) => entry.enabled),
  ).toEqual([true, true, false, false, false]);
});

test("builds deterministic checklist candidates with missing unslop disabled", () => {
  const policy = {
    agentsSkillsRoot: "/Users/test/.agents/skills",
    codexPluginCacheRoot: "/Users/test/.codex/plugins/cache",
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

test("local discovery keeps the newest trusted plugin and skips linked skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-skill-discovery-"));
  try {
    const policy = await loadDefaultSkillPolicy(home);
    const root = join(policy.codexPluginCacheRoot, "ponytail", "ponytail");
    for (const version of ["4.9.0", "4.10.0"]) {
      const directory = join(root, version, "skills", "ponytail");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), "trusted skill");
    }
    await mkdir(policy.agentsSkillsRoot, { recursive: true });
    await symlink(
      join(root, "4.10.0", "skills", "ponytail"),
      join(policy.agentsSkillsRoot, "tdd"),
    );
    const discovered = await discoverTrustedSkills({
      ...policy,
      standaloneSkillSources: new Map([["tdd", "mattpocock/skills"]]),
    });
    expect(discovered).toEqual([
      {
        name: "ponytail:ponytail",
        path: join(root, "4.10.0", "skills", "ponytail", "SKILL.md"),
        enabled: true,
      },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
