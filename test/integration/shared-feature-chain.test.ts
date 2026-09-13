import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogManifest } from "../../src/domain/schemas";
import { GitHubExecutionStore } from "../../src/github/execution-store";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import type {
  GitHubCommandRunner,
  TaskPublisher,
} from "../../src/github/pr-publisher";
import { BunGitHubCommandRunner } from "../../src/github/pr-publisher";
import {
  parseRemoteTaskEnvelope,
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";
import type { HarnessStepRequest } from "../../src/harness/contracts";
import { createFakeHarness } from "../../src/harness/fake";
import { GitHubTaskRunner } from "../../src/scheduler/github-runner";
import { createModelAdvisor } from "../../src/scheduler/model-routing";
import {
  cleanupTaskWorktrees,
  createTaskBranchManager,
  type TaskBranchManager,
} from "../../src/workspace/task-branch";
import { git } from "../helpers/git";
import { memoryPlan } from "../helpers/github-plan";

const model = "test/model";
const at = "2026-09-13T00:00:00.000Z";

function attemptScript(
  taskId: string,
  role: "scout" | "implement" | "review",
  commitSha = "0".repeat(40),
) {
  const output =
    role === "scout"
      ? {
          kind: "scout" as const,
          summary: `Inspect ${taskId}`,
          files: ["chain.txt"],
          tests: ["real Git chain fixture"],
          risks: [],
        }
      : role === "implement"
        ? {
            kind: "implement" as const,
            commitSha,
            validation: ["real Git chain fixture"],
            risks: [],
            limitations: [],
          }
        : {
            kind: "review" as const,
            decision: "accepted" as const,
            findings: [],
            remainingGaps: [],
          };
  const started =
    taskId === "issue-42" && role === "implement"
      ? [
          {
            nextCursor: "started",
            event: {
              type: "attempt.started" as const,
              eventId: "started",
              attemptId: "fixture",
              sequence: 1,
              occurredAt: at,
            },
          },
        ]
      : [];
  const offset = started.length;
  return {
    taskId,
    role,
    retryIndex: 0,
    expect: {
      model,
      effort: role === "implement" ? ("medium" as const) : ("high" as const),
    },
    deliveries: [
      ...started,
      {
        nextCursor: "output",
        event: {
          type: "attempt.output" as const,
          eventId: "output",
          attemptId: "fixture",
          sequence: offset + 1,
          occurredAt: at,
          output,
        },
      },
      {
        nextCursor: "completed",
        event: {
          type: "attempt.completed" as const,
          eventId: "completed",
          attemptId: "fixture",
          sequence: offset + 2,
          occurredAt: at,
        },
      },
    ],
  };
}

test("A to B to C shares one real worktree and PR through dirty restart, squash evidence, and cleanup", async () => {
  const temp = await mkdtemp(join(tmpdir(), "roc-shared-chain-"));
  const root = join(temp, "repo");
  try {
    const origin = join(temp, "origin.git");
    await git(["init", "--bare", origin], temp);
    await git(["clone", origin, root], temp);
    await git(["checkout", "-b", "main"], root);
    await git(["config", "user.name", "Roc Test"], root);
    await git(["config", "user.email", "roc@example.test"], root);
    await writeFile(join(root, "chain.txt"), "base\n");
    await git(["add", "."], root);
    await git(["commit", "-m", "seed"], root);
    await git(["push", "origin", "main"], root);
    const base = await git(["rev-parse", "HEAD"], root);

    const remote = memoryPlan([["chain.txt"], ["chain.txt"], ["chain.txt"]]);
    const original = remote.issues.map((issue) =>
      parseRemoteTaskEnvelope(issue.body),
    );
    const first = original[0];
    if (!first) throw Error("Missing chain fixture plan");
    const plan: BacklogManifest = {
      cycleId: first.cycleId,
      goal: first.goal,
      tasks: original.map((envelope, index) => ({
        ...envelope.task,
        spec: {
          ...envelope.task.spec,
          dependencies: [],
          ...(index === 0 ? {} : { continues: { task: `T${index}` } }),
        },
      })),
    };
    for (const [index, issue] of remote.issues.entries()) {
      const envelope = remoteTaskEnvelope(plan, `T${index + 1}`);
      issue.body = renderRemoteTaskBody(envelope);
      issue.comments[0]!.body = renderRemoteTaskApproval(envelope);
    }
    const store = new GitHubExecutionStore(
      "acme/test",
      "daemon",
      new Set(["owner"]),
      remote.api,
    );

    const fake = createFakeHarness({
      attempts: [41, 42, 43].flatMap((number) =>
        (["scout", "implement", "review"] as const).map((role) =>
          attemptScript(`issue-${number}`, role),
        ),
      ),
    });
    let activeBranches = await createTaskBranchManager(
      await realpath(root),
      base,
    );
    let chainBranch: string | undefined;
    let interruptB = true;
    let dirtyB = false;
    const commits = new Map<string, string>();
    const workspaces = new Map<string, { path: string; branch: string }>();
    const harness = {
      async step(request: HarnessStepRequest) {
        if (request.attempt.role === "implement") {
          const taskId = request.attempt.taskId;
          const workspace = await activeBranches.prepare(
            taskId,
            request.input.ticket.baseCommit,
            taskId === "issue-41" ? undefined : chainBranch,
          );
          chainBranch ??= workspace.branch;
          workspaces.set(taskId, {
            path: workspace.path,
            branch: workspace.branch,
          });
          if (!commits.has(taskId) && !dirtyB) {
            const current = await readFile(
              join(workspace.path, "chain.txt"),
              "utf8",
            );
            await writeFile(
              join(workspace.path, "chain.txt"),
              `${current}${taskId}\n`,
            );
            if (taskId === "issue-42") dirtyB = true;
          }
          if (
            taskId === "issue-42" &&
            request.backendCursor === "started" &&
            interruptB
          ) {
            interruptB = false;
            throw Error("Simulated process loss during B");
          }
          if (
            !commits.has(taskId) &&
            (taskId !== "issue-42" || request.backendCursor === "started")
          ) {
            const commit = await activeBranches.commitChanges(
              taskId,
              request.input.ticket.baseCommit,
            );
            commits.set(taskId, commit);
            dirtyB = false;
            fake.scriptAttempt(attemptScript(taskId, "implement", commit));
          }
        }
        return fake.harness.step(request);
      },
      async cancel(attemptId: string) {
        await fake.harness.cancel(attemptId);
      },
    };

    const publications: Parameters<TaskPublisher["publish"]>[0][] = [];
    let merged = false;
    let mergeCommit: string | undefined;
    const realCommand = new BunGitHubCommandRunner();
    const command: GitHubCommandRunner = {
      async run(input) {
        if (input.command[0] !== "gh") return realCommand.run(input);
        if (input.command.includes("--jq")) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: `${[...commits.values()].join("\n")}\n`,
          };
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            number: 7,
            state: merged ? "MERGED" : "OPEN",
            baseRefName: "main",
            headRefName: chainBranch,
            headRefOid: commits.get("issue-43") ?? [...commits.values()].at(-1),
            mergeCommit: merged ? { oid: mergeCommit } : null,
          }),
        };
      },
    };
    const publisher: TaskPublisher = {
      baseBranch: "main",
      async publish(input) {
        publications.push(structuredClone(input));
        const workspace = await activeBranches.prepare(
          input.task.id,
          input.task.baseCommit,
          input.publication.branch,
        );
        await git(
          [
            "push",
            "origin",
            `${input.publication.branch}:${input.publication.branch}`,
          ],
          workspace.path,
        );
        return {
          number: 7,
          url: "https://github.com/acme/test/pull/7",
          state: "OPEN",
        };
      },
    };
    const advisor = createModelAdvisor(
      [{ id: model, supportedReasoningEfforts: ["medium", "high", "xhigh"] }],
      { luna: model, terra: model, sol: model },
    );
    const makeRunner = (branches: TaskBranchManager) =>
      new GitHubTaskRunner({
        store,
        branches,
        harness,
        advisor,
        publisher,
        command,
        cwd: root,
        baseBranch: "main",
      });
    const signal = new AbortController().signal;

    let runner = makeRunner(activeBranches);
    expect(await runner.runOnce(signal)).toBe(true);
    expect((await store.get(41)).execution?.phase).toBe("awaiting_merge");
    await expect(runner.runOnce(signal)).rejects.toThrow(
      "Simulated process loss during B",
    );
    const interrupted = await store.get(42);
    expect(interrupted.execution).toMatchObject({
      phase: "implementing",
      attempts: [
        expect.anything(),
        {
          descriptor: { role: "implement" },
          status: "running",
          cursor: "started",
        },
      ],
    });
    const interruptedWorkspace = workspaces.get("issue-42");
    expect(interruptedWorkspace).toBeDefined();
    expect(
      await git(["status", "--porcelain"], interruptedWorkspace!.path),
    ).toContain("chain.txt");

    activeBranches = await createTaskBranchManager(await realpath(root), base);
    runner = makeRunner(activeBranches);
    expect(await runner.runOnce(signal)).toBe(true);
    expect((await store.get(42)).execution?.phase).toBe("awaiting_merge");
    expect(await runner.runOnce(signal)).toBe(true);
    expect((await store.get(43)).execution?.phase).toBe("awaiting_merge");
    fake.assertComplete();

    const identities = [...workspaces.values()];
    const finalCommit = commits.get("issue-43");
    if (!chainBranch || !finalCommit)
      throw Error("Shared chain did not produce its final branch identity");
    expect(new Set(identities.map((item) => item.path)).size).toBe(1);
    expect(new Set(identities.map((item) => item.branch))).toEqual(
      new Set([chainBranch]),
    );
    expect(publications).toHaveLength(3);
    expect(
      new Set(publications.map((input) => input.publication.branch)),
    ).toEqual(new Set([chainBranch]));
    expect(new Set(publications.map(() => 7))).toEqual(new Set([7]));
    expect(publications.map((input) => input.chain?.segments.length)).toEqual([
      3, 3, 3,
    ]);
    expect(
      publications[0]?.chain?.segments.map((segment) => segment.commitSha),
    ).toEqual([commits.get("issue-41"), undefined, undefined]);
    expect(
      publications[2]?.chain?.segments.map((segment) => segment.commitSha),
    ).toEqual([
      commits.get("issue-41"),
      commits.get("issue-42"),
      commits.get("issue-43"),
    ]);
    for (const number of [41, 42, 43]) {
      const record = (await store.get(number)).execution;
      const review = record?.attempts.findLast(
        (attempt) => attempt.descriptor.role === "review",
      );
      expect(review?.descriptor.attemptId).toBe(
        record?.mergeReview?.reviewAttemptId,
      );
      expect(review?.descriptor.attemptId).not.toBe(
        record?.attempts.findLast(
          (attempt) => attempt.descriptor.role === "implement",
        )?.descriptor.attemptId,
      );
    }
    expect(await git(["rev-parse", `refs/heads/${chainBranch}`], origin)).toBe(
      finalCommit,
    );

    await git(["merge", "--squash", chainBranch!], root);
    await git(["commit", "-m", "squash shared chain"], root);
    mergeCommit = await git(["rev-parse", "HEAD"], root);
    await git(["push", "origin", "main"], root);
    merged = true;
    expect(await runner.runOnce(signal)).toBe(false);
    const completed = await store.list();
    expect(completed.tasks.map((task) => task.execution?.phase)).toEqual([
      "done",
      "done",
      "done",
    ]);
    expect(
      completed.tasks.map((task) => task.execution?.publication?.mergeCommit),
    ).toEqual([mergeCommit, mergeCommit, mergeCommit]);

    const snapshot = githubTaskSnapshot(completed.tasks);
    const cleanup = await cleanupTaskWorktrees(
      root,
      new Map(snapshot.tasks.map((task) => [task.id, task.status] as const)),
      {
        chainMembers: snapshot.chainMembers,
        incompleteChainWorktrees: snapshot.incompleteChainWorktrees,
      },
    );
    expect(cleanup.failures).toBe(0);
    expect(cleanup.removed).toEqual([
      { task: "issue-41", path: interruptedWorkspace!.path },
    ]);
    expect(cleanup.kept).toEqual([]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
