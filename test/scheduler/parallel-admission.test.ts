import { expect, test } from "bun:test";
import { canRunTogether } from "../../src/scheduler/parallel-admission";
import { memoryGitHub } from "../helpers/github-native";

test("parallel admission accepts disjoint paths and serializes overlaps, ambiguous scopes and hooks", async () => {
  const task = await memoryGitHub().store().get(41);
  const left = structuredClone(task);
  const right = structuredClone(task);
  right.task.id = "issue-42";
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
