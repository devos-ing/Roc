import { z } from "zod";

const NonEmpty = z.string().trim().min(1);

export const SkillIdentitySchema = z
  .object({ name: NonEmpty, source: NonEmpty })
  .strict();

export const SkillSettingsSchema = z
  .object({ allowlist: z.array(SkillIdentitySchema) })
  .strict();

export type SkillIdentity = z.infer<typeof SkillIdentitySchema>;
export type SkillSettings = z.infer<typeof SkillSettingsSchema>;

/** Produces a collision-safe key for one normalized skill identity. */
export function skillIdentityKey(identity: SkillIdentity): string {
  const parsed = SkillIdentitySchema.parse(identity);
  return JSON.stringify([parsed.source.toLowerCase(), parsed.name]);
}
