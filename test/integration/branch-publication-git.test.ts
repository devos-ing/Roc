import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunGitHubCommandRunner,
  GitHubBranchPublisher,
  type GitHubCommandRunner,
} from "../../src/github/pr-publisher";
import { createTaskBranchManager } from "../../src/workspace/task-branch";

/** Runs one real git command and fails on a nonzero exit without a shell. */
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.exitCode !== 0)
    throw Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString().trim();
}

/** Builds a bare origin, a seed checkout holding the shared base A and the task commit T. */
async function fixture(): Promise<{
  root: string;
  origin: string;
  seed: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "roc-branch-publication-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--bare", "-b", "main", "origin.git");
  git(root, "init", "-b", "main", "seed");
  git(seed, "config", "user.name", "Fixture");
  git(seed, "config", "user.email", "fixture@local");
  await writeFile(join(seed, "base.txt"), "A\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "base A");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main");
  git(seed, "checkout", "-b", "agile/T1");
  await writeFile(join(seed, "answer.ts"), "42\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "agile(T1): implement ticket");
  git(seed, "checkout", "main");
  return { root, origin, seed };
}

/** Records every publisher command while running it against real git. */
function recording(commands: string[][]): GitHubCommandRunner {
  const inner = new BunGitHubCommandRunner();
  return {
    async run(input) {
      commands.push(input.command);
      return inner.run(input);
    },
  };
}

function publishInput(baseCommit: string, commitSha: string) {
  return {
    task: {
      id: "T1",
      cycleId: "2026-W37",
      title: "Land without a pull request",
      spec: {
        problem: "No landing",
        desiredOutcome: "Landed commit",
        scope: ["answer.ts"],
        nonGoals: [],
        acceptanceCriteria: ["answer is 42"],
        validation: ["bun test"],
        dependencies: [],
        risk: "medium" as const,
        contextCandidates: [],
        tokenCeiling: 1,
      },
      status: "publishing" as const,
      priority: 0,
      approvalRequired: false,
      approved: true,
      baseCommit,
    },
    implementation: {
      kind: "implement" as const,
      commitSha,
      validation: ["bun test"],
      risks: [],
      limitations: [],
    },
    publication: {
      taskId: "T1",
      branch: "agile/T1",
      baseBranch: "main",
      commitSha,
      status: "pending" as const,
    },
  };
}

test("branch publication rebases onto an advanced base, lands both changes, and traces the original commit with a tag", async () => {
  const { root, origin, seed } = await fixture();
  try {
    const baseSha = git(seed, "rev-parse", "main");
    // Concurrent work advances origin's base before the task publishes.
    await writeFile(join(seed, "base.txt"), "A+B\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "base B");
    git(seed, "push", "origin", "main");
    const originalHead = git(seed, "rev-parse", "refs/heads/agile/T1");
    const commands: string[][] = [];
    const branches = await createTaskBranchManager(
      seed,
      "refs/remotes/origin/main",
    );
    const publisher = new GitHubBranchPublisher(
      "main",
      branches,
      recording(commands),
    );

    const published = await publisher.publish(
      publishInput(baseSha, originalHead),
    );

    const landed = git(origin, "rev-parse", "refs/heads/main");
    expect(published).toEqual({ branch: "agile/T1", commitSha: landed });
    // The rebase rewrote the task commit onto the advanced base.
    expect(landed).not.toBe(originalHead);
    expect(git(origin, "show", "main:answer.ts")).toBe("42");
    expect(git(origin, "show", "main:base.txt")).toBe("A+B");
    // The tag preserves the original commit on origin; the task branch names the landed head.
    expect(git(origin, "rev-parse", "refs/tags/agile-trace/T1")).toBe(
      originalHead,
    );
    expect(git(origin, "rev-parse", "refs/heads/agile/T1")).toBe(landed);
    expect(commands.flat().some((arg) => arg.includes("force"))).toBe(false);
    const basePush = commands.findIndex((command) =>
      command.includes(`${landed}:refs/heads/main`),
    );
    const traceTagPush = commands.findIndex((command) =>
      command.includes(`${originalHead}:refs/tags/agile-trace/T1`),
    );
    const branchPush = commands.findIndex((command) =>
      command.some((arg) => arg.endsWith(":refs/heads/agile/T1")),
    );
    expect(basePush).toBeGreaterThan(0);
    expect(traceTagPush).toBeGreaterThan(basePush);
    expect(branchPush).toBeGreaterThan(basePush);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("branch publication restarts after an interrupted trace push and finishes idempotently", async () => {
  const { root, origin, seed } = await fixture();
  try {
    const baseSha = git(seed, "rev-parse", "main");
    const originalHead = git(seed, "rev-parse", "refs/heads/agile/T1");
    const commands: string[][] = [];
    const inner = recording(commands);
    let failingTagPush = 1;
    const flaky: GitHubCommandRunner = {
      async run(input) {
        if (
          failingTagPush > 0 &&
          input.command[1] === "push" &&
          input.command[3]?.endsWith(":refs/tags/agile-trace/T1")
        ) {
          failingTagPush--;
          return {
            exitCode: 1,
            stdout: "",
            stderr: "injected tag push failure",
          };
        }
        return inner.run(input);
      },
    };
    const branches = await createTaskBranchManager(
      seed,
      "refs/remotes/origin/main",
    );
    const input = publishInput(baseSha, originalHead);

    await expect(
      new GitHubBranchPublisher("main", branches, flaky).publish(input),
    ).rejects.toThrow("git failed: injected tag push failure");
    // The base fast-forward survived the interrupted trace; the restart must not lose it.
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(originalHead);

    commands.length = 0;
    await expect(
      new GitHubBranchPublisher("main", branches, inner).publish(input),
    ).resolves.toEqual({ branch: "agile/T1", commitSha: originalHead });
    expect(git(origin, "rev-parse", "refs/tags/agile-trace/T1")).toBe(
      originalHead,
    );
    expect(git(origin, "rev-parse", "refs/heads/agile/T1")).toBe(originalHead);
    // The trace tag never entered the local checkout, so task validation still works.
    const localTag = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--verify", "refs/tags/agile-trace/T1"],
      cwd: seed,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(localTag.exitCode).not.toBe(0);
    expect(commands.flat().some((arg) => arg.includes("force"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
