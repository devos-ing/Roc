import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const NonEmpty = z.string().trim().min(1);

const DiscoveredSkillSchema = z
  .object({
    name: NonEmpty,
    path: NonEmpty,
    enabled: z.boolean(),
  })
  .passthrough();

export const SkillListResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          cwd: NonEmpty,
          skills: z.array(DiscoveredSkillSchema),
          errors: z.array(z.unknown()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const SkillLockSchema = z
  .object({
    skills: z.record(z.string(), z.object({ source: NonEmpty }).passthrough()),
  })
  .passthrough();

const allowedStandaloneSources = new Set([
  "mattpocock/skills",
  "ayghri/i-have-adhd",
  "dietrichgebert/ponytail",
]);

export type DiscoveredSkill = z.infer<typeof DiscoveredSkillSchema>;
export type DefaultSkillPolicy = {
  agentsSkillsRoot: string;
  allowedStandaloneSkillNames: Set<string>;
};

export async function loadDefaultSkillPolicy(
  home = homedir(),
): Promise<DefaultSkillPolicy> {
  const agentsRoot = join(home, ".agents");
  const raw = await Bun.file(join(agentsRoot, ".skill-lock.json"))
    .json()
    .catch(() => undefined);
  const parsed = SkillLockSchema.safeParse(raw);
  const allowedStandaloneSkillNames = new Set<string>();
  if (parsed.success) {
    for (const [name, metadata] of Object.entries(parsed.data.skills)) {
      if (allowedStandaloneSources.has(metadata.source.toLowerCase())) {
        allowedStandaloneSkillNames.add(name);
      }
    }
  }
  return {
    agentsSkillsRoot: join(agentsRoot, "skills"),
    allowedStandaloneSkillNames,
  };
}

export function buildDefaultSkillConfig(
  skills: DiscoveredSkill[],
  input: DefaultSkillPolicy,
): { path: string; enabled: boolean }[] {
  return skills.map((skill) => {
    const standalonePath = join(input.agentsSkillsRoot, skill.name, "SKILL.md");
    const allowed =
      skill.name.startsWith("ponytail:") ||
      skill.name.startsWith("i-have-adhd:") ||
      (input.allowedStandaloneSkillNames.has(skill.name) &&
        skill.path === standalonePath);
    return { path: skill.path, enabled: skill.enabled && allowed };
  });
}
