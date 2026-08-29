import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { resolveProjectRoot } from "../../src/cli/project-root";

const roots: string[] = [];

/** Creates an isolated directory outside the checkout and records it for cleanup. */
async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join("/tmp", "roc-project-root-"));
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
  await simpleGit({ baseDir: root }).init();

  expect(await resolveProjectRoot(nested)).toBe(await realpath(root));
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
