import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutionRecord,
  GitHubExecutionStore,
  renderExecution,
} from "../../src/github/execution-store";
import { GitHubRemoteIssueReader } from "../../src/github/issue-reader";
import type { GitHubCommandRunner } from "../../src/github/pr-publisher";
import {
  BunGitHubCommandRunner,
  GitHubPullRequestPublisher,
} from "../../src/github/pr-publisher";
import {
  jsonHash,
  parseRemoteTaskEnvelope,
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";
import type { HarnessStepRequest } from "../../src/harness/contracts";
import { createFakeHarness } from "../../src/harness/fake";
import { AgileError } from "../../src/runtime/errors";
import { GitHubTaskPool } from "../../src/scheduler/github-pool";
import { GitHubTaskRunner } from "../../src/scheduler/github-runner";
import { createModelAdvisor } from "../../src/scheduler/model-routing";
import type { TaskBranchManager } from "../../src/workspace/task-branch";
import { createTaskBranchManager } from "../../src/workspace/task-branch";
import { git } from "../helpers/git";
import { barrier, memoryPlan } from "../helpers/github-plan";
import { githubWorkflowLedger } from "../helpers/github-workflow-ledger";
import { protocolGitHub } from "../helpers/graphql-github";

const initialBase = "a".repeat(40);
const model = "test/model";
const time = "2026-09-09T00:00:00.000Z";
/** Makes distinct, valid fixture commit identities without mutating a real repository. */
function sha(prefix: string, number: number) {
  return `${prefix.repeat(38)}${number}`;
}

/** Drives real store/runner/pool boundaries with Fake Harness roles and a stateful GitHub transport. */
function fixture(count = 1, dependent = false, skipScout = false) {
  const remote = memoryPlan(
    Array.from({ length: count }, (_, i) => [`src/${i}.ts`]),
  );
  if (dependent || skipScout) {
    const envelopes = remote.issues.map((issue) =>
      parseRemoteTaskEnvelope(issue.body),
    );
    const first = envelopes[0]!;
    const plan = {
      cycleId: first.cycleId,
      goal: first.goal,
      tasks: envelopes.map((envelope, i) => ({
        ...envelope.task,
        spec: {
          ...envelope.task.spec,
          dependencies: dependent && i === 1 ? ["T1"] : [],
          ...(skipScout ? { risk: "low" as const, skipScout: true } : {}),
        },
      })),
    };
    for (const [i, issue] of remote.issues.entries()) {
      const envelope = remoteTaskEnvelope(plan, `T${i + 1}`);
      issue.body = renderRemoteTaskBody(envelope);
      issue.comments[0]!.body = renderRemoteTaskApproval(envelope);
    }
  }
  const data = {
    base: initialBase,
    check: "pending",
    ancestry: true,
    unreadablePr: false,
    denyCheckpoint: false,
    afterPolicy: undefined as (() => void) | undefined,
    beforeMerge: undefined as ((number: number) => Promise<void>) | undefined,
    beforeRefresh: undefined as (() => Promise<void>) | undefined,
    afterRefresh: undefined as (() => void) | undefined,
    beforeRole: undefined as
      | ((request: HarnessStepRequest) => Promise<void>)
      | undefined,
    refreshError: false,
    responses: new Map<number, "success" | "denied" | "lost">(),
  };
  let writes = 0;
  let roleCalls = 0;
  const events: string[] = [];
  const requests: HarnessStepRequest[] = [];
  const publications: Parameters<
    import("../../src/github/pr-publisher").TaskPublisher["publish"]
  >[0][] = [];
  const protocol = protocolGitHub(remote.issues);
  const reader = new GitHubRemoteIssueReader("/fixture", {
    async run(input) {
      if (input.command.includes("POST") || input.command.includes("PATCH")) {
        writes++;
        if (data.denyCheckpoint)
          throw Error("unknown checkpoint write outcome");
      }
      return protocol.command.run(input);
    },
  });
  const store = new GitHubExecutionStore(
    "acme/test",
    "daemon",
    new Set(["owner"]),
    reader,
  );
  const prs = new Map<
    number,
    {
      number: number;
      state: string;
      merged: boolean;
      merge_commit_sha: string | null;
      draft: boolean;
      mergeable: boolean;
      mergeable_state: string;
      head: { ref: string; sha: string; repository: string };
      base: { ref: string; sha: string; repository: string };
    }
  >();
  const fake = createFakeHarness({
    attempts: remote.issues.flatMap((issue) =>
      ["scout", "implement", "review"]
        .filter((role) => !skipScout || role !== "scout")
        .map((role) => ({
          taskId: `issue-${issue.number}`,
          role,
          retryIndex: 0,
          expect: { model, effort: role === "implement" ? "medium" : "high" },
          deliveries: [
            {
              nextCursor: "output",
              event: {
                type: "attempt.output",
                eventId: "output",
                attemptId: "fixture",
                sequence: 1,
                occurredAt: time,
                output:
                  role === "scout"
                    ? {
                        kind: role,
                        summary: "Inspect approved paths",
                        files: ["src/0.ts"],
                        tests: ["bun test"],
                        risks: [],
                      }
                    : role === "implement"
                      ? {
                          kind: role,
                          commitSha: sha("b", issue.number),
                          validation: ["Fake validation completed"],
                          risks: [],
                          limitations: [],
                        }
                      : {
                          kind: role,
                          decision: "accepted",
                          findings: [],
                          remainingGaps: [],
                        },
              },
            },
            {
              nextCursor: "completed",
              event: {
                type: "attempt.completed",
                eventId: "completed",
                attemptId: "fixture",
                sequence: 2,
                occurredAt: time,
              },
            },
          ],
        })),
    ),
  });
  const branches: TaskBranchManager = {
    async prepare(taskId, baseCommit = initialBase) {
      return {
        taskId,
        path: "/fixture",
        branch: `agile/${taskId}`,
        baseCommit,
      };
    },
    async refresh(taskId, input) {
      const number = Number(taskId.slice(6));
      const record = (await store.get(number)).execution!;
      const receipt = record.refreshes!.at(-1)!;
      expect(receipt).toEqual({
        expectedHead: input.expectedHead,
        expectedBase: input.expectedBase,
        targetBase: input.targetBase,
        budgetRemaining: 2 - record.refreshes!.length,
      });
      expect(record.mergeReview).toBeUndefined();
      expect(record.baseCommit).toBe(input.expectedBase);
      expect(record.publication!.commitSha).toBe(input.expectedHead);
      events.push(`refresh-start:${number}`);
      await data.beforeRefresh?.();
      if (data.refreshError) throw Error("Conflict or unsafe workspace");
      const pr = prs.get(number)!;
      expect(pr.head.sha).toBe(input.expectedHead);
      const head = sha(record.refreshes!.length === 1 ? "d" : "e", number);
      pr.head.sha = head;
      pr.base.sha = input.targetBase;
      data.check = "pending";
      events.push(`refresh-end:${number}`);
      data.afterRefresh?.();
      return head;
    },
    async restoreChanges() {},
    async commitChanges() {
      throw Error("Fake Implement supplies its trusted commit");
    },
    async assertCommit() {},
    async assertReviewReady(id, head, base) {
      events.push(`review-ready:${id}:${head}:${base}`);
    },
    async status() {
      return "";
    },
  };
  const command: GitHubCommandRunner = {
    async run({ command }) {
      let value: unknown;
      if (command[0] === "git") {
        events.push(command.join(" "));
        if (command[1] === "merge-base" && !data.ancestry)
          return { exitCode: 1, stdout: "", stderr: "missing ancestry" };
        return { exitCode: 0, stdout: data.base, stderr: "" };
      }
      if (command[1] === "pr") {
        const number = Number(command[3]);
        const pr = prs.get(number)!;
        if (command.at(-1)?.includes("reviewDecision")) {
          data.afterPolicy?.();
          value = {
            number,
            headRefOid: pr.head.sha,
            reviewDecision: "APPROVED",
          };
        } else
          value = {
            number,
            state: pr.merged ? "MERGED" : pr.state.toUpperCase(),
            baseRefName: pr.base.ref,
            headRefName: pr.head.ref,
            headRefOid: pr.head.sha,
            mergeCommit: pr.merge_commit_sha
              ? { oid: pr.merge_commit_sha }
              : null,
          };
      } else {
        const path = command[2]!;
        const number = Number(path.match(/\/pulls\/(\d+)/)?.[1]);
        if (command.includes("PUT")) {
          expect(command).toContain(`sha=${prs.get(number)!.head.sha}`);
          events.push(`merge-start:${number}`);
          await data.beforeMerge?.(number);
          const response = data.responses.get(number) ?? "success";
          if (response !== "denied") {
            const pr = prs.get(number)!;
            pr.state = "closed";
            pr.merged = true;
            pr.merge_commit_sha = sha("c", number);
            data.base = pr.merge_commit_sha;
          }
          events.push(`merge-end:${number}`);
          if (response === "lost") throw Error("merge response lost");
          return {
            exitCode: response === "denied" ? 1 : 0,
            stdout: "{}",
            stderr: "",
          };
        }
        if (number) {
          events.push(`read-pr:${number}`);
          if (data.unreadablePr)
            return { exitCode: 1, stdout: "", stderr: "offline" };
          value = prs.get(number);
        } else if (path.includes("/git/ref/"))
          value = { ref: "refs/heads/main", sha: data.base, type: "commit" };
        else if (path.endsWith("/protection"))
          value = {
            strict: true,
            enforceAdmins: true,
            contexts: ["CI"],
            checks: [{ context: "CI", app_id: 42 }],
            requiredReviews: {
              required_approving_review_count: 1,
              require_code_owner_reviews: false,
              require_last_push_approval: false,
            },
          };
        else if (path.includes("/rules/"))
          value = { total_count: null, items: [] };
        else if (path.includes("/check-runs"))
          value = {
            total_count: 1,
            items: [
              {
                id: 1,
                name: "CI",
                head_sha: path.split("/")[4],
                app_id: 42,
                status: data.check === "pending" ? "in_progress" : "completed",
                conclusion: data.check === "pending" ? null : data.check,
              },
            ],
          };
        else if (path.includes("/statuses"))
          value = { total_count: null, items: [] };
        else throw Error(`Unexpected transport command: ${command.join(" ")}`);
      }
      return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
    },
  };
  const input = {
    store,
    branches,
    command,
    cwd: "/fixture",
    baseBranch: "main",
    harness: {
      async step(request: Parameters<typeof fake.harness.step>[0]) {
        roleCalls++;
        requests.push(structuredClone(request));
        await data.beforeRole?.(request);
        return fake.harness.step(request);
      },
      async cancel() {},
    },
    advisor: createModelAdvisor(
      [{ id: model, supportedReasoningEfforts: ["medium", "high", "xhigh"] }],
      { luna: model, terra: model, sol: model },
    ),
    publisher: {
      baseBranch: "main",
      async publish(
        input: Parameters<
          import("../../src/github/pr-publisher").TaskPublisher["publish"]
        >[0],
      ) {
        publications.push(structuredClone(input));
        const number = Number(input.task.id.slice(6));
        events.push(
          `publish:${number}:${input.acceptance === undefined ? "unverified" : "evidence"}`,
        );
        prs.set(number, {
          number,
          state: "open",
          merged: false,
          merge_commit_sha: null,
          draft: false,
          mergeable: true,
          mergeable_state: "clean",
          head: {
            ref: input.publication.branch,
            sha: input.publication.commitSha,
            repository: "acme/test",
          },
          base: {
            ref: "main",
            sha: input.task.baseCommit!,
            repository: "acme/test",
          },
        });
        return {
          number,
          state: "OPEN" as const,
          url: `https://github.com/acme/test/pull/${number}`,
        };
      },
    },
  };
  return {
    ...remote,
    protocol,
    reader,
    store,
    fake,
    input,
    data,
    prs,
    events,
    requests,
    publications,
    scriptReview(number = 41, decision: "accepted" | "rejected" = "accepted") {
      fake.scriptAttempt({
        taskId: `issue-${number}`,
        role: "review",
        retryIndex: 0,
        expect: { model, effort: "high" },
        deliveries: [
          {
            nextCursor: "usage",
            event: {
              type: "attempt.usage_delta",
              eventId: "usage",
              attemptId: "fresh-review",
              sequence: 1,
              occurredAt: time,
              inputTokens: 101,
              cachedInputTokens: 10,
              outputTokens: 12,
              reasoningOutputTokens: 3,
            },
          },
          {
            nextCursor: "output",
            event: {
              type: "attempt.output",
              eventId: "output",
              attemptId: "fresh-review",
              sequence: 2,
              occurredAt: time,
              output: {
                kind: "review",
                decision,
                findings: [],
                remainingGaps: [],
              },
            },
          },
          {
            nextCursor: "completed",
            event: {
              type: "attempt.completed",
              eventId: "completed",
              attemptId: "fresh-review",
              sequence: 3,
              occurredAt: time,
            },
          },
        ],
      });
    },
    writes: () => writes,
    roleCalls: () => roleCalls,
    runner: (autoMerge = false) =>
      new GitHubTaskRunner({ ...input, autoMerge }),
    async record(number = 41) {
      return (await store.get(number)).execution!;
    },
    async alter(change: (record: ExecutionRecord) => void, number = 41) {
      const record = (await store.get(number)).execution!;
      change(record);
      remote.issues
        .find((issue) => issue.number === number)!
        .comments.find((comment) => comment.author?.login === "daemon")!.body =
        renderExecution(record);
    },
  };
}

/** Executes one coordinator tick with a fresh process-equivalent runner. */
async function tick(f: ReturnType<typeof fixture>, autoMerge = true) {
  return f.runner(autoMerge).runOnce(new AbortController().signal);
}

test("manual default, exact Review evidence, stable CI polling, lost merge response and confirmed dependency release", async () => {
  const f = fixture(2, true);
  expect(await tick(f, false)).toBe(true);
  const reviewed = await f.record();
  expect(reviewed.phase).toBe("awaiting_merge");
  expect(reviewed.mergeReview).toEqual({
    specHash: jsonHash((await f.store.get(41)).envelope),
    headSha: sha("b", 41),
    baseSha: initialBase,
    reviewAttemptId: reviewed.attempts[2]!.descriptor.attemptId,
  });
  const beforePoll = f.writes();
  expect(await tick(f, false)).toBe(false);
  expect(f.writes()).toBe(beforePoll);
  expect(f.events.some((event) => event.startsWith("merge-start"))).toBe(false);
  expect(await tick(f)).toBe(false);
  expect((await f.record()).failure).toContain("must pass");
  const waitingWrites = f.writes();
  for (let i = 0; i < 3; i++) expect(await tick(f)).toBe(false);
  expect(f.writes()).toBe(waitingWrites);
  expect(f.roleCalls()).toBe(6);
  expect((await f.store.get(42)).execution).toBeUndefined();
  f.data.check = "success";
  f.data.responses.set(41, "lost");
  // An unverified remote merge does not mark done or release a dependent Issue.
  f.data.ancestry = false;
  expect(await tick(f)).toBe(false);
  expect((await f.record()).phase).toBe("awaiting_merge");
  expect((await f.record()).failure).toContain("ancestry");
  expect((await f.store.get(42)).execution).toBeUndefined();
  f.data.ancestry = true;
  expect(await tick(f)).toBe(true);
  expect(await f.record()).toMatchObject({
    phase: "done",
    publication: { mergeCommit: sha("c", 41) },
  });
  expect((await f.record()).failure).toBeUndefined();
  expect(await f.record(42)).toMatchObject({
    phase: "awaiting_merge",
    baseCommit: sha("c", 41),
    mergeReview: { baseSha: sha("c", 41) },
  });
  expect(f.events.filter((event) => event === "merge-start:41")).toHaveLength(
    1,
  );
  expect(f.events).toContain(
    `git merge-base --is-ancestor ${sha("c", 41)} refs/remotes/origin/main`,
  );
  expect(f.events).toContain(
    `git merge-base --is-ancestor ${sha("c", 41)} ${sha("c", 41)}`,
  );
  expect(await tick(f)).toBe(false);
  expect((await f.record(42)).phase).toBe("done");
  f.fake.assertComplete();
});

for (const autoMerge of [false, true]) {
  test(`closed Issue recovers a merged PR after restart and releases its dependent (autoMerge=${autoMerge})`, async () => {
    const f = fixture(2, true);
    expect(await tick(f, autoMerge)).toBe(true);
    const awaiting = await f.record();
    expect(awaiting.phase).toBe("awaiting_merge");
    expect(f.roleCalls()).toBe(6);
    f.issues[0]!.state = "CLOSED";
    const pr = f.prs.get(41)!;
    pr.state = "closed";
    pr.merged = true;
    pr.merge_commit_sha = sha("c", 41);
    f.data.base = pr.merge_commit_sha;
    expect((await f.store.get(41)).task.status).toBe("retired");

    // Remote completion alone cannot repair the checkpoint or release dependencies.
    f.data.ancestry = false;
    expect(await tick(f, autoMerge)).toBe(false);
    expect((await f.record()).phase).toBe("awaiting_merge");
    expect((await f.record()).failure).toContain("ancestry");
    expect((await f.store.get(42)).execution).toBeUndefined();
    expect(f.roleCalls()).toBe(6);

    f.data.ancestry = true;
    expect(await tick(f, autoMerge)).toBe(true);
    expect(await f.record()).toMatchObject({
      phase: "done",
      publication: { mergeCommit: sha("c", 41) },
      attempts: awaiting.attempts,
    });
    expect((await f.record()).failure).toBeUndefined();
    expect((await f.store.get(41)).task.status).toBe("done");
    expect(await f.record(42)).toMatchObject({
      phase: "awaiting_merge",
      baseCommit: sha("c", 41),
      mergeReview: { baseSha: sha("c", 41) },
    });
    expect(f.events).toContain(
      `git merge-base --is-ancestor ${sha("c", 41)} refs/remotes/origin/main`,
    );
    expect(f.events).toContain(
      `git merge-base --is-ancestor ${sha("c", 41)} ${sha("c", 41)}`,
    );
    expect(f.events.some((event) => event.startsWith("merge-start"))).toBe(
      false,
    );
    expect(f.roleCalls()).toBe(12);
    f.fake.assertComplete();
  });

  test(`closed Issue never authorizes merging an open PR (autoMerge=${autoMerge})`, async () => {
    const f = fixture(2, true);
    expect(await tick(f, autoMerge)).toBe(true);
    const awaiting = await f.record();
    expect(awaiting.phase).toBe("awaiting_merge");
    f.issues[0]!.state = "CLOSED";
    f.data.check = "success";
    const writes = f.writes();
    for (let i = 0; i < 2; i++) expect(await tick(f, autoMerge)).toBe(false);
    expect(await f.record()).toEqual(awaiting);
    expect(f.writes()).toBe(writes);
    expect(f.prs.get(41)!.merged).toBe(false);
    expect((await f.store.get(42)).execution).toBeUndefined();
    expect(f.events.some((event) => event.startsWith("merge-start"))).toBe(
      false,
    );
    expect(f.roleCalls()).toBe(6);
  });
}

test("approval withdrawal at the last policy read blocks merge without replaying agents", async () => {
  for (const close of [false, true]) {
    const f = fixture();
    await tick(f, false);
    f.data.check = "success";
    f.data.afterPolicy = () => {
      if (close) f.issues[0]!.state = "CLOSED";
      else
        f.issues[0]!.comments = f.issues[0]!.comments.filter(
          (comment) => comment.author?.login !== "owner",
        );
    };
    await tick(f);
    expect((await f.record()).phase).toBe("awaiting_merge");
    expect((await f.record()).failure).toContain("approval");
    const writes = f.writes();
    await tick(f);
    expect(f.writes()).toBe(writes);
    expect(f.events.some((event) => event.startsWith("merge-start"))).toBe(
      false,
    );
    expect(f.roleCalls()).toBe(6);
  }
});

test("changed external head, closed PR and missing or rejected Review evidence require replan", async () => {
  for (const change of [
    async (f: ReturnType<typeof fixture>) => {
      f.prs.get(41)!.head.sha = sha("d", 41);
    },
    async (f: ReturnType<typeof fixture>) => {
      f.prs.get(41)!.state = "closed";
    },
    async (f: ReturnType<typeof fixture>) => {
      await f.alter((record) => {
        delete record.mergeReview;
      });
    },
    async (f: ReturnType<typeof fixture>) => {
      await f.alter((record) => {
        record.mergeReview!.specHash = `sha256:${"0".repeat(64)}`;
      });
    },
    async (f: ReturnType<typeof fixture>) => {
      await f.alter((record) => {
        const review = record.attempts[2]!.output;
        if (review?.kind === "review") review.decision = "rejected";
      });
    },
  ]) {
    const f = fixture();
    await tick(f, false);
    f.data.check = "success";
    await change(f);
    await tick(f);
    expect((await f.record()).phase).toBe("needs_replan");
    expect(f.events.some((event) => event.startsWith("merge-start"))).toBe(
      false,
    );
    expect(f.roleCalls()).toBe(6);
  }
});

test("the single pool selector serializes merge operations and reads back before considering the next PR", async () => {
  const f = fixture(2);
  await tick(f, false);
  await tick(f, false);
  f.data.check = "success";
  f.data.responses.set(41, "denied");
  const started = barrier();
  const finish = barrier();
  f.data.beforeMerge = async (number) => {
    if (number === 41) {
      started.release();
      await finish.promise;
    }
  };
  const pool = new GitHubTaskPool({
    ...f.input,
    autoMerge: true,
    concurrency: 2,
  });
  const running = pool.run(new AbortController().signal, true);
  await started.promise;
  expect(f.events.filter((event) => event.startsWith("merge-start"))).toEqual([
    "merge-start:41",
  ]);
  finish.release();
  await running;
  const end = f.events.indexOf("merge-end:41");
  const next = f.events.indexOf("merge-start:42");
  expect(next).toBeGreaterThan(end);
  expect(f.events.slice(end + 1, next)).toContain("read-pr:41");
  expect((await f.record()).phase).toBe("awaiting_merge");
  expect((await f.record(42)).phase).toBe("done");
});

test("shutdown drains submitted merge readback without completing or starting another merge", async () => {
  const f = fixture(2);
  await tick(f, false);
  await tick(f, false);
  f.data.check = "success";
  const started = barrier();
  const finish = barrier();
  f.data.beforeMerge = async () => {
    started.release();
    await finish.promise;
  };
  const pool = new GitHubTaskPool({ ...f.input, autoMerge: true });
  const running = pool.run(new AbortController().signal, true);
  const settled = running.catch((error) => error);
  await started.promise;
  let drained = false;
  const cancelled = pool.cancel().then(() => {
    drained = true;
  });
  await Bun.sleep(10);
  expect(drained).toBe(false);
  finish.release();
  await cancelled;
  expect(await settled).toBeInstanceOf(Error);
  expect(f.events.filter((event) => event.startsWith("merge-start"))).toEqual([
    "merge-start:41",
  ]);
  expect(f.events.at(-1)).toBe("read-pr:41");
  expect((await f.record()).phase).toBe("awaiting_merge");
  // A new coordinator confirms the already merged PR rather than submitting again.
  await tick(f);
  expect((await f.record()).phase).toBe("done");
  expect((await f.record(42)).phase).toBe("awaiting_merge");
  expect((await f.record(42)).refreshes).toHaveLength(1);
});

test("parallel PR merge refreshes the next patch, runs an independent exact-target Review and waits for new CI", async () => {
  const f = fixture(2);
  await tick(f, false);
  await tick(f, false);
  const original = await f.record(42);
  const envelope = (await f.store.get(42)).envelope;
  const body = f.issues[1]!.body;
  f.scriptReview(42);
  f.data.check = "success";
  await tick(f);
  expect((await f.record()).phase).toBe("done");
  const refreshed = await f.record(42);
  expect(refreshed).toMatchObject({
    phase: "awaiting_merge",
    specHash: jsonHash(envelope),
    baseCommit: sha("c", 41),
    refreshes: [
      {
        expectedHead: sha("b", 42),
        expectedBase: initialBase,
        targetBase: sha("c", 41),
        budgetRemaining: 1,
        result: { headSha: sha("d", 42) },
      },
    ],
    publication: { number: 42, commitSha: sha("d", 42) },
    mergeReview: { headSha: sha("d", 42), baseSha: sha("c", 41) },
  });
  expect(f.issues[1]!.body).toBe(body);
  expect(refreshed.attempts.slice(0, 3)).toEqual(original.attempts);
  expect(refreshed.hooks).toEqual(original.hooks);
  expect(refreshed.attempts).toHaveLength(4);
  const review = refreshed.attempts[3]!;
  expect(review).toMatchObject({
    descriptor: {
      role: "review",
      model,
      effort: "high",
      retryIndex: 0,
      modelProfile: "sol",
    },
    status: "succeeded",
    usageKnown: true,
    reviewTarget: { headSha: sha("d", 42), baseSha: sha("c", 41) },
    usage: {
      inputTokens: 101,
      cachedInputTokens: 10,
      outputTokens: 12,
      reasoningOutputTokens: 3,
    },
  });
  expect(review.descriptor.attemptId).not.toBe(
    original.attempts[2]!.descriptor.attemptId,
  );
  expect(refreshed.mergeReview!.reviewAttemptId).toBe(
    review.descriptor.attemptId,
  );
  expect(f.requests.at(-1)!.input).toMatchObject({
    role: "review",
    ticket: { spec: envelope.task.spec, baseCommit: sha("c", 41) },
    implementation: {
      commitSha: sha("d", 42),
      validation: ["Fake validation completed"],
    },
  });
  expect(f.events).toContain(
    `review-ready:issue-42:${sha("d", 42)}:${sha("c", 41)}`,
  );
  expect(f.events.indexOf("refresh-start:42")).toBeGreaterThan(
    f.events.indexOf("merge-end:41"),
  );
  const refreshedPublication = f.publications
    .filter((item) => item.task.id === "issue-42")
    .at(-1);
  const invalidatedPublication = f.publications
    .filter((item) => item.task.id === "issue-42")
    .at(-2);
  expect(invalidatedPublication).toMatchObject({
    task: { baseCommit: initialBase },
    publication: { commitSha: sha("b", 42) },
    reconcileOnly: true,
  });
  expect(invalidatedPublication?.acceptance).toBeUndefined();
  expect(f.events.lastIndexOf("publish:42:unverified")).toBeLessThan(
    f.events.indexOf("refresh-start:42"),
  );
  expect(refreshedPublication).toMatchObject({
    task: { baseCommit: sha("c", 41) },
    publication: { commitSha: sha("d", 42) },
    acceptance: {
      binding: {
        currentHeadSha: sha("d", 42),
        currentBaseSha: sha("c", 41),
        reviewedHeadSha: sha("d", 42),
        reviewedBaseSha: sha("c", 41),
      },
    },
  });
  const roles = f.roleCalls();
  await tick(f);
  expect((await f.record(42)).failure).toContain("must pass");
  const writes = f.writes();
  await tick(f);
  expect(f.writes()).toBe(writes);
  expect(f.roleCalls()).toBe(roles);
  expect(f.prs.get(42)!.merged).toBe(false);
  f.data.check = "success";
  await tick(f);
  expect((await f.record(42)).phase).toBe("done");
  expect(f.events.filter((event) => event === "merge-start:42")).toHaveLength(
    1,
  );
  f.fake.assertComplete();
});

test("withdrawn authority during pre-refresh checklist invalidation prevents branch mutation", async () => {
  const f = fixture(2);
  await tick(f, false);
  await tick(f, false);
  const task = await f.store.get(42);
  const get = f.store.get.bind(f.store);
  let reads = 0;
  let withdrawn = false;
  let withdrawalRead = 0;
  f.store.get = async (number) => {
    const task = await get(number);
    if (number !== 42) return task;
    reads++;
    if (reads !== 4) return task;
    withdrawn = true;
    withdrawalRead = reads;
    return { ...task, approved: false };
  };
  const publications = f.publications.length;
  const runner = new GitHubTaskRunner(f.input);
  const refreshBase = Reflect.get(runner, "refreshBase");
  if (typeof refreshBase !== "function") throw Error("Missing refreshBase");
  await refreshBase.call(
    runner,
    task,
    sha("c", 41),
    new AbortController().signal,
  );
  expect(withdrawn).toBe(true);
  expect(withdrawalRead).toBe(4);
  const record = await f.record(42);
  expect(f.events).not.toContain("refresh-start:42");
  expect(f.publications).toHaveLength(publications);
  expect(record.publication?.commitSha).toBe(sha("b", 42));
  expect(record.refreshes?.[0]?.result).toBeUndefined();
  expect(record.attempts).toHaveLength(3);
  expect(f.prs.get(42)?.merged).toBe(false);
});

test("approved Scout omission retains exact-head Review, re-review after refresh and original Implement history", async () => {
  const f = fixture(1, false, true);
  await tick(f, false);
  const original = await f.record();
  expect(original.attempts.map((attempt) => attempt.descriptor.role)).toEqual([
    "implement",
    "review",
  ]);
  f.data.base = sha("c", 42);
  f.scriptReview();
  await tick(f);
  const refreshed = await f.record();
  expect(refreshed.attempts.map((attempt) => attempt.descriptor.role)).toEqual([
    "implement",
    "review",
    "review",
  ]);
  expect(refreshed.attempts[0]).toEqual(original.attempts[0]);
  expect(refreshed.mergeReview?.headSha).toBe(refreshed.publication?.commitSha);
  expect(
    f.requests.every(
      (request) =>
        request.input.role === "scout" || request.input.scout === undefined,
    ),
  ).toBe(true);
  f.data.check = "success";
  await tick(f);
  expect((await f.record()).phase).toBe("done");
});

test("two durable refresh cycles are independent of infrastructure retries and a third advancement requires replan across restarts", async () => {
  const f = fixture();
  await tick(f, false);
  const original = await f.record();
  for (let cycle = 1; cycle <= 2; cycle++) {
    f.data.base = sha("c", 41 + cycle);
    f.scriptReview();
    await tick(f);
    const record = await f.record();
    expect(record.phase).toBe("awaiting_merge");
    expect(record.refreshes).toHaveLength(cycle);
    expect(record.refreshes!.at(-1)!.budgetRemaining).toBe(2 - cycle);
    expect(record.attempts).toHaveLength(3 + cycle);
    expect(record.attempts.at(-1)!.descriptor.retryIndex).toBe(0);
    expect(record.attempts.slice(0, 3)).toEqual(original.attempts);
  }
  f.data.base = sha("c", 44);
  f.data.check = "success";
  const roles = f.roleCalls();
  await tick(f);
  expect(await f.record()).toMatchObject({
    phase: "needs_replan",
    failure: expect.stringContaining("budget exhausted"),
  });
  expect((await f.record()).refreshes).toHaveLength(2);
  expect(
    new Set(
      (await f.record()).attempts.map(
        (attempt) => attempt.descriptor.attemptId,
      ),
    ).size,
  ).toBe(5);
  await tick(f);
  expect(f.roleCalls()).toBe(roles);
  expect(f.events.filter((event) => event === "refresh-start:41")).toHaveLength(
    2,
  );
  expect(f.prs.get(41)!.merged).toBe(false);
  f.fake.assertComplete();
});

test("rejected fresh Review and unsafe Git refresh require replan without altering historical attempts or replaying publication", async () => {
  for (const unsafe of [false, true]) {
    const f = fixture();
    await tick(f, false);
    const original = await f.record();
    f.data.base = sha("c", 42);
    f.data.refreshError = unsafe;
    if (!unsafe) f.scriptReview(41, "rejected");
    await tick(f);
    const record = await f.record();
    expect(record.phase).toBe("needs_replan");
    expect(record.mergeReview).toBeUndefined();
    expect(record.attempts.slice(0, 3)).toEqual(original.attempts);
    expect(record.attempts).toHaveLength(unsafe ? 3 : 4);
    expect(record.publication!.commitSha).toBe(
      unsafe ? original.publication!.commitSha : sha("d", 41),
    );
    if (!unsafe) expect(record.failure).toContain("Review rejected");
    const roles = f.roleCalls();
    await tick(f);
    expect(f.roleCalls()).toBe(roles);
    expect(f.prs.get(41)!.merged).toBe(false);
    f.fake.assertComplete();
  }
});

test("an interrupted refresh intent never authorizes merge or blindly restarts Git, even with stale accepted evidence", async () => {
  for (const phase of ["awaiting_merge", "reviewing"] as const) {
    const f = fixture();
    await tick(f, false);
    await f.alter((record) => {
      record.phase = phase;
      record.refreshes = [
        {
          expectedHead: record.publication!.commitSha,
          expectedBase: initialBase,
          targetBase: sha("c", 42),
          budgetRemaining: 1,
        },
      ];
    });
    f.data.check = "success";
    await tick(f);
    expect((await f.record()).phase).toBe("needs_replan");
    expect(f.roleCalls()).toBe(6);
    expect(f.events.some((event) => /^(refresh|merge)-start/.test(event))).toBe(
      false,
    );
  }
});

test("unknown refresh intent/result checkpoint writes retain daemon ownership and never start a Review", async () => {
  for (const afterPush of [false, true]) {
    const f = fixture();
    await tick(f, false);
    f.data.base = sha("c", 42);
    if (afterPush)
      f.data.afterRefresh = () => {
        f.data.denyCheckpoint = true;
      };
    else f.data.denyCheckpoint = true;
    const pool = new GitHubTaskPool({ ...f.input, autoMerge: true });
    await expect(
      pool.run(new AbortController().signal, true),
    ).rejects.toMatchObject({ code: "GITHUB_CHECKPOINT_UNCONFIRMED" });
    expect(f.roleCalls()).toBe(6);
    const record = await f.record();
    expect(record.phase).toBe("awaiting_merge");
    expect(record.refreshes?.[0]?.result).toBeUndefined();
    expect(
      f.events.filter((event) => event === "refresh-start:41"),
    ).toHaveLength(afterPush ? 1 : 0);
    if (afterPush) {
      f.data.denyCheckpoint = false;
      await tick(f);
      expect((await f.record()).phase).toBe("needs_replan");
      expect(
        f.events.filter((event) => event === "refresh-start:41"),
      ).toHaveLength(1);
    }
  }
});

test("shutdown waits for selector-owned refresh and preserves an ambiguous intent instead of dispatching Review or a sibling merge", async () => {
  const f = fixture(2);
  await tick(f, false);
  await tick(f, false);
  f.data.base = sha("c", 43);
  const started = barrier();
  const finish = barrier();
  f.data.beforeRefresh = async () => {
    started.release();
    await finish.promise;
  };
  const pool = new GitHubTaskPool({ ...f.input, autoMerge: true });
  const running = pool
    .run(new AbortController().signal, true)
    .catch((error) => error);
  await started.promise;
  let drained = false;
  const cancelled = pool.cancel().then(() => {
    drained = true;
  });
  await Bun.sleep(10);
  expect(drained).toBe(false);
  finish.release();
  await cancelled;
  expect(await running).toBeInstanceOf(Error);
  expect(
    f.events.filter((event) => /^(refresh|merge)-start/.test(event)),
  ).toEqual(["refresh-start:41"]);
  expect(await f.record()).toMatchObject({
    phase: "needs_replan",
    failure: expect.stringContaining("cancelled"),
  });
  expect((await f.record()).refreshes![0]!.result).toBeUndefined();
  expect(f.roleCalls()).toBe(12);
});

test("cancelling a selector-owned fresh Review drains its child before returning and cannot reuse the old acceptance", async () => {
  const f = fixture();
  await tick(f, false);
  f.data.base = sha("c", 42);
  f.scriptReview();
  const started = barrier();
  const finish = barrier();
  f.data.beforeRole = async () => {
    started.release();
    await finish.promise;
  };
  let cancelledAttempt: string | undefined;
  const pool = new GitHubTaskPool({
    ...f.input,
    autoMerge: true,
    harness: {
      ...f.input.harness,
      async cancel(attemptId) {
        cancelledAttempt = attemptId;
      },
    },
  });
  const running = pool.run(new AbortController().signal, true);
  await started.promise;
  let drained = false;
  const cancelled = pool.cancel("issue-41").then(() => {
    drained = true;
  });
  await Bun.sleep(10);
  expect(drained).toBe(false);
  finish.release();
  await cancelled;
  await running;
  const record = await f.record();
  expect(record.phase).toBe("needs_replan");
  expect(record.attempts.at(-1)!.status).toBe("blocked_policy");
  expect(cancelledAttempt).toBe(record.attempts.at(-1)!.descriptor.attemptId);
  expect(record.mergeReview).toBeUndefined();
  expect(f.prs.get(41)!.merged).toBe(false);
});

test("selector-owned Review failures preserve safe diagnostic attribution", async () => {
  const f = fixture();
  await tick(f, false);
  f.data.base = sha("c", 42);
  const errors: AgileError[] = [];
  f.data.beforeRole = async () => {
    throw new AgileError({
      code: "GITHUB_READ_FAILED",
      category: "infra",
      component: "github-state",
      retryable: true,
      message: "GitHub read failed",
      cause: Error("private token"),
    });
  };
  const pool = new GitHubTaskPool({
    ...f.input,
    autoMerge: true,
    async logError(error) {
      errors.push(error);
    },
  });
  await pool.run(new AbortController().signal, true);
  const record = await f.record();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    code: "GITHUB_READ_FAILED",
    taskId: "issue-41",
    attemptId: record.attempts.at(-1)!.descriptor.attemptId,
  });
  expect(record.failure).toContain("GITHUB_READ_FAILED");
  expect(record.failure).toContain("reviewing");
  expect(record.failure).not.toContain("private token");
  expect(record.phase).toBe("needs_replan");
});

test("selector-owned Review keeps authority polling alive and cancels on approval withdrawal", async () => {
  const f = fixture();
  await tick(f, false);
  f.data.base = sha("c", 42);
  f.scriptReview();
  const started = barrier();
  const finish = barrier();
  f.data.beforeRole = async (request) => {
    if (request.backendCursor) {
      started.release();
      await finish.promise;
    }
  };
  let cancellations = 0;
  const pool = new GitHubTaskPool({
    ...f.input,
    autoMerge: true,
    harness: {
      ...f.input.harness,
      async cancel() {
        cancellations++;
        finish.release();
      },
    },
  });
  const setTimer = globalThis.setTimeout;
  const accelerated = Object.assign(
    (...[handler, delay, ...args]: Parameters<typeof setTimeout>) =>
      setTimer(handler, delay === 30_000 ? 1 : delay, ...args),
    { __promisify__: setTimer.__promisify__ },
  );
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    accelerated as typeof setTimeout,
  );
  try {
    const running = pool.run(new AbortController().signal, true);
    await started.promise;
    f.issues[0]!.comments = f.issues[0]!.comments.filter(
      (comment) => comment.author?.login !== "owner",
    );
    await running;
    expect(cancellations).toBeGreaterThan(0);
    expect((await f.record()).phase).toBe("needs_replan");
    expect((await f.record()).mergeReview).toBeUndefined();
    expect(f.prs.get(41)!.merged).toBe(false);
  } finally {
    timer.mockRestore();
  }
});

test("selector-owned Review survives a missing list entry after direct authority confirmation", async () => {
  const f = fixture();
  await tick(f, false);
  f.data.base = sha("c", 42);
  f.scriptReview();
  const finish = barrier();
  let reviewing = false;
  let omitted = false;
  let confirmations = 0;
  let cancellations = 0;
  f.data.beforeRole = async (request) => {
    if (request.backendCursor) {
      reviewing = true;
      await finish.promise;
    }
  };
  const list = f.store.list.bind(f.store);
  f.store.list = async () => {
    const snapshot = await list();
    if (reviewing && !omitted) {
      omitted = true;
      return { ...snapshot, tasks: [] };
    }
    return snapshot;
  };
  const confirm = f.store.confirmCancellation.bind(f.store);
  f.store.confirmCancellation = async (task, observed) => {
    const reason = await confirm(task, observed);
    if (reviewing && !observed) {
      confirmations++;
      finish.release();
    }
    return reason;
  };
  const pool = new GitHubTaskPool({
    ...f.input,
    autoMerge: true,
    harness: {
      ...f.input.harness,
      async cancel() {
        cancellations++;
        finish.release();
      },
    },
  });
  const setTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign(
      (...[handler, delay, ...args]: Parameters<typeof setTimeout>) =>
        setTimer(handler, delay === 30_000 ? 1 : delay, ...args),
      { __promisify__: setTimer.__promisify__ },
    ) as typeof setTimeout,
  );
  try {
    await pool.run(new AbortController().signal, true);
    expect(confirmations).toBe(1);
    expect(cancellations).toBe(0);
    const record = await f.record();
    expect(record.phase).toBe("awaiting_merge");
    expect(record.mergeReview?.headSha).toBe(record.publication?.commitSha);
    expect(record.refreshes).toHaveLength(1);
    expect(record.attempts.at(-1)?.status).toBe("succeeded");
    expect(f.prs.get(41)?.merged).toBe(false);
  } finally {
    finish.release();
    await pool.cancel();
    timer.mockRestore();
  }
});

test("unknown done checkpoint writes remain daemon failures and cannot release dependencies", async () => {
  const f = fixture(2, true);
  await tick(f, false);
  f.data.check = "success";
  f.data.denyCheckpoint = true;
  await expect(tick(f)).rejects.toMatchObject({
    code: "GITHUB_CHECKPOINT_UNCONFIRMED",
  });
  expect((await f.record()).phase).toBe("awaiting_merge");
  expect((await f.store.get(42)).execution).toBeUndefined();
  f.data.denyCheckpoint = false;
  expect(await tick(f)).toBe(true);
  expect((await f.record()).phase).toBe("done");
  expect(f.events.filter((event) => event === "merge-start:41")).toHaveLength(
    1,
  );
});

test("fresh claim rejects withdrawal, spec/member changes and dependency checkpoint races before any role or checkpoint write", async () => {
  for (const fault of [
    "approval",
    "spec",
    "closed",
    "member",
    "checkpoint",
    "duplicate",
  ] as const) {
    const f = fixture(2, true);
    await tick(f, false);
    f.issues[1]!.labels = f.issues[1]!.labels.filter(
      (label) => label.name !== "roc:ready",
    );
    f.data.check = "success";
    await tick(f);
    expect((await f.record()).phase).toBe("done");
    expect(f.issues[0]!.state).toBe("CLOSED");
    f.issues[1]!.labels.push({ name: "roc:ready" });
    const snapshot = (await f.store.list()).tasks;
    const writes = f.writes();
    const roles = f.roleCalls();
    const mutate = () => {
      if (fault === "approval") f.issues[1]!.comments.shift();
      if (fault === "spec")
        f.issues[1]!.body = f.issues[1]!.body.replaceAll(
          "Wrong answer",
          "Changed requirement",
        );
      if (fault === "closed") f.issues[1]!.state = "CLOSED";
      if (fault === "member") f.issues.splice(0, 1);
      if (fault === "checkpoint")
        f.issues[0]!.comments = f.issues[0]!.comments.filter(
          (comment) => comment.author?.login !== "daemon",
        );
      if (fault === "duplicate")
        f.issues[0]!.comments.push({
          ...f.issues[0]!.comments.find(
            (comment) => comment.author?.login === "daemon",
          )!,
          databaseId: 989898,
        });
    };
    if (["approval", "spec", "closed", "member"].includes(fault)) mutate();
    else {
      const command = f.input.command;
      f.input.command = {
        async run(input) {
          const result = await command.run(input);
          if (input.command[1] === "merge-base") mutate();
          return result;
        },
      };
    }
    const result = await new GitHubTaskRunner(f.input)
      .claimNext(
        snapshot,
        new AbortController().signal,
        (task) => task.issue.number === 42,
      )
      .catch((error: unknown) => error);
    expect(result === undefined || result instanceof Error).toBe(true);
    expect(f.writes()).toBe(writes);
    expect(f.roleCalls()).toBe(roles);
    expect(
      f.issues
        .find((issue) => issue.number === 42)!
        .comments.some((comment) => comment.author?.login === "daemon"),
    ).toBe(false);
  }
});

test("production GraphQL, real worktrees, Fake Harness, PR publication and guarded merge release T2 without replay after restart", async () => {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), "roc-gql-vertical-")),
  );
  const root = join(temp, "repo");
  try {
    await git(["init", "--bare", join(temp, "origin.git")], temp);
    await git(["clone", join(temp, "origin.git"), root], temp);
    await git(["checkout", "-b", "main"], root);
    await git(["config", "user.name", "Test"], root);
    await git(["config", "user.email", "test@example.test"], root);
    await writeFile(join(root, "answer.txt"), "0\n");
    await git(["add", "."], root);
    await git(["commit", "-m", "seed"], root);
    const base = await git(["rev-parse", "HEAD"], root);
    await git(["push", "origin", "main"], root);
    const seedPath = join(temp, "seed-work");
    await git(
      ["worktree", "add", "-b", "fixture-seed", seedPath, "main"],
      root,
    );
    const heads = new Map<number, string>();
    for (const number of [41, 42]) {
      await writeFile(join(seedPath, "answer.txt"), `${number}\n`);
      await git(["add", "."], seedPath);
      await git(
        ["commit", "-m", `agile(issue-${number}): implement ticket`],
        seedPath,
      );
      heads.set(number, await git(["rev-parse", "HEAD"], seedPath));
    }
    const f = fixture(2, true);
    const ledger = githubWorkflowLedger();
    ledger.observeStore(f.store);
    const protocolRun = f.protocol.command.run.bind(f.protocol.command);
    f.protocol.command.run = ledger.observeRunner({ run: protocolRun }).run;
    const actualBranches = await createTaskBranchManager(
      root,
      "refs/remotes/origin/main",
    );
    const branches = new Proxy(actualBranches, {
      get(target, key) {
        const method = Reflect.get(target, key);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          ledger.event(`worktree-${String(key)}`, "worktree-operation");
          return Reflect.apply(method, target, args);
        };
      },
    });
    f.input.branches = branches;
    f.input.cwd = root;
    f.data.base = base;
    const real = new BunGitHubCommandRunner();
    const remoteCommand = f.input.command;
    let publications = 0;
    let merges = 0;
    const boundaryCommands: string[][] = [];
    const command: GitHubCommandRunner = ledger.observeRunner({
      async run(input) {
        const args = input.command;
        boundaryCommands.push(args);
        if (args[0] === "git") return real.run(input);
        if (args[1] === "repo")
          return {
            exitCode: 0,
            stderr: "",
            stdout: '{"nameWithOwner":"acme/test"}',
          };
        if (args[1] === "pr" && args[2] === "list") {
          const branch = args[args.indexOf("--head") + 1];
          const pr = [...f.prs.values()].find((pr) => pr.head.ref === branch);
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              pr
                ? [
                    {
                      number: pr.number,
                      url: `https://github.com/acme/test/pull/${pr.number}`,
                      state: pr.merged ? "MERGED" : "OPEN",
                      headRepositoryOwner: { login: "acme" },
                      headRefOid: pr.head.sha,
                    },
                  ]
                : [],
            ),
          };
        }
        if (args[1] === "pr" && args[2] === "create") {
          publications++;
          const branch = args[args.indexOf("--head") + 1]!;
          const number = Number(branch.split("-").at(-1));
          f.prs.set(number, {
            number,
            state: "open",
            merged: false,
            merge_commit_sha: null,
            draft: false,
            mergeable: true,
            mergeable_state: "clean",
            head: {
              ref: branch,
              sha: heads.get(number)!,
              repository: "acme/test",
            },
            base: { ref: "main", sha: f.data.base, repository: "acme/test" },
          });
          return {
            exitCode: 0,
            stderr: "",
            stdout: `https://github.com/acme/test/pull/${number}`,
          };
        }
        const result = await remoteCommand.run(input);
        if (args.includes("PUT")) {
          merges++;
          const number = Number(args[2]!.match(/pulls\/(\d+)/u)?.[1]);
          const head = heads.get(number)!;
          await git(["push", "origin", `${head}:main`], root);
          f.prs.get(number)!.merge_commit_sha = head;
          f.data.base = head;
        }
        return result;
      },
    });
    f.input.command = command;
    const publisher = new GitHubPullRequestPublisher("main", branches, command);
    f.input.publisher = {
      baseBranch: "main",
      async publish(input) {
        if (input.task.id === "issue-41" && publications === 0)
          ledger.snapshot("before-t1-publication");
        const result = await publisher.publish(input);
        return { ...result, state: "OPEN" };
      },
    };
    const roles: string[] = [];
    const fake = createFakeHarness({
      attempts: [41, 42].flatMap((number) =>
        ["scout", "implement", "review"].map((role) => ({
          taskId: `issue-${number}`,
          role,
          retryIndex: 0,
          expect: { model, effort: role === "implement" ? "medium" : "high" },
          deliveries: [
            {
              nextCursor: "output",
              event: {
                type: "attempt.output",
                eventId: "output",
                attemptId: "fixture",
                sequence: 1,
                occurredAt: time,
                output:
                  role === "scout"
                    ? {
                        kind: role,
                        summary: "Read approved files",
                        files: ["answer.txt"],
                        tests: [],
                        risks: [],
                      }
                    : role === "implement"
                      ? {
                          kind: role,
                          commitSha: heads.get(number)!,
                          validation: ["verified fixture commit"],
                          risks: [],
                          limitations: [],
                        }
                      : {
                          kind: role,
                          decision: "accepted",
                          findings: [],
                          remainingGaps: [],
                          acceptanceResults: [
                            {
                              criterionIndex: 0,
                              status: "passed",
                              evidence: "Fixture commit inspected",
                            },
                          ],
                        },
              },
            },
            {
              nextCursor: "done",
              event: {
                type: "attempt.completed",
                eventId: "done",
                attemptId: "fixture",
                sequence: 2,
                occurredAt: time,
              },
            },
          ],
        })),
      ),
    });
    f.input.harness = {
      async step(request) {
        if (!request.backendCursor) {
          roles.push(`${request.attempt.taskId}:${request.attempt.role}`);
          ledger.event(`role-${request.attempt.role}`, "role-start");
          if (request.attempt.retryIndex > 0)
            ledger.event("role-retry", "role-start");
          if (request.attempt.role === "implement") {
            const number = Number(request.attempt.taskId.slice(6));
            const workspace = await branches.prepare(
              request.attempt.taskId,
              (await f.store.get(number)).execution!.baseCommit,
            );
            await git(
              ["merge", "--ff-only", heads.get(number)!],
              workspace.path,
            );
          }
        }
        return fake.harness.step(request);
      },
      async cancel() {},
    };
    const signal = new AbortController().signal;
    await new GitHubTaskPool({ ...f.input, autoMerge: false }).run(
      signal,
      true,
    );
    const t1 = (await f.store.get(41)).execution!;
    expect(t1.phase, t1.failure).toBe("awaiting_merge");
    expect((await f.store.get(42)).execution).toBeUndefined();
    expect(roles).toEqual([
      "issue-41:scout",
      "issue-41:implement",
      "issue-41:review",
    ]);
    expect(publications).toBe(1);
    const restarted = new GitHubExecutionStore(
      "acme/test",
      "daemon",
      new Set(["owner"]),
      f.reader,
    );
    ledger.observeStore(restarted);
    f.input.store = restarted;
    f.data.check = "success";
    await new GitHubTaskPool({ ...f.input, autoMerge: true }).run(signal, true);
    expect((await restarted.get(41)).execution).toMatchObject({
      phase: "done",
      attempts: t1.attempts,
    });
    expect((await restarted.get(41)).issue.state).toBe("CLOSED");
    expect((await restarted.get(42)).execution).toMatchObject({
      phase: "awaiting_merge",
      baseCommit: heads.get(41),
    });
    expect(roles).toHaveLength(6);
    expect(publications).toBe(2);
    expect(merges).toBe(1);
    ledger.snapshot("restart-t1-done-and-t2-published");
    await new GitHubTaskPool({ ...f.input, autoMerge: true }).run(signal, true);
    expect((await restarted.get(42)).execution?.phase).toBe("done");
    ledger.snapshot("t2-done");
    await new GitHubTaskPool({ ...f.input, autoMerge: true }).run(signal, true);
    expect(roles).toHaveLength(6);
    expect(publications).toBe(2);
    expect(merges).toBe(2);
    expect(await git(["show", "origin/main:answer.txt"], root)).toBe("42");
    expect(
      f.protocol.commands.some((args) =>
        args.some((arg) => arg.startsWith("query=query KnownIssues")),
      ),
    ).toBe(true);
    fake.assertComplete();
    ledger.snapshot("final-idempotent-run");
    const report = ledger.report();
    expect(report.stages).toHaveLength(4);
    expect(
      report.entries.filter(
        (entry) => entry.kind === "fixture-github-dispatch",
      ),
    ).toHaveLength(
      f.protocol.commands.length +
        boundaryCommands.filter((args) => args[0] === "gh").length,
    );
    expect(
      report.entries.filter((entry) => entry.kind === "local-git-command"),
    ).toHaveLength(boundaryCommands.filter((args) => args[0] === "git").length);
    expect(report.totals.fixtureGraphQLCostSum).toBe(
      f.protocol.commands.filter((args) => args[2] === "graphql").length,
    );
    expect(report.totals.counts["checkpoint-write"]).toBe(f.writes());
    expect(report.totals.counts["known-issues-checkpoint-readback"]).toBe(
      f.writes(),
    );
    expect(report.totals.failedDispatches).toBe(0);
    expect(report.totals.rateHeaderResponses).toBe(0);
    expect(report.transportRetries).toBe(0);
    expect(report.totals.counts["role-retry"]).toBe(0);
    expect(report.totals.counts["worktree-refresh"]).toBe(0);
    for (const [category, count] of Object.entries(report.totals.counts)) {
      expect(
        report.stages.reduce(
          (sum, stage) => sum + (stage.counts[category] ?? 0),
          0,
        ),
      ).toBe(count);
      expect(
        report.entries.filter((entry) => entry.category === category),
      ).toHaveLength(count);
    }
    expect(
      report.stages.reduce(
        (sum, stage) => sum + stage.fixtureGraphQLCostSum,
        0,
      ),
    ).toBe(report.totals.fixtureGraphQLCostSum);
    expect(
      report.stages.reduce(
        (sum, stage) => sum + stage.toEntry - stage.fromEntry,
        0,
      ),
    ).toBe(report.entries.length);
    expect(
      report.stages.reduce((sum, stage) => sum + stage.localElapsedMs, 0),
    ).toBeCloseTo(report.localElapsedMs, 6);
    const final = report.stages[3]!;
    for (const category of [
      "role-scout",
      "role-implement",
      "role-review",
      "publication-write",
      "merge-write",
      "checkpoint-write",
    ])
      expect(final.counts[category]).toBe(0);
    expect(final.counts["managed-issues-list"]).toBeGreaterThan(0);
    const artifact =
      ".scratch/deliver-code/graphql-runtime/local-workflow-ledger.json";
    await mkdir(".scratch/deliver-code/graphql-runtime", { recursive: true });
    await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify({
        localWorkflowLedger: artifact,
        totalEntries: report.entries.length,
        simulatedGraphQLCost: report.totals.fixtureGraphQLCostSum,
        stageCosts: report.stages.map((stage) => ({
          boundary: stage.boundary,
          fixtureGraphQLCostSum: stage.fixtureGraphQLCostSum,
        })),
      }),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 30000);

test("cancelling a blocked dependency PR read drains the transport before any claim write", async () => {
  const f = fixture(2, true);
  await tick(f, false);
  f.issues[1]!.labels = f.issues[1]!.labels.filter(
    (label) => label.name !== "roc:ready",
  );
  f.data.check = "success";
  await tick(f);
  f.issues[1]!.labels.push({ name: "roc:ready" });
  const snapshot = (await f.store.list()).tasks;
  const entered = barrier();
  const stop = new AbortController();
  const writes = f.writes();
  let drained = false;
  const source = f.input.command;
  const command: GitHubCommandRunner = {
    async run(input) {
      if (input.command[1] !== "pr") return source.run(input);
      expect(input.signal).toBe(stop.signal);
      entered.release();
      await new Promise<void>((resolve) =>
        input.signal!.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      drained = true;
      input.signal?.throwIfAborted();
      throw Error("No result after cancellation");
    },
  };
  const pending = new GitHubTaskRunner({ ...f.input, command })
    .claimNext(snapshot, stop.signal, (task) => task.issue.number === 42)
    .catch((error: unknown) => error);
  await entered.promise;
  stop.abort();
  expect(await pending).toBeInstanceOf(Error);
  expect(drained).toBe(true);
  expect(f.writes()).toBe(writes);
});
