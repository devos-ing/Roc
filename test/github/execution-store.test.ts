import { expect, test } from "bun:test";
import { initialExecution } from "../../src/github/execution-store";
import { memoryGitHub } from "../helpers/github-native";

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
