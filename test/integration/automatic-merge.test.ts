import { expect, test } from "bun:test";
import {
  type ExecutionRecord,
  GitHubExecutionStore,
  renderExecution,
} from "../../src/github/execution-store";
import type { GitHubCommandRunner } from "../../src/github/pr-publisher";
import {
  jsonHash,
  parseRemoteTaskEnvelope,
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";
import { createFakeHarness } from "../../src/harness/fake";
import { GitHubTaskPool } from "../../src/scheduler/github-pool";
import { GitHubTaskRunner } from "../../src/scheduler/github-runner";
import { createModelAdvisor } from "../../src/scheduler/model-routing";
import type { TaskBranchManager } from "../../src/workspace/task-branch";
import { barrier, memoryPlan } from "../helpers/github-plan";

const initialBase = "a".repeat(40);
const model = "test/model";
const time = "2026-09-09T00:00:00.000Z";
/** Makes distinct, valid fixture commit identities without mutating a real repository. */
function sha(prefix: string, number: number) {
  return `${prefix.repeat(38)}${number}`;
}

/** Drives real store/runner/pool boundaries with Fake Harness roles and a stateful GitHub transport. */
function fixture(count = 1, dependent = false) {
  const remote = memoryPlan(
    Array.from({ length: count }, (_, i) => [`src/${i}.ts`]),
  );
  if (dependent) {
    const envelopes = remote.issues.map((issue) =>
      parseRemoteTaskEnvelope(issue.body),
    );
    const first = envelopes[0]!;
    const plan = {
      cycleId: first.cycleId,
      goal: first.goal,
      tasks: envelopes.map((envelope, i) => ({
        ...envelope.task,
        spec: { ...envelope.task.spec, dependencies: i === 1 ? ["T1"] : [] },
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
    responses: new Map<number, "success" | "denied" | "lost">(),
  };
  let writes = 0;
  let roleCalls = 0;
  const events: string[] = [];
  const store = new GitHubExecutionStore(
    "acme/test",
    "daemon",
    new Set(["owner"]),
    {
      ...remote.api,
      async writeComment(repo, number, body, id) {
        writes++;
        if (data.denyCheckpoint)
          throw Error("unknown checkpoint write outcome");
        await remote.api.writeComment(repo, number, body, id);
      },
    },
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
      ["scout", "implement", "review"].map((role) => ({
        taskId: `issue-${issue.number}`,
        role,
        retryIndex: 0,
        expect: { model, effort: "high" },
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
        return fake.harness.step(request);
      },
      async cancel() {},
    },
    advisor: createModelAdvisor(
      [{ id: model, supportedReasoningEfforts: ["high", "xhigh"] }],
      { luna: model, terra: model, sol: model },
    ),
    publisher: {
      baseBranch: "main",
      async publish(
        input: Parameters<
          import("../../src/github/pr-publisher").TaskPublisher["publish"]
        >[0],
      ) {
        const number = Number(input.task.id.slice(6));
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
    store,
    fake,
    input,
    data,
    prs,
    events,
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

test("changed external head/base, closed PR and missing or rejected Review evidence require replan", async () => {
  for (const change of [
    async (f: ReturnType<typeof fixture>) => {
      f.prs.get(41)!.head.sha = sha("d", 41);
    },
    async (f: ReturnType<typeof fixture>) => {
      f.data.base = sha("d", 41);
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
  await pool.cancel();
  finish.release();
  expect(await settled).toBeInstanceOf(Error);
  expect(f.events.filter((event) => event.startsWith("merge-start"))).toEqual([
    "merge-start:41",
  ]);
  expect(f.events.at(-1)).toBe("read-pr:41");
  expect((await f.record()).phase).toBe("awaiting_merge");
  // A new coordinator confirms the already merged PR rather than submitting again.
  await tick(f);
  expect((await f.record()).phase).toBe("done");
  expect((await f.record(42)).phase).toBe("needs_replan");
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
