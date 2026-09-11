import { expect, test } from "bun:test";
import {
  type ExecutionRecord,
  GitHubExecutionStore,
  initialExecution,
  renderExecution,
} from "../../src/github/execution-store";
import type { RemoteIssue } from "../../src/github/issue-reader";
import type { TaskPublisher } from "../../src/github/pr-publisher";
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

test("done-open repair rejects absent or mismatched authority and merge evidence without checkpoint changes", async () => {
  for (const fault of [
    "none",
    "label-only",
    "number",
    "mergeCommit",
    "pr-number",
    "head",
    "branch",
    "target",
    "merge",
    "ancestry",
    "approval",
    "spec",
  ]) {
    const remote = memoryGitHub();
    if (fault !== "label-only")
      await seed(remote, (record) => {
        record.phase = "done";
        record.publication = {
          number: 7,
          branch: "agile/issue-41",
          commitSha: base,
          mergeCommit: base,
        };
        if (fault === "number") delete record.publication.number;
        if (fault === "mergeCommit") delete record.publication.mergeCommit;
      });
    else remote.issue.labels = [{ name: "roc:task" }, { name: "roc:done" }];
    if (fault === "approval") remote.issue.comments.shift();
    if (fault === "spec")
      remote.issue.body = remote.issue.body.replaceAll(
        "Wrong answer",
        "Changed answer",
      );
    const before = structuredClone(remote.issue.comments);
    const diagnostics: string[] = [];
    const taskRunner = new GitHubTaskRunner({
      store: remote.store(),
      branches,
      harness: {
        async step() {
          throw Error("No replay");
        },
        async cancel() {},
      },
      advisor: createModelAdvisor([]),
      publisher: {
        baseBranch: "main",
        mode: "pr",
        async publish() {
          throw Error("No publication");
        },
      },
      command: {
        async run({ command }) {
          return {
            exitCode:
              fault === "ancestry" && command[1] === "merge-base" ? 1 : 0,
            stderr: "",
            stdout: JSON.stringify({
              number: fault === "pr-number" ? 9 : 7,
              state: "MERGED",
              baseRefName: fault === "target" ? "other" : "main",
              headRefName: fault === "branch" ? "other" : "agile/issue-41",
              headRefOid: fault === "head" ? "b".repeat(40) : base,
              mergeCommit: { oid: fault === "merge" ? "b".repeat(40) : base },
            }),
          };
        },
      },
      cwd: "/fixture",
      baseBranch: "main",
      diagnostic: (message) => diagnostics.push(message),
    });
    expect(await taskRunner.runOnce(new AbortController().signal)).toBe(false);
    expect(remote.issue.comments).toEqual(before);
    expect(remote.issue.state).toBe(fault === "none" ? "CLOSED" : "OPEN");
    if (!["none", "label-only"].includes(fault))
      expect(diagnostics.join()).toContain("closure pending");
  }
});

test.each([
  { state: "CLOSED" as const, admitted: true },
  { state: "OPEN" as const, admitted: false },
])(
  "done label recovery respects admission: %j",
  async ({ state, admitted }) => {
    const remote = memoryGitHub();
    await seed(remote, (record) => {
      record.phase = "done";
      record.publication = {
        number: 7,
        branch: "agile/issue-41",
        commitSha: base,
        mergeCommit: base,
      };
    });
    remote.issue.state = state;
    remote.issue.labels = [
      { name: "roc:task" },
      { name: "roc:awaiting-merge" },
    ];
    const before = structuredClone(remote.issue.comments);
    const labels: string[] = [];
    const store = remote.store();
    const syncLabels = store.syncLabels.bind(store);
    let synchronizations = 0;
    store.syncLabels = async (task) => {
      synchronizations++;
      await syncLabels(task);
    };
    remote.api.setStatusLabel = async (...args: unknown[]) => {
      const label = String(args[2]);
      labels.push(label);
      remote.issue.labels = [{ name: "roc:task" }, { name: label }];
    };
    const commands: string[][] = [];
    const run = new GitHubTaskRunner({
      store,
      branches,
      harness: {
        async step() {
          throw Error("No model replay");
        },
        async cancel() {},
      },
      advisor: createModelAdvisor([]),
      publisher: {
        baseBranch: "main",
        mode: "pr",
        async publish() {
          throw Error("No publication");
        },
      },
      command: {
        async run({ command }) {
          commands.push(command);
          throw Error("No PR or merge checks");
        },
      },
      cwd: "/fixture",
      baseBranch: "main",
    });
    const { tasks } = await store.list();
    expect(
      await run.claimNext(tasks, new AbortController().signal, () => admitted),
    ).toBeUndefined();
    expect(synchronizations).toBe(admitted ? 1 : 0);
    expect(labels).toEqual(admitted ? ["roc:done"] : []);
    expect(remote.issue.labels).toContainEqual({
      name: admitted ? "roc:done" : "roc:awaiting-merge",
    });
    expect(commands).toEqual([]);
    expect(remote.closures).toEqual([]);
    expect(remote.issue.state).toBe(state);
    expect(remote.issue.comments).toEqual(before);
    expect((await store.get(41)).execution).toEqual(tasks[0]?.execution);
  },
);

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

test("a persisted Implement attempt keeps high when new implementation routes use medium", async () => {
  const remote = memoryGitHub();
  await seed(remote, (record) => {
    record.phase = "implementing";
    record.attempts = [
      {
        descriptor: {
          attemptId: "old-scout",
          taskId: "issue-41",
          role: "scout",
          retryIndex: 0,
          modelProfile: "luna",
          model,
          effort: "high",
        },
        status: "succeeded",
        startedAt: time,
        endedAt: time,
        sequence: 1,
        events: {},
        usage: { ...zeroUsage },
        usageKnown: true,
        output: {
          kind: "scout",
          summary: "Inspect answer",
          files: ["answer.ts"],
          tests: ["bun test"],
          risks: [],
        },
      },
      {
        descriptor: {
          attemptId: "old-implement",
          taskId: "issue-41",
          role: "implement",
          retryIndex: 0,
          modelProfile: "terra",
          model,
          effort: "high",
        },
        status: "running",
        startedAt: time,
        sequence: 0,
        events: {},
        usage: { ...zeroUsage },
        usageKnown: false,
      },
    ];
  });
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "issue-41",
        role: "implement",
        retryIndex: 0,
        expect: { model, effort: "high" },
        deliveries: [
          {
            nextCursor: "1",
            event: {
              type: "attempt.blocked_policy",
              eventId: "stop",
              attemptId: "old-implement",
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
  expect(requests[0]).toMatchObject({
    mode: "reconcile",
    attempt: { attemptId: "old-implement", effort: "high" },
  });
  expect((await remote.store().get(41)).execution?.attempts).toHaveLength(2);
  fake.assertComplete();
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
      mode: "pr",
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
  now?: () => string,
  publisher?: TaskPublisher,
) {
  return new GitHubTaskRunner({
    store: remote.store(),
    branches,
    hooks,
    now,
    harness: harness ?? {
      async step() {
        throw Error("Unexpected agent work");
      },
      async cancel() {},
    },
    advisor: createModelAdvisor(
      [{ id: model, supportedReasoningEfforts: ["medium", "high", "xhigh"] }],
      { luna: model, terra: model, sol: model },
    ),
    publisher: publisher ?? {
      baseBranch: "main",
      mode: "pr",
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

test("activity checkpoints are coalesced while phase timing and the latest action survive restart", async () => {
  const remote = memoryGitHub();
  const start = Date.parse(time);
  let now = start;
  const saved: ExecutionRecord[] = [];
  const write = remote.api.writeComment;
  remote.api.writeComment = async (...args) => {
    saved.push(
      JSON.parse(
        args[2]
          .split("<!-- roc:execution\n")[1]!
          .split("\nroc:execution -->")[0]!,
      ),
    );
    await write(...args);
  };
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "issue-41",
        role: "scout",
        retryIndex: 0,
        expect: { model, effort: "high" },
        deliveries: [1, 2, 31, 32, 62, 63].map((second, index) => ({
          nextCursor: String(index + 1),
          event: {
            eventId: `activity-${index}`,
            attemptId: "fixture",
            sequence: index + 1,
            occurredAt: new Date(start + second * 1000).toISOString(),
            ...(second === 63
              ? {
                  type: "attempt.blocked_policy",
                  code: "interaction_cancelled",
                  message: "Needs input",
                }
              : {
                  type: "attempt.activity",
                  activity: {
                    itemId: String(index),
                    action: "read",
                    summary: `Read file ${second}`,
                    status: "completed",
                  },
                }),
          },
        })),
      },
    ],
  });
  await runner(
    remote,
    {
      async step(request) {
        const delivery = await fake.harness.step(request);
        if (delivery.kind === "event")
          now = Date.parse(delivery.event.occurredAt);
        return delivery;
      },
      async cancel() {},
    },
    undefined,
    () => new Date(now).toISOString(),
  ).runOnce(new AbortController().signal);
  const checkpoints = saved.filter(
    (record) => record.phase === "scouting" && record.attempts[0]?.activity,
  );
  expect(
    checkpoints.map((record) => record.attempts[0]?.activity?.summary),
  ).toEqual(["Read file 31", "Read file 62"]);
  const record = (await remote.store().get(41)).execution;
  expect(record?.attempts[0]?.activity?.summary).toBe("Read file 62");
  expect(record?.timeline?.map((entry) => entry.phase)).toEqual([
    "claimed",
    "scouting",
    "needs_replan",
  ]);
});

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
    const publications: Parameters<TaskPublisher["publish"]>[0][] = [];
    const publisher: TaskPublisher = {
      baseBranch: "main",
      mode: "pr",
      async publish(input) {
        publications.push(structuredClone(input));
        return {
          number: 7,
          url: "https://github.com/acme/test/pull/7",
          state: "OPEN",
        };
      },
    };
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
      undefined,
      publisher,
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
    expect(publications.at(-1)).toMatchObject({
      publication: { commitSha: head },
      reconcileOnly: true,
      acceptance: {
        binding: { currentHeadSha: head, currentBaseSha: targetBase },
      },
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
    await runner(remote, undefined, undefined, undefined, publisher).runOnce(
      new AbortController().signal,
    );
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

test("branch publication fast-forwards the base branch, records the landed sha, and closes on base ancestry", async () => {
  const remote = memoryGitHub();
  const head = "d".repeat(40);
  const landed = "e".repeat(40);
  const accepted = {
    kind: "review" as const,
    decision: "accepted" as const,
    findings: [],
    remainingGaps: [],
  };
  await seed(remote, (record) => {
    record.phase = "reviewing";
    record.publication = {
      branch: "agile/issue-41",
      commitSha: head,
      mode: "branch",
    };
    record.mergeReview = {
      specHash: record.specHash,
      headSha: head,
      baseSha: base,
      reviewAttemptId: "original-review",
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
        commitSha: head,
        validation: ["bun test"],
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
        usage: { ...zeroUsage },
        usageKnown: true,
      });
  });
  const publications: Parameters<TaskPublisher["publish"]>[0][] = [];
  const publisher: TaskPublisher = {
    baseBranch: "main",
    mode: "branch",
    async publish(input) {
      publications.push(structuredClone(input));
      // Simulates a rebase onto an advanced base: the landed sha differs from the implemented head.
      return { branch: "agile/issue-41", commitSha: landed };
    },
  };
  const commands: string[][] = [];
  const run = new GitHubTaskRunner({
    store: remote.store(),
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("No agent work should replay");
      },
      async cancel() {},
    },
    publisher,
    command: {
      async run({ command }) {
        commands.push(command);
        return { exitCode: 0, stdout: base, stderr: "" };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(true);
  const record = (await remote.store().get(41)).execution!;
  expect(record.phase).toBe("done");
  expect(record.publication).toEqual({
    branch: "agile/issue-41",
    commitSha: landed,
    mode: "branch",
  });
  expect(publications).toHaveLength(1);
  expect(publications[0]).toMatchObject({
    publication: {
      taskId: "issue-41",
      branch: "agile/issue-41",
      commitSha: head,
      status: "pending",
    },
    implementation: { kind: "implement", commitSha: head },
  });
  expect("reconcileOnly" in publications[0]!).toBe(false);
  // Closure verifies the published commit is an ancestor of origin's base branch; no pull request is read.
  expect(commands).toEqual([
    ["git", "fetch", "origin", "main"],
    ["git", "merge-base", "--is-ancestor", landed, "refs/remotes/origin/main"],
  ]);
  expect(commands.flat()).not.toContain("pr");
  expect(remote.closures).toEqual([41]);
  expect(remote.issue.state).toBe("CLOSED");
});

test("branch-published dependencies gate on completion alone while PR dependencies still require merge evidence", async () => {
  for (const branchDependency of [true, false]) {
    // Both envelopes share one manifest so their plan identity matches, as production plans do.
    const planManifest = {
      ...manifest,
      tasks: [
        {
          ...manifest.tasks[0]!,
          spec: { ...manifest.tasks[0]!.spec, dependencies: ["T2"] },
        },
        { ...manifest.tasks[0]!, id: "T2", title: "Upstream work" },
      ],
    };
    const upstreamEnvelope = remoteTaskEnvelope(planManifest, "T2");
    const downstreamEnvelope = remoteTaskEnvelope(planManifest, "T1");
    const issue = (
      number: number,
      envelope: ReturnType<typeof remoteTaskEnvelope>,
    ): RemoteIssue => ({
      number,
      title: envelope.task.title,
      body: renderRemoteTaskBody(envelope),
      url: `https://github.com/acme/test/issues/${number}`,
      state: "OPEN",
      labels: [{ name: "roc:task" }, { name: "roc:ready" }],
      comments: [
        {
          databaseId: 1,
          author: { login: "owner" },
          body: renderRemoteTaskApproval(envelope),
        },
      ],
    });
    const issues = [issue(41, downstreamEnvelope), issue(42, upstreamEnvelope)];
    const upstreamRecord: ExecutionRecord = {
      version: 1,
      issueNumber: 42,
      specHash: jsonHash(upstreamEnvelope),
      revision: 0,
      baseBranch: "main",
      baseCommit: base,
      phase: "done",
      updatedAt: time,
      attempts: [],
      hooks: {},
      publication: branchDependency
        ? { branch: "agile/T2", commitSha: base, mode: "branch" }
        : {
            branch: "agile/T2",
            commitSha: base,
            mode: "pr",
            number: 8,
            mergeCommit: base,
          },
    };
    issues[1]!.comments.push({
      databaseId: 2,
      author: { login: "daemon" },
      body: renderExecution(upstreamRecord),
    });
    const api = {
      async read() {
        return structuredClone(issues);
      },
      async get(_repo: string, number: number) {
        return structuredClone(issues.find((item) => item.number === number)!);
      },
      async writeComment(_repo: string, _number: number, body: string) {
        const target = JSON.parse(
          body
            .split("<!-- roc:execution\n")[1]!
            .split("\nroc:execution -->")[0]!,
        ) as ExecutionRecord;
        const existing = issues
          .find((item) => item.number === target.issueNumber)!
          .comments.find((item) => item.databaseId === 2);
        if (existing) existing.body = body;
        else
          issues
            .find((item) => item.number === target.issueNumber)!
            .comments.push({
              databaseId: 2,
              author: { login: "daemon" },
              body,
            });
      },
      async closeCompleted(_repo: string, number: number) {},
      async setStatusLabel() {},
    };
    const store = new GitHubExecutionStore(
      "acme/test",
      "daemon",
      new Set(["owner"]),
      api,
    );
    const commands: string[][] = [];
    const run = new GitHubTaskRunner({
      store,
      branches,
      harness: {
        async step() {
          throw Error("No agent work");
        },
        async cancel() {},
      },
      advisor: createModelAdvisor([]),
      publisher: {
        baseBranch: "main",
        mode: "pr",
        async publish() {
          throw Error("No publication");
        },
      },
      command: {
        async run({ command }) {
          commands.push(command);
          return {
            exitCode: 0,
            stdout:
              command[0] === "gh"
                ? JSON.stringify({
                    number: 8,
                    state: "OPEN",
                    baseRefName: "main",
                    headRefName: "agile/T2",
                    headRefOid: base,
                    mergeCommit: { oid: base },
                  })
                : base,
            stderr: "",
          };
        },
      },
      cwd: "/fixture",
      baseBranch: "main",
    });
    commands.length = 0;
    await run.runOnce(new AbortController().signal).catch(() => undefined);
    const downstream = (await store.get(41)).execution;
    if (branchDependency) {
      // A completed branch dependency admits the downstream task without reading any pull request,
      // after verifying its landed commit is an ancestor of the fetched base.
      expect(downstream).toBeDefined();
      expect(commands).toEqual([
        ["git", "fetch", "origin", "main"],
        ["git", "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
        ["git", "merge-base", "--is-ancestor", base, base],
      ]);
      expect(commands.flat()).not.toContain("view");
    } else {
      // An unmerged pull-request dependency keeps the downstream task blocked.
      expect(downstream).toBeUndefined();
      expect(commands).toEqual([
        [
          "gh",
          "pr",
          "view",
          "8",
          "--repo",
          "acme/test",
          "--json",
          "number,state,baseRefName,headRefName,headRefOid,mergeCommit",
        ],
      ]);
    }
  }
});

test("branch dependencies require the same base and the landed commit inside the fetched base", async () => {
  for (const scenario of [
    {
      name: "same base with landed ancestry",
      upstreamBaseBranch: "main",
      ancestryExitCode: 0,
      admissible: true,
      expectedCommands: [
        ["git", "fetch", "origin", "main"],
        ["git", "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
        ["git", "merge-base", "--is-ancestor", "c".repeat(40), base],
      ],
    },
    {
      name: "upstream done on another base",
      upstreamBaseBranch: "release/next",
      ancestryExitCode: 0,
      admissible: false,
      expectedCommands: [],
    },
    {
      name: "same base that no longer contains the upstream commit",
      upstreamBaseBranch: "main",
      ancestryExitCode: 1,
      admissible: false,
      expectedCommands: [
        ["git", "fetch", "origin", "main"],
        ["git", "rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
        ["git", "merge-base", "--is-ancestor", "c".repeat(40), base],
      ],
    },
  ]) {
    // Both envelopes share one manifest so their plan identity matches, as production plans do.
    const planManifest = {
      ...manifest,
      tasks: [
        {
          ...manifest.tasks[0]!,
          spec: { ...manifest.tasks[0]!.spec, dependencies: ["T2"] },
        },
        { ...manifest.tasks[0]!, id: "T2", title: "Upstream work" },
      ],
    };
    const upstreamEnvelope = remoteTaskEnvelope(planManifest, "T2");
    const downstreamEnvelope = remoteTaskEnvelope(planManifest, "T1");
    const issue = (
      number: number,
      envelope: ReturnType<typeof remoteTaskEnvelope>,
    ): RemoteIssue => ({
      number,
      title: envelope.task.title,
      body: renderRemoteTaskBody(envelope),
      url: `https://github.com/acme/test/issues/${number}`,
      state: "OPEN",
      labels: [{ name: "roc:task" }, { name: "roc:ready" }],
      comments: [
        {
          databaseId: 1,
          author: { login: "owner" },
          body: renderRemoteTaskApproval(envelope),
        },
      ],
    });
    const issues = [issue(41, downstreamEnvelope), issue(42, upstreamEnvelope)];
    const upstreamRecord: ExecutionRecord = {
      version: 1,
      issueNumber: 42,
      specHash: jsonHash(upstreamEnvelope),
      revision: 0,
      baseBranch: scenario.upstreamBaseBranch,
      baseCommit: base,
      phase: "done",
      updatedAt: time,
      attempts: [],
      hooks: {},
      publication: {
        branch: "agile/T2",
        commitSha: "c".repeat(40),
        mode: "branch",
      },
    };
    issues[1]!.comments.push({
      databaseId: 2,
      author: { login: "daemon" },
      body: renderExecution(upstreamRecord),
    });
    const api = {
      async read() {
        return structuredClone(issues);
      },
      async get(_repo: string, number: number) {
        return structuredClone(issues.find((item) => item.number === number)!);
      },
      async writeComment(_repo: string, _number: number, body: string) {
        const target = JSON.parse(
          body
            .split("<!-- roc:execution\n")[1]!
            .split("\nroc:execution -->")[0]!,
        ) as ExecutionRecord;
        const existing = issues
          .find((item) => item.number === target.issueNumber)!
          .comments.find((item) => item.databaseId === 2);
        if (existing) existing.body = body;
        else
          issues
            .find((item) => item.number === target.issueNumber)!
            .comments.push({
              databaseId: 2,
              author: { login: "daemon" },
              body,
            });
      },
      async closeCompleted(_repo: string, number: number) {},
      async setStatusLabel() {},
    };
    const store = new GitHubExecutionStore(
      "acme/test",
      "daemon",
      new Set(["owner"]),
      api,
    );
    const commands: string[][] = [];
    const run = new GitHubTaskRunner({
      store,
      branches,
      harness: {
        async step() {
          throw Error("No agent work");
        },
        async cancel() {},
      },
      advisor: createModelAdvisor([]),
      publisher: {
        baseBranch: "main",
        mode: "pr",
        async publish() {
          throw Error("No publication");
        },
      },
      command: {
        async run({ command }) {
          commands.push(command);
          return {
            exitCode:
              command[1] === "merge-base" ? scenario.ancestryExitCode : 0,
            stdout: command[1] === "rev-parse" ? base : "",
            stderr: "",
          };
        },
      },
      cwd: "/fixture",
      baseBranch: "main",
    });
    await run.runOnce(new AbortController().signal).catch(() => undefined);
    const downstream = (await store.get(41)).execution;
    expect(downstream !== undefined, scenario.name).toBe(scenario.admissible);
    expect(commands, scenario.name).toEqual(scenario.expectedCommands);
    expect(commands.flat()).not.toContain("view");
  }
});

test("a reviewing pull-request checkpoint reroutes to the pull-request publisher when the daemon restarts in branch mode", async () => {
  const remote = memoryGitHub();
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
      url: "https://github.com/acme/test/pull/7",
      branch: "agile/issue-41",
      commitSha: head,
      mode: "pr",
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
        usage: { ...zeroUsage },
        usageKnown: true,
      });
  });
  const fake = createFakeHarness({
    attempts: [
      {
        taskId: "issue-41",
        role: "review",
        retryIndex: 0,
        expect: { model, effort: "high" },
        deliveries: [
          {
            nextCursor: "output",
            event: {
              type: "attempt.output",
              eventId: "output",
              attemptId: "fixture",
              sequence: 1,
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
              sequence: 2,
              occurredAt: time,
            },
          },
        ],
      },
    ],
  });
  const branchPublications: Parameters<TaskPublisher["publish"]>[0][] = [];
  const prPublications: Parameters<TaskPublisher["publish"]>[0][] = [];
  const commands: string[][] = [];
  const run = new GitHubTaskRunner({
    store: remote.store(),
    branches,
    advisor: createModelAdvisor(
      [{ id: model, supportedReasoningEfforts: ["medium", "high", "xhigh"] }],
      { luna: model, terra: model, sol: model },
    ),
    harness: {
      async step(request) {
        return fake.harness.step(request);
      },
      async cancel() {},
    },
    // The daemon restarted with branch publication configured; the checkpoint still says "pr".
    publisher: {
      baseBranch: "main",
      mode: "branch",
      async publish(input) {
        branchPublications.push(structuredClone(input));
        return { branch: "agile/issue-41", commitSha: "e".repeat(40) };
      },
    },
    alternatePublisher: {
      baseBranch: "main",
      mode: "pr",
      async publish(input) {
        prPublications.push(structuredClone(input));
        return {
          number: 7,
          url: "https://github.com/acme/test/pull/7",
          state: "OPEN" as const,
        };
      },
    },
    command: {
      async run({ command }) {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  const record = (await remote.store().get(41)).execution!;
  // The task returned to the pull-request waiting flow on the original pull request.
  expect(record.phase).toBe("awaiting_merge");
  expect(record.publication).toMatchObject({ number: 7, mode: "pr" });
  expect(branchPublications).toEqual([]);
  expect(prPublications).toHaveLength(1);
  expect(prPublications[0]).toMatchObject({
    reconcileOnly: true,
    publication: { commitSha: head, branch: "agile/issue-41" },
    acceptance: {
      binding: { currentHeadSha: head, currentBaseSha: targetBase },
    },
  });
  // No Git command ran at all, so nothing could push the base branch.
  expect(commands).toEqual([]);
  fake.assertComplete();
});
