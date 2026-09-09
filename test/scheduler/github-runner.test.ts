import { expect, test } from "bun:test";
import {
  type ExecutionRecord,
  GitHubExecutionStore,
  initialExecution,
  renderExecution,
} from "../../src/github/execution-store";
import {
  jsonHash,
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";
import type {
  AgentHarness,
  HarnessStepRequest,
} from "../../src/harness/contracts";
import { createFakeHarness } from "../../src/harness/fake";
import { GitHubTaskRunner } from "../../src/scheduler/github-runner";
import { createModelAdvisor } from "../../src/scheduler/model-routing";
import type { TaskHookRunner } from "../../src/scheduler/task-hooks";
import type { TaskBranchManager } from "../../src/workspace/task-branch";
import { manifest, memoryGitHub } from "../helpers/github-native";

const base = "a".repeat(40);
const time = "2026-09-08T00:00:00.000Z";
const model = "test/model";
const zeroUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};
const branches: TaskBranchManager = {
  async prepare(taskId) {
    return {
      taskId,
      path: "/fixture",
      branch: `agile/${taskId}`,
      baseCommit: base,
    };
  },
  async refresh() {
    throw Error("Unexpected base refresh");
  },
  async restoreChanges() {},
  async commitChanges() {
    return base;
  },
  async assertCommit() {},
  async assertReviewReady() {},
  async status() {
    return "";
  },
};

test("shutdown after a confirmed publication does not rewrite completed work as cancelled", async () => {
  const remote = memoryGitHub();
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      branch: "agile/issue-41",
      commitSha: base,
      number: 7,
    };
  });
  const before = await remote.store().get(41);
  expect(
    await runner(remote).interrupt(
      before,
      "Task cancelled; execution requires replan",
    ),
  ).toBe(false);
  expect((await remote.store().get(41)).execution).toEqual(before.execution);
});

test("dependencies wait for the recorded PR head to merge into the target before pinning a fetched base", async () => {
  const remote = memoryGitHub();
  const first = manifest.tasks[0];
  if (!first) throw Error("Missing task fixture");
  const plan = {
    ...manifest,
    tasks: [
      first,
      { ...first, id: "T2", spec: { ...first.spec, dependencies: ["T1"] } },
    ],
  };
  const predecessorEnvelope = remoteTaskEnvelope(plan, "T1");
  remote.issue.body = renderRemoteTaskBody(predecessorEnvelope);
  remote.issue.comments[0] = {
    databaseId: 1,
    author: { login: "owner" },
    body: renderRemoteTaskApproval(predecessorEnvelope),
  };
  const nextEnvelope = remoteTaskEnvelope(plan, "T2");
  const next = {
    ...structuredClone(remote.issue),
    number: 42,
    body: renderRemoteTaskBody(nextEnvelope),
    comments: [
      {
        databaseId: 3,
        author: { login: "owner" },
        body: renderRemoteTaskApproval(nextEnvelope),
      },
    ],
  };
  await seed(remote, (record) => {
    record.phase = "done";
    record.publication = {
      number: 7,
      branch: "agile/issue-41",
      commitSha: base,
      mergeCommit: "c".repeat(40),
    };
  });
  const api = {
    ...remote.api,
    async read() {
      return structuredClone([remote.issue, next]);
    },
    async get(_repo: string, number: number) {
      return structuredClone(number === 41 ? remote.issue : next);
    },
    async writeComment(
      _repo: string,
      number: number,
      body: string,
      id?: number,
    ) {
      const issue = number === 41 ? remote.issue : next;
      const comment = issue.comments.find((item) => item.databaseId === id);
      if (comment) comment.body = body;
      else
        issue.comments.push({
          databaseId: 4,
          author: { login: "daemon" },
          body,
        });
    },
  };
  const store = new GitHubExecutionStore(
    "acme/test",
    "daemon",
    new Set(["owner"]),
    api,
  );
  let merged = false;
  let head = "b".repeat(40);
  let roles = 0;
  const commands: string[][] = [];
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step(): Promise<never> {
        roles++;
        throw Error("No compatible model should dispatch");
      },
      async cancel() {},
    },
    publisher: {
      baseBranch: "main",
      async publish() {
        throw Error("Unexpected publication");
      },
    },
    command: {
      async run(input) {
        commands.push(input.command);
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            input.command[0] === "gh"
              ? JSON.stringify({
                  state: merged ? "MERGED" : "OPEN",
                  baseRefName: "main",
                  headRefName: "agile/issue-41",
                  headRefOid: head,
                  mergeCommit: merged ? { oid: "c".repeat(40) } : null,
                })
              : "d".repeat(40),
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  merged = true;
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  expect((await store.get(42)).execution).toBeUndefined();
  head = base;
  expect(await run.runOnce(new AbortController().signal)).toBe(true);
  expect((await store.get(42)).execution).toMatchObject({
    baseCommit: "d".repeat(40),
    phase: "needs_replan",
  });
  expect(commands).toContainEqual([
    "git",
    "merge-base",
    "--is-ancestor",
    "c".repeat(40),
    "d".repeat(40),
  ]);
  expect(roles).toBe(0);
});

/** Constructs a runner whose unexpected publication or agent execution fails the test. */
function runner(
  remote: ReturnType<typeof memoryGitHub>,
  harness?: AgentHarness,
  hooks?: TaskHookRunner,
) {
  return new GitHubTaskRunner({
    store: remote.store(),
    branches,
    hooks,
    harness: harness ?? {
      async step() {
        throw Error("Unexpected agent work");
      },
      async cancel() {},
    },
    advisor: createModelAdvisor(
      [{ id: model, supportedReasoningEfforts: ["high", "xhigh"] }],
      { luna: model, terra: model, sol: model },
    ),
    publisher: {
      baseBranch: "main",
      async publish() {
        throw Error("Unexpected publication");
      },
    },
    command: {
      async run() {
        return { exitCode: 0, stdout: base, stderr: "" };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
}

/** Seeds the durable comment as if an earlier process stopped at the supplied checkpoint. */
async function seed(
  remote: ReturnType<typeof memoryGitHub>,
  edit: (record: ExecutionRecord) => void,
) {
  const task = await remote.store().get(41);
  const record = initialExecution(task, "main", base);
  edit(record);
  remote.issue.comments.push({
    databaseId: 2,
    author: { login: "daemon" },
    body: renderExecution(record),
  });
}

test("confirmed refresh recovery selects only the new exact-target Review and never replays historical roles, hooks or publication", async () => {
  for (const recovering of [false, true]) {
    const remote = memoryGitHub({
      command: "must-not-replay",
      args: [],
      timeoutSeconds: 1,
    });
    const targetBase = "c".repeat(40);
    const head = "d".repeat(40);
    const accepted = {
      kind: "review" as const,
      decision: "accepted" as const,
      findings: [],
      remainingGaps: [],
    };
    await seed(remote, (record) => {
      record.phase = "reviewing";
      record.baseCommit = targetBase;
      record.publication = {
        number: 7,
        branch: "agile/issue-41",
        commitSha: head,
      };
      record.refreshes = [
        {
          expectedHead: "b".repeat(40),
          expectedBase: base,
          targetBase,
          budgetRemaining: 1,
          result: { headSha: head },
        },
      ];
      record.hooks.posthook = {
        hash: "historical-hook",
        status: "succeeded",
        attempts: 1,
      };
      for (const output of [
        {
          kind: "scout" as const,
          summary: "Inspect",
          files: ["answer.ts"],
          tests: ["bun test"],
          risks: [],
        },
        {
          kind: "implement" as const,
          commitSha: "b".repeat(40),
          validation: ["original validation"],
          risks: [],
          limitations: [],
        },
        accepted,
      ])
        record.attempts.push({
          descriptor: {
            attemptId: `original-${output.kind}`,
            taskId: "issue-41",
            role: output.kind,
            retryIndex: 0,
            model,
            modelProfile: "sol",
            effort: "high",
          },
          status: "succeeded",
          startedAt: time,
          endedAt: time,
          sequence: 2,
          events: {},
          output,
          usage: { ...zeroUsage, inputTokens: 50 },
          usageKnown: true,
        });
      if (recovering)
        record.attempts.push({
          descriptor: {
            attemptId: "persisted-fresh-review",
            taskId: "issue-41",
            role: "review",
            retryIndex: 0,
            model,
            modelProfile: "sol",
            effort: "xhigh",
          },
          reviewTarget: { headSha: head, baseSha: targetBase },
          status: "running",
          startedAt: time,
          sequence: 2,
          events: {},
          cursor: "output",
          output: accepted,
          usage: { ...zeroUsage, inputTokens: 11 },
          usageKnown: false,
        });
    });
    const before = (await remote.store().get(41)).execution!;
    const fake = createFakeHarness({
      attempts: [
        {
          taskId: "issue-41",
          role: "review",
          retryIndex: 0,
          expect: { model, effort: recovering ? "xhigh" : "high" },
          deliveries: [
            {
              nextCursor: "usage",
              event: {
                type: "attempt.usage_delta",
                eventId: "usage",
                attemptId: "fixture",
                sequence: 1,
                occurredAt: time,
                ...zeroUsage,
                inputTokens: 11,
              },
            },
            {
              nextCursor: "output",
              event: {
                type: "attempt.output",
                eventId: "output",
                attemptId: "fixture",
                sequence: 2,
                occurredAt: time,
                output: accepted,
              },
            },
            {
              nextCursor: "completed",
              event: {
                type: "attempt.completed",
                eventId: "completed",
                attemptId: "fixture",
                sequence: 3,
                occurredAt: time,
              },
            },
          ],
        },
      ],
    });
    const requests: HarnessStepRequest[] = [];
    const run = runner(
      remote,
      {
        async step(request) {
          requests.push(request);
          return fake.harness.step(request);
        },
        async cancel() {},
      },
      {
        async run() {
          throw Error("Must not replay posthook");
        },
        async stop() {},
      },
    );
    expect(await run.runOnce(new AbortController().signal)).toBe(false);
    const record = (await remote.store().get(41)).execution!;
    expect(record.phase).toBe("awaiting_merge");
    expect(record.attempts.slice(0, 3)).toEqual(before.attempts.slice(0, 3));
    expect(record.hooks).toEqual(before.hooks);
    expect(record.attempts).toHaveLength(4);
    const review = record.attempts[3]!;
    expect(review.usage).toEqual({ ...zeroUsage, inputTokens: 11 });
    expect(review.usageKnown).toBe(true);
    expect(record.mergeReview).toEqual({
      specHash: record.specHash,
      headSha: head,
      baseSha: targetBase,
      reviewAttemptId: review.descriptor.attemptId,
    });
    expect(requests[0]).toMatchObject({
      mode: recovering ? "reconcile" : "dispatch",
      attempt: { role: "review", effort: recovering ? "xhigh" : "high" },
      input: {
        role: "review",
        ticket: { baseCommit: targetBase, spec: { validation: ["bun test"] } },
        implementation: { commitSha: head },
      },
    });
    fake.assertComplete();

    // A completed fresh Review whose next phase write was interrupted is reused, not rerun.
    record.phase = "reviewing";
    remote.issue.comments.find(
      (comment) => comment.author?.login === "daemon",
    )!.body = renderExecution(record);
    await runner(remote).runOnce(new AbortController().signal);
    expect((await remote.store().get(41)).execution!.attempts).toEqual(
      record.attempts,
    );
    expect((await remote.store().get(41)).execution!.phase).toBe(
      "awaiting_merge",
    );
  }
});

test("cursorless persisted attempts reconcile, account duplicate usage once, and consume a bounded retry", async () => {
  const remote = memoryGitHub();
  await seed(remote, (record) => {
    record.phase = "scouting";
    record.attempts.push({
      descriptor: {
        attemptId: "old",
        taskId: "issue-41",
        role: "scout",
        retryIndex: 0,
        model,
        modelProfile: "luna",
        effort: "high",
      },
      status: "running",
      startedAt: time,
      sequence: 0,
      events: {},
      usage: { ...zeroUsage },
      usageKnown: false,
    });
  });
  const usage = {
    type: "attempt.usage_delta",
    eventId: "usage",
    attemptId: "old",
    sequence: 1,
    occurredAt: time,
    ...zeroUsage,
    inputTokens: 10,
  };
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "issue-41",
        role: "scout",
        retryIndex: 0,
        expect: { model, effort: "high" },
        deliveries: [
          { nextCursor: "1", event: usage },
          { nextCursor: "2", event: usage },
          {
            nextCursor: "3",
            event: {
              type: "attempt.failed_infra",
              eventId: "orphan",
              attemptId: "old",
              sequence: 2,
              occurredAt: time,
              code: "orphaned_turn",
              message: "Turn interrupted",
              retryable: true,
            },
          },
        ],
      },
      {
        taskId: "issue-41",
        role: "scout",
        retryIndex: 1,
        expect: { model, effort: "high" },
        deliveries: [
          {
            nextCursor: "4",
            event: {
              type: "attempt.blocked_policy",
              eventId: "blocked",
              attemptId: "new",
              sequence: 1,
              occurredAt: time,
              code: "interaction_cancelled",
              message: "Needs input",
            },
          },
        ],
      },
    ],
  });
  const requests: HarnessStepRequest[] = [];
  await runner(remote, {
    async step(request) {
      requests.push(request);
      return fake.harness.step(request);
    },
    async cancel() {},
  }).runOnce(new AbortController().signal);
  fake.assertComplete();
  expect(requests[0]).toMatchObject({
    mode: "reconcile",
    backendCursor: undefined,
  });
  expect(requests.at(-1)).toMatchObject({
    mode: "dispatch",
    attempt: { retryIndex: 1 },
  });
  const record = (await remote.store().get(41)).execution;
  expect(record?.attempts[0]?.usage.inputTokens).toBe(10);
  expect(record?.attempts[0]?.usageKnown).toBe(false);
  expect(record?.attempts).toHaveLength(2);
  expect(record?.phase).toBe("needs_replan");
});

test("terminal posthooks wait for exact trust, resume without rerunning roles, and preserve outcome", async () => {
  const hook = { command: "cleanup", args: [], timeoutSeconds: 1 };
  const remote = memoryGitHub(hook);
  await seed(remote, (record) => {
    record.phase = "rejected";
  });
  let calls = 0;
  const hooks: TaskHookRunner = {
    async run() {
      calls++;
      return { succeeded: true, timedOut: false, stdout: "", stderr: "" };
    },
    async stop() {},
  };
  expect(
    await runner(remote, undefined, hooks).runOnce(
      new AbortController().signal,
    ),
  ).toBe(true);
  expect((await remote.store().get(41)).execution).toMatchObject({
    phase: "rejected",
    failure: "Untrusted posthook",
  });
  expect(
    await runner(remote, undefined, hooks).runOnce(
      new AbortController().signal,
    ),
  ).toBe(false);
  remote.issue.comments.push({
    databaseId: 3,
    author: { login: "owner" },
    body: `<!-- roc:hook-trust ${jsonHash({ phase: "posthook", hook })} -->`,
  });
  expect(
    await runner(remote, undefined, hooks).runOnce(
      new AbortController().signal,
    ),
  ).toBe(true);
  expect((await remote.store().get(41)).execution).toMatchObject({
    phase: "rejected",
    hooks: { posthook: { status: "succeeded", attempts: 1 } },
  });
  expect(calls).toBe(1);
  expect(
    await runner(remote, undefined, hooks).runOnce(
      new AbortController().signal,
    ),
  ).toBe(false);
});

test("an interrupted terminal posthook records attention and never repeats an uncertain side effect", async () => {
  const hook = { command: "cleanup", args: [], timeoutSeconds: 1 };
  const remote = memoryGitHub(hook);
  await seed(remote, (record) => {
    record.phase = "failed_infra";
    record.hooks.posthook = {
      hash: jsonHash({ phase: "posthook", hook }),
      status: "running",
      attempts: 1,
    };
  });
  remote.issue.comments.push({
    databaseId: 3,
    author: { login: "owner" },
    body: `<!-- roc:hook-trust ${jsonHash({ phase: "posthook", hook })} -->`,
  });
  const hooks: TaskHookRunner = {
    async run() {
      throw Error("Must not repeat uncertain cleanup");
    },
    async stop() {},
  };
  expect(
    await runner(remote, undefined, hooks).runOnce(
      new AbortController().signal,
    ),
  ).toBe(true);
  expect((await remote.store().get(41)).execution).toMatchObject({
    phase: "failed_infra",
    failure: "Interrupted posthook requires reconciliation",
  });
  expect(
    await runner(remote, undefined, hooks).runOnce(
      new AbortController().signal,
    ),
  ).toBe(false);
});
