import { expect, test } from "bun:test";
import { GitHubRemoteIssueReader } from "../../src/github/issue-reader";
import { AgileError } from "../../src/runtime/errors";

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
    expect(String(error)).not.toContain("secret-token");
    expect(String(error)).not.toContain("private response");
  }
});
