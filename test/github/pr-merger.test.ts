import { expect, test } from "bun:test";
import { GitHubPullRequestMerger } from "../../src/github/pr-merger";
import type { GitHubCommandRunner } from "../../src/github/pr-publisher";

const head = "b".repeat(40);
const base = "a".repeat(40);
const merge = "c".repeat(40);
const candidate = {
  number: 7,
  headBranch: "agile/issue-41",
  headSha: head,
  baseBranch: "release/test",
  baseSha: base,
};

/** Supplies the exact projected gh response shapes and records every transport operation. */
function fixture() {
  const pr = {
    number: 7,
    state: "open",
    merged: false,
    merge_commit_sha: null as string | null,
    draft: false,
    mergeable: true as boolean | null,
    mergeable_state: "clean",
    head: { ref: candidate.headBranch, sha: head, repository: "acme/test" },
    base: { ref: candidate.baseBranch, sha: base, repository: "acme/test" },
  };
  const check = {
    id: 1,
    name: "CI",
    head_sha: head,
    app_id: 42,
    status: "completed",
    conclusion: "success",
  };
  const data = {
    pr,
    base: {
      ref: `refs/heads/${candidate.baseBranch}`,
      sha: base,
      type: "commit",
    },
    protection: {
      strict: true,
      enforceAdmins: true,
      contexts: ["CI"],
      checks: [{ context: "CI", app_id: 42 as number | null }],
      requiredReviews: {
        required_approving_review_count: 1,
        require_code_owner_reviews: false,
        require_last_push_approval: false,
      },
    },
    rules: [] as { ruleset_id: number; type: string; parameters: unknown }[],
    checks: [check],
    statuses: [] as { id: number; context: string; state: string }[],
    review: {
      number: 7,
      headRefOid: head,
      reviewDecision: "APPROVED" as string | null,
    },
    unreadable: "",
    totalOverride: undefined as number | undefined,
    response: "success" as "success" | "lost" | "denied" | "malformed",
    unreadableAfterMerge: false,
    beforeFinalRead: undefined as (() => void) | undefined,
    beforeWrite: undefined as (() => void) | undefined,
  };
  const calls: string[][] = [];
  let prReads = 0;
  let writes = 0;
  const command: GitHubCommandRunner = {
    async run({ command, cwd }) {
      expect(cwd).toBe("/fixture");
      calls.push(command);
      const path = command[2] ?? "";
      if (command.includes("PUT")) {
        writes++;
        data.beforeWrite?.();
        expect(command).toEqual([
          "gh",
          "api",
          "repos/acme/test/pulls/7/merge",
          "--method",
          "PUT",
          "-f",
          "merge_method=squash",
          "-f",
          `sha=${head}`,
        ]);
        if (data.response !== "denied") {
          pr.state = "closed";
          pr.merged = true;
          pr.merge_commit_sha = merge;
        }
        if (data.response === "lost")
          throw Error("connection reset after remote merge");
        return {
          exitCode: data.response === "denied" ? 405 : 0,
          stdout: data.response === "malformed" ? "not json" : "{}",
          stderr: "",
        };
      }
      if (data.unreadable && path.includes(data.unreadable))
        return { exitCode: 1, stdout: "", stderr: "secret raw diagnostic" };
      let value: unknown;
      if (command[1] === "pr") {
        expect(command).toEqual([
          "gh",
          "pr",
          "view",
          "7",
          "--repo",
          "acme/test",
          "--json",
          "number,headRefOid,reviewDecision",
        ]);
        value = data.review;
      } else {
        expect(command.slice(3, 6)).toEqual(["--method", "GET", "--jq"]);
        expect(command[6]).toBeString();
        if (path === "repos/acme/test/pulls/7") {
          prReads++;
          if (prReads === 2) data.beforeFinalRead?.();
          if (pr.merged && data.unreadableAfterMerge)
            return { exitCode: 1, stdout: "", stderr: "offline" };
          value = pr;
        } else if (path === "repos/acme/test/git/ref/heads/release%2Ftest")
          value = data.base;
        else if (path === "repos/acme/test/branches/release%2Ftest/protection")
          value = data.protection;
        else {
          const url = new URL(`https://api.github.com/${path}`);
          expect(url.searchParams.get("per_page")).toBe("100");
          const page = Number(url.searchParams.get("page"));
          let items: unknown[];
          if (url.pathname === "/repos/acme/test/rules/branches/release%2Ftest")
            items = data.rules;
          else if (
            url.pathname === `/repos/acme/test/commits/${head}/check-runs`
          ) {
            expect(url.searchParams.get("filter")).toBe("latest");
            items = data.checks;
          } else if (
            url.pathname === `/repos/acme/test/commits/${head}/statuses`
          )
            items = data.statuses;
          else throw Error(`Unexpected endpoint: ${path}`);
          value = {
            total_count: path.includes("/check-runs")
              ? (data.totalOverride ?? items.length)
              : null,
            items: items.slice((page - 1) * 100, page * 100),
          };
        }
      }
      return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
    },
  };
  return {
    data,
    calls,
    command,
    merger: new GitHubPullRequestMerger("acme/test", "/fixture", command),
    writes: () => writes,
  };
}

for (const response of ["success", "lost", "malformed"] as const) {
  test(`synchronous exact-head squash confirms remote truth after a ${response} response`, async () => {
    const f = fixture();
    f.data.response = response;
    let approvals = 0;
    const result = await f.merger.reconcile(
      candidate,
      async () => {
        approvals++;
        return undefined;
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: "merged", mergeCommit: merge });
    expect(approvals).toBe(1);
    expect(f.writes()).toBe(1);
    expect(f.calls.at(-1)?.[2]).toBe("repos/acme/test/pulls/7");
  });
}

test("reads all check/status/rule pages, rejects late failures and honors configured app identities", async () => {
  const f = fixture();
  const check = f.data.checks[0];
  if (!check) throw Error("Missing check");
  f.data.checks = Array.from({ length: 101 }, (_, i) => ({
    ...check,
    id: i + 1,
    name: i === 100 ? "CI" : `extra-${i}`,
  }));
  f.data.statuses = Array.from({ length: 101 }, (_, i) => ({
    id: i + 1,
    context: "legacy",
    state: i === 100 ? "success" : "failure",
  }));
  f.data.rules = Array.from({ length: 101 }, (_, i) => ({
    ruleset_id: i + 1,
    type: "deletion",
    parameters: null,
  }));
  f.data.checks[100] = { ...check, id: 101, app_id: 99 };
  expect(
    await f.merger.reconcile(
      candidate,
      async () => undefined,
      new AbortController().signal,
    ),
  ).toMatchObject({
    kind: "waiting",
    reason: expect.stringContaining("app 42"),
  });
  expect(f.writes()).toBe(0);
  for (const endpoint of ["check-runs", "statuses", "rules/branches"])
    expect(
      f.calls.some(
        (call) => call[2]?.includes(endpoint) && call[2]?.includes("page=2"),
      ),
    ).toBe(true);
  f.data.checks[100] = { ...check, id: 101, conclusion: "failure" };
  expect(
    await f.merger.reconcile(
      candidate,
      async () => undefined,
      new AbortController().signal,
    ),
  ).toMatchObject({
    kind: "waiting",
    reason: expect.stringContaining("must pass"),
  });
  f.data.checks[100] = { ...check, id: 101 };
  expect(
    await f.merger.reconcile(
      candidate,
      async () => undefined,
      new AbortController().signal,
    ),
  ).toEqual({ kind: "merged", mergeCommit: merge });
});

test("fails closed on protection, unreadable policy, queue, checks and human review blockers", async () => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void, string][] = [
    [
      "missing protection",
      (f) => {
        f.data.unreadable = "/protection";
      },
      "Classic branch protection",
    ],
    [
      "loose protection",
      (f) => {
        f.data.protection.strict = false;
      },
      "strict",
    ],
    [
      "administrator bypass",
      (f) => {
        f.data.protection.enforceAdmins = false;
      },
      "administrators",
    ],
    [
      "no configured check",
      (f) => {
        f.data.protection.contexts = [];
        f.data.protection.checks = [];
      },
      "at least one",
    ],
    [
      "unreadable rules",
      (f) => {
        f.data.unreadable = "/rules/";
      },
      "rules are unreadable",
    ],
    [
      "queue",
      (f) => {
        f.data.rules = [{ ruleset_id: 1, type: "merge_queue", parameters: {} }];
      },
      "merge queue",
    ],
    [
      "unsupported rule",
      (f) => {
        f.data.rules = [
          { ruleset_id: 1, type: "required_deployments", parameters: {} },
        ];
      },
      "not supported",
    ],
    [
      "rule check",
      (f) => {
        f.data.rules = [
          {
            ruleset_id: 1,
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "deploy", integration_id: 88 },
              ],
            },
          },
        ];
      },
      "deploy",
    ],
    [
      "incomplete check pages",
      (f) => {
        f.data.totalOverride = 101;
      },
      "pagination is incomplete",
    ],
    [
      "unreadable review rule",
      (f) => {
        f.data.rules = [
          { ruleset_id: 1, type: "pull_request", parameters: null },
        ];
      },
      "review parameters",
    ],
    [
      "missing check",
      (f) => {
        f.data.checks = [];
      },
      "missing",
    ],
    [
      "pending check",
      (f) => {
        const check = f.data.checks[0];
        if (!check) throw Error("Missing check");
        check.status = "in_progress";
      },
      "must pass",
    ],
    [
      "unreadable checks",
      (f) => {
        f.data.unreadable = "check-runs";
      },
      "check runs are unreadable",
    ],
    [
      "failed status",
      (f) => {
        f.data.statuses = [{ id: 1, context: "extra", state: "failure" }];
      },
      "must pass",
    ],
    [
      "wrong check head",
      (f) => {
        const check = f.data.checks[0];
        if (!check) throw Error("Missing check");
        check.head_sha = base;
      },
      "check head",
    ],
    [
      "human reviews",
      (f) => {
        f.data.review.reviewDecision = "REVIEW_REQUIRED";
      },
      "human GitHub reviews",
    ],
    [
      "changes requested",
      (f) => {
        f.data.review.reviewDecision = "CHANGES_REQUESTED";
      },
      "human GitHub reviews",
    ],
    [
      "unknown required reviews",
      (f) => {
        f.data.review.reviewDecision = null;
      },
      "human GitHub reviews",
    ],
    [
      "draft",
      (f) => {
        f.data.pr.draft = true;
      },
      "non-draft",
    ],
    [
      "server blocked",
      (f) => {
        f.data.pr.mergeable_state = "blocked";
      },
      "requirements",
    ],
    [
      "unknown mergeability",
      (f) => {
        f.data.pr.mergeable = null;
      },
      "requirements",
    ],
  ];
  for (const [name, change, reason] of cases) {
    const f = fixture();
    change(f);
    expect(
      await f.merger.reconcile(
        candidate,
        async () => undefined,
        new AbortController().signal,
      ),
      name,
    ).toMatchObject({
      kind: "waiting",
      reason: expect.stringContaining(reason),
    });
    expect(f.writes(), name).toBe(0);
  }
});

test("changed identity, closed PR and withdrawn authority cannot merge, including final-read races", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.data.pr.head.sha = base;
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.pr.head.repository = "fork/test";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.pr.base.ref = "other";
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.pr.number = 8;
    },
    (f: ReturnType<typeof fixture>) => {
      f.data.pr.state = "closed";
    },
  ]) {
    for (const atFinalRead of [false, true]) {
      const f = fixture();
      if (atFinalRead) f.data.beforeFinalRead = () => change(f);
      else change(f);
      expect(
        await f.merger.reconcile(
          candidate,
          async () => undefined,
          new AbortController().signal,
        ),
      ).toMatchObject({ kind: "replan" });
      expect(f.writes()).toBe(0);
    }
  }
  const f = fixture();
  expect(
    await f.merger.reconcile(
      candidate,
      async () => "approval withdrawn",
      new AbortController().signal,
    ),
  ).toEqual({ kind: "waiting", reason: "approval withdrawn" });
  expect(f.writes()).toBe(0);
});

test("target advancement requests authorized refresh at either base check but inconsistent snapshots wait", async () => {
  for (const final of [false, true]) {
    const f = fixture();
    const change = () => {
      f.data.base.sha = merge;
      f.data.pr.base.sha = merge;
    };
    if (final) f.data.beforeFinalRead = change;
    else change();
    let approvals = 0;
    expect(
      await f.merger.reconcile(
        candidate,
        async () => {
          approvals++;
          return undefined;
        },
        new AbortController().signal,
      ),
    ).toEqual({ kind: "refresh", targetBase: merge });
    expect(approvals).toBe(1);
    expect(f.writes()).toBe(0);
    expect(
      await f.merger.reconcile(
        candidate,
        async () => "approval withdrawn",
        new AbortController().signal,
      ),
    ).toEqual({ kind: "waiting", reason: "approval withdrawn" });
  }
  const inconsistent = fixture();
  inconsistent.data.pr.base.sha = merge;
  expect(
    await inconsistent.merger.reconcile(
      candidate,
      async () => undefined,
      new AbortController().signal,
    ),
  ).toMatchObject({
    kind: "waiting",
    reason: expect.stringContaining("disagree"),
  });
  expect(inconsistent.writes()).toBe(0);
});

test("denied or unreadable merge readback never claims success; restart reads before another write", async () => {
  const f = fixture();
  f.data.response = "denied";
  expect(
    await f.merger.reconcile(
      candidate,
      async () => undefined,
      new AbortController().signal,
    ),
  ).toMatchObject({ kind: "waiting" });
  expect(f.calls.at(-1)?.[2]).toBe("repos/acme/test/pulls/7");
  f.data.response = "lost";
  f.data.unreadableAfterMerge = true;
  expect(
    await f.merger.reconcile(
      candidate,
      async () => undefined,
      new AbortController().signal,
    ),
  ).toMatchObject({
    kind: "waiting",
    reason: expect.stringContaining("PR state is unreadable"),
  });
  f.data.unreadableAfterMerge = false;
  expect(
    await f.merger.reconcile(
      candidate,
      async () => {
        throw Error("Already merged");
      },
      new AbortController().signal,
    ),
  ).toEqual({ kind: "merged", mergeCommit: merge });
  expect(f.writes()).toBe(2);
});

test("cancellation suppresses the write but still reads back an already submitted merge", async () => {
  const f = fixture();
  const stop = new AbortController();
  await expect(
    f.merger.reconcile(
      candidate,
      async () => {
        stop.abort();
        return undefined;
      },
      stop.signal,
    ),
  ).rejects.toThrow();
  expect(f.writes()).toBe(0);
  const submitted = fixture();
  const afterWrite = new AbortController();
  submitted.data.beforeWrite = () => afterWrite.abort();
  expect(
    await submitted.merger.reconcile(
      candidate,
      async () => undefined,
      afterWrite.signal,
    ),
  ).toEqual({ kind: "merged", mergeCommit: merge });
  expect(submitted.calls.at(-1)?.[2]).toBe("repos/acme/test/pulls/7");
});
