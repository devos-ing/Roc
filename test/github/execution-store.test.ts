import { expect, test } from "bun:test";
import {
  initialExecution,
  renderExecution,
} from "../../src/github/execution-store";
import { memoryGitHub } from "../helpers/github-native";

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
