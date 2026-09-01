import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPackagedSkills } from "../../src/skills/install";

test("packaged skill installation rejects a symbolic-link source without writing targets", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "roc-skill-source-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "roc-skill-target-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "roc-skill-outside-"));
  const outsideFile = join(outsideRoot, "SKILL.md");
  await mkdir(join(sourceRoot, "unsafe-skill"));
  await writeFile(outsideFile, "outside source");
  await symlink(outsideFile, join(sourceRoot, "unsafe-skill", "SKILL.md"));

  try {
    await expect(
      installPackagedSkills({ sourceRoot, root: targetRoot }),
    ).rejects.toThrow("Skill source path is a symbolic link");
    await expect(lstat(join(targetRoot, ".agents"))).rejects.toThrow();
    expect(await readFile(outsideFile, "utf8")).toBe("outside source");
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("packaged skill installation rejects a nested destination symbolic link without writing through it", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "roc-skill-source-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "roc-skill-target-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "roc-skill-outside-"));
  await mkdir(join(sourceRoot, "review-skill", "scripts"), {
    recursive: true,
  });
  await writeFile(
    join(sourceRoot, "review-skill", "scripts", "ledger.py"),
    "print('safe')\n",
  );
  await mkdir(join(targetRoot, ".agents", "skills", "review-skill"), {
    recursive: true,
  });
  await symlink(
    outsideRoot,
    join(targetRoot, ".agents", "skills", "review-skill", "scripts"),
    "dir",
  );

  try {
    await expect(
      installPackagedSkills({ sourceRoot, root: targetRoot }),
    ).rejects.toThrow("Skill path component is a symbolic link");
    await expect(lstat(join(outsideRoot, "ledger.py"))).rejects.toThrow();
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
