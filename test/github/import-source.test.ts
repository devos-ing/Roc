import { expect, test } from "bun:test";
import {
  type GhCommandRunner,
  parseApprovedIssueBody,
  readApprovedGitHubIssueCandidates,
  readApprovedGitHubIssues,
} from "../../src/github/import-source";

const body = `## Problem

A problem.

## Desired outcome

An outcome.

## Scope

- import Issues

## Non-goals

- None

## Acceptance criteria

- imports all pages

## Validation

- bun test`;

/** Creates a deterministic gh command runner from responses in invocation order. */
function runner(
  responses: Array<{ stdout?: string; stderr?: string; exitCode?: number }>,
  commands?: string[][],
): GhCommandRunner {
  let index = 0;
  return async (args) => {
    commands?.push(args);
    return { exitCode: 0, stdout: "", stderr: "", ...responses[index++] };
  };
}

test("parses the strict approved Issue template", () => {
  expect(parseApprovedIssueBody(42, body)).toEqual({
    problem: "A problem.",
    desiredOutcome: "An outcome.",
    scope: ["import Issues"],
    nonGoals: [],
    acceptanceCriteria: ["imports all pages"],
    validation: ["bun test"],
  });
  expect(() =>
    parseApprovedIssueBody(42, body.replace("## Validation", "## Extra")),
  ).toThrow("Issue #42");
});

test("reads all ready Issue pages while excluding pull requests", async () => {
  const issue = (number: number, extra = {}) => ({
    number,
    title: `Issue ${number}`,
    body,
    state: "open",
    labels: [{ name: "roc:ready" }],
    ...extra,
  });
  const commands: string[][] = [];
  const candidates = await readApprovedGitHubIssueCandidates({
    run: runner(
      [
        {
          stdout: JSON.stringify({
            nameWithOwner: "owner/repository",
            url: "https://github.com/owner/repository",
          }),
        },
        {},
        {
          stdout: JSON.stringify([
            [issue(1), issue(2, { pull_request: {} })],
            [issue(3, { labels: [] }), issue(4, { body: null })],
          ]),
        },
      ],
      commands,
    ),
  });

  expect(candidates.map((issue) => issue.number)).toEqual([1, 4]);
  expect(candidates[1]).toEqual({
    number: 4,
    title: "Issue 4",
    body: null,
    url: "https://github.com/owner/repository/issues/4",
  });
  expect(commands).toEqual([
    ["repo", "view", "--json", "nameWithOwner,url"],
    ["auth", "status", "--active", "--hostname", "github.com"],
    [
      "api",
      "--hostname",
      "github.com",
      "--paginate",
      "--slurp",
      "repos/owner/repository/issues?state=open&labels=roc%3Aready&per_page=100",
    ],
  ]);
});

test("reports installation and authentication prerequisites", async () => {
  const missing = async (): Promise<never> => {
    const error = new Error("missing");
    Object.assign(error, { code: "ENOENT" });
    throw error;
  };
  const missingStderr: string[] = [];
  await expect(
    readApprovedGitHubIssues({
      run: missing,
      platform: "darwin",
      stderr: (line) => missingStderr.push(line),
    }),
  ).rejects.toThrow("brew install gh");
  expect(missingStderr).toEqual([expect.stringContaining("brew install gh")]);

  const authStderr: string[] = [];
  await expect(
    readApprovedGitHubIssues({
      run: runner([
        {
          stdout: JSON.stringify({
            nameWithOwner: "owner/repository",
            url: "https://github.com/owner/repository",
          }),
        },
        { exitCode: 1 },
      ]),
      stderr: (line) => authStderr.push(line),
    }),
  ).rejects.toThrow("gh auth login");
  expect(authStderr).toEqual([expect.stringContaining("gh auth login")]);
});
