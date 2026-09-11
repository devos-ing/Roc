import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiHarness } from "../../src/agents/pi/harness";
import { renderExecution } from "../../src/github/execution-store";
import {
  BaseAdvancedError,
  BunGitHubCommandRunner,
  GitHubBranchPublisher,
  type GitHubCommandRunner,
  type TaskPublisher,
} from "../../src/github/pr-publisher";
import type { AgentHarness } from "../../src/harness/contracts";
import { GitHubTaskRunner } from "../../src/scheduler/github-runner";
import { createModelAdvisor } from "../../src/scheduler/model-routing";
import {
  createTaskBranchManager,
  type TaskBranchManager,
} from "../../src/workspace/task-branch";
import { messageEnd, RecordedPiClient } from "../agents/pi/fixtures";
import { memoryGitHub } from "../helpers/github-native";

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

test("branch publication pushes the reviewed task branch, fast-forwards the base, and defers traces to the landing checkpoint", async () => {
  const { root, origin, seed } = await fixture();
  try {
    const baseSha = git(seed, "rev-parse", "main");
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

    expect(published).toEqual({ branch: "agile/T1", commitSha: originalHead });
    // The base fast-forwards to the reviewed head and the task branch backs it on origin.
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(originalHead);
    expect(git(origin, "rev-parse", "refs/heads/agile/T1")).toBe(originalHead);
    // No trace may run inside publish: the runner checkpoints the landing before traces.
    expect(refMissing(origin, "refs/tags/agile-trace/T1")).toBe(true);
    expect(commands.flat().some((arg) => arg.includes("force"))).toBe(false);
    expect(commands.flat().join(" ")).not.toContain("rebase");
    const basePush = commands.findIndex((command) =>
      command.includes(`${originalHead}:refs/heads/main`),
    );
    const taskBranchPush = commands.findIndex((command) =>
      command.includes(`${originalHead}:refs/heads/agile/T1`),
    );
    expect(basePush).toBeGreaterThan(0);
    expect(taskBranchPush).toBeGreaterThan(0);
    expect(taskBranchPush).toBeLessThan(basePush);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("branch publication reports an advanced base to the runner without rebasing or landing", async () => {
  const { root, origin, seed } = await fixture();
  try {
    const baseSha = git(seed, "rev-parse", "main");
    const originalHead = git(seed, "rev-parse", "refs/heads/agile/T1");
    // Concurrent work advances origin's base before the task publishes.
    await writeFile(join(seed, "base.txt"), "A+B\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-m", "base B");
    git(seed, "push", "origin", "main");
    const advancedBase = git(origin, "rev-parse", "refs/heads/main");
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

    const error = await publisher
      .publish(publishInput(baseSha, originalHead))
      .catch((error: unknown) => error);

    if (!(error instanceof BaseAdvancedError)) throw error;
    expect(error.name).toBe("BaseAdvancedError");
    expect(error.details).toMatchObject({
      taskId: "T1",
      branch: "agile/T1",
      baseBranch: "main",
      expectedBase: baseSha,
      targetBase: advancedBase,
    });
    // The error reports the retained worktree so an operator can reconcile there.
    expect(
      error.details.workspacePath.endsWith("seed.agile-worktrees/T1"),
    ).toBe(true);
    expect(error.message).toContain("fresh independent Review");
    // Nothing landed: the base stays at the concurrent commit and the task branch keeps
    // its original history because the publisher never rebases.
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(advancedBase);
    expect(git(seed, "rev-parse", "refs/heads/agile/T1")).toBe(originalHead);
    expect(git(seed, "rev-parse", `${originalHead}^{commit}`)).toBe(
      originalHead,
    );
    expect(commands.flat().some((arg) => arg.includes("force"))).toBe(false);
    expect(commands.flat().join(" ")).not.toContain("rebase");
    expect(commands.flat().join(" ")).not.toContain("refs/tags/agile-trace/T1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("trace completion recovers an interrupted tag push and replays idempotently", async () => {
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
    const publisher = new GitHubBranchPublisher("main", branches, inner);
    const landed = await publisher.publish(publishInput(baseSha, originalHead));
    // The base fast-forward survived the interrupted trace; the restart must not lose it.
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(landed.commitSha);

    await expect(
      new GitHubBranchPublisher("main", branches, flaky).completeTrace({
        taskId: "T1",
        branch: "agile/T1",
        workspacePath: seed,
        originalHead,
        landedHead: landed.commitSha,
      }),
    ).rejects.toThrow("git failed: injected tag push failure");
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(landed.commitSha);

    commands.length = 0;
    await expect(
      new GitHubBranchPublisher("main", branches, inner).completeTrace({
        taskId: "T1",
        branch: "agile/T1",
        workspacePath: seed,
        originalHead,
        landedHead: landed.commitSha,
      }),
    ).resolves.toBeUndefined();
    expect(git(origin, "rev-parse", "refs/tags/agile-trace/T1")).toBe(
      originalHead,
    );
    expect(git(origin, "rev-parse", "refs/heads/agile/T1")).toBe(
      landed.commitSha,
    );
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

/** The runner-level fixtures below drive the full scheduler loop against a real bare origin. */

const model = "openai-codex/gpt-6-astra";

async function runnerFixture(): Promise<{
  root: string;
  origin: string;
  seed: string;
  clone: string;
  baseSha: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "roc-branch-runner-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  git(root, "init", "--bare", "-b", "main", "origin.git");
  git(root, "init", "-b", "main", "seed");
  git(seed, "config", "user.name", "Fixture");
  git(seed, "config", "user.email", "fixture@local");
  // The task reads the config value, so a rebased base can silently change its behavior:
  // the original base exports 42 and a concurrent author may flip it to 7.
  await writeFile(join(seed, "config.ts"), "export const config = 42;\n");
  await writeFile(join(seed, "base.txt"), "A\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "base A");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "main");
  git(root, "clone", origin, clone);
  git(clone, "config", "user.name", "Fixture");
  git(clone, "config", "user.email", "fixture@local");
  return {
    root,
    origin,
    seed,
    clone,
    baseSha: git(seed, "rev-parse", "main"),
  };
}

/** Advances origin's base from the side seed checkout, like a concurrent author would. */
async function advanceBase(
  seed: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(seed, file), content);
  git(seed, "add", "-A");
  git(seed, "commit", "-m", message);
  git(seed, "push", "origin", "main");
}

type ScriptedOutput = {
  kind: "scout" | "implement" | "review";
  decision?: "accepted" | "rejected";
};

/** Builds a Pi harness whose roles replay the scripted outputs, one per role start. */
function scriptedHarness(
  branches: TaskBranchManager,
  outputs: ScriptedOutput[],
): { harness: AgentHarness; roles: string[] } {
  const roles: string[] = [];
  const harness = createPiHarness({
    branches,
    startClient: async (cwd) => {
      const output = outputs[roles.length];
      if (!output) throw Error("Unexpected additional role");
      roles.push(output.kind);
      const payload =
        output.kind === "scout"
          ? {
              kind: "scout",
              summary: "Make the answer follow the config value",
              files: ["answer.ts"],
              tests: ["bun test"],
              risks: [],
            }
          : output.kind === "implement"
            ? {
                kind: "implement",
                validation: ["bun test"],
                risks: [],
                limitations: [],
              }
            : {
                kind: "review",
                decision: output.decision ?? "accepted",
                findings:
                  output.decision === "rejected"
                    ? [
                        "The rebased answer now returns the advanced base's config value; the accepted behavior returned 42",
                      ]
                    : [],
                remainingGaps: [],
              };
      return new RecordedPiClient(
        [
          messageEnd({ text: JSON.stringify(payload) }),
          { type: "agent_settled" },
        ],
        { model: { provider: "openai-codex", id: "gpt-6-astra" } },
        async () => {
          if (output.kind === "implement")
            await writeFile(
              join(cwd, "answer.ts"),
              'import { config } from "./config";\nexport const answer = () => config;\n',
            );
        },
      );
    },
  });
  return { harness, roles };
}

/** Wraps the real Git boundary: records commands and can advance origin's base per push. */
function branchPublisher(
  branches: TaskBranchManager,
  options: {
    commands: string[][];
    onBasePush?: () => Promise<void> | void;
    failTagPushes?: number;
  },
): GitHubBranchPublisher {
  const inner = new BunGitHubCommandRunner();
  let tagFailures = options.failTagPushes ?? 0;
  const runner: GitHubCommandRunner = {
    async run(input) {
      options.commands.push(input.command);
      if (
        input.command[1] === "push" &&
        input.command[3]?.endsWith(":refs/heads/main")
      )
        await options.onBasePush?.();
      if (
        tagFailures > 0 &&
        input.command[1] === "push" &&
        input.command[3]?.includes(":refs/tags/agile-trace/")
      ) {
        tagFailures--;
        return {
          exitCode: 1,
          stdout: "",
          stderr: "injected tag push failure",
        };
      }
      return inner.run(input);
    },
  };
  return new GitHubBranchPublisher("main", branches, runner);
}

function runnerFor(input: {
  store: ReturnType<typeof memoryGitHub>["store"];
  clone: string;
  branches: TaskBranchManager;
  harness: AgentHarness;
  publisher: TaskPublisher;
  diagnostic?: (message: string) => void;
}): GitHubTaskRunner {
  return new GitHubTaskRunner({
    store: input.store(),
    branches: input.branches,
    harness: input.harness,
    advisor: createModelAdvisor(
      [{ id: model, supportedReasoningEfforts: ["medium", "high", "xhigh"] }],
      { luna: model, terra: model, sol: model },
    ),
    publisher: input.publisher,
    command: new BunGitHubCommandRunner(),
    cwd: input.clone,
    baseBranch: "main",
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
  });
}

/** Verifies a ref is absent on origin without letting the git helper throw. */
function refMissing(cwd: string, ref: string): boolean {
  return (
    Bun.spawnSync({
      cmd: ["git", "rev-parse", "--verify", ref],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode !== 0
  );
}

test("an advanced base sends the rebased patch through a fresh independent Review before landing", async () => {
  const f = await runnerFixture();
  try {
    const remote = memoryGitHub();
    const branches = await createTaskBranchManager(
      await realpath(f.clone),
      "refs/remotes/origin/main",
    );
    const commands: string[][] = [];
    let basePushes = 0;
    const publisher = branchPublisher(branches, {
      commands,
      // A concurrent author flips the config value while the first push is in flight.
      onBasePush: () =>
        basePushes++ === 0
          ? advanceBase(
              f.seed,
              "config.ts",
              "export const config = 7;\n",
              "base B: config flips to 7",
            )
          : undefined,
    });
    const { harness, roles } = scriptedHarness(branches, [
      { kind: "scout" },
      { kind: "implement" },
      { kind: "review" },
      { kind: "review" },
    ]);
    const run = runnerFor({
      store: remote.store,
      clone: f.clone,
      branches,
      harness,
      publisher,
    });

    expect(await run.runOnce(new AbortController().signal)).toBe(true);

    const record = (await remote.store().get(41)).execution!;
    // The rebased patch entered a fresh independent Review instead of landing directly.
    expect(roles).toEqual(["scout", "implement", "review", "review"]);
    const implement = record.attempts[1]?.output;
    if (implement?.kind !== "implement")
      throw Error("Missing implement receipt");
    const originalHead = implement.commitSha;
    const landed = git(f.origin, "rev-parse", "refs/heads/main");
    const advancedBase = git(f.seed, "rev-parse", "main");
    expect(landed).not.toBe(originalHead);
    expect(record.refreshes).toEqual([
      {
        expectedHead: originalHead,
        expectedBase: f.baseSha,
        targetBase: advancedBase,
        budgetRemaining: 1,
        result: { headSha: landed },
      },
    ]);
    expect(record.baseCommit).toBe(advancedBase);
    expect(record.publication).toEqual({
      branch: "agile/issue-41",
      commitSha: landed,
      mode: "branch",
    });
    // The landing evidence binds the exact rebased head and the advanced base.
    const fresh = record.attempts[3]!;
    expect(fresh.reviewTarget).toEqual({
      headSha: landed,
      baseSha: advancedBase,
    });
    expect(record.mergeReview).toMatchObject({
      headSha: landed,
      baseSha: advancedBase,
      reviewAttemptId: fresh.descriptor.attemptId,
    });
    // Landed state: the rebased base's config value reached origin together with the patch.
    expect(git(f.origin, "show", "main:config.ts")).toBe(
      "export const config = 7;",
    );
    expect(git(f.origin, "show", "main:answer.ts")).toContain("config");
    // The trace tag preserves the originally reviewed commit; the task branch names the landed head.
    expect(git(f.origin, "rev-parse", "refs/tags/agile-trace/issue-41")).toBe(
      originalHead,
    );
    expect(git(f.origin, "rev-parse", "refs/heads/agile/issue-41")).toBe(
      landed,
    );
    expect(remote.issue.state).toBe("CLOSED");
    // Exactly one rejected attempt and one post-Review fast-forward touched the base ref.
    expect(
      commands.filter((command) =>
        command.some((arg) => arg.endsWith(":refs/heads/main")),
      ),
    ).toHaveLength(2);
    expect(commands.flat().some((arg) => arg.includes("force"))).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

test("a fresh Review rejection keeps the advanced base unlanded and demands a replan", async () => {
  const f = await runnerFixture();
  try {
    const remote = memoryGitHub();
    const branches = await createTaskBranchManager(
      await realpath(f.clone),
      "refs/remotes/origin/main",
    );
    const commands: string[][] = [];
    let basePushes = 0;
    const publisher = branchPublisher(branches, {
      commands,
      onBasePush: () =>
        basePushes++ === 0
          ? advanceBase(
              f.seed,
              "config.ts",
              "export const config = 7;\n",
              "base B: config flips to 7",
            )
          : undefined,
    });
    const { harness, roles } = scriptedHarness(branches, [
      { kind: "scout" },
      { kind: "implement" },
      { kind: "review" },
      { kind: "review", decision: "rejected" },
    ]);
    const run = runnerFor({
      store: remote.store,
      clone: f.clone,
      branches,
      harness,
      publisher,
    });

    expect(await run.runOnce(new AbortController().signal)).toBe(true);

    const record = (await remote.store().get(41)).execution!;
    expect(roles).toEqual(["scout", "implement", "review", "review"]);
    expect(record.phase).toBe("needs_replan");
    expect(record.failure).toBe(
      "Fresh Review rejected the rebased patch; replan required",
    );
    // The base was never advanced by the task: the concurrent commit is still the tip.
    expect(git(f.origin, "rev-parse", "refs/heads/main")).toBe(
      git(f.seed, "rev-parse", "main"),
    );
    expect(git(f.origin, "show", "main:config.ts")).toBe(
      "export const config = 7;",
    );
    expect(refMissing(f.origin, "refs/tags/agile-trace/issue-41")).toBe(true);
    expect(remote.issue.state).toBe("OPEN");
    expect(remote.closures).toEqual([]);
    expect(
      commands.filter((command) =>
        command.some((arg) => arg.endsWith(":refs/heads/main")),
      ),
    ).toHaveLength(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

test("a base advancing again during fresh Review consumes the second bounded refresh and lands", async () => {
  const f = await runnerFixture();
  try {
    const remote = memoryGitHub();
    const branches = await createTaskBranchManager(
      await realpath(f.clone),
      "refs/remotes/origin/main",
    );
    const commands: string[][] = [];
    let basePushes = 0;
    const publisher = branchPublisher(branches, {
      commands,
      onBasePush: async () => {
        const attempt = basePushes++;
        if (attempt === 0)
          await advanceBase(
            f.seed,
            "base.txt",
            "A+B\n",
            "base B (non-conflicting)",
          );
        if (attempt === 1)
          await advanceBase(
            f.seed,
            "base.txt",
            "A+B+C\n",
            "base C lands during fresh Review",
          );
      },
    });
    const { harness, roles } = scriptedHarness(branches, [
      { kind: "scout" },
      { kind: "implement" },
      { kind: "review" },
      { kind: "review" },
      { kind: "review" },
    ]);
    const run = runnerFor({
      store: remote.store,
      clone: f.clone,
      branches,
      harness,
      publisher,
    });

    expect(await run.runOnce(new AbortController().signal)).toBe(true);

    const record = (await remote.store().get(41)).execution!;
    expect(roles).toEqual(["scout", "implement", "review", "review", "review"]);
    const landed = git(f.origin, "rev-parse", "refs/heads/main");
    const finalBase = git(f.seed, "rev-parse", "main");
    expect(record.phase).toBe("done");
    expect(record.refreshes?.map((refresh) => refresh.budgetRemaining)).toEqual(
      [1, 0],
    );
    expect(record.baseCommit).toBe(finalBase);
    expect(record.publication).toEqual({
      branch: "agile/issue-41",
      commitSha: landed,
      mode: "branch",
    });
    expect(record.attempts[4]?.reviewTarget).toEqual({
      headSha: landed,
      baseSha: finalBase,
    });
    expect(git(f.origin, "show", "main:base.txt")).toBe("A+B+C");
    expect(remote.issue.state).toBe("CLOSED");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

test("exhausting the two refresh cycles stops with a replan instead of landing an unreviewed rebase", async () => {
  const f = await runnerFixture();
  try {
    const remote = memoryGitHub();
    const branches = await createTaskBranchManager(
      await realpath(f.clone),
      "refs/remotes/origin/main",
    );
    const commands: string[][] = [];
    let basePushes = 0;
    const publisher = branchPublisher(branches, {
      commands,
      onBasePush: async () => {
        const attempt = basePushes++;
        const tags = ["B", "C", "D"];
        const tag = tags[attempt];
        if (tag)
          await advanceBase(
            f.seed,
            "base.txt",
            `A+${tag}\n`,
            `base ${tag} lands before every push`,
          );
      },
    });
    const { harness, roles } = scriptedHarness(branches, [
      { kind: "scout" },
      { kind: "implement" },
      { kind: "review" },
      { kind: "review" },
      { kind: "review" },
    ]);
    const run = runnerFor({
      store: remote.store,
      clone: f.clone,
      branches,
      harness,
      publisher,
    });

    expect(await run.runOnce(new AbortController().signal)).toBe(true);

    const record = (await remote.store().get(41)).execution!;
    expect(roles).toEqual(["scout", "implement", "review", "review", "review"]);
    expect(record.phase).toBe("needs_replan");
    expect(record.failure).toBe(
      "Automatic base refresh budget exhausted (two cycles); replan required",
    );
    expect(record.refreshes).toHaveLength(2);
    expect(record.publication).toMatchObject({ mode: "branch" });
    // The base kept advancing, but no task commit ever entered it.
    expect(git(f.origin, "show", "main:base.txt")).toBe("A+D");
    expect(refMissing(f.origin, "main:answer.ts")).toBe(true);
    expect(remote.issue.state).toBe("OPEN");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

test("a conflicting rebased patch aborts the refresh and records a replan without replaying Git", async () => {
  const f = await runnerFixture();
  try {
    const remote = memoryGitHub();
    const branches = await createTaskBranchManager(
      await realpath(f.clone),
      "refs/remotes/origin/main",
    );
    const commands: string[][] = [];
    let basePushes = 0;
    const diagnostics: string[] = [];
    const publisher = branchPublisher(branches, {
      commands,
      onBasePush: () =>
        basePushes++ === 0
          ? advanceBase(
              f.seed,
              "answer.ts",
              "export const answer = () => 0;\n",
              "base B rewrites answer.ts",
            )
          : undefined,
    });
    const { harness, roles } = scriptedHarness(branches, [
      { kind: "scout" },
      { kind: "implement" },
      { kind: "review" },
    ]);
    const run = runnerFor({
      store: remote.store,
      clone: f.clone,
      branches,
      harness,
      publisher,
      diagnostic: (message) => diagnostics.push(message),
    });

    expect(await run.runOnce(new AbortController().signal)).toBe(true);

    const record = (await remote.store().get(41)).execution!;
    // The refresh conflicted before any fresh Review could run; the intent is reconciled, not replayed.
    expect(roles).toEqual(["scout", "implement", "review"]);
    expect(record.phase).toBe("needs_replan");
    expect(record.failure).toBe(
      "Branch base refresh failed: Base refresh conflicted; original task work preserved; replan required",
    );
    expect(diagnostics.join()).toContain("Branch base refresh failed");
    expect(git(f.origin, "rev-parse", "refs/heads/main")).toBe(
      git(f.seed, "rev-parse", "main"),
    );
    expect(remote.issue.state).toBe("OPEN");
    expect(remote.closures).toEqual([]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

test("an interrupted trace push recovers from the persisted landing without revalidating or re-implementing", async () => {
  const f = await runnerFixture();
  try {
    const remote = memoryGitHub();
    const branches = await createTaskBranchManager(
      await realpath(f.clone),
      "refs/remotes/origin/main",
    );
    const commands: string[][] = [];
    const diagnostics: string[] = [];
    let basePushes = 0;
    const publisher = branchPublisher(branches, {
      commands,
      failTagPushes: 1,
      onBasePush: () =>
        basePushes++ === 0
          ? advanceBase(f.seed, "base.txt", "A+B\n", "base B (non-conflicting)")
          : undefined,
    });
    const { harness, roles } = scriptedHarness(branches, [
      { kind: "scout" },
      { kind: "implement" },
      { kind: "review" },
      { kind: "review" },
    ]);
    const run = runnerFor({
      store: remote.store,
      clone: f.clone,
      branches,
      harness,
      publisher,
      diagnostic: (message) => diagnostics.push(message),
    });

    // The landing survived; only the tag push failed, so the run completes without throwing.
    expect(await run.runOnce(new AbortController().signal)).toBe(true);
    // The recovery completes without any Implement rerun or additional role.
    expect(roles).toEqual(["scout", "implement", "review", "review"]);

    const record = (await remote.store().get(41)).execution!;
    const implement = record.attempts[1]?.output;
    if (implement?.kind !== "implement")
      throw Error("Missing implement receipt");
    const originalHead = implement.commitSha;
    const landed = git(f.origin, "rev-parse", "refs/heads/main");
    expect(landed).not.toBe(originalHead);
    expect(diagnostics.join()).toContain("branch trace completion is pending");
    expect(record.phase).toBe("publishing");
    expect(record.failure).toBeUndefined();
    expect(record.baseCommit).toBe(git(f.seed, "rev-parse", "main"));
    expect(record.publication).toEqual({
      branch: "agile/issue-41",
      commitSha: landed,
      mode: "branch",
    });
    expect(git(f.origin, "rev-parse", "refs/heads/main")).toBe(landed);
    expect(refMissing(f.origin, "refs/tags/agile-trace/issue-41")).toBe(true);

    // A fresh manager, publisher and runner retry from the persisted checkpoint alone.
    const recoveryBranches = await createTaskBranchManager(
      await realpath(f.clone),
      "refs/remotes/origin/main",
    );
    const recoveryCommands: string[][] = [];
    const recoveryPublisher = branchPublisher(recoveryBranches, {
      commands: recoveryCommands,
    });
    const recoveryHarness = createPiHarness({
      branches: recoveryBranches,
      startClient: async () => {
        throw Error("Saved results must not start another Pi role");
      },
    });
    const recovery = new GitHubTaskRunner({
      store: remote.store(),
      branches: recoveryBranches,
      harness: recoveryHarness,
      advisor: createModelAdvisor([]),
      publisher: recoveryPublisher,
      command: new BunGitHubCommandRunner(),
      cwd: f.clone,
      baseBranch: "main",
    });
    expect(await recovery.runOnce(new AbortController().signal)).toBe(true);

    const recovered = (await remote.store().get(41)).execution!;
    expect(recovered.phase).toBe("done");
    expect(recovered.failure).toBeUndefined();
    expect(recovered.publication).toEqual({
      branch: "agile/issue-41",
      commitSha: landed,
      mode: "branch",
    });
    // No publication, no role rerun: only the idempotent traces completed.
    expect(
      recoveryCommands.filter((command) =>
        command.some((arg) => arg.endsWith(":refs/heads/main")),
      ),
    ).toEqual([]);
    expect(recovered.attempts).toHaveLength(4);
    expect(
      recovered.attempts.every((attempt) => attempt.status === "succeeded"),
    ).toBe(true);
    expect(git(f.origin, "rev-parse", "refs/heads/main")).toBe(landed);
    expect(git(f.origin, "rev-parse", "refs/tags/agile-trace/issue-41")).toBe(
      originalHead,
    );
    expect(git(f.origin, "rev-parse", "refs/heads/agile/issue-41")).toBe(
      landed,
    );
    expect(remote.issue.state).toBe("CLOSED");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

test("a republished checkpoint whose landing the base already contains replays idempotently", async () => {
  const f = await runnerFixture();
  try {
    const remote = memoryGitHub();
    const branches = await createTaskBranchManager(
      await realpath(f.clone),
      "refs/remotes/origin/main",
    );
    const commands: string[][] = [];
    let basePushes = 0;
    const publisher = branchPublisher(branches, {
      commands,
      onBasePush: () =>
        basePushes++ === 0
          ? advanceBase(f.seed, "base.txt", "A+B\n", "base B (non-conflicting)")
          : undefined,
    });
    const { harness } = scriptedHarness(branches, [
      { kind: "scout" },
      { kind: "implement" },
      { kind: "review" },
      { kind: "review" },
    ]);
    const run = runnerFor({
      store: remote.store,
      clone: f.clone,
      branches,
      harness,
      publisher,
    });
    expect(await run.runOnce(new AbortController().signal)).toBe(true);
    const done = (await remote.store().get(41)).execution!;
    const landed = git(f.origin, "rev-parse", "refs/heads/main");
    expect(done.phase).toBe("done");

    // Simulate a crash that reverted the done write back to its publishing checkpoint.
    remote.issue.state = "OPEN";
    delete remote.issue.stateReason;
    done.phase = "publishing";
    const comment = remote.issue.comments.find(
      (item) => item.author?.login === "daemon",
    );
    if (!comment) throw Error("Missing daemon checkpoint");
    comment.body = renderExecution(done);

    const replayBranches = await createTaskBranchManager(
      await realpath(f.clone),
      "refs/remotes/origin/main",
    );
    const replayCommands: string[][] = [];
    const replayPublisher = branchPublisher(replayBranches, {
      commands: replayCommands,
    });
    const replay = runnerFor({
      store: remote.store,
      clone: f.clone,
      branches: replayBranches,
      harness: {
        async step() {
          throw Error("No agent work should replay");
        },
        async cancel() {},
      },
      publisher: replayPublisher,
    });
    expect(await replay.runOnce(new AbortController().signal)).toBe(true);

    const record = (await remote.store().get(41)).execution!;
    expect(record.phase).toBe("done");
    expect(record.publication).toEqual({
      branch: "agile/issue-41",
      commitSha: landed,
      mode: "branch",
    });
    // The remote already contained the landing, so the base was never pushed again.
    expect(
      replayCommands.filter((command) =>
        command.some((arg) => arg.endsWith(":refs/heads/main")),
      ),
    ).toEqual([]);
    expect(git(f.origin, "rev-parse", "refs/heads/main")).toBe(landed);
    const implement = record.attempts[1]?.output;
    if (implement?.kind !== "implement")
      throw Error("Missing implement receipt");
    expect(git(f.origin, "rev-parse", "refs/tags/agile-trace/issue-41")).toBe(
      implement.commitSha,
    );
    expect(String(remote.issue.state)).toBe("CLOSED");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);
