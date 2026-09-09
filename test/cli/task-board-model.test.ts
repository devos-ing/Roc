import { expect, test } from "bun:test";
import { buildTaskBoardSnapshot } from "../../src/cli/task-board-model";
import { initialExecution } from "../../src/github/execution-store";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { memoryGitHub } from "../helpers/github-native";

test("an empty remote source produces an empty board without local storage", () => {
  const snapshot = githubTaskSnapshot([]);
  const board = buildTaskBoardSnapshot({
    ...snapshot,
    currentCycleId: "2026-W37",
    remoteCheckpoints: true,
  });
  expect(board.tasks).toEqual([]);
  expect(board.remoteCheckpoints).toBe(true);
});

test("the GitHub board keeps awaiting-merge work in progress and uses Issue identities", async () => {
  const fake = memoryGitHub();
  const task = await fake.store().get(41);
  task.execution = initialExecution(task, "main", "a".repeat(40));
  task.execution.phase = "awaiting_merge";
  task.task.status = "awaiting_merge";
  const snapshot = githubTaskSnapshot([task]);
  const board = buildTaskBoardSnapshot({
    ...snapshot,
    currentCycleId: "2026-W37",
  });
  expect(board.columns.inProgress.map((item) => item.id)).toEqual(["issue-41"]);
  expect(board.columns.done).toEqual([]);
  expect(board.tasks[0]?.rawStatus).toBe("awaiting_merge");
});
