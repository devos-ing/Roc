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

test("rejects legacy Unslop and Ponytail selections while retaining trusted skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-skill-policy-"));
  const root = join(home, ".agents", "skills");
  const selected = [
    { name: "tdd", source: "mattpocock/skills" },
    { name: "unslop", source: "backnotprop/pstack" },
    { name: "ponytail", source: "dietrichgebert/ponytail" },
    { name: "i-have-adhd:focus", source: "ayghri/i-have-adhd" },
  ];
  const skills = [
    { name: "tdd", path: join(root, "tdd", "SKILL.md"), enabled: true },
    {
      name: "unslop",
      path: join(root, "unslop", "SKILL.md"),
      enabled: true,
    },
    {
      name: "ponytail",
      path: join(root, "ponytail", "SKILL.md"),
      enabled: true,
    },
  ];
  try {
    await mkdir(join(home, ".agents"), { recursive: true });
    await writeFile(
      join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({
        skills: {
          tdd: { source: "mattpocock/skills" },
          unslop: { source: "backnotprop/pstack" },
          ponytail: { source: "dietrichgebert/ponytail" },
        },
      }),
    );
    const policy = await loadDefaultSkillPolicy(home, selected);

    expect([...policy.standaloneSkillSources]).toEqual([
      ["tdd", "mattpocock/skills"],
    ]);
    expect(buildDefaultSkillConfig(skills, policy)).toEqual([
      { path: skills[0]!.path, enabled: true },
      { path: skills[1]!.path, enabled: false },
      { path: skills[2]!.path, enabled: false },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rejects both Ponytail plugin forms and keeps trusted i-have-adhd provenance", () => {
  const agentsSkillsRoot = "/Users/test/.agents/skills";
  const codexPluginCacheRoot = "/Users/test/.codex/plugins/cache";
  const pluginPath = join(
    codexPluginCacheRoot,
    "i-have-adhd",
    "i-have-adhd",
    "1.0.0",
    "skills",
    "focus",
    "SKILL.md",
  );
  const skills = [
    {
      name: "i-have-adhd:focus",
      path: pluginPath,
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
    {
      name: "ponytail:ponytail",
      path: join(agentsSkillsRoot, "ponytail:ponytail", "SKILL.md"),
      enabled: true,
    },
  ];
  const policy = {
    agentsSkillsRoot,
    codexPluginCacheRoot,
    standaloneSkillSources: new Map<string, string>(),
    selectedSkillKeys: new Set([
      skillIdentityKey({
        name: "i-have-adhd:focus",
        source: "ayghri/i-have-adhd",
      }),
      skillIdentityKey({
        name: "ponytail:ponytail",
        source: "dietrichgebert/ponytail",
      }),
    ]),
  };

  expect(buildDefaultSkillConfig(skills, policy)).toEqual([
    { path: pluginPath, enabled: true },
    { path: skills[1]!.path, enabled: false },
    { path: skills[2]!.path, enabled: false },
  ]);
});

test("builds choices only from installed trusted skills", () => {
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
        {
          name: "unslop",
          path: "/Users/test/.agents/skills/unslop/SKILL.md",
          enabled: true,
        },
      ],
      policy,
    ),
  ).toEqual([
    {
      identity: { name: "tdd", source: "mattpocock/skills" },
      initiallySelected: true,
    },
  ]);
});

test("discovers only the newest trusted plugin and skips symlinked skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-skill-discovery-"));
  try {
    const policy = await loadDefaultSkillPolicy(home);
    const root = join(
      policy.codexPluginCacheRoot,
      "i-have-adhd",
      "i-have-adhd",
    );
    for (const version of ["1.0.0", "1.1.0"]) {
      const directory = join(root, version, "skills", "focus");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), "trusted skill");
    }
    await mkdir(policy.agentsSkillsRoot, { recursive: true });
    await symlink(
      join(root, "1.1.0", "skills", "focus"),
      join(policy.agentsSkillsRoot, "tdd"),
    );

    expect(await discoverTrustedSkills(policy)).toEqual([
      {
        name: "i-have-adhd:focus",
        path: join(root, "1.1.0", "skills", "focus", "SKILL.md"),
        enabled: true,
      },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
