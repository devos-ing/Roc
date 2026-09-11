import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubRemoteIssueReader } from "../../src/github/issue-reader";
import { BunGitHubCommandRunner } from "../../src/github/pr-publisher";
import { GitHubRateLimitRunner } from "../../src/github/rate-limit";
import { barrier } from "../helpers/github-plan";

test("gh transport preserves paginated JSON while extracting response rate-limit headers", async () => {
  const temp = await mkdtemp(join(tmpdir(), "roc-gh-headers-"));
  const oldPath = process.env.PATH;
  const payload = [
    [{ body: "HTTP/2.0 403 Fake\nX-Ratelimit-Remaining: 0\n\n" }],
    [],
  ];
  const first =
    "HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 1\nX-Ratelimit-Reset: 2000000000\n\n";
  const last =
    "HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 2000000000\n\n";
  try {
    const gh = join(temp, "gh");
    await writeFile(
      gh,
      `#!/bin/sh\ncase " $* " in *" --include "*) ;; *) exit 9;; esac\ncat <<'BODY'\n[${first}${JSON.stringify(payload[0])},${last}${JSON.stringify(payload[1])}]\nBODY\n`,
    );
    await chmod(gh, 0o755);
    process.env.PATH = `${temp}:${oldPath ?? ""}`;
    const runner = new BunGitHubCommandRunner();
    const result = await runner.run({
      command: [
        "gh",
        "api",
        "--paginate",
        "--slurp",
        "repos/acme/test/issues/1/comments",
      ],
      cwd: temp,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(payload);
    expect(result).toMatchObject({
      httpStatus: 200,
      rateLimit: { remaining: 0, resetAt: 2_000_000_000_000 },
    });
    await writeFile(
      gh,
      "#!/bin/sh\ncat <<'BODY'\nHTTP/2.0 429 Too Many Requests\nRetry-After: 17\n\n{\"message\":\"secondary rate limit\"}\nBODY\necho 'gh: secondary rate limit (HTTP 429)' >&2\nexit 1\n",
    );
    expect(
      await runner.run({ command: ["gh", "api", "user"], cwd: temp }),
    ).toMatchObject({
      exitCode: 1,
      httpStatus: 429,
      rateLimit: { retryAfterMs: 17_000 },
    });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(temp, { recursive: true, force: true });
  }
});

test("a rate-limited Issue read waits for reset and returns its original result", async () => {
  let now = 1_000_000;
  let reads = 0;
  const waits: number[] = [];
  const notices: number[] = [];
  const runner = new GitHubRateLimitRunner(
    {
      async run() {
        reads++;
        return reads === 1
          ? {
              exitCode: 1,
              stdout: "",
              stderr: "API rate limit exceeded for user private-id (HTTP 403)",
              rateLimit: { remaining: 0, resetAt: 1_060_000 },
            }
          : { exitCode: 0, stdout: "[]", stderr: "" };
      },
    },
    {
      signal: new AbortController().signal,
      now: () => now,
      async wait(milliseconds) {
        waits.push(milliseconds);
        now += milliseconds;
      },
      onWait: (until) => notices.push(until),
    },
  );
  const reader = new GitHubRemoteIssueReader("/fixture", runner);
  expect(await reader.read("acme/test")).toEqual([]);
  expect(reads).toBe(2);
  expect(waits).toEqual([60_000]);
  expect(notices).toEqual([1_060_000]);
});

test("parallel reads share the Retry-After pause and git remains available", async () => {
  let now = 1_000_000;
  const entered = barrier();
  const release = barrier();
  const commands: string[][] = [];
  const waits: number[] = [];
  const runner = new GitHubRateLimitRunner(
    {
      async run({ command }) {
        commands.push(command);
        return commands.length === 1
          ? {
              exitCode: 1,
              stdout: "",
              stderr: "secondary rate limit (HTTP 429)",
              rateLimit: {
                retryAfterMs: 2_000,
                remaining: 0,
                resetAt: 2_000_000,
              },
            }
          : { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    {
      signal: new AbortController().signal,
      now: () => now,
      async wait(milliseconds) {
        waits.push(milliseconds);
        entered.release();
        await release.promise;
        now += milliseconds;
      },
    },
  );
  const first = runner.run({
    command: ["gh", "issue", "view", "1"],
    cwd: "/fixture",
  });
  await entered.promise;
  const second = runner.run({
    command: ["gh", "issue", "view", "2"],
    cwd: "/fixture",
  });
  await runner.run({ command: ["git", "status"], cwd: "/fixture" });
  expect(commands).toEqual([
    ["gh", "issue", "view", "1"],
    ["git", "status"],
  ]);
  expect(waits).toEqual([2_000]);
  release.release();
  expect((await Promise.all([first, second])).map((r) => r.exitCode)).toEqual([
    0, 0,
  ]);
  expect(commands).toHaveLength(4);
});

test("secondary limits back off when the quota endpoint supplies no exhausted window", async () => {
  let now = 1_000_000;
  let reads = 0;
  const waits: number[] = [];
  const runner = new GitHubRateLimitRunner(
    {
      async run({ command }) {
        if (command.includes("rate_limit"))
          return {
            exitCode: 0,
            stdout: '{"resources":{"core":{"remaining":100}}}',
            stderr: "",
          };
        reads++;
        return reads < 3
          ? {
              exitCode: 1,
              stdout: "",
              stderr: "secondary rate limit (HTTP 403)",
            }
          : { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    {
      signal: new AbortController().signal,
      now: () => now,
      async wait(milliseconds) {
        waits.push(milliseconds);
        now += milliseconds;
      },
    },
  );
  expect(
    (await runner.run({ command: ["gh", "issue", "list"], cwd: "/fixture" }))
      .exitCode,
  ).toBe(0);
  expect(waits).toEqual([60_000, 120_000]);
  expect(reads).toBe(3);
});

test("permission failures and uncertain mutations are never automatically replayed", async () => {
  for (const write of [false, true]) {
    let calls = 0;
    const result = {
      exitCode: 1,
      stdout: "private output",
      stderr: write
        ? "API rate limit exceeded (HTTP 403)"
        : "Resource not accessible (HTTP 403)",
      ...(write
        ? { rateLimit: { remaining: 0, resetAt: Date.now() + 60_000 } }
        : {}),
    };
    const runner = new GitHubRateLimitRunner(
      {
        async run() {
          calls++;
          return result;
        },
      },
      { signal: new AbortController().signal },
    );
    expect(
      await runner.run({
        command: write
          ? [
              "gh",
              "api",
              "repos/acme/test/issues",
              "--method",
              "POST",
              "--input",
              "/body",
            ]
          : ["gh", "issue", "list"],
        cwd: "/fixture",
      }),
    ).toBe(result);
    expect(calls).toBe(1);
  }
});

test("cancellation interrupts a rate-limit wait without sending another request", async () => {
  const stop = new AbortController();
  const waiting = barrier();
  let calls = 0;
  const runner = new GitHubRateLimitRunner(
    {
      async run() {
        calls++;
        return {
          exitCode: 1,
          stdout: "",
          stderr: "API rate limit exceeded (HTTP 403)",
          rateLimit: { remaining: 0, resetAt: Date.now() + 60_000 },
        };
      },
    },
    { signal: stop.signal, onWait: () => waiting.release() },
  );
  const result = runner.run({
    command: ["gh", "issue", "list"],
    cwd: "/fixture",
  });
  const outcome = result.catch((error: unknown) => error);
  await waiting.promise;
  stop.abort();
  expect(await outcome).toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
});

test("healthy GitHub cleanup remains available after admission is cancelled", async () => {
  const stop = new AbortController();
  let calls = 0;
  const runner = new GitHubRateLimitRunner(
    {
      async run() {
        calls++;
        return { exitCode: 0, stdout: "checkpoint", stderr: "" };
      },
    },
    { signal: stop.signal },
  );
  stop.abort();
  expect(
    (
      await runner.run({
        command: ["gh", "api", "repos/acme/test/issues/1/comments"],
        cwd: "/fixture",
      })
    ).stdout,
  ).toBe("checkpoint");
  expect(calls).toBe(1);
});

test("GraphQL's already-exceeded diagnostic waits for its exhausted quota window", async () => {
  let now = 1_000_000;
  let reads = 0;
  const waits: number[] = [];
  const runner = new GitHubRateLimitRunner(
    {
      async run({ command }) {
        if (command.includes("rate_limit"))
          return {
            exitCode: 0,
            stdout: '{"resources":{"graphql":{"remaining":0,"reset":1060}}}',
            stderr: "",
          };
        reads++;
        return reads === 1
          ? {
              exitCode: 1,
              stdout: "",
              stderr:
                "GraphQL: API rate limit already exceeded for user ID private-id.",
            }
          : { exitCode: 0, stdout: "[]", stderr: "" };
      },
    },
    {
      signal: new AbortController().signal,
      now: () => now,
      async wait(ms) {
        waits.push(ms);
        now += ms;
      },
    },
  );
  expect(
    await new GitHubRemoteIssueReader("/fixture", runner).read("acme/test"),
  ).toEqual([]);
  expect(waits).toEqual([60_000]);
  expect(reads).toBe(2);
});
