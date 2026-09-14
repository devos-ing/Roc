import { expect, test } from "bun:test";
import { TicketSpecSchema } from "../../src/domain/schemas";
import {
  type ExecutionRecord,
  GitHubExecutionStore,
  initialExecution,
  renderExecution,
} from "../../src/github/execution-store";
import type { RemoteIssue } from "../../src/github/issue-reader";
import type {
  GitHubCommandRunner,
  TaskPublisher,
} from "../../src/github/pr-publisher";
import {
  jsonHash,
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
  validateTaskGraph,
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
    async getMany(repo: string, numbers: readonly number[]) {
      return Promise.all(numbers.map((number) => api.get(repo, number)));
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

/** Builds a chain plan fixture: predecessor ticket T1 on issue #41, continues ticket T2 on issue #42. */
function chainFixture(continues: { task: string }) {
  const remote = memoryGitHub();
  const first = manifest.tasks[0];
  if (!first) throw Error("Missing task fixture");
  const plan = {
    ...manifest,
    tasks: [first, { ...first, id: "T2", spec: { ...first.spec, continues } }],
  };
  const predecessorEnvelope = remoteTaskEnvelope(plan, "T1");
  remote.issue.body = renderRemoteTaskBody(predecessorEnvelope);
  remote.issue.comments[0] = {
    databaseId: 1,
    author: { login: "owner" },
    body: renderRemoteTaskApproval(predecessorEnvelope),
  };
  const chainEnvelope = remoteTaskEnvelope(plan, "T2");
  const chain: RemoteIssue = {
    ...structuredClone(remote.issue),
    number: 42,
    body: renderRemoteTaskBody(chainEnvelope),
    comments: [
      {
        databaseId: 3,
        author: { login: "owner" },
        body: renderRemoteTaskApproval(chainEnvelope),
      },
    ],
  };
  const api = {
    ...remote.api,
    async read() {
      return structuredClone([remote.issue, chain]);
    },
    async get(_repo: string, number: number) {
      if (number !== 41 && number !== 42) throw Error("Not Found");
      return structuredClone(number === 41 ? remote.issue : chain);
    },
    async getMany(repo: string, numbers: readonly number[]) {
      return Promise.all(numbers.map((number) => api.get(repo, number)));
    },
    async writeComment(
      _repo: string,
      number: number,
      body: string,
      id?: number,
    ) {
      const issue = number === 41 ? remote.issue : chain;
      const comment = issue.comments.find((item) => item.databaseId === id);
      if (comment) comment.body = body;
      else
        issue.comments.push({
          databaseId: 4,
          author: { login: "daemon" },
          body,
        });
    },
    async closeCompleted(_repo: string, number: number) {
      remote.closures.push(number);
      const issue = number === 41 ? remote.issue : chain;
      if (issue.state === "OPEN") {
        issue.state = "CLOSED";
        issue.stateReason = "COMPLETED";
      }
    },
  };
  const store = new GitHubExecutionStore(
    "acme/test",
    "daemon",
    new Set(["owner"]),
    api,
  );
  return { remote, store, chain, api };
}

/** Constructs a claim-only runner whose unexpected execution boundaries fail the test. */
function chainRunner(
  store: GitHubExecutionStore,
  diagnostics: string[],
  branchManager: TaskBranchManager = branches,
  commandRunner?: GitHubCommandRunner,
) {
  return new GitHubTaskRunner({
    store,
    branches: branchManager,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
      },
      async cancel() {},
    },
    publisher: {
      baseBranch: "main",
      async publish() {
        throw Error("Unexpected publication");
      },
    },
    command:
      commandRunner ??
      ({
        async run({ command }) {
          if (command[0] === "gh")
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                number: 7,
                state: "OPEN",
                baseRefName: "main",
                headRefName: "agile/issue-41",
                headRefOid: base,
                mergeCommit: null,
              }),
            };
          return { exitCode: 0, stderr: "", stdout: base };
        },
      } satisfies GitHubCommandRunner),
    cwd: "/fixture",
    baseBranch: "main",
    diagnostic: (message) => diagnostics.push(message),
  });
}

/** Adds exact accepted Implement and independent Review evidence to a frozen chain segment. */
function trustChainSegment(record: ExecutionRecord, commitSha: string): void {
  const implementationId = "chain-implement";
  const reviewId = "chain-review";
  record.attempts.push(
    {
      descriptor: {
        attemptId: implementationId,
        taskId: `issue-${record.issueNumber}`,
        role: "implement",
        retryIndex: 0,
        modelProfile: "terra",
        model,
        effort: "medium",
      },
      status: "succeeded",
      startedAt: time,
      endedAt: time,
      sequence: 0,
      events: {},
      usage: zeroUsage,
      usageKnown: true,
      output: {
        kind: "implement",
        commitSha,
        validation: ["bun test"],
        risks: [],
        limitations: [],
      },
    },
    {
      descriptor: {
        attemptId: reviewId,
        taskId: `issue-${record.issueNumber}`,
        role: "review",
        retryIndex: 0,
        modelProfile: "sol",
        model,
        effort: "high",
      },
      status: "succeeded",
      startedAt: time,
      endedAt: time,
      sequence: 0,
      events: {},
      usage: zeroUsage,
      usageKnown: true,
      output: {
        kind: "review",
        decision: "accepted",
        findings: [],
        remainingGaps: [],
      },
    },
  );
  record.mergeReview = {
    specHash: record.specHash,
    headSha: commitSha,
    baseSha: record.baseCommit,
    reviewAttemptId: reviewId,
  };
}

test("a chain ticket claims onto the frozen predecessor branch segment after its exact Review", async () => {
  const { remote, store } = chainFixture({ task: "T1" });
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: "agile/issue-41",
      commitSha: base,
    };
    trustChainSegment(record, base);
  });
  const diagnostics: string[] = [];
  const { tasks } = await store.list();
  const claimed = await chainRunner(store, diagnostics).claimNext(
    tasks,
    new AbortController().signal,
  );
  expect(claimed?.issue.number).toBe(42);
  expect((await store.get(42)).execution).toMatchObject({
    baseCommit: base,
    baseBranch: "agile/issue-41",
  });
  expect((await store.get(41)).execution?.phase).toBe("awaiting_merge");
  expect(diagnostics).toEqual([]);
});

test("a chain claim replans when the root merge target no longer matches the configured target", async () => {
  const { remote, store } = chainFixture({ task: "T1" });
  await seed(remote, (record) => {
    record.baseBranch = "release";
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: "agile/issue-41",
      commitSha: base,
    };
    trustChainSegment(record, base);
  });
  const diagnostics: string[] = [];
  const { tasks } = await store.list();
  expect(
    await chainRunner(store, diagnostics).claimNext(
      tasks,
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect((await store.get(42)).execution).toMatchObject({
    phase: "needs_replan",
    failure: expect.stringContaining("root branch, target, or pull request"),
  });
});

test("a chain claim replans when the root checkpoint points at a different task branch", async () => {
  const { remote, store } = chainFixture({ task: "T1" });
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: "agile/other",
      commitSha: base,
    };
    trustChainSegment(record, base);
  });
  const diagnostics: string[] = [];
  const { tasks } = await store.list();
  expect(
    await chainRunner(store, diagnostics).claimNext(
      tasks,
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect((await store.get(42)).execution).toMatchObject({
    phase: "needs_replan",
    failure: expect.stringContaining("root branch, target, or pull request"),
  });
});

test("a later chain claim replans when its predecessor no longer uses the root branch", async () => {
  const { remote, store, predecessor } = chainPairFixture();
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: "agile/issue-41",
      commitSha: base,
    };
    trustChainSegment(record, base);
  });
  const segment = "b".repeat(40);
  await seedChainTicket(
    store,
    predecessor,
    "agile/issue-41",
    base,
    (record) => {
      record.phase = "awaiting_merge";
      record.publication = {
        number: 7,
        branch: "agile/other",
        commitSha: segment,
      };
      trustChainSegment(record, segment);
    },
  );
  const diagnostics: string[] = [];
  const { tasks } = await store.list();
  expect(
    await chainRunner(store, diagnostics).claimNext(
      tasks,
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect((await store.get(43)).execution).toMatchObject({
    phase: "needs_replan",
    failure: expect.stringContaining("root branch, target, or pull request"),
  });
});

test("a chain claim replans instead of waiting on confirmed mismatched Review evidence", async () => {
  const { remote, store } = chainFixture({ task: "T1" });
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: "agile/issue-41",
      commitSha: base,
    };
  });
  const diagnostics: string[] = [];
  const { tasks } = await store.list();
  expect(
    await chainRunner(store, diagnostics).claimNext(
      tasks,
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect((await store.get(42)).execution).toMatchObject({
    phase: "needs_replan",
    failure: expect.stringContaining(
      "corrupt or mismatched Review publication",
    ),
  });
});

test("a chain claim is abandoned when its predecessor merges between validation and the checkpoint save", async () => {
  const { remote, store } = chainFixture({ task: "T1" });
  const chainBranch = "agile/issue-41";
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = { number: 7, branch: chainBranch, commitSha: base };
    trustChainSegment(record, base);
  });
  const mergePredecessor = async () => {
    const current = await remote.store().get(41);
    const record = current.execution;
    if (!record?.publication || !current.commentId)
      throw Error("Missing seeded predecessor");
    record.phase = "done";
    record.publication.number = 7;
    record.publication.mergeCommit = base;
    await remote.api.writeComment(
      "acme/test",
      41,
      renderExecution(record),
      current.commentId,
    );
    remote.issue.state = "CLOSED";
  };
  const diagnostics: string[] = [];
  let changed = false;
  const changingBranches: TaskBranchManager = {
    ...branches,
    async status() {
      if (!changed) {
        changed = true;
        await mergePredecessor();
      }
      return "";
    },
  };
  const run = chainRunner(store, diagnostics, changingBranches);
  const { tasks } = await store.list();
  expect(
    await run.claimNext(tasks, new AbortController().signal),
  ).toBeUndefined();
  expect(run.admissionChanged).toBe(true);
  expect((await store.get(42)).execution).toBeUndefined();
  expect(diagnostics).toEqual([]);
});

test("chain predecessor state follows the fresh issue read, not the stale listing snapshot", async () => {
  const { remote, store, chain, api } = chainFixture({ task: "T1" });
  const chainBranch = "agile/issue-41";
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = { number: 7, branch: chainBranch, commitSha: base };
  });
  const staleListing = structuredClone([remote.issue, chain]);
  const current = await remote.store().get(41);
  const record = current.execution;
  if (!record?.publication || !current.commentId)
    throw Error("Missing seeded predecessor");
  record.phase = "done";
  record.publication.number = 7;
  record.publication.mergeCommit = base;
  await remote.api.writeComment(
    "acme/test",
    41,
    renderExecution(record),
    current.commentId,
  );
  remote.issue.state = "CLOSED";
  api.read = async () => structuredClone(staleListing);
  const diagnostics: string[] = [];
  const run = chainRunner(store, diagnostics);
  const { tasks } = await store.list();
  expect(
    await run.claimNext(tasks, new AbortController().signal),
  ).toBeUndefined();
  expect((await store.get(42)).execution).toMatchObject({
    phase: "needs_replan",
    baseBranch: chainBranch,
    failure: expect.stringContaining("already merged"),
  });
  expect(diagnostics.join()).toContain("already merged or closed");
});

test("a chain ticket whose predecessor is already merged to done is durably marked needs_replan", async () => {
  const { remote, store } = chainFixture({ task: "T1" });
  await seed(remote, (record) => {
    record.phase = "done";
    record.publication = {
      number: 7,
      branch: "agile/issue-41",
      commitSha: base,
      mergeCommit: base,
    };
    trustChainSegment(record, base);
  });
  remote.issue.state = "CLOSED";
  const diagnostics: string[] = [];
  const runner = chainRunner(store, diagnostics);
  const { tasks } = await store.list();
  expect(
    await runner.claimNext(tasks, new AbortController().signal),
  ).toBeUndefined();
  expect((await store.get(42)).execution).toMatchObject({
    phase: "needs_replan",
    baseBranch: "agile/issue-41",
    failure: expect.stringContaining("already merged"),
  });
  expect(diagnostics.join()).toContain("already merged or closed");
  // The persisted needs_replan checkpoint keeps every later claim attempt away.
  const after = await store.list();
  expect(
    await runner.claimNext(after.tasks, new AbortController().signal),
  ).toBeUndefined();
  expect(after.tasks.map((task) => task.task.status)).toContain("needs_replan");
});

/** Builds a three-issue chain plan with an optional same-plan dependency outside the chain. */
function chainPairFixture(withExternalDependency = false) {
  const remote = memoryGitHub();
  const first = manifest.tasks[0];
  if (!first) throw Error("Missing task fixture");
  const plan = {
    ...manifest,
    tasks: [
      first,
      {
        ...first,
        id: "T2",
        spec: { ...first.spec, continues: { task: "T1" } },
      },
      {
        ...first,
        id: "T3",
        spec: {
          ...first.spec,
          dependencies: withExternalDependency ? ["T4"] : [],
          continues: { task: "T2" },
        },
      },
      ...(withExternalDependency
        ? [
            {
              ...first,
              id: "T4",
              priority: 3,
              spec: { ...first.spec, dependencies: [] },
            },
          ]
        : []),
    ],
  };
  const issueFor = (
    id: string,
    number: number,
    commentId: number,
  ): RemoteIssue => {
    const envelope = remoteTaskEnvelope(plan, id);
    return {
      ...structuredClone(remote.issue),
      number,
      body: renderRemoteTaskBody(envelope),
      comments: [
        {
          databaseId: commentId,
          author: { login: "owner" },
          body: renderRemoteTaskApproval(envelope),
        },
      ],
    };
  };
  const firstEnvelope = remoteTaskEnvelope(plan, "T1");
  remote.issue.body = renderRemoteTaskBody(firstEnvelope);
  remote.issue.comments[0] = {
    databaseId: 1,
    author: { login: "owner" },
    body: renderRemoteTaskApproval(firstEnvelope),
  };
  const predecessor = issueFor("T2", 42, 3);
  const successor = issueFor("T3", 43, 5);
  const external = withExternalDependency ? issueFor("T4", 44, 7) : undefined;
  const issues = [remote.issue, predecessor, successor, external].filter(
    (issue): issue is RemoteIssue => issue !== undefined,
  );
  const issueByNumber = (number: number) => {
    const issue = issues.find((candidate) => candidate.number === number);
    if (!issue) throw Error(`Missing fixture issue #${number}`);
    return issue;
  };
  const api = {
    ...remote.api,
    async read() {
      return structuredClone(issues);
    },
    async get(_repo: string, number: number) {
      return structuredClone(issueByNumber(number));
    },
    async getMany(repo: string, numbers: readonly number[]) {
      return Promise.all(numbers.map((number) => api.get(repo, number)));
    },
    async writeComment(
      _repo: string,
      number: number,
      body: string,
      id?: number,
    ) {
      const issue = issueByNumber(number);
      const comment = issue.comments.find((item) => item.databaseId === id);
      if (comment) comment.body = body;
      else
        issue.comments.push({
          databaseId: issue.comments.length + 1,
          author: { login: "daemon" },
          body,
        });
    },
    async closeCompleted(_repo: string, number: number) {
      remote.closures.push(number);
      const issue = issueByNumber(number);
      if (issue.state === "OPEN") {
        issue.state = "CLOSED";
        issue.stateReason = "COMPLETED";
      }
    },
  };
  const store = new GitHubExecutionStore(
    "acme/test",
    "daemon",
    new Set(["owner"]),
    api,
  );
  return { remote, store, predecessor, successor, external };
}

/** Seeds a durable chain-ticket checkpoint as if an earlier process stopped there. */
async function seedChainTicket(
  store: GitHubExecutionStore,
  issue: RemoteIssue,
  baseBranch: string,
  baseCommit: string,
  edit: (record: ExecutionRecord) => void,
) {
  const task = await store.get(issue.number);
  const record = initialExecution(task, baseBranch, baseCommit);
  edit(record);
  issue.comments.push({
    databaseId: 100 + issue.number,
    author: { login: "daemon" },
    body: renderExecution(record),
  });
}

test("outside-chain dependencies must already be ancestors of the trusted predecessor segment", async () => {
  for (const ancestry of [true, false]) {
    const { remote, store, predecessor, external } = chainPairFixture(true);
    if (!external) throw Error("Missing external dependency fixture");
    const chainBranch = "agile/issue-41";
    const segment = "b".repeat(40);
    const dependencyMerge = "d".repeat(40);
    await seed(remote, (record) => {
      record.phase = "awaiting_merge";
      record.publication = {
        number: 7,
        branch: chainBranch,
        commitSha: base,
      };
      trustChainSegment(record, base);
    });
    await seedChainTicket(store, predecessor, chainBranch, base, (record) => {
      record.phase = "awaiting_merge";
      record.publication = {
        number: 7,
        branch: chainBranch,
        commitSha: segment,
      };
      trustChainSegment(record, segment);
    });
    await seedChainTicket(store, external, "main", base, (record) => {
      record.phase = "done";
      record.publication = {
        number: 9,
        branch: "agile/issue-44",
        commitSha: dependencyMerge,
        mergeCommit: dependencyMerge,
      };
    });
    const command: GitHubCommandRunner = {
      async run({ command }) {
        if (command[0] === "gh")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              number: Number(command[3]),
              state: "OPEN",
              baseRefName: "main",
              headRefName: chainBranch,
              headRefOid: segment,
              mergeCommit: null,
            }),
          };
        if (command[1] === "merge-base" && command[3] === dependencyMerge)
          return {
            exitCode: ancestry ? 0 : 1,
            stderr: ancestry ? "" : "missing ancestry",
            stdout: "",
          };
        return { exitCode: 0, stderr: "", stdout: segment };
      },
    };
    const diagnostics: string[] = [];
    const { tasks } = await store.list();
    const claimed = await chainRunner(
      store,
      diagnostics,
      branches,
      command,
    ).claimNext(tasks, new AbortController().signal);
    if (ancestry) {
      expect(claimed?.issue.number).toBe(43);
      expect((await store.get(43)).execution).toMatchObject({
        phase: "claimed",
        baseCommit: segment,
        baseBranch: chainBranch,
      });
    } else {
      expect(claimed).toBeUndefined();
      expect((await store.get(43)).execution).toMatchObject({
        phase: "needs_replan",
        failure: expect.stringContaining(
          "External dependency merged after the trusted chain base",
        ),
      });
      expect(diagnostics.join()).toContain(
        "absent from the trusted chain base",
      );
    }
  }
});

test("a merged chain branch credits every awaiting chain ticket with the same merge commit", async () => {
  const { remote, store, predecessor, successor } = chainPairFixture();
  const chainBranch = "agile/issue-41";
  const segmentA = "b".repeat(40);
  const segmentB = "e".repeat(40);
  const merged = "c".repeat(40);
  await seed(remote, (record) => {
    record.phase = "done";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: base,
      mergeCommit: base,
    };
    trustChainSegment(record, base);
  });
  remote.issue.state = "CLOSED";
  await seedChainTicket(store, predecessor, chainBranch, base, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: segmentA,
    };
    trustChainSegment(record, segmentA);
  });
  await seedChainTicket(store, successor, chainBranch, segmentA, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: segmentB,
    };
    trustChainSegment(record, segmentB);
  });
  const diagnostics: string[] = [];
  const commands: string[][] = [];
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "MERGED",
                  baseRefName: "main",
                  headRefName: chainBranch,
                  headRefOid: segmentB,
                  mergeCommit: { oid: merged },
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
    diagnostic: (message) => diagnostics.push(message),
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  for (const [number, commitSha] of [
    [42, segmentA],
    [43, segmentB],
  ] as const) {
    expect((await store.get(number)).execution).toMatchObject({
      phase: "done",
      baseBranch: chainBranch,
      publication: {
        number: 7,
        branch: chainBranch,
        commitSha,
        mergeCommit: merged,
      },
    });
  }
  expect(predecessor.state).toBe("CLOSED");
  expect(successor.state).toBe("CLOSED");
  expect(diagnostics).toEqual([]);
  expect(commands).toContainEqual([
    "git",
    "merge-base",
    "--is-ancestor",
    segmentA,
    merged,
  ]);
  expect(commands).toContainEqual(["git", "fetch", "origin", "main"]);
  expect(commands).not.toContainEqual(["git", "fetch", "origin", chainBranch]);
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
});

test("an extra unreviewed PR head commit replans the root before any chain member completes", async () => {
  const { remote, store, predecessor, successor } = chainPairFixture();
  const chainBranch = "agile/issue-41";
  const segmentA = "b".repeat(40);
  const segmentB = "e".repeat(40);
  const merged = "c".repeat(40);
  const extraHead = "f".repeat(40);
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: base,
    };
    trustChainSegment(record, base);
  });
  await seedChainTicket(store, predecessor, chainBranch, base, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: segmentA,
    };
    trustChainSegment(record, segmentA);
  });
  await seedChainTicket(store, successor, chainBranch, segmentA, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: segmentB,
    };
    trustChainSegment(record, segmentB);
  });
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "MERGED",
                  baseRefName: "main",
                  headRefName: chainBranch,
                  headRefOid: extraHead,
                  mergeCommit: { oid: merged },
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  expect((await store.get(41)).execution).toMatchObject({
    phase: "needs_replan",
    failure: expect.stringContaining(
      "PR head does not match the final reviewed segment",
    ),
  });
  expect(
    (await store.list()).tasks.every(
      (candidate) => candidate.execution?.phase !== "done",
    ),
  ).toBe(true);
});

test("a squash merge that omits the reviewed middle segment replans before any member completes", async () => {
  const { remote, store, predecessor, successor } = chainPairFixture();
  const chainBranch = "agile/issue-41";
  const segmentA = "b".repeat(40);
  const segmentB = "e".repeat(40);
  const merged = "c".repeat(40);
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: base,
    };
    trustChainSegment(record, base);
  });
  await seedChainTicket(store, predecessor, chainBranch, base, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: segmentA,
    };
    trustChainSegment(record, segmentA);
  });
  await seedChainTicket(store, successor, chainBranch, segmentA, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: segmentB,
    };
    trustChainSegment(record, segmentB);
  });
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        if (command[0] === "gh" && command.includes("--jq"))
          return {
            exitCode: 0,
            stderr: "",
            stdout: `${base}\n${segmentB}\n`,
          };
        return {
          exitCode:
            command[1] === "merge-base" && command[3] === segmentA ? 1 : 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "MERGED",
                  baseRefName: "main",
                  headRefName: chainBranch,
                  headRefOid: segmentB,
                  mergeCommit: { oid: merged },
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  expect((await store.get(41)).execution).toMatchObject({
    phase: "needs_replan",
    failure: expect.stringContaining("squash merge dropped or excluded"),
  });
  expect(
    (await store.list()).tasks.every(
      (candidate) => candidate.execution?.phase !== "done",
    ),
  ).toBe(true);
});

test("an early merged chain PR replans the root while future segments are unstarted", async () => {
  const { remote, store } = chainFixture({ task: "T1" });
  const chainBranch = "agile/issue-41";
  const merged = "c".repeat(40);
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: base,
    };
    trustChainSegment(record, base);
  });
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "MERGED",
                  baseRefName: "main",
                  headRefName: chainBranch,
                  headRefOid: base,
                  mergeCommit: { oid: merged },
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  expect((await store.get(41)).execution).toMatchObject({
    phase: "needs_replan",
    failure: expect.stringContaining(
      "before every planned segment had exact accepted Review",
    ),
  });
});

test("a merged terminal segment without exact Review evidence requires replan", async () => {
  const { remote, store, chain } = chainFixture({ task: "T1" });
  const chainBranch = "agile/issue-41";
  const segment = "b".repeat(40);
  const merged = "c".repeat(40);
  await seed(remote, (record) => {
    record.phase = "done";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: base,
      mergeCommit: base,
    };
    trustChainSegment(record, base);
  });
  remote.issue.state = "CLOSED";
  const task = await store.get(42);
  const record = initialExecution(task, chainBranch, base);
  record.phase = "awaiting_merge";
  record.publication = { number: 7, branch: chainBranch, commitSha: segment };
  chain.comments.push({
    databaseId: 4,
    author: { login: "daemon" },
    body: renderExecution(record),
  });
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "MERGED",
                  baseRefName: "main",
                  headRefName: chainBranch,
                  headRefOid: segment,
                  mergeCommit: { oid: merged },
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  expect((await store.get(42)).execution).toMatchObject({
    phase: "needs_replan",
    failure: expect.stringContaining(
      "before every planned segment had exact accepted Review",
    ),
  });
});

test("a merged chain PR that dropped its segment leaves an explicit replan instead of waiting forever", async () => {
  const { remote, store, chain } = chainFixture({ task: "T1" });
  const chainBranch = "agile/issue-41";
  const segment = "b".repeat(40);
  const merged = "c".repeat(40);
  await seed(remote, (record) => {
    record.phase = "done";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: base,
      mergeCommit: base,
    };
    trustChainSegment(record, base);
  });
  remote.issue.state = "CLOSED";
  const task = await store.get(42);
  const record = initialExecution(task, chainBranch, base);
  record.phase = "awaiting_merge";
  record.publication = { number: 7, branch: chainBranch, commitSha: segment };
  trustChainSegment(record, segment);
  chain.comments.push({
    databaseId: 4,
    author: { login: "daemon" },
    body: renderExecution(record),
  });
  const commands: string[][] = [];
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        commands.push(command);
        const jq = command.indexOf("--jq");
        if (command[0] === "gh" && jq >= 0) {
          // gh applies the jq expression to the full --json payload and prints one value per line.
          return command[jq + 1] === ".commits[].oid"
            ? { exitCode: 0, stderr: "", stdout: `${"f".repeat(40)}\n` }
            : { exitCode: 1, stderr: "expression error", stdout: "" };
        }
        return {
          exitCode:
            command[1] === "merge-base" && command[3] === segment ? 1 : 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "MERGED",
                  baseRefName: "main",
                  headRefName: chainBranch,
                  headRefOid: segment,
                  mergeCommit: { oid: merged },
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  const after = (await store.get(42)).execution;
  expect(after).toMatchObject({
    phase: "needs_replan",
    baseBranch: chainBranch,
  });
  expect(after?.failure).toContain("squash merge dropped or excluded");
  expect(after?.publication?.mergeCommit).toBeUndefined();
  expect(chain.state).toBe("OPEN");
  expect(commands).toContainEqual([
    "git",
    "merge-base",
    "--is-ancestor",
    segment,
    merged,
  ]);
  expect(commands).toContainEqual([
    "gh",
    "pr",
    "view",
    "7",
    "--repo",
    "acme/test",
    "--json",
    "commits",
    "--jq",
    ".commits[].oid",
  ]);
});

test("a squash-merged chain PR verifies its segment via the PR commit list and credits the squash commit", async () => {
  const { remote, store, chain } = chainFixture({ task: "T1" });
  const chainBranch = "agile/issue-41";
  const segment = "b".repeat(40);
  const merged = "c".repeat(40);
  await seed(remote, (record) => {
    record.phase = "done";
    record.publication = {
      number: 7,
      branch: chainBranch,
      commitSha: base,
      mergeCommit: base,
    };
    trustChainSegment(record, base);
  });
  remote.issue.state = "CLOSED";
  const task = await store.get(42);
  const record = initialExecution(task, chainBranch, base);
  record.phase = "awaiting_merge";
  record.publication = { number: 7, branch: chainBranch, commitSha: segment };
  trustChainSegment(record, segment);
  chain.comments.push({
    databaseId: 4,
    author: { login: "daemon" },
    body: renderExecution(record),
  });
  const diagnostics: string[] = [];
  const commands: string[][] = [];
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        commands.push(command);
        const jq = command.indexOf("--jq");
        if (command[0] === "gh" && jq >= 0) {
          // gh evaluates the expression against the full {"commits":[...]} payload
          // and fails on expressions that do not match that shape.
          const commits = [{ oid: base }, { oid: segment }];
          return command[jq + 1] === ".commits[].oid"
            ? {
                exitCode: 0,
                stderr: "",
                stdout: `${commits.map((item) => item.oid).join("\n")}\n`,
              }
            : { exitCode: 1, stderr: "expression error", stdout: "" };
        }
        return {
          exitCode:
            command[1] === "merge-base" && command[3] === segment ? 1 : 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "MERGED",
                  baseRefName: "main",
                  headRefName: chainBranch,
                  headRefOid: segment,
                  mergeCommit: { oid: merged },
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
    diagnostic: (message) => diagnostics.push(message),
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  const after = (await store.get(42)).execution;
  expect(after).toMatchObject({
    phase: "done",
    baseBranch: chainBranch,
    publication: {
      number: 7,
      branch: chainBranch,
      commitSha: segment,
      mergeCommit: merged,
    },
  });
  expect(after?.failure).toBeUndefined();
  expect(diagnostics.join()).toContain(
    "segment verified via PR commit list (squash merge; ancestry unavailable)",
  );
  expect(chain.state).toBe("CLOSED");
});

test("a successor refuses a publisher result that changes the root pull request number", async () => {
  const { remote, store, chain } = chainFixture({ task: "T1" });
  const chainBranch = "agile/issue-41";
  const implementationCommit = "d".repeat(40);
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = { number: 7, branch: chainBranch, commitSha: base };
  });
  const reviewed = await store.get(42);
  const record = initialExecution(reviewed, chainBranch, base);
  record.phase = "reviewing";
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
      commitSha: implementationCommit,
      validation: ["bun test"],
      risks: [],
      limitations: [],
    },
    {
      kind: "review" as const,
      decision: "accepted" as const,
      findings: [],
      remainingGaps: [],
    },
  ])
    record.attempts.push({
      descriptor: {
        attemptId: `${output.kind}-attempt`,
        taskId: "issue-42",
        role: output.kind,
        retryIndex: 0,
        model,
        modelProfile: "terra",
        effort: "high",
      },
      status: "succeeded",
      startedAt: time,
      endedAt: time,
      sequence: 1,
      events: {},
      output,
      usage: { ...zeroUsage },
      usageKnown: true,
    });
  record.mergeReview = {
    specHash: record.specHash,
    headSha: implementationCommit,
    baseSha: base,
    reviewAttemptId: "review-attempt",
  };
  chain.comments.push({
    databaseId: 4,
    author: { login: "daemon" },
    body: renderExecution(record),
  });
  const chainBranches: TaskBranchManager = {
    ...branches,
    async prepare(taskId) {
      return {
        taskId,
        path: "/fixture",
        branch: chainBranch,
        baseCommit: base,
      };
    },
  };
  const publications: Parameters<TaskPublisher["publish"]>[0][] = [];
  const run = new GitHubTaskRunner({
    store,
    branches: chainBranches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
      },
      async cancel() {},
    },
    publisher: {
      baseBranch: "main",
      async publish(input) {
        publications.push(structuredClone(input));
        return {
          number: 8,
          url: "https://github.com/acme/test/pull/8",
          state: "OPEN",
        };
      },
    },
    command: {
      async run({ command }) {
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "OPEN",
                  baseRefName: "main",
                  headRefName: chainBranch,
                  headRefOid: base,
                  mergeCommit: null,
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  await expect(run.runOnce(new AbortController().signal)).rejects.toThrow(
    "expected #7",
  );
  expect(publications).toHaveLength(1);
  // The shared chain branch is the PR head, never its own base.
  expect(publications[0]?.publication).toMatchObject({
    branch: chainBranch,
    baseBranch: "main",
    commitSha: implementationCommit,
  });
  expect((await store.get(42)).execution).toMatchObject({
    phase: "publishing",
    baseBranch: chainBranch,
    publication: { branch: chainBranch },
  });
});

test("root publication includes every known future chain segment before successors execute", async () => {
  const { remote, store } = chainPairFixture();
  await seed(remote, (record) => {
    record.phase = "reviewing";
    record.attempts.push({
      descriptor: {
        attemptId: "root-scout",
        taskId: "issue-41",
        role: "scout",
        retryIndex: 0,
        modelProfile: "sol",
        model,
        effort: "high",
      },
      status: "succeeded",
      startedAt: time,
      endedAt: time,
      sequence: 0,
      events: {},
      usage: zeroUsage,
      usageKnown: true,
      output: {
        kind: "scout",
        summary: "Root inspected",
        files: ["answer.ts"],
        tests: ["bun test"],
        risks: [],
      },
    });
    trustChainSegment(record, base);
  });
  const publications: Parameters<TaskPublisher["publish"]>[0][] = [];
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
      },
      async cancel() {},
    },
    publisher: {
      baseBranch: "main",
      async publish(input) {
        publications.push(structuredClone(input));
        return {
          number: 7,
          url: "https://github.com/acme/test/pull/7",
          state: "OPEN",
        };
      },
    },
    command: {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(true);
  expect(publications).toHaveLength(1);
  expect(publications[0]?.chain).toEqual({
    rootTitle: "Return 42",
    segments: [
      { taskId: "T1", issueNumber: 41, commitSha: base, reviewed: true },
      { taskId: "T2", issueNumber: 42, reviewed: false },
      { taskId: "T3", issueNumber: 43, reviewed: false },
    ],
  });
});

test("an auto-merge predecessor recovers read-only while its chain successor keeps the PR open", async () => {
  const { remote, store } = chainFixture({ task: "T1" });
  const taskBranch = "agile/issue-41";
  const segmentA = "b".repeat(40);
  const pushed = "e".repeat(40);
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: taskBranch,
      commitSha: segmentA,
    };
    trustChainSegment(record, segmentA);
    trustChainSegment(record, segmentA);
    trustChainSegment(record, segmentA);
  });
  const diagnostics: string[] = [];
  const commands: string[][] = [];
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "OPEN",
                  baseRefName: "main",
                  headRefName: taskBranch,
                  headRefOid: pushed,
                  mergeCommit: null,
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
    autoMerge: true,
    diagnostic: (message) => diagnostics.push(message),
  });
  const { tasks } = await store.list();
  await run.claimNext(tasks, new AbortController().signal);
  const record = (await store.get(41)).execution;
  expect(record).toMatchObject({
    phase: "awaiting_merge",
    baseBranch: "main",
    publication: { number: 7, branch: taskBranch, commitSha: segmentA },
  });
  expect(record?.failure).toBeUndefined();
  expect(record?.publication?.mergeCommit).toBeUndefined();
  expect(remote.issue.state).toBe("OPEN");
  expect(diagnostics).toEqual([]);
  // The read-only recovery never constructs a merger; every merger call goes through `gh api`.
  expect(commands.some((command) => command.includes("gh api"))).toBe(false);
  expect(commands).not.toContainEqual([
    "git",
    "merge-base",
    "--is-ancestor",
    segmentA,
    pushed,
  ]);
});

test("a structural successor keeps its predecessor out of standalone auto-merge when approval is withdrawn", async () => {
  const { remote, store, chain } = chainFixture({ task: "T1" });
  const taskBranch = "agile/issue-41";
  const segmentA = "b".repeat(40);
  const pushed = "e".repeat(40);
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: taskBranch,
      commitSha: segmentA,
    };
    trustChainSegment(record, segmentA);
  });
  // Mutable successor approval cannot turn the shared root back into a standalone PR.
  chain.comments = [];
  const commands: string[][] = [];
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "OPEN",
                  baseRefName: "main",
                  headRefName: taskBranch,
                  headRefOid: pushed,
                  mergeCommit: null,
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
  });
  const { tasks } = await store.list();
  await run.claimNext(tasks, new AbortController().signal);
  const record = (await store.get(41)).execution;
  expect(record).toMatchObject({
    phase: "awaiting_merge",
    baseBranch: "main",
    publication: { branch: taskBranch, commitSha: segmentA },
  });
  expect(commands).not.toContainEqual([
    "gh",
    "pr",
    "merge",
    "7",
    "--repo",
    "acme/test",
    "--squash",
    "--delete-branch=false",
  ]);
});

test("a chained ticket rejects a duplicate predecessor dependency in plan validation", () => {
  const first = manifest.tasks[0];
  if (!first) throw Error("Missing task fixture");
  const conflicting = TicketSpecSchema.safeParse({
    ...first.spec,
    dependencies: ["T1"],
    continues: { task: "T1" },
  });
  expect(conflicting.success).toBe(true);
  if (!conflicting.success) throw Error("Expected schema fixture to parse");
  expect(() =>
    validateTaskGraph({
      ...manifest,
      tasks: [first, { ...first, id: "T2", spec: conflicting.data }],
    }),
  ).toThrow("duplicates its continuation predecessor");
  expect(
    TicketSpecSchema.safeParse({ ...first.spec, continues: { task: "T1" } })
      .success,
  ).toBe(true);
});

test("a merged PR pushed forward by its fully reviewed chain successor still credits the predecessor ticket", async () => {
  const { remote, store, chain } = chainFixture({ task: "T1" });
  const taskBranch = "agile/issue-41";
  const segmentA = "b".repeat(40);
  const pushed = "e".repeat(40);
  const merged = "c".repeat(40);
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: taskBranch,
      commitSha: segmentA,
    };
    trustChainSegment(record, segmentA);
  });
  await seedChainTicket(store, chain, taskBranch, segmentA, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: taskBranch,
      commitSha: pushed,
    };
    trustChainSegment(record, pushed);
  });
  const diagnostics: string[] = [];
  const commands: string[][] = [];
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "MERGED",
                  baseRefName: "main",
                  headRefName: taskBranch,
                  headRefOid: pushed,
                  mergeCommit: { oid: merged },
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
    diagnostic: (message) => diagnostics.push(message),
  });
  expect(await run.runOnce(new AbortController().signal)).toBe(false);
  expect((await store.get(41)).execution).toMatchObject({
    phase: "done",
    baseBranch: "main",
    publication: {
      number: 7,
      branch: taskBranch,
      commitSha: segmentA,
      mergeCommit: merged,
    },
  });
  expect((await store.get(41)).execution?.failure).toBeUndefined();
  expect(remote.issue.state).toBe("CLOSED");
  expect(remote.closures).toEqual([41, 42]);
  expect(diagnostics.join()).not.toContain("Issue #41");
  expect(commands).toContainEqual([
    "git",
    "merge-base",
    "--is-ancestor",
    segmentA,
    merged,
  ]);
});

test("a predecessor ticket stays quietly awaiting while its chain successor keeps the PR open with new commits", async () => {
  const { remote, store } = chainFixture({ task: "T1" });
  const taskBranch = "agile/issue-41";
  const segmentA = "b".repeat(40);
  const pushed = "e".repeat(40);
  await seed(remote, (record) => {
    record.phase = "awaiting_merge";
    record.publication = {
      number: 7,
      branch: taskBranch,
      commitSha: segmentA,
    };
    trustChainSegment(record, segmentA);
  });
  const diagnostics: string[] = [];
  const commands: string[][] = [];
  const run = new GitHubTaskRunner({
    store,
    branches,
    advisor: createModelAdvisor([]),
    harness: {
      async step() {
        throw Error("Unexpected agent work");
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
      async run({ command }) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout:
            command[0] === "gh"
              ? JSON.stringify({
                  number: 7,
                  state: "OPEN",
                  baseRefName: "main",
                  headRefName: taskBranch,
                  headRefOid: pushed,
                  mergeCommit: null,
                })
              : "",
        };
      },
    },
    cwd: "/fixture",
    baseBranch: "main",
    diagnostic: (message) => diagnostics.push(message),
  });
  const { tasks } = await store.list();
  await run.claimNext(tasks, new AbortController().signal);
  const record = (await store.get(41)).execution;
  expect(record).toMatchObject({
    phase: "awaiting_merge",
    baseBranch: "main",
  });
  expect(record?.failure).toBeUndefined();
  expect(remote.issue.state).toBe("OPEN");
  expect(diagnostics).toEqual([]);
  expect(commands).not.toContainEqual([
    "git",
    "merge-base",
    "--is-ancestor",
    segmentA,
    pushed,
  ]);
});

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
