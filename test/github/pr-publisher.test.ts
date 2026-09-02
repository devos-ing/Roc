import { expect, test } from "bun:test";
import {
  GitHubCliPreflight,
  type GitHubCommandRunner,
  GitHubPublicationError,
  GitHubPullRequestPublisher,
} from "../../src/github/pr-publisher";
import type { TaskBranchManager } from "../../src/workspace/task-branch";

const task = {
  id: "T1",
  cycleId: "2026-W35",
  title: "Publish one pull request",
  spec: {
    problem: "No pull request",
    desiredOutcome: "One pull request",
    scope: ["publication"],
    nonGoals: [],
    acceptanceCriteria: ["one PR"],
    validation: ["bun test"],
    dependencies: [],
    risk: "medium" as const,
    contextCandidates: [],
    tokenCeiling: 1,
  },
  status: "publishing" as const,
  priority: 0,
  approvalRequired: false,
  approved: true,
  baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const input = {
  task,
  implementation: {
    kind: "implement" as const,
    commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    validation: ["bun test"],
    risks: [],
    limitations: [],
  },
  publication: {
    taskId: "T1",
    branch: "agile/T1",
    baseBranch: "main",
    commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    status: "pending" as const,
  },
};

function branches(calls: string[]): TaskBranchManager {
  return {
    async prepare() {
      calls.push("prepare");
      return {
        taskId: "T1",
        path: "/repo",
        branch: "agile/T1",
        baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      };
    },
    async assertReviewReady() {
      calls.push("assertReviewReady");
    },
    async commitChanges() {
      throw new Error("not used");
    },
    async restoreChanges() {
      throw new Error("not used");
    },
    async assertCommit() {
      throw new Error("not used");
    },
    async status() {
      throw new Error("not used");
    },
  };
}

function runner(
  calls: string[][],
  results: Array<{ stdout?: string; stderr?: string; exitCode?: number }>,
): GitHubCommandRunner {
  return {
    async run(command) {
      calls.push(command.command);
      const result = results.shift();
      if (result === undefined) throw new Error("Unexpected command");
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
  };
}

test("reconciles an existing merged pull request without a push", async () => {
  const commands: string[][] = [];
  const branchCalls: string[] = [];
  const publisher = new GitHubPullRequestPublisher(
    "main",
    branches(branchCalls),
    runner(commands, [
      {
        stdout: JSON.stringify({ nameWithOwner: "agile-agents/roc" }),
      },
      {
        stdout: JSON.stringify([
          {
            number: 8,
            url: "https://example.test/pull/8",
            state: "MERGED",
            headRepositoryOwner: { login: "agile-agents" },
          },
        ]),
      },
    ]),
  );

  await expect(publisher.publish(input)).resolves.toMatchObject({
    number: 8,
    state: "MERGED",
  });
  expect(branchCalls).toEqual(["prepare", "assertReviewReady"]);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(
    expect.arrayContaining(["gh", "pr", "list", "--state", "all"]),
  );
});

test("updates an open pull request instead of creating a second one", async () => {
  const commands: string[][] = [];
  const publisher = new GitHubPullRequestPublisher(
    "main",
    branches([]),
    runner(commands, [
      {
        stdout: JSON.stringify({ nameWithOwner: "agile-agents/roc" }),
      },
      {
        stdout: JSON.stringify([
          {
            number: 8,
            url: "https://example.test/pull/8",
            state: "OPEN",
            headRepositoryOwner: { login: "agile-agents" },
          },
        ]),
      },
      {},
      {},
    ]),
  );

  await publisher.publish(input);
  expect(commands).toHaveLength(4);
  expect(commands[2]).toEqual(["git", "push", "origin", "agile/T1"]);
  expect(commands[3]).toEqual([
    "gh",
    "pr",
    "edit",
    "8",
    "--title",
    task.title,
    "--body",
    expect.stringContaining("## Validation"),
  ]);
  expect(commands.flat()).not.toContain("create");
});

test("pushes and creates one pull request when none exists", async () => {
  const commands: string[][] = [];
  const publisher = new GitHubPullRequestPublisher(
    "main",
    branches([]),
    runner(commands, [
      { stdout: JSON.stringify({ nameWithOwner: "agile-agents/roc" }) },
      { stdout: "[]" },
      {},
      { stdout: "https://example.test/pull/9" },
      {
        stdout: JSON.stringify([
          {
            number: 9,
            url: "https://example.test/pull/9",
            state: "OPEN",
            headRepositoryOwner: { login: "agile-agents" },
          },
        ]),
      },
    ]),
  );

  await expect(publisher.publish(input)).resolves.toMatchObject({
    number: 9,
    state: "OPEN",
  });
  expect(commands[2]).toEqual(["git", "push", "origin", "agile/T1"]);
  expect(commands[3]).toEqual(
    expect.arrayContaining(["gh", "pr", "create", "--base", "main"]),
  );
});

test("fails before push when a matching pull request closed without merging", async () => {
  const commands: string[][] = [];
  const publisher = new GitHubPullRequestPublisher(
    "main",
    branches([]),
    runner(commands, [
      { stdout: JSON.stringify({ nameWithOwner: "agile-agents/roc" }) },
      {
        stdout: JSON.stringify([
          {
            number: 8,
            url: "https://example.test/pull/8",
            state: "CLOSED",
            headRepositoryOwner: { login: "agile-agents" },
          },
        ]),
      },
    ]),
  );

  await expect(publisher.publish(input)).rejects.toBeInstanceOf(
    GitHubPublicationError,
  );
  expect(commands).toHaveLength(2);
});

test("ignores a fork pull request with the same task branch", async () => {
  const commands: string[][] = [];
  const publisher = new GitHubPullRequestPublisher(
    "main",
    branches([]),
    runner(commands, [
      { stdout: JSON.stringify({ nameWithOwner: "agile-agents/roc" }) },
      {
        stdout: JSON.stringify([
          {
            number: 8,
            url: "https://example.test/pull/8",
            state: "OPEN",
            headRepositoryOwner: { login: "fork-owner" },
          },
        ]),
      },
      {},
      { stdout: "https://example.test/pull/9" },
      {
        stdout: JSON.stringify([
          {
            number: 9,
            url: "https://example.test/pull/9",
            state: "OPEN",
            headRepositoryOwner: { login: "agile-agents" },
          },
        ]),
      },
    ]),
  );

  await expect(publisher.publish(input)).resolves.toMatchObject({ number: 9 });
  expect(commands[1]?.at(-1)).toBe("number,url,state,headRepositoryOwner");
  expect(commands[3]).toEqual(expect.arrayContaining(["gh", "pr", "create"]));
});

test("uses the durable base branch when publication resumes after reconfiguration", async () => {
  const commands: string[][] = [];
  const publisher = new GitHubPullRequestPublisher(
    "main",
    branches([]),
    runner(commands, [
      { stdout: JSON.stringify({ nameWithOwner: "agile-agents/roc" }) },
      {
        stdout: JSON.stringify([
          {
            number: 8,
            url: "https://example.test/pull/8",
            state: "MERGED",
            headRepositoryOwner: { login: "agile-agents" },
          },
        ]),
      },
    ]),
  );

  await expect(
    publisher.publish({
      ...input,
      publication: { ...input.publication, baseBranch: "release/2026-W35" },
    }),
  ).resolves.toMatchObject({ number: 8, state: "MERGED" });
  expect(commands[1]).toEqual(
    expect.arrayContaining(["--base", "release/2026-W35"]),
  );
  expect(commands.flat()).not.toContain("push");
});

test("preflight requires explicit base branch and GitHub access", async () => {
  const commands: string[][] = [];
  const ready = new GitHubCliPreflight(
    "/repo",
    "main",
    runner(commands, [{}, {}]),
  );

  await expect(ready.assertReady()).resolves.toBeUndefined();
  expect(commands).toEqual([
    ["gh", "auth", "status"],
    ["gh", "repo", "view", "--json", "nameWithOwner"],
  ]);
  await expect(
    new GitHubCliPreflight("/repo", "HEAD", runner([], [])).assertReady(),
  ).rejects.toBeInstanceOf(GitHubPublicationError);
});
