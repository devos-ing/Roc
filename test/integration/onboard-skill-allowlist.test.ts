import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import { loadSchedulerSkillPolicy } from "../../src/cli/runtime";
import { loadRocSettings, saveRocSettings } from "../../src/settings";
import {
  buildDefaultSkillConfig,
  discoverTrustedSkills,
  loadDefaultSkillPolicy,
} from "../../src/skills/policy";

test("onboarding selection becomes the scheduler skill configuration", async () => {
  const project = await mkdtemp(join(tmpdir(), "roc-allowlist-project-"));
  const home = await mkdtemp(join(tmpdir(), "roc-allowlist-home-"));
  const agentsSkills = join(home, ".agents", "skills");
  const discovered = [
    {
      name: "tdd",
      path: join(agentsSkills, "tdd", "SKILL.md"),
      enabled: true,
    },
    {
      name: "unslop",
      path: join(agentsSkills, "unslop", "SKILL.md"),
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
        },
      }),
    );
    for (const skill of discovered) {
      await mkdir(join(agentsSkills, skill.name), { recursive: true });
      await writeFile(skill.path, "# Trusted fixture skill");
    }
    await mkdir(join(agentsSkills, "untrusted"), { recursive: true });
    await writeFile(
      join(agentsSkills, "untrusted", "SKILL.md"),
      "# Not in the trusted lock",
    );
    const io = {
      out: () => {},
      err: () => {},
      ask: async (question: string) =>
        question.startsWith("Roc's coding tools") ? "yes" : "2",
      selectCycle: async () => "weekly" as const,
      selectSkills: async () => ({
        kind: "selected" as const,
        identities: [{ name: "unslop", source: "backnotprop/pstack" }],
      }),
    };
    const runtime = {
      runScheduler: async () => {},
      configureModel: async () => "openai-codex/gpt-5.5",
      projectRoot: project,
      homeRoot: home,
      listWorkspaceSkills: async () =>
        discoverTrustedSkills(await loadDefaultSkillPolicy(home)),
    };

    expect(await runCli(["onboard", "--global"], io, runtime)).toBe(0);
    const settings = await loadRocSettings(home);
    expect(settings.skills?.allowlist).toEqual([
      { name: "unslop", source: "backnotprop/pstack" },
    ]);
    const models = { luna: "openai-codex/gpt-5.6-luna" };
    await saveRocSettings({ ...settings, models }, home);
    expect(await runCli(["onboard", "--global"], io, runtime)).toBe(0);
    expect((await loadRocSettings(home)).models).toEqual(models);
    const policy = await loadSchedulerSkillPolicy(home);
    expect(
      buildDefaultSkillConfig(await discoverTrustedSkills(policy), policy).sort(
        (a, b) => a.path.localeCompare(b.path),
      ),
    ).toEqual([
      { path: discovered[0]!.path, enabled: false },
      { path: discovered[1]!.path, enabled: true },
    ]);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
