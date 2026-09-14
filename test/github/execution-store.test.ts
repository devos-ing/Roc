import { expect, test } from "bun:test";
import {
  ExecutionRecordSchema,
  initialExecution,
  type NativeTask,
  renderExecution,
} from "../../src/github/execution-store";
import {
  jsonHash,
  parseRemoteTaskEnvelope,
  type RemoteTaskEnvelope,
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";
import { manifest, memoryGitHub } from "../helpers/github-native";
import { memoryPlan } from "../helpers/github-plan";

/** Republishes a complete approved revision of one in-memory plan, keeping earlier approvals and checkpoints. */
function republishPlan(
  remote: ReturnType<typeof memoryPlan>,
  revise: (tasks: RemoteTaskEnvelope["task"][]) => RemoteTaskEnvelope["task"][],
): void {
  const published = remote.issues.map((issue) =>
    parseRemoteTaskEnvelope(issue.body),
  );
  const first = published[0];
  if (!first) throw Error("Missing published plan");
  const plan = {
    cycleId: first.cycleId,
    goal: first.goal,
    tasks: revise(published.map((envelope) => envelope.task)),
  };
  for (const issue of remote.issues) {
    const envelope = remoteTaskEnvelope(
      plan,
      parseRemoteTaskEnvelope(issue.body).task.id,
    );
    issue.body = renderRemoteTaskBody(envelope);
    issue.comments.push({
      databaseId:
        Math.max(...issue.comments.map((comment) => comment.databaseId)) + 1,
      author: { login: "owner" },
      body: renderRemoteTaskApproval(envelope),
    });
  }
}

/** Builds the finished checkpoint a member publishes before a later plan revision. */
function doneExecution(task: NativeTask, issueNumber: number) {
  return ExecutionRecordSchema.parse({
    ...initialExecution(task, "main", "a".repeat(40)),
    phase: "done",
    publication: {
      number: 7,
      branch: `agile/issue-${issueNumber}`,
      commitSha: "b".repeat(40),
      mergeCommit: "c".repeat(40),
    },
  });
}

test("closure requires unchanged approved confirmed done evidence and preserves its checkpoint", async () => {
  for (const fault of [
    "none",
    "approval",
    "stale",
    "wrong-issue",
    "plan",
    "denied",
    "closed",
  ]) {
    const remote = memoryGitHub();
    const store = remote.store();
    const task = await store.get(41);
    const record = initialExecution(task, "release", "a".repeat(40));
    record.phase = "done";
    record.publication = {
      number: 7,
      branch: "agile/issue-41",
      commitSha: "b".repeat(40),
      mergeCommit: "c".repeat(40),
    };
    remote.issue.comments.push({
      databaseId: 2,
      author: { login: "daemon" },
      body: renderExecution(record),
    });
    const expected = await store.get(41);
    if (fault === "approval") remote.issue.comments.shift();
    if (fault === "stale") expected.execution!.revision++;
    if (fault === "wrong-issue") expected.issue.number = 42;
    if (fault === "plan") remote.api.read = async () => [];
    if (fault === "denied") remote.denyClosure(true);
    if (fault === "closed") {
      remote.issue.state = "CLOSED";
      remote.issue.stateReason = "NOT_PLANNED";
    }
    const before = structuredClone(remote.issue.comments);
    if (["none", "closed"].includes(fault))
      await store.closeCompleted(expected);
    else await expect(store.closeCompleted(expected)).rejects.toThrow();
    expect(remote.issue.comments).toEqual(before);
    expect(remote.issue.state).toBe(
      ["none", "closed"].includes(fault) ? "CLOSED" : "OPEN",
    );
    if (fault === "closed")
      expect(remote.issue.stateReason).toBe("NOT_PLANNED");
  }
});

test("a lost checkpoint response is reconciled and a fresh store reads the same remote state", async () => {
  const fake = memoryGitHub();
  const store = fake.store();
  const task = (await store.list()).tasks[0];
  if (!task) throw Error("Missing task");
  const record = initialExecution(task, "main", "a".repeat(40));
  fake.loseNextResponse();
  await store.save(task, record);
  expect(fake.issue.comments).toHaveLength(2);
  expect((await fake.store().get(41)).execution).toEqual(record);
  await store.save(await store.get(41), record);
  expect(fake.issue.comments).toHaveLength(2);
});

test("withdrawn approval blocks a previously admitted task and human checkpoint impostors are ignored", async () => {
  const fake = memoryGitHub();
  const store = fake.store();
  const task = (await store.list()).tasks[0];
  if (!task) throw Error("Missing task");
  await store.save(task, initialExecution(task, "main", "a".repeat(40)));
  fake.issue.comments.push({
    ...fake.issue.comments[1]!,
    databaseId: 9,
    author: { login: "untrusted" },
  });
  expect((await store.get(41)).approved).toBe(true);
  fake.issue.comments = fake.issue.comments.filter(
    (comment) => comment.databaseId !== 1,
  );
  expect((await store.get(41)).approved).toBe(false);
});

test("authority confirmation does not authorize cached state when a direct read fails", async () => {
  const remote = memoryGitHub();
  const store = remote.store();
  const task = (await store.list()).tasks[0];
  if (!task) throw Error("Missing approved task");
  const before = structuredClone(remote.issue);
  remote.api.get = async () => {
    throw Error("private credential detail");
  };
  await expect(store.confirmCancellation(task, task)).resolves.toBeUndefined();
  await expect(store.confirmCancellation(task)).rejects.toMatchObject({
    code: "GITHUB_AUTHORITY_UNCONFIRMED",
    taskId: "issue-41",
    message: expect.stringContaining("authority confirmation failed"),
  });
  expect(remote.issue).toEqual(before);
});

test("supersede rewrites same-plan dependents onto the replacement and re-approves the plan", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"], ["d.ts"]], {
    T2: ["T1"],
  });
  const store = remote.store;
  const dead = await store.get(41);
  const rejected = initialExecution(dead, "main", "a".repeat(40));
  rejected.phase = "rejected";
  remote.issues[0]!.comments.push({
    databaseId: 50,
    author: { login: "daemon" },
    body: renderExecution(rejected),
  });
  remote.commentAuthor = "owner";
  const result = await store.supersede(41, 44);
  expect(result.dependentIssues).toEqual([42]);
  expect(result.rewrittenIssues).toEqual([41, 42, 43, 44]);
  const view = await store.list();
  for (const item of view.tasks) {
    expect(item.envelope.planId).toBe(result.planId);
    if (item.issue.number === 41) continue;
    expect(item.approved).toBe(true);
    expect(item.blockedReason).toBeUndefined();
  }
  const dependent = view.tasks.find((item) => item.issue.number === 42);
  if (!dependent) throw Error("Missing dependent task");
  expect(dependent.envelope.task.spec.dependencies).toEqual(["T4"]);
  expect(dependent.task.status).toBe("ready");
  expect(
    parseRemoteTaskEnvelope(remote.issues[1]!.body).task.spec.dependencies,
  ).toEqual(["T4"]);
  expect(
    remote.issues[1]!.comments.some(
      (comment) =>
        comment.body.includes("Supersede:") &&
        comment.body.includes("T4 (Issue #44)"),
    ),
  ).toBe(true);
});

test("supersede refuses cross-plan replacements without writing", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"]], { T2: ["T1"] });
  const foreign = remoteTaskEnvelope(
    {
      ...manifest,
      cycleId: "2026-W40",
      goal: "A different plan goal",
      tasks: [manifest.tasks[0]!],
    },
    "T1",
  );
  remote.issues.push({
    number: 61,
    title: foreign.task.title,
    body: renderRemoteTaskBody(foreign),
    url: "https://github.com/acme/test/issues/61",
    state: "OPEN",
    labels: [{ name: "roc:task" }, { name: "roc:ready" }],
    comments: [
      {
        databaseId: 61,
        author: { login: "owner" },
        body: renderRemoteTaskApproval(foreign),
      },
    ],
  });
  const before = structuredClone(remote.issues);
  await expect(remote.store.supersede(41, 61)).rejects.toThrow(
    /belong to different plans/,
  );
  expect(remote.issues).toEqual(before);
});

test("supersede refuses a terminal replacement without writing", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], {
    T2: ["T1"],
  });
  const store = remote.store;
  const replacement = await store.get(43);
  const rejected = initialExecution(replacement, "main", "a".repeat(40));
  rejected.phase = "rejected";
  remote.issues[2]!.comments.push({
    databaseId: 60,
    author: { login: "daemon" },
    body: renderExecution(rejected),
  });
  const before = structuredClone(remote.issues);
  await expect(store.supersede(41, 43)).rejects.toThrow(/already terminal/);
  expect(remote.issues).toEqual(before);
});

test("supersede refuses a rewrite that would create a dependency cycle", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], {
    T2: ["T1"],
    T3: ["T2"],
  });
  const before = structuredClone(remote.issues);
  await expect(remote.store.supersede(41, 43)).rejects.toThrow(
    /cyclic or incomplete/,
  );
  expect(remote.issues).toEqual(before);
});

test("supersede migrates member checkpoints so done evidence survives and closed members stay done", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"], ["d.ts"]], {
    T2: ["T1"],
  });
  const store = remote.store;
  remote.commentAuthor = "owner";
  const dead = await store.get(41);
  const rejected = initialExecution(dead, "main", "a".repeat(40));
  rejected.phase = "rejected";
  remote.issues[0]!.comments.push({
    databaseId: 50,
    author: { login: "daemon" },
    body: renderExecution(rejected),
  });
  const at = (seconds: number) =>
    new Date(Date.parse("2026-09-09T00:00:00Z") + seconds * 1000).toISOString();
  const finished = await store.get(43);
  const done = ExecutionRecordSchema.parse({
    ...initialExecution(finished, "main", "a".repeat(40)),
    phase: "done",
    updatedAt: at(35),
    timeline: [
      { phase: "claimed", at: at(0) },
      { phase: "done", at: at(35) },
    ],
    attempts: [
      {
        descriptor: {
          attemptId: "real-attempt",
          taskId: "issue-43",
          role: "implement",
          retryIndex: 0,
          modelProfile: "terra",
          model: "test/model",
          effort: "high",
        },
        status: "succeeded",
        startedAt: at(5),
        endedAt: at(20),
        sequence: 1,
        events: {},
        usage: {
          inputTokens: 10,
          cachedInputTokens: 4,
          outputTokens: 2,
          reasoningOutputTokens: 1,
        },
        usageKnown: false,
      },
    ],
    publication: {
      number: 7,
      branch: "agile/issue-43",
      commitSha: "b".repeat(40),
      mergeCommit: "c".repeat(40),
    },
  });
  remote.issues[2]!.comments.push({
    databaseId: 60,
    author: { login: "daemon" },
    body: renderExecution(done),
  });
  remote.issues[2]!.state = "CLOSED";
  remote.issues[2]!.stateReason = "COMPLETED";

  const result = await store.supersede(41, 44);
  expect(result.dependentIssues).toEqual([42]);
  const view = await store.list();
  const finishedTask = view.tasks.find((item) => item.issue.number === 43);
  const deadTask = view.tasks.find((item) => item.issue.number === 41);
  const dependent = view.tasks.find((item) => item.issue.number === 42);
  if (!finishedTask?.execution || !deadTask?.execution || !dependent)
    throw Error("Missing superseded plan members");
  expect(remote.issues[2]!.state).toBe("CLOSED");
  expect(finishedTask.task.status).toBe("done");
  expect(finishedTask.blockedReason).toBeUndefined();
  expect(finishedTask.execution.specHash).toBe(jsonHash(finishedTask.envelope));
  expect(finishedTask.execution.phase).toBe("done");
  expect(finishedTask.execution.revision).toBe(done.revision);
  expect(finishedTask.execution.attempts).toEqual(done.attempts);
  expect(finishedTask.execution.publication).toEqual(done.publication);
  expect(deadTask.execution.phase).toBe("rejected");
  expect(deadTask.execution.specHash).toBe(jsonHash(deadTask.envelope));
  expect(dependent.envelope.task.spec.dependencies).toEqual(["T4"]);
});

test("supersede resumes a partially migrated plan instead of refusing the mixed state", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"], ["d.ts"]], {
    T2: ["T1"],
  });
  const store = remote.store;
  remote.commentAuthor = "owner";
  const originalEditBody = remote.api.editBody;
  let failing = true;
  remote.api.editBody = async (repo: string, number: number, body: string) => {
    if (failing && number === 42) throw Error("injected network failure");
    return originalEditBody(repo, number, body);
  };
  await expect(store.supersede(41, 44)).rejects.toMatchObject({
    code: "GITHUB_SUPERSEDE_UNCONFIRMED",
  });
  expect((await store.get(41)).envelope.planId).not.toBe(
    (await store.get(43)).envelope.planId,
  );
  failing = false;
  const result = await store.supersede(41, 44);
  const view = await store.list();
  expect(view.tasks).toHaveLength(4);
  for (const item of view.tasks) {
    expect(item.envelope.planId).toBe(result.planId);
    expect(item.approved).toBe(true);
    expect(item.blockedReason).toBeUndefined();
  }
  const dependent = view.tasks.find((item) => item.issue.number === 42);
  if (!dependent) throw Error("Missing dependent task");
  expect(dependent.envelope.task.spec.dependencies).toEqual(["T4"]);
});

test("supersede refuses a replacement whose checkpoint carries terminal evidence", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], { T2: ["T1"] });
  const store = remote.store;
  remote.commentAuthor = "owner";
  const dead = await store.get(41);
  const rejected = initialExecution(dead, "main", "a".repeat(40));
  rejected.phase = "rejected";
  // The migrated checkpoint keeps its terminal phase, so the rejection
  // evidence survives the plan rewrite and still blocks a reverse supersede.
  remote.issues[0]!.comments.push({
    databaseId: 50,
    author: { login: "daemon" },
    body: renderExecution(rejected),
  });
  await store.supersede(41, 43);
  const before = structuredClone(remote.issues);
  await expect(store.supersede(43, 41)).rejects.toThrow(
    /already terminal.*execution phase rejected/s,
  );
  expect(remote.issues).toEqual(before);
});

test("supersede re-anchors mergeReview bindings when migrating awaiting_merge evidence", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], { T2: ["T1"] });
  const store = remote.store;
  remote.commentAuthor = "owner";
  const dead = await store.get(41);
  const rejected = initialExecution(dead, "main", "a".repeat(40));
  rejected.phase = "rejected";
  remote.issues[0]!.comments.push({
    databaseId: 50,
    author: { login: "daemon" },
    body: renderExecution(rejected),
  });
  const dependent = await store.get(42);
  const merging = ExecutionRecordSchema.parse({
    ...initialExecution(dependent, "main", "a".repeat(40)),
    phase: "awaiting_merge",
    publication: {
      number: 7,
      branch: "agile/issue-42",
      commitSha: "b".repeat(40),
    },
    // mergeReview.specHash binds to the pre-supersede envelope exactly like
    // the top-level specHash does at creation time in the runner.
    mergeReview: {
      specHash: jsonHash(dependent.envelope),
      headSha: "b".repeat(40),
      baseSha: "a".repeat(40),
      reviewAttemptId: "review-1",
    },
  });
  remote.issues[1]!.comments.push({
    databaseId: 51,
    author: { login: "daemon" },
    body: renderExecution(merging),
  });
  const result = await store.supersede(41, 43);
  expect(result.rewrittenIssues).toEqual([41, 42, 43]);
  const view = await store.list();
  const migrated = view.tasks.find((item) => item.issue.number === 42);
  if (!migrated?.execution) throw Error("Missing dependent task");
  expect(migrated.execution.specHash).toBe(jsonHash(migrated.envelope));
  // The binding pointer follows the top-level hash; every other mergeReview
  // field survives verbatim so the awaiting_merge member stays mergeable.
  expect(migrated.execution.mergeReview).toEqual({
    specHash: jsonHash(migrated.envelope),
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    reviewAttemptId: "review-1",
  });
  expect(migrated.execution.phase).toBe("awaiting_merge");
  expect(migrated.task.status).toBe("awaiting_merge");
  expect(migrated.blockedReason).toBeUndefined();
  const deadTask = view.tasks.find((item) => item.issue.number === 41);
  if (!deadTask?.execution) throw Error("Missing superseded task");
  expect(deadTask.execution.specHash).toBe(jsonHash(deadTask.envelope));
  expect(deadTask.execution.mergeReview).toBeUndefined();
});

test("supersede re-sends an approval lost mid-attempt so a retry converges instead of deadlocking", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], { T2: ["T1"] });
  const store = remote.store;
  remote.commentAuthor = "owner";
  const dead = await store.get(41);
  const rejected = initialExecution(dead, "main", "a".repeat(40));
  rejected.phase = "rejected";
  remote.issues[0]!.comments.push({
    databaseId: 50,
    author: { login: "daemon" },
    body: renderExecution(rejected),
  });
  const originalWriteComment = remote.api.writeComment;
  let failing = true;
  remote.api.writeComment = async (
    repo: string,
    number: number,
    body: string,
    id?: number,
  ) => {
    if (failing && id === undefined && body.includes("roc:approval"))
      throw Error("injected approval failure");
    return originalWriteComment(repo, number, body, id);
  };
  await expect(store.supersede(41, 43)).rejects.toMatchObject({
    code: "GITHUB_SUPERSEDE_UNCONFIRMED",
  });
  failing = false;
  const result = await store.supersede(41, 43);
  const view = await store.list();
  expect(view.tasks).toHaveLength(3);
  for (const item of view.tasks) {
    expect(item.envelope.planId).toBe(result.planId);
    expect(item.approved).toBe(true);
    expect(item.blockedReason).toBeUndefined();
  }
  const migrated = view.tasks.find((item) => item.issue.number === 41);
  if (!migrated?.execution) throw Error("Missing superseded task");
  expect(migrated.execution.specHash).toBe(jsonHash(migrated.envelope));
  expect(migrated.execution.phase).toBe("rejected");
});

test("supersede finishes an interrupted checkpoint migration so a retry truly completes", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], { T2: ["T1"] });
  const store = remote.store;
  remote.commentAuthor = "owner";
  const dependent = await store.get(42);
  const rejected = initialExecution(dependent, "main", "a".repeat(40));
  rejected.phase = "rejected";
  remote.issues[1]!.comments.push({
    databaseId: 51,
    author: { login: "daemon" },
    body: renderExecution(rejected),
  });
  const originalWriteComment = remote.api.writeComment;
  let failing = true;
  remote.api.writeComment = async (
    repo: string,
    number: number,
    body: string,
    id?: number,
  ) => {
    if (failing && id !== undefined) throw Error("injected checkpoint failure");
    return originalWriteComment(repo, number, body, id);
  };
  await expect(store.supersede(41, 43)).rejects.toMatchObject({
    code: "GITHUB_SUPERSEDE_UNCONFIRMED",
  });
  // The dependent's body and approval were already rewritten; without the
  // precheck the retry would skip its stale checkpoint and report fake success.
  failing = false;
  const result = await store.supersede(41, 43);
  const view = await store.list();
  expect(view.tasks).toHaveLength(3);
  for (const item of view.tasks) {
    expect(item.envelope.planId).toBe(result.planId);
    expect(item.approved).toBe(true);
    expect(item.blockedReason).toBeUndefined();
  }
  const migrated = view.tasks.find((item) => item.issue.number === 42);
  if (!migrated?.execution) throw Error("Missing dependent task");
  expect(migrated.execution.specHash).toBe(jsonHash(migrated.envelope));
  expect(migrated.execution.phase).toBe("rejected");
});

test("supersede refuses a checkpoint matching no known specification before any write", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], { T2: ["T1"] });
  const store = remote.store;
  const dependent = await store.get(42);
  const stale = initialExecution(dependent, "main", "a".repeat(40));
  stale.phase = "rejected";
  // A checkpoint left unanchored by an earlier plan change matches neither
  // the current nor the target specification, so the whole supersede refuses.
  stale.specHash = `sha256:${"f".repeat(64)}`;
  remote.issues[1]!.comments.push({
    databaseId: 51,
    author: { login: "daemon" },
    body: renderExecution(stale),
  });
  const before = structuredClone(remote.issues);
  await expect(store.supersede(41, 43)).rejects.toThrow(
    /Issue #42 has a checkpoint .* reconcile the stale checkpoint/s,
  );
  expect(remote.issues).toEqual(before);
});

test("supersede resumes a retry whose anchors were both rewritten before the interruption", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"], ["d.ts"]], {
    T3: ["T1"],
  });
  const store = remote.store;
  remote.commentAuthor = "owner";
  const originalEditBody = remote.api.editBody;
  let failing = true;
  remote.api.editBody = async (repo: string, number: number, body: string) => {
    if (failing && number === 44) throw Error("injected network failure");
    return originalEditBody(repo, number, body);
  };
  await expect(store.supersede(41, 42)).rejects.toMatchObject({
    code: "GITHUB_SUPERSEDE_UNCONFIRMED",
  });
  // Issues 41-43 were already rewritten, so both anchors sit on the new plan
  // id while Issue 44 lags; the retry must still recognize the partial plan.
  failing = false;
  const result = await store.supersede(41, 42);
  const view = await store.list();
  expect(view.tasks).toHaveLength(4);
  for (const item of view.tasks) {
    expect(item.envelope.planId).toBe(result.planId);
    expect(item.approved).toBe(true);
    expect(item.blockedReason).toBeUndefined();
  }
  const dependent = view.tasks.find((item) => item.issue.number === 43);
  if (!dependent) throw Error("Missing dependent task");
  expect(dependent.envelope.task.spec.dependencies).toEqual(["T2"]);
});

test("supersede keeps a finished member stale when an approved revision changed its requirement", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"], ["d.ts"]]);
  const store = remote.store;
  remote.commentAuthor = "owner";
  remote.issues[2]!.comments.push({
    databaseId: 60,
    author: { login: "daemon" },
    body: renderExecution(doneExecution(await store.get(43), 43)),
  });
  remote.issues[2]!.state = "CLOSED";
  remote.issues[2]!.stateReason = "COMPLETED";
  // A complete approved revision changes T3's scope while its earlier approvals
  // and its finished checkpoint stay on the Issue, so that checkpoint is bound
  // to a specification this supersede never replaced.
  republishPlan(remote, (tasks) =>
    tasks.map((task) =>
      task.id === "T3"
        ? { ...task, spec: { ...task.spec, scope: ["entirely-new.ts"] } }
        : task,
    ),
  );
  const before = structuredClone(remote.issues);
  await expect(store.supersede(41, 42)).rejects.toThrow(
    /reconcile the stale checkpoint/,
  );
  const view = await store.list();
  const member = view.tasks.find((item) => item.issue.number === 43);
  if (!member) throw Error("Missing revised member");
  // The unrelated revision is not this supersede's provenance: the checkpoint
  // stays stale, so the member stays retired instead of returning to done.
  expect(member.blockedReason).toBe(
    "Approved specification changed; execution requires replan",
  );
  expect(member.task.status).toBe("retired");
  expect(remote.issues).toEqual(before);
});

test("supersede keeps a dependent needing replan instead of resurrecting its done evidence", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], { T2: ["T1"] });
  const store = remote.store;
  remote.commentAuthor = "owner";
  await store.supersede(41, 43);
  remote.issues[1]!.comments.push({
    databaseId: 80,
    author: { login: "daemon" },
    body: renderExecution(doneExecution(await store.get(42), 42)),
  });
  // A complete approved revision changes the dependent's requirement, so its
  // finished checkpoint no longer authorizes the Issue it was written for.
  republishPlan(remote, (tasks) =>
    tasks.map((task) =>
      task.id === "T2"
        ? { ...task, spec: { ...task.spec, desiredOutcome: "Return 99" } }
        : task,
    ),
  );
  const stale = (await store.list()).tasks.find(
    (item) => item.issue.number === 42,
  );
  if (!stale) throw Error("Missing revised dependent");
  expect(stale.task.status).toBe("needs_replan");
  const before = structuredClone(remote.issues);
  // Replaying the supersede must not rebind the stale checkpoint onto the
  // revised plan, and must not close the Issue it no longer describes.
  await expect(store.supersede(41, 43)).rejects.toThrow(
    /reconcile the stale checkpoint/,
  );
  expect(remote.issues).toEqual(before);
  const view = await store.list();
  const dependent = view.tasks.find((item) => item.issue.number === 42);
  if (!dependent) throw Error("Missing dependent task");
  expect(dependent.blockedReason).toBe(
    "Approved specification changed; execution requires replan",
  );
  expect(dependent.task.status).toBe("needs_replan");
  await expect(store.closeCompleted(dependent)).rejects.toThrow(
    /closure authority changed/,
  );
  expect(remote.issues[1]!.state).toBe("OPEN");
});

test("supersede refuses to launder merge review evidence already invalid against its own checkpoint", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], { T2: ["T1"] });
  const store = remote.store;
  remote.commentAuthor = "owner";
  const dead = await store.get(41);
  const rejected = initialExecution(dead, "main", "a".repeat(40));
  rejected.phase = "rejected";
  remote.issues[0]!.comments.push({
    databaseId: 50,
    author: { login: "daemon" },
    body: renderExecution(rejected),
  });
  const dependent = await store.get(42);
  const merging = ExecutionRecordSchema.parse({
    ...initialExecution(dependent, "main", "a".repeat(40)),
    phase: "awaiting_merge",
    publication: {
      number: 7,
      branch: "agile/issue-42",
      commitSha: "b".repeat(40),
    },
    // The binding pointer was broken before this supersede: repairing it while
    // re-anchoring the plan would resurrect merge evidence that must stay refused.
    mergeReview: {
      specHash: `sha256:${"0".repeat(64)}`,
      headSha: "b".repeat(40),
      baseSha: "a".repeat(40),
      reviewAttemptId: "review-1",
    },
  });
  remote.issues[1]!.comments.push({
    databaseId: 51,
    author: { login: "daemon" },
    body: renderExecution(merging),
  });
  const before = structuredClone(remote.issues);
  await expect(store.supersede(41, 43)).rejects.toThrow(
    /merge review evidence/,
  );
  expect(remote.issues).toEqual(before);
});

test("supersede rereads a checkpoint advanced mid-attempt and never overwrites its newer evidence", async () => {
  /** Runs one supersede whose replacement checkpoint the daemon advances during the first body rewrite. */
  async function supersedeAdvancing(
    advance: (planned: ReturnType<typeof initialExecution>) => unknown,
  ) {
    const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], { T2: ["T1"] });
    const store = remote.store;
    remote.commentAuthor = "owner";
    const planned = initialExecution(
      await store.get(43),
      "main",
      "a".repeat(40),
    );
    planned.phase = "implementing";
    remote.issues[2]!.comments.push({
      databaseId: 60,
      author: { login: "daemon" },
      body: renderExecution(planned),
    });
    const originalWriteComment = remote.api.writeComment;
    const checkpoints: string[] = [];
    let advanced = false;
    remote.api.writeComment = async (
      repo: string,
      number: number,
      body: string,
      id?: number,
    ) => {
      if (id !== undefined && number === 43) checkpoints.push(body);
      if (!advanced && number === 41 && id === undefined) {
        advanced = true;
        const comment = remote.issues[2]!.comments.find(
          (item) => item.databaseId === 60,
        );
        if (!comment) throw Error("Missing replacement checkpoint");
        comment.body = renderExecution(
          ExecutionRecordSchema.parse(advance(planned)),
        );
      }
      return originalWriteComment(repo, number, body, id);
    };
    const outcome = await store.supersede(41, 43).then(
      () => undefined,
      (error: unknown) => error,
    );
    return { remote, store, checkpoints, outcome };
  }

  const running = await supersedeAdvancing((planned) => ({
    ...planned,
    revision: planned.revision + 1,
    phase: "rejected",
    failure: "Injected concurrent rejection",
  }));
  expect(running.outcome).toBeUndefined();
  const rejected = (await running.store.list()).tasks.find(
    (item) => item.issue.number === 43,
  );
  if (!rejected?.execution) throw Error("Missing replacement task");
  // The newer revision keeps its phase and failure evidence; only the binding moves.
  expect(rejected.execution.revision).toBe(1);
  expect(rejected.execution.phase).toBe("rejected");
  expect(rejected.execution.failure).toBe("Injected concurrent rejection");
  expect(rejected.execution.specHash).toBe(jsonHash(rejected.envelope));
  expect(rejected.blockedReason).toBeUndefined();
  expect(
    running.checkpoints.some((body) => body.includes('"implementing"')),
  ).toBe(false);

  // A checkpoint that moved to an unrelated specification is refused instead of
  // being overwritten, and never surfaces as a retryable interrupted attempt.
  const foreign = await supersedeAdvancing((planned) => ({
    ...planned,
    revision: planned.revision + 1,
    phase: "rejected",
    specHash: `sha256:${"9".repeat(64)}`,
  }));
  expect(foreign.outcome).toBeInstanceOf(Error);
  expect((foreign.outcome as { code?: string }).code).toBeUndefined();
  expect(String(foreign.outcome)).toMatch(
    /Supersede refused:.*different specification/s,
  );
  expect(
    foreign.remote.issues[2]!.comments.find(
      (comment) => comment.databaseId === 60,
    )?.body,
  ).toContain("9".repeat(64));
});

test("supersede resumes a migration interrupted after every body was rewritten", async () => {
  const remote = memoryPlan([["a.ts"], ["b.ts"], ["c.ts"]], { T2: ["T1"] });
  const store = remote.store;
  remote.commentAuthor = "owner";
  const implementing = initialExecution(
    await store.get(43),
    "main",
    "a".repeat(40),
  );
  implementing.phase = "implementing";
  remote.issues[2]!.comments.push({
    databaseId: 60,
    author: { login: "daemon" },
    body: renderExecution(implementing),
  });
  const originalWriteComment = remote.api.writeComment;
  let failing = true;
  remote.api.writeComment = async (
    repo: string,
    number: number,
    body: string,
    id?: number,
  ) => {
    if (failing && id !== undefined) throw Error("injected checkpoint failure");
    return originalWriteComment(repo, number, body, id);
  };
  await expect(store.supersede(41, 43)).rejects.toMatchObject({
    code: "GITHUB_SUPERSEDE_UNCONFIRMED",
  });
  // Every body already carries the rewritten plan, so the replaced specification
  // is only recognizable by reversing this supersede's dependency repoint.
  const interrupted = await store.list();
  expect(
    new Set(interrupted.tasks.map((item) => item.envelope.planId)).size,
  ).toBe(1);
  failing = false;
  const result = await store.supersede(41, 43);
  const view = await store.list();
  expect(view.tasks).toHaveLength(3);
  for (const item of view.tasks) {
    expect(item.envelope.planId).toBe(result.planId);
    expect(item.approved).toBe(true);
    expect(item.blockedReason).toBeUndefined();
  }
  const migrated = view.tasks.find((item) => item.issue.number === 43);
  if (!migrated?.execution) throw Error("Missing replacement task");
  expect(migrated.execution.specHash).toBe(jsonHash(migrated.envelope));
  expect(migrated.execution.phase).toBe("implementing");
});
