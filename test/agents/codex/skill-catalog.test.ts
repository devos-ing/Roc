import { expect, test } from "bun:test";
import { listWorkspaceSkills } from "../../../src/agents/codex/skill-catalog";

test("returns the complete requested workspace skill catalog", async () => {
  const client = {
    request: async () => ({
      data: [
        {
          cwd: "/repo",
          skills: [
            { name: "tdd", path: "/skills/tdd/SKILL.md", enabled: true },
          ],
          errors: [],
        },
      ],
    }),
  };

  await expect(listWorkspaceSkills(client, "/repo")).resolves.toEqual([
    { name: "tdd", path: "/skills/tdd/SKILL.md", enabled: true },
  ]);
});

test("fails closed for a missing or partial workspace catalog", async () => {
  for (const response of [
    { data: [] },
    { data: [{ cwd: "/repo", skills: [], errors: ["failed"] }] },
  ]) {
    await expect(
      listWorkspaceSkills({ request: async () => response }, "/repo"),
    ).rejects.toThrow("complete workspace skill catalog");
  }
});
