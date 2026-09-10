import { expect, test } from "bun:test";
import {
  BunGitHubCommandRunner,
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
    async refresh() {
      throw Error("Unexpected base refresh");
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

test("create and edit bodies reference only canonical managed Issue IDs without closing keywords", async () => {
  for (const id of [
    "issue-41",
    "T1",
    "issue-01",
    "issue-0",
    "issue-41-extra",
  ]) {
    for (const existing of [true, false]) {
      const commands: string[][] = [];
      const pr = {
        number: 8,
        url: "https://example.test/pull/8",
        state: "OPEN",
        headRepositoryOwner: { login: "acme" },
      };
      const publisher = new GitHubPullRequestPublisher(
        "main",
        branches([]),
        runner(commands, [
          { stdout: JSON.stringify({ nameWithOwner: "acme/test" }) },
          { stdout: JSON.stringify(existing ? [pr] : []) },
          {},
          { stdout: "https://example.test/pull/8" },
          ...(!existing ? [{ stdout: JSON.stringify([pr]) }] : []),
        ]),
      );
      await publisher.publish({ ...input, task: { ...task, id } });
      const command = commands.find((item) => item.includes("--body"))!;
      const body = command[command.indexOf("--body") + 1]!;
      expect(body.includes("Related issue: #41")).toBe(id === "issue-41");
      if (id !== "issue-41") expect(body).not.toContain("Related issue:");
      expect(body).not.toMatch(/\b(closes|fixes|resolves)\b/i);
    }
  }
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

test("renders only complete current Review evidence as checked acceptance rows", async () => {
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
            headRepositoryOwner: { login: "agile-agents" },
          },
        ]),
      },
      {},
      {},
    ]),
  );
  await publisher.publish({
    ...input,
    acceptance: {
      review: {
        kind: "review",
        decision: "accepted",
        findings: [],
        remainingGaps: [],
        acceptanceResults: [
          {
            criterionIndex: 0,
            status: "passed",
            evidence: "bun test\npassed on the reviewed head",
          },
        ],
      },
      binding: {
        currentSpecHash: "sha256:current",
        reviewedSpecHash: "sha256:current",
        currentHeadSha: input.publication.commitSha,
        reviewedHeadSha: input.publication.commitSha,
        currentBaseSha: input.task.baseCommit,
        reviewedBaseSha: input.task.baseCommit,
      },
    },
  });
  const body = commands.at(-1)![commands.at(-1)!.indexOf("--body") + 1]!;
  expect(body).toContain("## Acceptance checklist");
  expect(body).toContain("- [x] one PR");
  expect(body).toContain("Automated Review evidence");
  expect(body).toContain("human acceptance is separate");
  expect(body).toContain("passed on the reviewed head");
});

test("does not render stale Review evidence as a checked pull-request row", async () => {
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
  await publisher.publish({
    ...input,
    acceptance: {
      review: {
        kind: "review",
        decision: "accepted",
        findings: [],
        remainingGaps: [],
        acceptanceResults: [
          { criterionIndex: 0, status: "passed", evidence: "old head" },
        ],
      },
      binding: {
        currentSpecHash: "sha256:current",
        reviewedSpecHash: "sha256:current",
        currentHeadSha: input.publication.commitSha,
        reviewedHeadSha: "c".repeat(40),
        currentBaseSha: input.task.baseCommit,
        reviewedBaseSha: input.task.baseCommit,
      },
    },
  });
  const body = commands.at(-2)![commands.at(-2)!.indexOf("--body") + 1]!;
  expect(body).toContain("- [ ] one PR");
  expect(body).toContain("No item-level evidence recorded.");
  expect(body).not.toContain("- [x] one PR");
});

test("does not relabel a self-consistent old Review binding as the publication head", async () => {
  const commands: string[][] = [];
  const oldHead = "c".repeat(40);
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
  await publisher.publish({
    ...input,
    acceptance: {
      review: {
        kind: "review",
        decision: "accepted",
        findings: [],
        remainingGaps: [],
        acceptanceResults: [
          { criterionIndex: 0, status: "passed", evidence: "old head" },
        ],
      },
      binding: {
        currentSpecHash: "sha256:current",
        reviewedSpecHash: "sha256:current",
        currentHeadSha: oldHead,
        reviewedHeadSha: oldHead,
        currentBaseSha: input.task.baseCommit,
        reviewedBaseSha: input.task.baseCommit,
      },
    },
  });
  const body = commands.at(-2)?.at(-1);
  expect(body).toContain("- [ ] one PR");
  expect(body).not.toContain("- [x] one PR");
});

test("does not let rejected or mismatched Review evidence replace the retained Implement commit", async () => {
  const refreshedCommit = "c".repeat(40);
  const publication = { ...input.publication, commitSha: refreshedCommit };
  const publisher = new GitHubPullRequestPublisher(
    "main",
    branches([]),
    runner([], []),
  );
  await expect(
    publisher.publish({
      ...input,
      publication,
      acceptance: {
        review: {
          kind: "review",
          decision: "rejected",
          findings: ["criterion failed"],
          remainingGaps: ["repair needed"],
        },
        binding: {
          currentSpecHash: "sha256:current",
          reviewedSpecHash: "sha256:current",
          currentHeadSha: refreshedCommit,
          reviewedHeadSha: refreshedCommit,
          currentBaseSha: input.task.baseCommit,
          reviewedBaseSha: input.task.baseCommit,
        },
      },
    }),
  ).rejects.toThrow(
    "Publication state does not match the current task implementation",
  );
  await expect(
    publisher.publish({
      ...input,
      publication,
      acceptance: {
        review: {
          kind: "review",
          decision: "accepted",
          findings: [],
          remainingGaps: [],
        },
        binding: {
          currentSpecHash: "sha256:current",
          reviewedSpecHash: "sha256:current",
          currentHeadSha: refreshedCommit,
          reviewedHeadSha: input.publication.commitSha,
          currentBaseSha: input.task.baseCommit,
          reviewedBaseSha: input.task.baseCommit,
        },
      },
    }),
  ).rejects.toThrow(
    "Publication state does not match the current task implementation",
  );
});

test("reconciles a refreshed checklist only when the remote PR already has the reviewed head", async () => {
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
            headRepositoryOwner: { login: "agile-agents" },
            headRefOid: input.publication.commitSha,
          },
        ]),
      },
      {},
    ]),
  );
  await publisher.publish({ ...input, reconcileOnly: true });
  expect(commands.flat()).not.toContain("push");
  expect(commands.at(-1)).toEqual(
    expect.arrayContaining(["gh", "pr", "edit", "8"]),
  );
});

test("preserves a changed remote head when checklist reconciliation is stale", async () => {
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
            headRepositoryOwner: { login: "agile-agents" },
            headRefOid: "c".repeat(40),
          },
        ]),
      },
    ]),
  );
  await expect(
    publisher.publish({ ...input, reconcileOnly: true }),
  ).rejects.toThrow("Pull request head does not match the reviewed task head");
  expect(commands.flat()).not.toContain("push");
  expect(commands.flat()).not.toContain("edit");
});

test("uses the refreshed publication head and base for body-only branch validation", async () => {
  const refreshedCommit = "c".repeat(40);
  const refreshedBase = "d".repeat(40);
  const calls: string[][] = [];
  const reviewReady: string[][] = [];
  const publisher = new GitHubPullRequestPublisher(
    "main",
    {
      ...branches([]),
      async prepare(taskId, baseCommit) {
        return {
          taskId,
          path: "/repo",
          branch: "agile/T1",
          baseCommit: baseCommit ?? refreshedBase,
        };
      },
      async assertReviewReady(taskId, head, baseCommit) {
        reviewReady.push([taskId, head, baseCommit ?? ""]);
      },
    },
    runner(calls, [
      { stdout: JSON.stringify({ nameWithOwner: "agile-agents/roc" }) },
      {
        stdout: JSON.stringify([
          {
            number: 8,
            url: "https://example.test/pull/8",
            state: "OPEN",
            headRepositoryOwner: { login: "agile-agents" },
            headRefOid: refreshedCommit,
          },
        ]),
      },
      {},
    ]),
  );
  await publisher.publish({
    ...input,
    task: { ...input.task, baseCommit: refreshedBase },
    publication: { ...input.publication, commitSha: refreshedCommit },
    reconcileOnly: true,
  });
  expect(reviewReady).toEqual([["T1", refreshedCommit, refreshedBase]]);
  expect(calls.flat()).not.toContain("push");
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
  expect(commands[1]?.at(-1)).toBe(
    "number,url,state,headRepositoryOwner,headRefOid",
  );
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

test("force-kills a GitHub command that exceeds its wall-clock bound", async () => {
  const result = await new BunGitHubCommandRunner(10).run({
    command: [process.execPath, "-e", "await Bun.sleep(10000)"],
    cwd: process.cwd(),
  });
  expect(result).toMatchObject({ exitCode: 124 });
  expect(result.stderr).toContain("command timed out");
});

test("repository preflight retries one timed-out read and stops safely after a second timeout", async () => {
  for (const recover of [true, false]) {
    let reads = 0;
    const preflight = new GitHubCliPreflight("/repo", "main", {
      async run({ command }) {
        if (command[1] === "auth")
          return { exitCode: 0, stdout: "", stderr: "" };
        expect(command).toEqual([
          "gh",
          "repo",
          "view",
          "--json",
          "nameWithOwner",
        ]);
        reads++;
        return recover && reads === 2
          ? { exitCode: 0, stdout: "{}", stderr: "" }
          : {
              exitCode: 124,
              stdout: "private response",
              stderr: "private token",
            };
      },
    });
    if (recover) await expect(preflight.assertReady()).resolves.toBeUndefined();
    else {
      const error = await preflight
        .assertReady()
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
      expect(String(error)).not.toContain("private");
    }
    expect(reads).toBe(2);
  }
});
