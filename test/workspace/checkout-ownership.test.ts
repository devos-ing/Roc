import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCheckoutOwnership } from "../../src/workspace/checkout-ownership";

async function createRepositoryRoot(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "roc-checkout-owner-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  return { root, repo };
}

async function removeRepositoryRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await rm(`${join(root, "repo")}.agile-checkout.lock`, {
    force: true,
  });
}

test("excludes canonical repository aliases until the owner releases", async () => {
  const { root, repo } = await createRepositoryRoot();
  const alias = join(root, "alias");
  await symlink(repo, alias);
  try {
    const owner = await acquireCheckoutOwnership(repo, "owner-a");
    expect((await stat(owner.lockPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(owner.lockPath, "utf8"))).toMatchObject({
      version: 1,
      runId: "owner-a",
      ownerPid: process.pid,
    });
    await expect(
      acquireCheckoutOwnership(alias, "owner-b"),
    ).rejects.toMatchObject({
      code: "SCHEDULER_CHECKOUT_IN_USE",
      category: "startup",
      retryable: false,
      component: "workspace",
      runId: "owner-b",
    });
    await owner.release();
    const next = await acquireCheckoutOwnership(alias, "owner-b");
    await next.release();
    await expect(next.release()).resolves.toBeUndefined();
  } finally {
    await removeRepositoryRoot(root);
  }
});

test("refuses an existing malformed lock rather than recovering it", async () => {
  const { root, repo } = await createRepositoryRoot();
  const lockPath = `${await realpath(repo)}.agile-checkout.lock`;
  await writeFile(lockPath, "not ownership metadata");
  try {
    await expect(
      acquireCheckoutOwnership(repo, "owner-b"),
    ).rejects.toMatchObject({
      code: "SCHEDULER_CHECKOUT_IN_USE",
      runId: "owner-b",
    });
    expect(await readFile(lockPath, "utf8")).toBe("not ownership metadata");
  } finally {
    await removeRepositoryRoot(root);
  }
});

test("refuses a lock-path symlink without touching its target", async () => {
  const { root, repo } = await createRepositoryRoot();
  const target = join(root, "target");
  const lockPath = `${repo}.agile-checkout.lock`;
  await writeFile(target, "do not modify");
  await symlink(target, lockPath);
  try {
    await expect(
      acquireCheckoutOwnership(repo, "owner-b"),
    ).rejects.toMatchObject({
      code: "SCHEDULER_CHECKOUT_IN_USE",
    });
    expect(await readFile(target, "utf8")).toBe("do not modify");
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
  } finally {
    await removeRepositoryRoot(root);
  }
});

test("does not delete a lock file replaced after acquisition", async () => {
  const { root, repo } = await createRepositoryRoot();
  const lockPath = `${repo}.agile-checkout.lock`;
  try {
    const owner = await acquireCheckoutOwnership(repo, "owner-a");
    await rm(lockPath);
    await writeFile(lockPath, "replacement owner");

    const failedRelease = owner.release();
    await expect(failedRelease).rejects.toMatchObject({
      code: "SCHEDULER_CHECKOUT_OWNERSHIP_LOST",
      category: "infra",
      retryable: false,
      component: "workspace",
      runId: "owner-a",
    });
    expect(owner.release()).toBe(failedRelease);
    await expect(owner.release()).rejects.toMatchObject({
      code: "SCHEDULER_CHECKOUT_OWNERSHIP_LOST",
    });
    expect(await readFile(lockPath, "utf8")).toBe("replacement owner");
  } finally {
    await removeRepositoryRoot(root);
  }
});

test("serializes concurrent release calls before a successor acquires", async () => {
  const { root, repo } = await createRepositoryRoot();
  try {
    const owner = await acquireCheckoutOwnership(repo, "owner-a");
    const firstRelease = owner.release();
    const concurrentRelease = owner.release();
    const sharesReleasePromise = concurrentRelease === firstRelease;
    await expect(
      Promise.all([firstRelease, concurrentRelease, owner.release()]),
    ).resolves.toEqual([undefined, undefined, undefined]);
    expect(sharesReleasePromise).toBe(true);

    const successor = await acquireCheckoutOwnership(repo, "owner-b");
    await expect(
      Promise.all([owner.release(), owner.release()]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(
      acquireCheckoutOwnership(repo, "owner-c"),
    ).rejects.toMatchObject({
      code: "SCHEDULER_CHECKOUT_IN_USE",
    });
    await successor.release();
  } finally {
    await removeRepositoryRoot(root);
  }
});

test("excludes other Bun processes and retains a lock after their exit", async () => {
  const { root, repo } = await createRepositoryRoot();
  const lockPath = `${await realpath(repo)}.agile-checkout.lock`;
  const moduleUrl = new URL(
    "../../src/workspace/checkout-ownership.ts",
    import.meta.url,
  ).href;
  const acquireScript = [
    `import { acquireCheckoutOwnership } from ${JSON.stringify(moduleUrl)};`,
    'const owner = await acquireCheckoutOwnership(process.argv.at(-1), "child");',
    "console.log(owner.lockPath);",
  ].join("\n");
  const rejectScript = [
    `import { acquireCheckoutOwnership } from ${JSON.stringify(moduleUrl)};`,
    "try {",
    '  await acquireCheckoutOwnership(process.argv.at(-1), "child");',
    '  console.log("acquired");',
    "} catch (error) {",
    '  console.log(error instanceof Error && "code" in error ? error.code : "unknown");',
    "}",
  ].join("\n");
  try {
    const owner = await acquireCheckoutOwnership(repo, "parent");
    const rejected = Bun.spawn([process.execPath, "-e", rejectScript, repo], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await rejected.exited).toBe(0);
    expect((await new Response(rejected.stdout).text()).trim()).toBe(
      "SCHEDULER_CHECKOUT_IN_USE",
    );
    await owner.release();

    const acquired = Bun.spawn([process.execPath, "-e", acquireScript, repo], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await acquired.exited).toBe(0);
    expect((await new Response(acquired.stdout).text()).trim()).toBe(lockPath);
    await expect(
      acquireCheckoutOwnership(repo, "successor"),
    ).rejects.toMatchObject({
      code: "SCHEDULER_CHECKOUT_IN_USE",
    });
  } finally {
    await removeRepositoryRoot(root);
  }
});
