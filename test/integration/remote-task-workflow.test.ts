import { expect, test } from "bun:test";
import type { BacklogManifest } from "../../src/domain/schemas";
import type {
  GitHubCommandRunner,
  TaskPublisher,
} from "../../src/github/pr-publisher";
import { GitHubRemoteDependencyGate } from "../../src/github/remote-dependencies";
import {
  GitHubRemoteTaskSource,
  type RemoteIssue,
  RemoteSchedulerSource,
} from "../../src/github/remote-source";
import { GitHubTaskPublisher } from "../../src/github/remote-tasks";
import { GitHubRemoteTaskWriter } from "../../src/github/remote-writeback";
import type { HarnessEvent } from "../../src/harness/contracts";
import { createFakeHarness } from "../../src/harness/fake";
import { SchedulerDaemon } from "../../src/scheduler/daemon";
import { Scheduler } from "../../src/scheduler/scheduler";
import { openDatabase } from "../../src/store/database";
import {
  type IdFactory,
  OrchestrationRepository,
} from "../../src/store/orchestration-repository";
import { PlanningRepository } from "../../src/store/planning-repository";
import { RemoteTaskRepository } from "../../src/store/remote-task-repository";

const manifest: BacklogManifest = {
  cycleId: "2026-09-06-P7D",
  goal: "Complete work on a remote worker",
  tasks: [
    {
      id: "REMOTE-BASE",
      title: "Prove the remote worker handoff",
      priority: 1,
      spec: {
        problem: "Approved work must cross the machine boundary safely",
        desiredOutcome: "The worker completes and reports the approved task",
        scope: ["remote workflow"],
        nonGoals: [],
        acceptanceCriteria: ["the GitHub Issue reaches done"],
        validation: ["bun test"],
        dependencies: [],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 1000,
      },
    },
    {
      id: "REMOTE-DEPENDENT",
      title: "Continue from the merged remote result",
      priority: 2,
      spec: {
        problem: "Dependent work must include its prerequisite merge",
        desiredOutcome: "The dependent starts from the fetched merged target",
        scope: ["remote dependency"],
        nonGoals: [],
        acceptanceCriteria: ["the dependency merge is in the pinned base"],
        validation: ["bun test"],
        dependencies: ["REMOTE-BASE"],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 1000,
      },
    },
  ],
};

/** Stores the observable GitHub state shared by the publisher and worker roles. */
class FakeGitHub {
  readonly issues: RemoteIssue[] = [];
  targetCommit = "b".repeat(40);
  private readonly mergedPullRequests = new Map<number, string>();
  private nextCommentId = 100;

  /** Makes one pull request merged and advances the fake target branch. */
  merge(number: number, mergeCommit: string, targetCommit: string): void {
    this.mergedPullRequests.set(number, mergeCommit);
    this.targetCommit = targetCommit;
  }

  /** Creates an argv runner authenticated as one fixed GitHub login. */
  runner(login: string): GitHubCommandRunner {
    return {
      run: async ({ command }) => {
        if (command[0] === "git") {
          if (command[1] === "fetch") return success();
          if (command[1] === "rev-parse") {
            return success(`${this.targetCommit}\n`);
          }
          if (command[1] === "merge-base") return success();
        }
        if (command[1] === "repo") return success("owner/repo\n");
        if (command[1] === "label") return success();
        if (command[1] === "pr" && command[2] === "view") {
          const number = Number(command[3]);
          const mergeCommit = this.mergedPullRequests.get(number);
          if (mergeCommit === undefined) throw new Error("PR is not merged");
          return success(
            JSON.stringify({
              state: "MERGED",
              baseRefName: "main",
              mergedAt: "2026-09-06T00:02:00.000Z",
              mergeCommit: { oid: mergeCommit },
            }),
          );
        }
        if (command[1] === "issue" && command[2] === "list") {
          return success(
            JSON.stringify(
              this.issues.map(({ number, title, body, url, state }) => ({
                number,
                title,
                body,
                url,
                state,
              })),
            ),
          );
        }
        if (command[1] === "issue" && command[2] === "create") {
          const number = this.issues.length + 1;
          const bodyPath = argumentAfter(command, "--body-file");
          const labels = argumentAfter(command, "--label")
            .split(",")
            .map((name) => ({ name }));
          this.issues.push({
            number,
            title: argumentAfter(command, "--title"),
            body: await Bun.file(bodyPath).text(),
            url: `https://example.test/issues/${number}`,
            state: "OPEN",
            labels,
            comments: [],
          });
          return success(`https://example.test/issues/${number}\n`);
        }
        if (command[1] === "issue" && command[2] === "edit") {
          const issue = this.issue(Number(command[3]));
          const bodyIndex = command.indexOf("--body-file");
          if (bodyIndex >= 0) {
            issue.body = await Bun.file(command[bodyIndex + 1] ?? "").text();
          }
          const removeIndex = command.indexOf("--remove-label");
          if (removeIndex >= 0) {
            const removed = command[removeIndex + 1];
            issue.labels = issue.labels.filter(
              (label) => label.name !== removed,
            );
          }
          const addIndex = command.indexOf("--add-label");
          if (addIndex >= 0) {
            const added = command[addIndex + 1];
            if (
              added !== undefined &&
              !issue.labels.some((label) => label.name === added)
            ) {
              issue.labels.push({ name: added });
            }
          }
          return success();
        }
        if (command[1] === "issue" && command[2] === "comment") {
          const issue = this.issue(Number(command[3]));
          issue.comments.push({
            body: await Bun.file(argumentAfter(command, "--body-file")).text(),
            author: { login },
            databaseId: this.nextCommentId,
          });
          this.nextCommentId += 1;
          return success();
        }
        if (command[1] === "api" && command[2] === "--method") {
          const commentId = Number(command[4]?.split("/").at(-1));
          const input = (await Bun.file(
            argumentAfter(command, "--input"),
          ).json()) as { body: string };
          const comment = this.issues
            .flatMap((issue) => issue.comments)
            .find((candidate) => candidate.databaseId === commentId);
          if (comment === undefined) throw new Error("missing fake comment");
          comment.body = input.body;
          return success();
        }
        throw new Error(`Unexpected fake GitHub command: ${command.join(" ")}`);
      },
    };
  }

  /** Returns the requested fake Issue or fails the test fixture immediately. */
  private issue(number: number): RemoteIssue {
    const issue = this.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) throw new Error(`Missing fake Issue ${number}`);
    return issue;
  }
}

/** Reads the argument immediately following one required command option. */
function argumentAfter(command: string[], option: string): string {
  const value = command[command.indexOf(option) + 1];
  if (value === undefined) throw new Error(`Missing ${option}`);
  return value;
}

/** Builds one successful deterministic command result. */
function success(stdout = "") {
  return { exitCode: 0, stdout, stderr: "" };
}

/** Builds all ordered harness deliveries for one successful role. */
function deliveries(
  key: string,
  attemptId: string,
  output: Extract<HarnessEvent, { type: "attempt.output" }>["output"],
) {
  return [
    {
      nextCursor: `${key}:1`,
      event: {
        type: "attempt.started" as const,
        eventId: `${key}:started`,
        attemptId,
        sequence: 1,
        occurredAt: "2026-09-06T00:00:01.000Z",
      },
    },
    {
      nextCursor: `${key}:2`,
      event: {
        type: "attempt.output" as const,
        eventId: `${key}:output`,
        attemptId,
        sequence: 2,
        occurredAt: "2026-09-06T00:00:02.000Z",
        output,
      },
    },
    {
      nextCursor: `${key}:3`,
      event: {
        type: "attempt.completed" as const,
        eventId: `${key}:completed`,
        attemptId,
        sequence: 3,
        occurredAt: "2026-09-06T00:00:03.000Z",
      },
    },
  ];
}

/** Produces deterministic identifiers in the order used by one three-role task. */
function ids(): IdFactory {
  const counts: Record<string, number> = {};
  return (kind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    return `${kind}-${counts[kind]}`;
  };
}

/** Scripts one successful Scout, Implement, and Review sequence. */
function attempts(taskId: string, firstAttempt: number) {
  return [
    {
      taskId,
      role: "scout" as const,
      retryIndex: 0 as const,
      expect: { model: "luna", effort: "high" as const },
      deliveries: deliveries(`${taskId}:scout`, `attempt-${firstAttempt}`, {
        kind: "scout",
        summary: "The approved task is ready",
        files: ["src/remote.ts"],
        tests: ["bun test"],
        risks: [],
      }),
    },
    {
      taskId,
      role: "implement" as const,
      retryIndex: 0 as const,
      expect: { model: "terra", effort: "high" as const },
      deliveries: deliveries(
        `${taskId}:implement`,
        `attempt-${firstAttempt + 1}`,
        {
          kind: "implement",
          commitSha: "a".repeat(40),
          validation: ["bun test"],
          risks: [],
          limitations: [],
        },
      ),
    },
    {
      taskId,
      role: "review" as const,
      retryIndex: 0 as const,
      expect: { model: "sol", effort: "high" as const },
      deliveries: deliveries(
        `${taskId}:review`,
        `attempt-${firstAttempt + 2}`,
        {
          kind: "review",
          decision: "accepted",
          findings: [],
          remainingGaps: [],
        },
      ),
    },
  ];
}

test("publishes on machine A and completes with a status receipt on machine B", async () => {
  const github = new FakeGitHub();
  const publisherRunner = github.runner("publisher");
  await new GitHubTaskPublisher("/machine-a", publisherRunner).publish(
    manifest,
  );

  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db, () => "2026-09-06T00:00:00.000Z");
  const remote = new RemoteTaskRepository(db, () => "2026-09-06T00:00:00.000Z");
  const source = new GitHubRemoteTaskSource(
    "owner/repo",
    new Set(["publisher"]),
    planning,
    remote,
    async () => github.issues,
  );
  const workerRunner = github.runner("worker");
  const dependencyGate = new GitHubRemoteDependencyGate(
    "/machine-b",
    "owner/repo",
    "main",
    remote,
    workerRunner,
  );

  const fake = createFakeHarness({
    attempts: [
      ...attempts("REMOTE-BASE", 1),
      ...attempts("REMOTE-DEPENDENT", 4),
    ],
  });
  let nextPullRequest = 7;
  const pullRequests: TaskPublisher = {
    baseBranch: "main",
    async publish() {
      const number = nextPullRequest;
      nextPullRequest += 1;
      return {
        number,
        url: `https://example.test/pulls/${number}`,
        state: "OPEN",
      };
    },
  };
  const orchestration = new OrchestrationRepository(
    db,
    () => "2026-09-06T00:01:00.000Z",
    ids(),
  );
  const scheduler = new Scheduler(
    orchestration,
    fake.harness,
    () => {},
    undefined,
    pullRequests,
    true,
  );
  const writer = new GitHubRemoteTaskWriter(
    "/machine-b",
    "owner/repo",
    "worker",
    remote,
    async () => github.issues,
    workerRunner,
  );
  let timestamp = Date.parse("2026-09-06T00:01:00.000Z");
  /** Runs the real daemon until its first idle wait for one worker session. */
  const runWorkerSession = async (ownerId: string): Promise<void> => {
    let stopped = false;
    const remoteScheduler = new RemoteSchedulerSource(
      {
        poll: async () => {
          const result = await source.poll();
          await dependencyGate.prepare();
          return result;
        },
      },
      orchestration,
      () => timestamp,
      () => {},
      () => writer.sync(),
    );
    const daemon = new SchedulerDaemon(
      scheduler,
      orchestration,
      {
        ownerId,
        now: () => new Date(timestamp),
        sleep: async (milliseconds, signal) => {
          if (signal !== undefined) {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return;
          }
          timestamp += milliseconds;
          stopped = true;
        },
      },
      remoteScheduler,
    );
    await daemon.run(() => stopped);
  };

  await runWorkerSession("worker-session-1");
  expect(orchestration.inspectTask("REMOTE-BASE")).toEqual({
    id: "REMOTE-BASE",
    status: "done",
  });
  expect(orchestration.inspectTask("REMOTE-DEPENDENT")).toEqual({
    id: "REMOTE-DEPENDENT",
    status: "ready",
  });

  const mergeCommit = "c".repeat(40);
  const mergedTarget = "d".repeat(40);
  github.merge(7, mergeCommit, mergedTarget);
  await runWorkerSession("worker-session-2");

  expect(orchestration.inspectTask("REMOTE-DEPENDENT")).toEqual({
    id: "REMOTE-DEPENDENT",
    status: "done",
  });
  expect(
    planning.listTasks().find((task) => task.id === "REMOTE-DEPENDENT"),
  ).toMatchObject({ baseCommit: mergedTarget });
  expect(
    github.issues.map((issue) => issue.labels.map((label) => label.name)),
  ).toEqual([
    expect.arrayContaining(["roc:done"]),
    expect.arrayContaining(["roc:done"]),
  ]);
  expect(
    github.issues.every(
      (issue) =>
        issue.comments.filter(
          (comment) =>
            comment.author?.login === "worker" &&
            comment.body.includes("roc:status"),
        ).length === 1,
    ),
  ).toBeTrue();
  expect(
    github.issues[0]?.comments.find(
      (comment) =>
        comment.author?.login === "worker" &&
        comment.body.includes("roc:status"),
    )?.body,
  ).toContain("dependency merge confirmed");
  expect(
    github.issues[1]?.comments.find(
      (comment) =>
        comment.author?.login === "worker" &&
        comment.body.includes("roc:status"),
    )?.body,
  ).toContain("execution complete, awaiting merge");
  expect(() => fake.assertComplete()).not.toThrow();
  db.close();
});
