import { expect, test } from "bun:test";
import type { RemoteIssue } from "../../src/github/issue-reader";
import {
  canonicalDigest,
  GRAPHQL_ISSUE_SAFETY_BOUND,
  GraphQLReadProof,
  GraphQLReadProofError,
  type GraphQLTransport,
  type GraphQLTransportResponse,
  LiveGraphQLTransport,
  liveArguments,
  measuredLeg,
  ObservedGitHubRunner,
  type ProofProcess,
  runPairedComparison,
} from "../../tools/github-read-proof";

type FixtureIssue = RemoteIssue & { id: string };

/** Returns a fixture value that a test has established must exist. */
function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

/** Builds one stable managed-Issue fixture with independent overflowing connections. */
function fixtureIssues(count = 26): FixtureIssue[] {
  return Array.from({ length: count }, (_, offset) => {
    const number = offset + 1;
    const labels = Array.from(
      { length: number === 1 ? 101 : 2 },
      (_, index) => ({
        name:
          number === 1
            ? `label-${String(index + 1).padStart(3, "0")}`
            : index === 0
              ? "roc:task"
              : "roc:ready",
      }),
    );
    const comments = Array.from(
      { length: number === 1 ? 103 : number === 2 ? 28 : 1 },
      (_, index) => ({
        databaseId: number * 10_000 + index + 1,
        body:
          number === 1 && index === 101
            ? "<!-- roc:approval --> approved"
            : number === 1 && index === 102
              ? "<!-- roc:checkpoint --> executor-owned"
              : `comment-${number}-${index + 1}`,
        author:
          index === 0 && number === 3 ? null : { login: `author-${number}` },
      }),
    );
    return {
      id: `I${number}`,
      number,
      title: `Task ${number}`,
      body: `body-${number}`,
      url: `https://example.test/issues/${number}`,
      state: number % 2 === 0 ? "CLOSED" : "OPEN",
      labels,
      comments,
    };
  });
}

/** Converts a fixture slice into GraphQL connection metadata with a deterministic cursor. */
function connection<T>(
  values: T[],
  cursor: string | null,
  prefix: string,
  totalCount = values.length,
) {
  const offset = cursor === null ? 0 : Number(cursor.slice(prefix.length));
  const nodes = values.slice(offset, offset + 25);
  const next = offset + nodes.length;
  return {
    totalCount,
    nodes,
    pageInfo: {
      hasNextPage: next < values.length,
      endCursor: next < values.length ? `${prefix}${next}` : null,
    },
  };
}

/** Creates a deterministic fixed-query transport and lets a test alter one response safely. */
function transport(
  issues: FixtureIssue[],
  alter?: (input: {
    operation: string;
    response: GraphQLTransportResponse;
  }) => GraphQLTransportResponse,
): GraphQLTransport {
  return {
    async request(input) {
      const cursor = input.variables.cursor ?? null;
      const rateLimit = {
        cost: 1,
        limit: 5000,
        remaining: 4900,
        resetAt: "2026-09-11T03:00:00Z",
      };
      let response: GraphQLTransportResponse;
      if (input.operation === "ManagedIssueDiscovery") {
        const outer = connection(issues, cursor, "issue:");
        response = {
          status: 200,
          httpRequests: 1,
          elapsedMs: 5,
          body: {
            data: {
              repository: {
                issues: {
                  ...outer,
                  nodes: outer.nodes.map((issue) => ({
                    ...issue,
                    labels: connection(issue.labels, null, "label:"),
                    comments: connection(issue.comments, null, "comment:"),
                  })),
                },
              },
              rateLimit,
            },
          },
        };
      } else {
        const issue = issues.find(
          (candidate) => candidate.id === input.variables.id,
        );
        if (!issue) throw new Error("Fixture received an unknown node id");
        const connectionPage =
          input.operation === "IssueLabels"
            ? connection(issue.labels, cursor, "label:")
            : connection(issue.comments, cursor, "comment:");
        const field = input.operation === "IssueLabels" ? "labels" : "comments";
        response = {
          status: 200,
          httpRequests: 1,
          elapsedMs: 5,
          body: {
            data: {
              node: { [field]: connectionPage },
              rateLimit,
            },
          },
        };
      }
      return alter?.({ operation: input.operation, response }) ?? response;
    },
  };
}

test("drains all independent GraphQL cursors and preserves the canonical RemoteIssue semantics", async () => {
  const source = fixtureIssues();
  const result = await new GraphQLReadProof(transport(source)).read("acme/roc");
  expect(result.issues).toEqual(source.map(({ id: _id, ...issue }) => issue));
  expect(canonicalDigest(result.issues)).toBe(canonicalDigest(source));
  expect(
    result.observations.filter(
      (item) => item.operation === "ManagedIssueDiscovery",
    ),
  ).toHaveLength(2);
  expect(
    result.observations.filter((item) => item.operation === "IssueLabels"),
  ).toHaveLength(4);
  expect(
    result.observations.filter((item) => item.operation === "IssueComments"),
  ).toHaveLength(5);
  expect(result.issues[0]?.comments[101]?.body).toContain("approval");
  expect(result.issues[0]?.comments[102]?.body).toContain("checkpoint");
  expect(result.issues[2]?.comments[0]?.author).toBeNull();
});

test("fails closed for partial data, null fields, cursor stalls, count drift, and duplicate ids", async () => {
  const cases: Array<
    [
      string,
      (input: {
        operation: string;
        response: GraphQLTransportResponse;
      }) => GraphQLTransportResponse,
      string,
    ]
  > = [
    [
      "partial errors",
      ({ response }) => ({
        ...response,
        body: { errors: [{ message: "private body" }] },
      }),
      "GQL_READ_INCOMPLETE",
    ],
    [
      "null title",
      ({ operation, response }) =>
        operation !== "ManagedIssueDiscovery"
          ? response
          : {
              ...response,
              body: {
                data: {
                  repository: {
                    issues: {
                      ...(
                        response.body as {
                          data: { repository: { issues: object } };
                        }
                      ).data.repository.issues,
                      nodes: [
                        {
                          ...required(
                            (
                              response.body as {
                                data: {
                                  repository: { issues: { nodes: object[] } };
                                };
                              }
                            ).data.repository.issues.nodes[0],
                            "fixture Issue",
                          ),
                          title: null,
                        },
                      ],
                    },
                  },
                  rateLimit: { cost: 1 },
                },
              },
            },
      "GQL_READ_INCOMPLETE",
    ],
    [
      "cursor stall",
      ({ operation, response }) =>
        operation !== "IssueComments"
          ? response
          : {
              ...response,
              body: {
                data: {
                  ...(response.body as { data: object }).data,
                  node: {
                    comments: {
                      ...(
                        response.body as {
                          data: { node: { comments: object } };
                        }
                      ).data.node.comments,
                      pageInfo: { hasNextPage: true, endCursor: "comment:25" },
                    },
                  },
                },
              },
            },
      "GQL_CURSOR_STALLED",
    ],
    [
      "count drift",
      ({ operation, response }) =>
        operation !== "IssueLabels"
          ? response
          : {
              ...response,
              body: {
                data: {
                  ...(response.body as { data: object }).data,
                  node: {
                    labels: {
                      ...(
                        response.body as {
                          data: { node: { labels: { totalCount: number } } };
                        }
                      ).data.node.labels,
                      totalCount: 999,
                    },
                  },
                },
              },
            },
      "GQL_COUNT_DRIFT",
    ],
    [
      "duplicate issue",
      ({ operation, response }) =>
        operation !== "ManagedIssueDiscovery"
          ? response
          : {
              ...response,
              body: {
                data: {
                  repository: {
                    issues: {
                      ...(
                        response.body as {
                          data: {
                            repository: {
                              issues: { nodes: Array<{ id: string }> };
                            };
                          };
                        }
                      ).data.repository.issues,
                      nodes: (
                        response.body as {
                          data: {
                            repository: {
                              issues: { nodes: Array<{ id: string }> };
                            };
                          };
                        }
                      ).data.repository.issues.nodes.map(
                        (node, index, nodes) =>
                          index === 1
                            ? {
                                ...node,
                                id: required(nodes[0], "first fixture Issue")
                                  .id,
                              }
                            : node,
                      ),
                    },
                  },
                  rateLimit: { cost: 1 },
                },
              },
            },
      "GQL_DUPLICATE",
    ],
  ];
  for (const [_name, alter, code] of cases) {
    const error = await new GraphQLReadProof(transport(fixtureIssues(), alter))
      .read("acme/roc")
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GraphQLReadProofError);
    expect(error).toMatchObject({ code });
  }
});

test("treats quota and permission errors differently and never retries permission", async () => {
  let calls = 0;
  let now = 1_000;
  const quota = new GraphQLReadProof(
    {
      async request(input) {
        calls++;
        if (calls === 1)
          return {
            status: 200,
            retryAfterMs: 100,
            body: { errors: [{ message: "rate limit" }] },
          };
        return transport(fixtureIssues()).request(input);
      },
    },
    {
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
    },
  );
  await expect(quota.read("acme/roc")).resolves.toMatchObject({
    issues: expect.any(Array),
  });
  expect(calls).toBeGreaterThan(1);

  let permissionCalls = 0;
  const permission = new GraphQLReadProof({
    async request() {
      permissionCalls++;
      return {
        status: 403,
        body: { errors: [{ message: "Resource not accessible" }] },
      };
    },
  });
  await expect(permission.read("acme/roc")).rejects.toMatchObject({
    code: "GQL_READ_PERMISSION",
  });
  expect(permissionCalls).toBe(1);
});

test("aborts an offline quota wait without issuing another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  let waited = 0;
  const reader = new GraphQLReadProof(
    {
      async request() {
        calls++;
        return {
          status: 200,
          retryAfterMs: 1_000,
          body: { errors: [{ message: "rate limit" }] },
        };
      },
    },
    {
      signal: controller.signal,
      now: () => 1_000,
      async wait() {
        waited++;
        controller.abort();
        controller.signal.throwIfAborted();
      },
    },
  );
  await expect(reader.read("acme/roc")).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(waited).toBe(1);
  expect(calls).toBe(1);
});

test("applies the 1000-Issue safety bound before returning a candidate snapshot", async () => {
  const source = fixtureIssues(GRAPHQL_ISSUE_SAFETY_BOUND);
  await expect(
    new GraphQLReadProof(transport(source)).read("acme/roc"),
  ).rejects.toMatchObject({ code: "GQL_ISSUE_BOUND" });
});

test("a new complete read reflects updates, deletion, and approval withdrawal in its digest", async () => {
  const before = fixtureIssues();
  const after = fixtureIssues();
  const changedFirst = required(after[0], "first fixture Issue");
  const changedSecond = required(after[1], "second fixture Issue");
  const changedThird = required(after[2], "third fixture Issue");
  changedFirst.comments = changedFirst.comments.filter(
    (comment) => !comment.body.includes("approval"),
  );
  changedSecond.body = "updated-body";
  changedThird.comments = [];
  const beforeResult = await new GraphQLReadProof(transport(before)).read(
    "acme/roc",
  );
  const afterResult = await new GraphQLReadProof(transport(after)).read(
    "acme/roc",
  );
  expect(canonicalDigest(afterResult.issues)).not.toBe(
    canonicalDigest(beforeResult.issues),
  );
  expect(
    afterResult.issues[0]?.comments.some((comment) =>
      comment.body.includes("approval"),
    ),
  ).toBeFalse();
  expect(afterResult.issues[2]?.comments).toEqual([]);
});

test("bounds a long unique-cursor cycle and rejects duplicate comments after a complete page count", async () => {
  let calls = 0;
  const endless = new GraphQLReadProof({
    async request(input) {
      calls++;
      const cursor = input.variables.cursor;
      const offset = cursor === null ? 0 : Number(cursor);
      return {
        status: 200,
        body: {
          data: {
            repository: {
              issues: {
                totalCount: 50,
                nodes: Array.from({ length: 25 }, (_, index) => ({
                  id: `I${offset + index}`,
                  number: offset + index + 1,
                  title: "Task",
                  body: "",
                  url: `https://example.test/${offset + index}`,
                  state: "OPEN",
                  labels: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  comments: {
                    totalCount: 0,
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                })),
                pageInfo: { hasNextPage: true, endCursor: String(offset + 25) },
              },
            },
          },
        },
      };
    },
  });
  await expect(endless.read("acme/roc")).rejects.toMatchObject({
    code: "GQL_CURSOR_STALLED",
  });
  expect(calls).toBe(2);

  const source = fixtureIssues();
  const duplicate = await new GraphQLReadProof(
    transport(source, ({ operation, response }) => {
      if (operation !== "IssueComments") return response;
      const body = response.body as {
        data: { node: { comments: { nodes: Array<{ databaseId: number }> } } };
      };
      const comments = body.data.node.comments;
      if (comments.nodes.length !== 3) return response;
      return {
        ...response,
        body: {
          data: {
            ...body.data,
            node: {
              comments: {
                ...comments,
                nodes: [
                  {
                    ...required(comments.nodes[0], "fixture comment"),
                    databaseId: 20_001,
                  },
                  ...comments.nodes.slice(1),
                ],
              },
            },
          },
        },
      };
    }),
  )
    .read("acme/roc")
    .catch((error: unknown) => error);
  expect(duplicate).toMatchObject({ code: "GQL_DUPLICATE" });
});

test("classifies no-body quota and HTTP-200 permission errors before retry decisions", async () => {
  for (const [response, code] of [
    [{ status: 429, body: {} }, "GQL_READ_QUOTA"],
    [
      {
        status: 200,
        body: { errors: [{ message: "Resource not accessible" }] },
      },
      "GQL_READ_PERMISSION",
    ],
  ] as const) {
    let calls = 0;
    const error = await new GraphQLReadProof({
      async request() {
        calls++;
        return response;
      },
    })
      .read("acme/roc")
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code });
    expect(calls).toBe(1);
  }
});

test("rejects unsafe live CLI and transport inputs before an executor sees a request", async () => {
  for (const argv of [
    [],
    ["--repo", "acme/roc", "--max-http", "1"],
    ["--live", "--repo", "acme/roc", "--repo", "other/repo", "--max-http", "1"],
    ["--live", "--repo", "acme/roc", "--max-http", "1", "--unknown"],
  ])
    expect(() => liveArguments(argv)).toThrow(GraphQLReadProofError);
  let requests = 0;
  const live = new LiveGraphQLTransport(1, {
    async execute() {
      requests++;
      return { status: 200, body: {} };
    },
  });
  await expect(
    live.request({
      operation: "Mutation",
      query: "mutation { x }",
      variables: {},
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "GQL_READ_INPUT" });
  expect(requests).toBe(0);
});

test("reserves every direct request attempt at the hard ceiling, including executor errors", async () => {
  const source = fixtureIssues(1);
  const onlyIssue = required(source[0], "fixture Issue");
  onlyIssue.labels = [];
  onlyIssue.comments = [];
  let calls = 0;
  const live = new LiveGraphQLTransport(1, {
    async execute(input) {
      calls++;
      return transport(source).request(input);
    },
  });
  await expect(
    new GraphQLReadProof(live, { mode: "live" }).read("acme/roc"),
  ).resolves.toMatchObject({ issues: expect.any(Array) });
  await expect(
    new GraphQLReadProof(live, { mode: "live" }).read("acme/roc"),
  ).rejects.toMatchObject({ code: "GQL_HTTP_BOUND" });
  expect(calls).toBe(1);

  const failed = new LiveGraphQLTransport(1, {
    async execute() {
      throw new Error("network");
    },
  });
  const failedResult = await new GraphQLReadProof(failed, { mode: "live" })
    .read("acme/roc")
    .catch((error: unknown) => error);
  expect(failedResult).toMatchObject({ code: "GQL_READ_INCOMPLETE" });
  await expect(
    new GraphQLReadProof(failed, { mode: "live" }).read("acme/roc"),
  ).rejects.toMatchObject({ code: "GQL_HTTP_BOUND" });
});

/** Provides controllable child pipes and records signals while requiring explicit drain completion. */
function child(stdout = "", trace = "", waitForKill = false) {
  let errorPipe!: ReadableStreamDefaultController<Uint8Array>;
  let outputPipe!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (code: number) => void;
  let closed = false;
  const signals: string[] = [];
  const encoder = new TextEncoder();
  const process: ProofProcess = {
    stdout: new ReadableStream({
      start(controller) {
        outputPipe = controller;
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        errorPipe = controller;
      },
    }),
    exited: new Promise<number>((resolve) => {
      finish = resolve;
    }),
    kill(signal) {
      signals.push(signal);
      if (signal === "SIGKILL" || !waitForKill) close(143);
    },
  };
  /** Finishes both pipes before resolving the simulated child exit. */
  function close(code = 0) {
    if (closed) return;
    closed = true;
    outputPipe.close();
    errorPipe.close();
    finish(code);
  }
  /** Sends a partial stderr chunk without interpreting or retaining its contents. */
  function emit(value: string) {
    errorPipe.enqueue(encoder.encode(value));
  }
  outputPipe.enqueue(encoder.encode(stdout));
  if (trace) emit(trace);
  return { process, emit, close, signals };
}

/** Returns the exact baseline comment argv for one managed Issue. */
function commentCommand(number = 1, repository = "acme/roc") {
  return [
    "gh",
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/issues/${number}/comments?per_page=100`,
  ];
}

test("REST observer validates argv, parses split traces, and stops all four children at the shared threshold", async () => {
  const children = Array.from({ length: 4 }, () => child("[[]]", "", true));
  let spawned = 0;
  const runner = new ObservedGitHubRunner(
    "/fixture",
    "acme/r.c",
    new AbortController().signal,
    2,
    () => required(children[spawned++], "child").process,
  );
  for (const command of [
    commentCommand(1, "acme/rXc"),
    ["gh", "api", "--method", "POST", "x"],
  ])
    await expect(
      runner.run({ command, cwd: "/fixture" }),
    ).rejects.toMatchObject({ code: "GQL_READ_INPUT" });
  expect(spawned).toBe(0);
  const pending = Promise.allSettled(
    children.map((_, index) =>
      runner.run({
        command: commentCommand(index + 1, "acme/r.c"),
        cwd: "/fixture",
      }),
    ),
  );
  children[0]?.emit("secret-body\n< HTTP/2.0 2");
  children[0]?.emit(
    "00 OK\n< X-Ratelimit-Remaining: 40\n< X-Ratelimit-Limit: 5000\n< X-Ratelimit-Reset: 1800000000\n",
  );
  children[1]?.emit("< HTTP/2.0 200 OK\n");
  await Bun.sleep(5);
  expect(children.every((item) => item.signals.includes("SIGTERM"))).toBeTrue();
  children[2]?.emit("< HTTP/2.0 200 OK\n");
  children[3]?.emit("< HTTP/2.0 200 OK\n");
  await pending;
  expect(children.every((item) => item.signals.includes("SIGKILL"))).toBeTrue();
  expect(runner.httpRequests).toBe(4);
  expect(runner.overshoot).toBe(2);
  expect(runner.rateHeaders).toContainEqual({
    remaining: 40,
    limit: 5000,
    resetAt: "2027-01-15T08:00:00.000Z",
  });
  await expect(
    runner.run({ command: commentCommand(5, "acme/r.c"), cwd: "/fixture" }),
  ).rejects.toMatchObject({ code: "GQL_HTTP_BOUND" });
  expect(spawned).toBe(4);
  expect(JSON.stringify(runner.commands)).not.toContain("secret-body");
  for (const value of [0, -1, 200, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(
      runPairedComparison("acme/roc", "/fixture", value, {
        spawn: () => {
          throw new Error("must not spawn");
        },
      }),
    ).rejects.toMatchObject({ code: "GQL_READ_INPUT" });
    expect(() =>
      liveArguments([
        "--live",
        "--repo",
        "acme/roc",
        "--max-http",
        String(value),
      ]),
    ).toThrow();
  }
});

test("retired M1 REST pairing cannot silently compare GraphQL against itself", async () => {
  let spawned = 0;
  const leg = await measuredLeg("rest", "acme/roc", "/fixture", 20, {
    spawn: () => {
      spawned++;
      throw Error("No live dispatch");
    },
  });
  expect(leg.status).toBe("incomplete");
  expect(leg.code).toBe("GQL_HISTORICAL_ONLY");
  expect(leg.httpRequests).toBe(0);
  expect(spawned).toBe(0);
});
