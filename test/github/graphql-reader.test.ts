import { expect, test } from "bun:test";
import {
  initialExecution,
  renderExecution,
} from "../../src/github/execution-store";
import { GitHubRemoteIssueReader } from "../../src/github/issue-reader";
import { GitHubRateLimitRunner } from "../../src/github/rate-limit";
import { canonicalDigest } from "../../tools/github-read-proof";
import { barrier, memoryPlan } from "../helpers/github-plan";
import { protocolGitHub } from "../helpers/graphql-github";

test("production read/get/getMany preserve 26 Issues, independent overflow and authority at comments 102/103", async () => {
  const source = memoryPlan(Array.from({ length: 26 }, (_, i) => [`src/${i}`]));
  const first = source.issues[0]!;
  const seed = (await source.store.list()).tasks[0]!;
  const checkpoint = initialExecution(seed, "main", "a".repeat(40));
  for (const issue of source.issues.slice(0, 2)) {
    const approval = issue.comments[0]!;
    issue.comments = Array.from({ length: 101 }, (_, i) => ({
      databaseId: issue.number * 1000 + i,
      body: `human ${i}`,
      author: i === 0 ? null : { login: "human" },
    }));
    issue.comments.push(approval);
    issue.labels.push(
      ...Array.from({ length: 99 }, (_, i) => ({ name: `label-${i}` })),
    );
  }
  first.comments.push({
    databaseId: 999999,
    author: { login: "daemon" },
    body: renderExecution(checkpoint),
  });
  const remote = protocolGitHub(source.issues);
  const expected = canonicalDigest(source.issues);
  expect(canonicalDigest(await remote.reader.read("acme/test"))).toBe(expected);
  expect(
    canonicalDigest(
      await remote.reader.getMany(
        "acme/test",
        source.issues.map((issue) => issue.number),
      ),
    ),
  ).toBe(expected);
  expect(await remote.reader.get("acme/test", 41)).toEqual(first);
  const task = (await remote.store().list()).tasks.find(
    (task) => task.issue.number === 41,
  )!;
  expect(task.approved).toBe(true);
  expect(task.execution).toEqual(checkpoint);
  expect(task.commentId).toBe(999999);
  expect(task.issue.comments[0]!.author).toBeNull();
  expect(
    remote.commands.every(
      (args) => args.slice(0, 3).join(" ") === "gh api graphql",
    ),
  ).toBe(true);
  const known = remote.commands.filter((args) =>
    args.some((arg) => arg.startsWith("query=query KnownIssues")),
  );
  expect(known.some((args) => args.includes("n24=65"))).toBe(true);
  expect(
    known.every(
      (args) => args.filter((arg) => /^n\d+=/u.test(arg)).length <= 25,
    ),
  ).toBe(true);
  expect(remote.commands.some((args) => args.includes("cursor=C_42:100"))).toBe(
    true,
  );
  expect(remote.commands.some((args) => args.includes("cursor=L_42:100"))).toBe(
    true,
  );
});

test("production parser discards the entire snapshot on incomplete schema, identities, cursors, errors or count drift", async () => {
  for (const fault of [
    "partial",
    "null",
    "id",
    "number",
    "comment-id",
    "author",
    "count",
    "duplicate",
    "cursor",
    "bound",
  ] as const) {
    const source = memoryPlan(
      Array.from({ length: 26 }, (_, i) => [`src/${i}`]),
    );
    const remote = protocolGitHub(source.issues);
    remote.faults.afterRead = (body, args) => {
      const response = body as {
        data: {
          repository: {
            issues: {
              nodes: Array<Record<string, any>>;
              totalCount: number;
              pageInfo: { endCursor: string | null };
            };
          };
        };
        errors?: unknown[];
      };
      const page = response.data.repository.issues;
      const first = page.nodes[0]!;
      if (fault === "partial")
        response.errors = [{ type: "FORBIDDEN", message: "secret-token" }];
      if (fault === "null") page.nodes[0] = null as never;
      if (fault === "id") first.id = null;
      if (fault === "number") page.nodes[1]!.number = first.number;
      if (fault === "comment-id") first.comments.nodes[0].databaseId = null;
      if (fault === "author") first.comments.nodes[0].author = undefined;
      if (fault === "count" && args.includes("cursor=issues:25"))
        page.totalCount++;
      if (fault === "duplicate") page.nodes[1] = first;
      if (fault === "cursor") page.pageInfo.endCursor = null;
      if (fault === "bound") page.totalCount = 1000;
      return response;
    };
    let snapshots = 0;
    const error = await remote.reader.read("acme/test").then(
      () => {
        snapshots++;
      },
      (error) => error,
    );
    expect(snapshots).toBe(0);
    expect(error.code).toMatch(/^GITHUB_READ_/u);
    expect(String(error)).not.toContain("secret-token");
  }
});

test("getMany validates locators and rejects missing aliases, foreign Issues and nested drift", async () => {
  for (const fault of [
    "input",
    "missing",
    "foreign",
    "nested-count",
    "nested-duplicate",
    "nested-cursor",
  ]) {
    const source = memoryPlan([["a"]]);
    source.issues[0]!.comments.push(
      ...Array.from({ length: 55 }, (_, i) => ({
        databaseId: i + 10,
        body: "",
        author: null,
      })),
    );
    const remote = protocolGitHub(source.issues);
    remote.faults.afterRead = (body, args) => {
      const response = body as any;
      if (fault === "missing") response.data.repository.i0 = null;
      if (fault === "foreign") response.data.repository.i0.number = 42;
      if (args.includes("cursor=C_41:25")) {
        if (fault === "nested-count") response.data.node.comments.totalCount++;
        if (fault === "nested-duplicate")
          response.data.node.comments.nodes[0].databaseId = 1;
        if (fault === "nested-cursor")
          response.data.node.comments.pageInfo.endCursor = "C_41:25";
      }
      return response;
    };
    await expect(
      remote.reader.getMany("acme/test", fault === "input" ? [41, 41] : [41]),
    ).rejects.toMatchObject({ code: "GITHUB_READ_INCOMPLETE" });
    if (fault === "input") expect(remote.commands).toHaveLength(0);
  }
});

test("GraphQL HTTP 200 quota retries share waiting, permission never retries and mutations have no read intent", async () => {
  const source = memoryPlan([["a"]]);
  const remote = protocolGitHub(source.issues);
  let calls = 0;
  let clock = 0;
  const waits: number[] = [];
  const runner = new GitHubRateLimitRunner(
    {
      async run(input) {
        if (input.command[2] === "graphql" && ++calls === 1)
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              data: {
                rateLimit: {
                  cost: 1,
                  limit: 5000,
                  remaining: 0,
                  resetAt: "1970-01-01T00:00:01Z",
                },
              },
              errors: [{ type: "RATE_LIMITED", message: "secret" }],
            }),
          };
        return remote.command.run(input);
      },
    },
    {
      signal: new AbortController().signal,
      now: () => clock,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    },
  );
  expect(
    await new GitHubRemoteIssueReader("/fixture", runner).get("acme/test", 41),
  ).toEqual(source.issues[0]!);
  expect(calls).toBe(2);
  expect(waits).toEqual([1000]);
  calls = 0;
  const denied = new GitHubRateLimitRunner(
    {
      async run() {
        calls++;
        return {
          exitCode: 0,
          stderr: "secret",
          stdout: JSON.stringify({
            data: null,
            errors: [{ type: "FORBIDDEN", message: "secret" }],
          }),
        };
      },
    },
    { signal: new AbortController().signal },
  );
  await expect(
    new GitHubRemoteIssueReader("/fixture", denied).get("acme/test", 41),
  ).rejects.toMatchObject({ code: "GITHUB_READ_FORBIDDEN", retryable: false });
  expect(calls).toBe(1);
});

test("worker cancellation leaves sibling quota wait alive and daemon cancellation drains an in-flight page", async () => {
  const entered = barrier();
  const release = barrier();
  const stop = new AbortController();
  let now = 0;
  let calls = 0;
  const runner = new GitHubRateLimitRunner(
    {
      async run() {
        calls++;
        return calls === 1
          ? {
              exitCode: 1,
              stdout: "",
              stderr: "HTTP 429",
              httpStatus: 429,
              rateLimit: { retryAfterMs: 1000 },
            }
          : { exitCode: 0, stdout: "{}", stderr: "" };
      },
    },
    {
      signal: stop.signal,
      now: () => now,
      wait: async (ms) => {
        entered.release();
        await release.promise;
        now += ms;
      },
    },
  );
  const worker = new AbortController();
  const first = runner
    .run({
      command: ["gh", "api", "graphql"],
      cwd: "/fixture",
      intent: "graphql-read",
      signal: worker.signal,
    })
    .catch((error) => error);
  await entered.promise;
  const sibling = runner.run({
    command: ["gh", "repo", "view"],
    cwd: "/fixture",
  });
  worker.abort();
  expect(await first).toBeInstanceOf(Error);
  expect(calls).toBe(1);
  release.release();
  await sibling;
  expect(calls).toBe(2);

  const source = memoryPlan(Array.from({ length: 26 }, () => ["a"]));
  const remote = protocolGitHub(source.issues);
  let drained = false;
  const read = new GitHubRemoteIssueReader(
    "/fixture",
    new GitHubRateLimitRunner(
      {
        async run(input) {
          const result = await remote.command.run(input);
          stop.abort();
          drained = true;
          return result;
        },
      },
      { signal: stop.signal },
    ),
  ).read("acme/test", stop.signal);
  await expect(read).rejects.toBeInstanceOf(Error);
  expect(drained).toBe(true);
  expect(remote.commands).toHaveLength(1);
});
