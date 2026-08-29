import type { CodexClientApi } from "./client";
import { type DiscoveredSkill, SkillListResponseSchema } from "./skill-policy";

type SkillCatalogClient = Pick<CodexClientApi, "request">;

/** Returns one complete workspace skill list or fails closed. */
export async function listWorkspaceSkills(
  client: SkillCatalogClient,
  cwd: string,
): Promise<DiscoveredSkill[]> {
  const catalog = SkillListResponseSchema.parse(
    await client.request("skills/list", { cwds: [cwd] }),
  );
  const workspace = catalog.data.find((entry) => entry.cwd === cwd);
  if (workspace === undefined || workspace.errors.length > 0) {
    throw new Error("Codex did not return a complete workspace skill catalog");
  }
  return workspace.skills;
}
