import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  type SkillIdentity,
  skillIdentityKey,
} from "../domain/skill-allowlist";

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
const UNSLOP_IDENTITY = {
  name: "unslop",
  source: "backnotprop/pstack",
} as const;
const pluginSources = [
  { prefix: "ponytail:", source: "dietrichgebert/ponytail" },
  { prefix: "i-have-adhd:", source: "ayghri/i-have-adhd" },
] as const;

export type DiscoveredSkill = z.infer<typeof DiscoveredSkillSchema>;
export type DefaultSkillCandidate = {
  identity: SkillIdentity;
  installed: boolean;
  initiallySelected: boolean;
};
export type DefaultSkillPolicy = {
  agentsSkillsRoot: string;
  standaloneSkillSources: ReadonlyMap<string, string>;
  selectedSkillKeys?: ReadonlySet<string>;
};

/** Resolves one discovered skill to a trusted stable identity when policy permits it. */
function trustedIdentityFor(
  skill: DiscoveredSkill,
  input: DefaultSkillPolicy,
): SkillIdentity | undefined {
  const plugin = pluginSources.find(({ prefix }) =>
    skill.name.startsWith(prefix),
  );
  if (plugin !== undefined) return { name: skill.name, source: plugin.source };

  const expectedPath = join(input.agentsSkillsRoot, skill.name, "SKILL.md");
  if (skill.path !== expectedPath) return undefined;
  const source = input.standaloneSkillSources.get(skill.name);
  return source === undefined ? undefined : { name: skill.name, source };
}

/** Loads trusted standalone source metadata and an optional saved selection. */
export async function loadDefaultSkillPolicy(
  home = homedir(),
  selected?: SkillIdentity[],
): Promise<DefaultSkillPolicy> {
  const agentsRoot = join(home, ".agents");
  const raw = await Bun.file(join(agentsRoot, ".skill-lock.json"))
    .json()
    .catch(() => undefined);
  const parsed = SkillLockSchema.safeParse(raw);
  const standaloneSkillSources = new Map<string, string>();
  if (parsed.success) {
    for (const [name, metadata] of Object.entries(parsed.data.skills)) {
      const source = metadata.source.toLowerCase();
      if (
        allowedStandaloneSources.has(source) ||
        (name === UNSLOP_IDENTITY.name && source === UNSLOP_IDENTITY.source)
      ) {
        standaloneSkillSources.set(name, source);
      }
    }
  }
  return {
    agentsSkillsRoot: join(agentsRoot, "skills"),
    standaloneSkillSources,
    ...(selected === undefined
      ? {}
      : { selectedSkillKeys: new Set(selected.map(skillIdentityKey)) }),
  };
}

/** Builds deterministic onboarding choices from trusted discovered skills. */
export function buildDefaultSkillCandidates(
  skills: DiscoveredSkill[],
  input: DefaultSkillPolicy,
): DefaultSkillCandidate[] {
  const candidates = skills.flatMap((skill) => {
    const identity = trustedIdentityFor(skill, input);
    if (identity === undefined) return [];
    return [
      {
        identity,
        installed: true,
        initiallySelected:
          input.selectedSkillKeys === undefined ||
          input.selectedSkillKeys.has(skillIdentityKey(identity)),
      },
    ];
  });
  if (
    !candidates.some(
      ({ identity }) =>
        skillIdentityKey(identity) === skillIdentityKey(UNSLOP_IDENTITY),
    )
  ) {
    candidates.push({
      identity: UNSLOP_IDENTITY,
      installed: false,
      initiallySelected: false,
    });
  }
  return candidates.sort(
    (left, right) =>
      Number(right.installed) - Number(left.installed) ||
      left.identity.source.localeCompare(right.identity.source) ||
      left.identity.name.localeCompare(right.identity.name),
  );
}

/** Converts discovered skills into the enabled configuration permitted by trust and selection. */
export function buildDefaultSkillConfig(
  skills: DiscoveredSkill[],
  input: DefaultSkillPolicy,
): { path: string; enabled: boolean }[] {
  return skills.map((skill) => {
    const identity = trustedIdentityFor(skill, input);
    const selected =
      identity !== undefined &&
      (input.selectedSkillKeys === undefined ||
        input.selectedSkillKeys.has(skillIdentityKey(identity)));
    return { path: skill.path, enabled: skill.enabled && selected };
  });
}
