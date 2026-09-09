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

test("bounded comment reads preserve ordering and drain failed batches before returning", async () => {
  for (const fail of [false, true]) {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const reader = new GitHubRemoteIssueReader("/fixture", {
      async run({ command }) {
        if (command[1] === "issue")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              Array.from({ length: 8 }, (_, index) => ({
                number: index + 1,
                title: "Task",
                body: "",
                url: `https://github.com/acme/repo/issues/${index + 1}`,
                state: "OPEN",
                labels: [],
              })),
            ),
          };
        calls++;
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(10);
        active--;
        const failed =
          fail && command.some((arg) => arg.includes("/issues/1/"));
        return {
          exitCode: failed ? 1 : 0,
          stdout: "[[]]",
          stderr: failed ? "HTTP 503" : "",
        };
      },
    });
    if (fail)
      await expect(reader.read("acme/repo")).rejects.toMatchObject({
        code: "GITHUB_READ_FAILED",
      });
    else
      expect(
        (await reader.read("acme/repo")).map((issue) => issue.number),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(calls).toBe(fail ? 4 : 8);
  }
});
