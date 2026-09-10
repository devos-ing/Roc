import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskBranchManager } from "../../src/workspace/task-branch";
import { git } from "../helpers/git";

test("tasks keep separate native worktrees and preparing another task leaves dirty work untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-native-worktrees-"));
  try {
    await git(["init", "--initial-branch=main"], root);
    await git(["config", "user.name", "Roc Test"], root);
    await git(["config", "user.email", "roc@example.test"], root);
    await writeFile(join(root, "value.txt"), "base\n");
    await git(["add", "."], root);
    await git(["commit", "-m", "seed"], root);
    const base = await git(["rev-parse", "HEAD"], root);
    const manager = await createTaskBranchManager(root, base);
    const a = await manager.prepare("issue-41", base);
    await writeFile(join(a.path, "value.txt"), "task A\n");
    const b = await manager.prepare("issue-42", base);
    expect(a.path).not.toBe(b.path);
    expect(await readFile(join(a.path, "value.txt"), "utf8")).toBe("task A\n");
    expect(await readFile(join(b.path, "value.txt"), "utf8")).toBe("base\n");
    expect(await git(["rev-list", "--count", `${base}..HEAD`], a.path)).toBe(
      "0",
    );
    expect(await git(["worktree", "list", "--porcelain"], root)).toContain(
      a.path,
    );
    const commit = await manager.commitChanges("issue-41", base);
    await manager.assertReviewReady("issue-41", commit, base);
    expect(await manager.status("issue-41", base)).toBe("");
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("base\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}.agile-worktrees`, { recursive: true, force: true });
    await rm(`${root}.agile-checkout`, { recursive: true, force: true });
  }
});
