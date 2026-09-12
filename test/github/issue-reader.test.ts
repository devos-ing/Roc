import { expect, test } from "bun:test";
import { GitHubRemoteIssueReader } from "../../src/github/issue-reader";
import { AgileError } from "../../src/runtime/errors";
import { graphqlResponse } from "../helpers/graphql-github";

test("completed closure reconciles lost responses and preserves human-closed reasons", async () => {
  for (const mode of ["success", "lost", "denied", "closed"]) {
    let state = mode === "closed" ? "CLOSED" : "OPEN";
    const commands: string[][] = [];
    const reader = new GitHubRemoteIssueReader("/fixture", {
      async run({ command }) {
        commands.push(command);
        if (command[2] === "close") {
          if (mode !== "denied") state = "CLOSED";
          return {
            exitCode: mode === "success" ? 0 : 1,
            stdout: "",
            stderr: "secret HTTP 403",
          };
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            graphqlResponse(
              [
                {
                  number: 41,
                  title: "Task",
                  body: "",
                  url: "https://example.test/41",
                  labels: [],
                  comments: [],
                  state: state as "OPEN" | "CLOSED",
                },
              ],
              command,
            ),
          ),
        };
      },
    });
    if (mode === "denied") {
      const error = await reader
        .closeCompleted("acme/test", 41)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: "GITHUB_ISSUE_CLOSE_PENDING",
        retryable: true,
      });
      expect(String(error)).not.toContain("secret");
    } else await reader.closeCompleted("acme/test", 41);
    const closes = commands.filter((command) => command[2] === "close");
    expect(closes).toEqual(
      mode === "closed"
        ? []
        : [
            [
              "gh",
              "issue",
              "close",
              "41",
              "--repo",
              "acme/test",
              "--reason",
              "completed",
            ],
          ],
    );
  }
});

test("GitHub failures distinguish reads and uncertain writes without exposing CLI secrets", async () => {
  const reader = new GitHubRemoteIssueReader("/fixture", {
    async run() {
      return {
        exitCode: 1,
        stdout: "private response",
        stderr: "Authorization: secret-token (HTTP 403)",
      };
    },
  });
  for (const [operation, code] of [
    [() => reader.repository(), "GITHUB_READ_FAILED"],
    [
      () => reader.writeComment("acme/repo", 1, "checkpoint"),
      "GITHUB_WRITE_FAILED",
    ],
  ] as const) {
    const error = await operation().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AgileError);
    expect(error).toMatchObject({ code, retryable: false });
    expect(String(error)).toContain("HTTP 403");
    expect(String(error)).toContain(
      code === "GITHUB_READ_FAILED" ? "repository lookup" : "comment write",
    );
    expect(String(error)).not.toContain("secret-token");
    expect(String(error)).not.toContain("private response");
  }
});

test("GitHub read failures retain safe timeout, exit, and runner classifications", async () => {
  for (const [result, expected] of [
    [
      {
        exitCode: 124,
        stdout: "private response",
        stderr: "command timed out",
      },
      "repository lookup; timeout",
    ],
    [
      { exitCode: 9, stdout: "private response", stderr: "untrusted output" },
      "repository lookup; exit 9",
    ],
  ] as const) {
    const reader = new GitHubRemoteIssueReader("/fixture", {
      /** Returns a controlled failed command result for diagnostic classification. */
      async run() {
        return result;
      },
    });

    await expect(reader.repository()).rejects.toMatchObject({
      code: "GITHUB_READ_FAILED",
      message: expect.stringContaining(expected),
      retryable: true,
    });
  }

  const reader = new GitHubRemoteIssueReader("/fixture", {
    /** Simulates a runner start failure without exposing its details. */
    async run() {
      throw new Error("private runner failure");
    },
  });

  const error = await reader.repository().catch((error: unknown) => error);
  expect(error).toMatchObject({
    code: "GITHUB_READ_FAILED",
    message: expect.stringContaining(
      "repository lookup; runner or process-start failure",
    ),
    retryable: true,
  });
  expect(String(error)).not.toContain("private runner failure");
});
