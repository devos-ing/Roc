import { expect, test } from "bun:test";
import {
  initialExecution,
  renderExecution,
} from "../../src/github/execution-store";
import {
  parseRemoteTaskEnvelope,
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";
import { manifest, memoryGitHub } from "../helpers/github-native";
import { memoryPlan } from "../helpers/github-plan";

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
