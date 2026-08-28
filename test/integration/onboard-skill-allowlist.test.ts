import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/run";
import { loadSchedulerSkillPolicy } from "../../src/cli/runtime";
import { buildDefaultSkillConfig } from "../../src/agents/codex/skill-policy";
import { loadRocSettings } from "../../src/settings";

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
    const io = {
      out: () => {},
      err: () => {},
      ask: async () => "2",
      selectSkills: async () => ({
        kind: "selected" as const,
        identities: [{ name: "unslop", source: "backnotprop/pstack" }],
      }),
    };
    const runtime = {
      runScheduler: async () => {},
      projectRoot: project,
      homeRoot: home,
      listWorkspaceSkills: async () => discovered,
    };

    expect(await runCli(["onboard", "--global"], io, runtime)).toBe(0);
    const settings = await loadRocSettings(home);
    expect(settings.skills?.allowlist).toEqual([
      { name: "unslop", source: "backnotprop/pstack" },
    ]);
    const policy = await loadSchedulerSkillPolicy(home);
    expect(buildDefaultSkillConfig(discovered, policy)).toEqual([
      { path: discovered[0]!.path, enabled: false },
      { path: discovered[1]!.path, enabled: true },
    ]);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
