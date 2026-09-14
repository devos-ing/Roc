import { expect, test } from "bun:test";
import { canRunTogether } from "../../src/scheduler/parallel-admission";
import { memoryGitHub } from "../helpers/github-native";

test("parallel admission accepts disjoint paths and serializes overlaps, ambiguous scopes and hooks", async () => {
  const task = await memoryGitHub().store().get(41);
  const left = structuredClone(task);
  const right = structuredClone(task);
  right.task.id = "issue-42";
  right.envelope.task.id = "T2";
  left.task.spec.scope = ["src/auth/"];
  right.task.spec.scope = ["src/billing.ts"];
  expect(canRunTogether(left, right)).toBe(true);
  for (const scope of [
    ["SRC/Auth/login.ts"],
    ["src"],
    ["."],
    ["src/**"],
    ["fix authentication"],
    ["../outside.ts"],
    ["TCP port 3000"],
    ["/absolute/file.ts"],
  ]) {
    right.task.spec.scope = scope;
    expect(canRunTogether(left, right), scope.join(",")).toBe(false);
  }
  right.task.spec.scope = ["src/authentication.ts"];
  expect(canRunTogether(left, right)).toBe(true);
  right.task.spec.prehook = { command: "setup", args: [], timeoutSeconds: 1 };
  expect(canRunTogether(left, right)).toBe(false);
  expect(canRunTogether(left, left)).toBe(false);
});

test("parallel admission serializes sibling successors of one chain predecessor", async () => {
  const task = await memoryGitHub().store().get(41);
  const left = structuredClone(task);
  const right = structuredClone(task);
  right.task.id = "issue-42";
  left.task.spec.scope = ["src/auth/"];
  right.task.spec.scope = ["src/billing.ts"];
  left.task.spec.continues = { issue: 41 };
  right.task.spec.continues = { issue: 41 };
  // Disjoint paths do not matter: both siblings would share the predecessor worktree.
  expect(canRunTogether(left, right)).toBe(false);
  right.task.spec.continues = { issue: 40 };
  // Legacy references cannot establish a trusted workspace identity and stay serialized.
  expect(canRunTogether(left, right)).toBe(false);
  delete left.task.spec.continues;
  delete right.task.spec.continues;
  right.envelope.task.id = "T2";
  expect(canRunTogether(left, right)).toBe(true);
});

test("parallel admission serializes every member of a shared continuation chain", async () => {
  const task = await memoryGitHub().store().get(41);
  const first = structuredClone(task);
  const second = structuredClone(task);
  const third = structuredClone(task);
  first.task.id = "A";
  second.task.id = "B";
  third.task.id = "C";
  first.envelope.task.id = "A";
  second.envelope.task.id = "B";
  third.envelope.task.id = "C";
  first.task.spec.scope = ["src/a.ts"];
  second.task.spec.scope = ["src/b.ts"];
  third.task.spec.scope = ["src/c.ts"];
  second.task.spec.continues = { task: "A" };
  third.task.spec.continues = { task: "B" };
  expect(canRunTogether(first, second, [first, second, third])).toBe(false);
  expect(canRunTogether(first, third, [first, second, third])).toBe(false);
  expect(canRunTogether(second, third, [first, second, third])).toBe(false);
});
