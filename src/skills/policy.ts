import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import {
  type SkillIdentity,
  skillIdentityKey,
} from "../domain/skill-allowlist";
import { loadRocSettings } from "../settings";

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
  {
    prefix: "ponytail:",
    source: "dietrichgebert/ponytail",
    cachePublisher: "ponytail",
    cachePackage: "ponytail",
  },
  {
    prefix: "i-have-adhd:",
    source: "ayghri/i-have-adhd",
    cachePublisher: "i-have-adhd",
    cachePackage: "i-have-adhd",
  },
] as const;

export type DiscoveredSkill = z.infer<typeof DiscoveredSkillSchema>;
export type DefaultSkillCandidate = {
  identity: SkillIdentity;
  installed: boolean;
  initiallySelected: boolean;
};
export type DefaultSkillPolicy = {
  agentsSkillsRoot: string;
  codexPluginCacheRoot: string;
  standaloneSkillSources: ReadonlyMap<string, string>;
  selectedSkillKeys?: ReadonlySet<string>;
};

/** Returns whether a value can name exactly one safe filesystem path segment. */
function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

/** Resolves a discovered plugin skill only when its cache path has trusted provenance. */
function trustedPluginIdentityFor(
  skill: DiscoveredSkill,
  input: DefaultSkillPolicy,
): SkillIdentity | undefined {
  const plugin = pluginSources.find(({ prefix }) =>
    skill.name.startsWith(prefix),
  );
  if (plugin === undefined) return undefined;

  const suffix = skill.name.slice(plugin.prefix.length);
  if (!isSafePathSegment(suffix)) return undefined;

  const pluginRoot = join(
    input.codexPluginCacheRoot,
    plugin.cachePublisher,
    plugin.cachePackage,
  );
  const [version, skillsDirectory, pathSuffix, fileName, ...extra] = relative(
    pluginRoot,
    skill.path,
  ).split(sep);
  if (
    extra.length > 0 ||
    version === undefined ||
    !isSafePathSegment(version) ||
    skillsDirectory !== "skills" ||
    pathSuffix !== suffix ||
    fileName !== "SKILL.md"
  ) {
    return undefined;
  }
  const expectedPath = join(
    pluginRoot,
    version,
    skillsDirectory,
    pathSuffix,
    fileName,
  );
  return skill.path === expectedPath
    ? { name: skill.name, source: plugin.source }
    : undefined;
}

/** Resolves one discovered skill to a trusted stable identity when policy permits it. */
function trustedIdentityFor(
  skill: DiscoveredSkill,
  input: DefaultSkillPolicy,
): SkillIdentity | undefined {
  if (pluginSources.some(({ prefix }) => skill.name.startsWith(prefix))) {
    return trustedPluginIdentityFor(skill, input);
  }

  if (!isSafePathSegment(skill.name)) return undefined;
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
    codexPluginCacheRoot: join(home, ".codex", "plugins", "cache"),
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

/** Loads the trusted skill policy intersected with the saved onboarding selection. */
export async function loadSchedulerSkillPolicy(
  homeRoot = homedir(),
): Promise<DefaultSkillPolicy> {
  const settings = await loadRocSettings(homeRoot);
  return loadDefaultSkillPolicy(homeRoot, settings.skills?.allowlist);
}

/** Discovers installed trusted skills locally without starting an agent or loading skill code. */
export async function discoverTrustedSkills(
  policy: DefaultSkillPolicy,
): Promise<DiscoveredSkill[]> {
  const skills = new Map<string, DiscoveredSkill>();
  const roots = [
    { root: policy.agentsSkillsRoot, pattern: "*/SKILL.md", prefix: "" },
    ...pluginSources.map((plugin) => ({
      root: join(
        policy.codexPluginCacheRoot,
        plugin.cachePublisher,
        plugin.cachePackage,
      ),
      pattern: "*/skills/*/SKILL.md",
      prefix: plugin.prefix,
    })),
  ];
  for (const { root, pattern, prefix } of roots) {
    try {
      const paths = await Array.fromAsync(
        new Bun.Glob(pattern).scan({
          cwd: root,
          absolute: true,
          onlyFiles: true,
          followSymlinks: false,
        }),
      );
      paths.sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true }),
      );
      for (const path of paths) {
        const name = prefix + path.split(sep).at(-2);
        const skill = { name, path, enabled: true };
        const identity = trustedIdentityFor(skill, policy);
        if (identity === undefined || !(await lstat(path)).isFile()) continue;
        const key = skillIdentityKey(identity);
        if (!skills.has(key)) skills.set(key, skill);
      }
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  return [...skills.values()];
}
