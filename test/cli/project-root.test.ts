import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  normalizeProjectSlug,
  projectDisplaySlug,
  resolveProjectDisplaySlug,
  resolveProjectRoot,
} from "../../src/cli/project-root";
import { git } from "../helpers/git";

const roots: string[] = [];

/** Creates an isolated directory outside the checkout and records it for cleanup. */
async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "roc-project-root-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

test("finds the nearest Roc project from a nested directory", async () => {
  const root = await temporaryDirectory();
  const nested = join(root, "packages", "worker", "src");
  await mkdir(join(root, ".agile"), { recursive: true });
  await mkdir(nested, { recursive: true });

  expect(await resolveProjectRoot(nested)).toBe(await realpath(root));
});

test("falls back to the Git checkout root before Roc is initialized", async () => {
  const root = await temporaryDirectory();
  const nested = join(root, "packages", "worker");
  await mkdir(nested, { recursive: true });
  await git(["init"], root);

  expect(await resolveProjectRoot(nested)).toBe(await realpath(root));
});

test("ignores inherited Git repository overrides when resolving another checkout", async () => {
  const hookRoot = await temporaryDirectory();
  const targetRoot = await temporaryDirectory();
  const nested = join(targetRoot, "packages", "worker");
  await mkdir(nested, { recursive: true });
  await git(["init"], hookRoot);
  await git(["init"], targetRoot);
  const priorGitDir = process.env.GIT_DIR;
  const priorGitIndexFile = process.env.GIT_INDEX_FILE;
  process.env.GIT_DIR = join(hookRoot, ".git");
  process.env.GIT_INDEX_FILE = join(hookRoot, ".git", "index");

  try {
    expect(await resolveProjectRoot(nested)).toBe(await realpath(targetRoot));
    await git(
      ["remote", "add", "origin", "git@github.com:devos-ing/Target.git"],
      targetRoot,
    );
    expect(await resolveProjectDisplaySlug(targetRoot)).toBe("target");
  } finally {
    if (priorGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = priorGitDir;
    if (priorGitIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = priorGitIndexFile;
  }
});

test("uses the containing repository origin from a Git worktree", async () => {
  const root = await temporaryDirectory();
  const worktree = await temporaryDirectory();
  await git(["init"], root);
  await git(["config", "user.email", "test@example.com"], root);
  await git(["config", "user.name", "Test User"], root);
  await writeFile(join(root, "README.md"), "fixture\n");
  await git(["add", "README.md"], root);
  await git(["commit", "-m", "fixture"], root);
  await git(
    [
      "remote",
      "add",
      "origin",
      "https://github.com/devos-ing/Worktree-Roc.git",
    ],
    root,
  );
  await git(["worktree", "add", "-b", "display-fixture", worktree], root);

  expect(await resolveProjectDisplaySlug(worktree)).toBe("worktree-roc");
});

test("rejects a project-bound command outside Roc and Git projects", async () => {
  const root = await temporaryDirectory();

  await expect(resolveProjectRoot(root)).rejects.toMatchObject({
    code: "PROJECT_ROOT_NOT_FOUND",
  });
  expect(await resolveProjectRoot(root, { allowCurrentDirectory: true })).toBe(
    await realpath(root),
  );
});

test("derives a local display slug from normal, SSH, local, and absent origins", async () => {
  const root = await temporaryDirectory();
  await git(["init"], root);
  await git(
    ["remote", "add", "origin", "https://github.com/devos-ing/Roc.git"],
    root,
  );

  expect(await resolveProjectDisplaySlug(root)).toBe("roc");
  expect(
    projectDisplaySlug("https://example.com/---.git", "/srv/My Project"),
  ).toBe("my-project");
  await git(
    ["remote", "set-url", "origin", "git@github.com:devos-ing/Roc.git"],
    root,
  );
  expect(await resolveProjectDisplaySlug(root)).toBe("roc");
  expect(
    projectDisplaySlug("git@example.com:Team:Core.git", "/srv/My Project"),
  ).toBe("team-core");
  expect(
    projectDisplaySlug("git@[2001:db8::1]:Roc.git", "/srv/My Project"),
  ).toBe("roc");
  expect(projectDisplaySlug("[2001:db8::1]:Roc.git", "/srv/My Project")).toBe(
    "roc",
  );
  expect(
    projectDisplaySlug("git@example.com:Team[Core].git", "/srv/My Project"),
  ).toBe("team-core");
  expect(
    projectDisplaySlug(
      "git@example.com:team/nested/Roc.git",
      "/srv/My Project",
    ),
  ).toBe("roc");
  await git(["remote", "set-url", "origin", "/srv/本地 Repo.git"], root);
  expect(await resolveProjectDisplaySlug(root)).toBe("本地-repo");
  expect(projectDisplaySlug("/srv/Team:Core.git", "/srv/My Project")).toBe(
    "team-core",
  );
  expect(projectDisplaySlug("./Team:Core.git", "/srv/My Project")).toBe(
    "team-core",
  );
  expect(projectDisplaySlug("../Team:Core.git", "/srv/My Project")).toBe(
    "team-core",
  );
  await git(["remote", "set-url", "origin", "file:///srv/本地 Repo.git"], root);
  expect(await resolveProjectDisplaySlug(root)).toBe("本地-repo");
  expect(
    projectDisplaySlug("file:///srv/Team:Core.git", "/srv/My Project"),
  ).toBe("team-core");
  await git(["remote", "remove", "origin"], root);
  expect(await resolveProjectDisplaySlug(root)).toBe(
    normalizeProjectSlug(basename(root)),
  );
  expect(projectDisplaySlug(undefined, "---")).toBe("project");
});
