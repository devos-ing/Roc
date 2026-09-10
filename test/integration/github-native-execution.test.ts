import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiHarness } from "../../src/agents/pi/harness";
import { renderExecution } from "../../src/github/execution-store";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { BunGitHubCommandRunner } from "../../src/github/pr-publisher";
import {
  jsonHash,
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";
import { createFakeHarness } from "../../src/harness/fake";
import { GitHubTaskRunner } from "../../src/scheduler/github-runner";
import { createModelAdvisor } from "../../src/scheduler/model-routing";
import type { TaskBranchManager } from "../../src/workspace/task-branch";
import { createTaskBranchManager } from "../../src/workspace/task-branch";
import { messageEnd, RecordedPiClient } from "../agents/pi/fixtures";
import { git } from "../helpers/git";
import { manifest, memoryGitHub } from "../helpers/github-native";

test("Fake Harness completes on a non-default target and restart retries only denied closure", async () => {
  const hook = { command: "fixture", args: [], timeoutSeconds: 1 };
  const remote = memoryGitHub(hook);
  remote.issue.comments.push({
    databaseId: 10,
    author: { login: "owner" },
    body: `<!-- roc:hook-trust ${jsonHash({ phase: "posthook", hook })} -->`,
  });
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const model = "test/model";
  const time = "2026-09-08T00:00:00.000Z";
  const outputs = [
    { kind: "scout", summary: "Inspect", files: [], tests: [], risks: [] },
    {
      kind: "implement",
      commitSha: head,
      validation: ["checked"],
      risks: [],
      limitations: [],
    },
    {
      kind: "review",
      decision: "accepted",
      findings: [],
      remainingGaps: [],
      acceptanceResults: [
        {
          criterionIndex: 0,
          status: "passed",
          evidence: "Fake validation confirmed answer() returns 42",
        },
      ],
    },
  ];
  const fake = createFakeHarness({
    attempts: outputs.map((output) => ({
      taskId: "issue-41",
      role: output.kind,
      retryIndex: 0,
      expect: {
        model,
        effort: output.kind === "implement" ? "medium" : "high",
      },
      deliveries: [
        {
          nextCursor: "output",
          event: {
            type: "attempt.output",
            eventId: "output",
            attemptId: "fixture",
            sequence: 1,
            occurredAt: time,
            output,
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
  });
  const branches: TaskBranchManager = {
    async prepare(taskId) {
      return {
        taskId,
        path: "/fixture",
        branch: `agile/${taskId}`,
        baseCommit: base,
      };
    },
    async refresh() {
      throw Error("No refresh");
    },
    async restoreChanges() {},
    async commitChanges() {
      return head;
    },
    async assertCommit() {},
    async assertReviewReady() {},
    async status() {
      return "";
    },
  };
  let publications = 0;
  let steps = 0;
  let hooks = 0;
  let merged = false;
  const commands: string[][] = [];
  const order: string[] = [];
  const get = remote.api.get;
  remote.api.get = async () => {
    const issue = await get();
    if (
      issue.comments.some((comment) => comment.body.includes('"phase": "done"'))
    )
      order.push("done-read");
    return issue;
  };
  const close = remote.api.closeCompleted;
  remote.api.closeCompleted = async (...args) => {
    order.push("close");
    expect(order).toContain("done-read");
    await close(...args);
  };
  const diagnostics: string[] = [];
  const makeRunner = () =>
    new GitHubTaskRunner({
      store: remote.store(),
      branches,
      harness: {
        async step(request) {
          steps++;
          return fake.harness.step(request);
        },
        async cancel() {},
      },
      hooks: {
        async stop() {},
        async run() {
          hooks++;
          return {
            succeeded: true,
            exitCode: 0,
            timedOut: false,
            stdout: "",
            stderr: "",
          };
        },
      },
      advisor: createModelAdvisor(
        [{ id: model, supportedReasoningEfforts: ["medium", "high", "xhigh"] }],
        { luna: model, terra: model, sol: model },
      ),
      publisher: {
        baseBranch: "release",
        async publish() {
          publications++;
          return {
            number: 7,
            url: "https://github.com/acme/test/pull/7",
            state: "OPEN",
          };
        },
      },
      command: {
        async run({ command }) {
          commands.push(command);
          return {
            exitCode: 0,
            stderr: "",
            stdout:
              command[0] === "gh"
                ? JSON.stringify({
                    number: 7,
                    state: merged ? "MERGED" : "OPEN",
                    baseRefName: "release",
                    headRefName: "agile/issue-41",
                    headRefOid: head,
                    mergeCommit: merged ? { oid: head } : null,
                  })
                : base,
          };
        },
      },
      cwd: "/fixture",
      baseBranch: "release",
      diagnostic: (message) => diagnostics.push(message),
    });
  const signal = new AbortController().signal;
  expect(await makeRunner().runOnce(signal)).toBe(true);
  expect(
    githubTaskSnapshot([await remote.store().get(41)]).inspection.tasks[0]
      ?.acceptanceChecklist,
  ).toEqual([
    {
      criterionIndex: 0,
      criterion: "answer is 42",
      status: "passed",
      evidence: "Fake validation confirmed answer() returns 42",
    },
  ]);
  fake.assertComplete();
  expect(hooks).toBe(1);
  merged = true;
  const write = remote.api.writeComment;
  remote.api.writeComment = async (...args) => {
    if (args[2].includes('"phase": "done"')) throw Error("denied checkpoint");
    await write(...args);
  };
  await expect(makeRunner().runOnce(signal)).rejects.toMatchObject({
    code: "GITHUB_CHECKPOINT_UNCONFIRMED",
  });
  expect(remote.closures).toEqual([]);
  expect((await remote.store().get(41)).execution?.phase).toBe(
    "awaiting_merge",
  );
  remote.api.writeComment = write;
  remote.loseNextResponse();
  remote.denyClosure(true);
  await makeRunner().runOnce(signal);
  const done = (await remote.store().get(41)).execution;
  expect(done?.phase).toBe("done");
  expect(remote.issue.state).toBe("OPEN");
  expect(diagnostics.join()).toContain("closure pending");
  const before = { steps, publications, hooks };
  remote.denyClosure(false);
  await makeRunner().runOnce(signal);
  expect(remote.issue.state).toBe("CLOSED");
  expect(remote.issue.stateReason).toBe("COMPLETED");
  expect((await remote.store().get(41)).execution).toEqual(done);
  expect({ steps, publications, hooks }).toEqual(before);
  expect(
    commands.some(
      (command) => command[1] === "fetch" && command[3] === "release",
    ),
  ).toBe(true);
  expect(
    commands.some((command) => command[1] === "pr" && command[2] === "merge"),
  ).toBe(false);
});

for (const skipScout of [false, true])
  test(`GitHub checkpoints drive a real worktree through independent Pi Review (skipScout=${skipScout})`, async () => {
    const temp = await mkdtemp(join(tmpdir(), "roc-github-native-"));
    const root = join(temp, "repo");
    try {
      await git(["init", "--bare", join(temp, "origin.git")], temp);
      await git(["clone", join(temp, "origin.git"), root], temp);
      await git(["checkout", "-b", "main"], root);
      await git(["config", "user.name", "Roc Test"], root);
      await git(["config", "user.email", "roc@example.test"], root);
      await writeFile(
        join(root, "answer.ts"),
        "export const answer = () => 0;\n",
      );
      await git(["add", "."], root);
      await git(["commit", "-m", "seed"], root);
      await git(["push", "origin", "main"], root);
      const branches = await createTaskBranchManager(
        await realpath(root),
        "HEAD",
      );
      const remote = memoryGitHub();
      if (skipScout) {
        const envelope = remoteTaskEnvelope(
          {
            ...manifest,
            tasks: manifest.tasks.map((task) => ({
              ...task,
              spec: { ...task.spec, risk: "low", skipScout: true },
            })),
          },
          "T1",
        );
        remote.issue.body = renderRemoteTaskBody(envelope);
        remote.issue.comments[0]!.body = renderRemoteTaskApproval(envelope);
      }
      const expectedRoles = skipScout
        ? ["implement", "review"]
        : ["scout", "implement", "review"];
      const outputs = [
        {
          kind: "scout",
          summary: "Change the answer",
          files: ["answer.ts"],
          tests: ["bun test"],
          risks: [],
        },
        {
          kind: "implement",
          validation: ["fixture checked answer"],
          risks: [],
          limitations: [],
        },
        {
          kind: "review",
          decision: "accepted",
          findings: [],
          remainingGaps: [],
        },
      ].filter((output) => !skipScout || output.kind !== "scout");
      const roles: string[] = [];
      const clients: RecordedPiClient[] = [];
      const harness = createPiHarness({
        branches,
        startClient: async (cwd) => {
          const index = roles.length;
          const output = outputs[index];
          if (!output) throw Error("Unexpected additional role");
          roles.push(output.kind);
          const client = new RecordedPiClient(
            [
              messageEnd({ text: JSON.stringify(output) }),
              { type: "agent_settled" },
            ],
            { model: { provider: "openai-codex", id: "gpt-6-astra" } },
            async () => {
              if (output.kind === "implement")
                await writeFile(
                  join(cwd, "answer.ts"),
                  "export const answer = () => 42;\n",
                );
            },
          );
          clients.push(client);
          return client;
        },
      });
      const model = "openai-codex/gpt-6-astra";
      let publications = 0;
      const runner = new GitHubTaskRunner({
        store: remote.store(),
        harness,
        branches,
        advisor: createModelAdvisor(
          [
            {
              id: model,
              supportedReasoningEfforts: ["medium", "high", "xhigh"],
            },
          ],
          { luna: model, terra: model, sol: model },
        ),
        publisher: {
          baseBranch: "main",
          async publish(input) {
            publications++;
            await branches.assertReviewReady(
              input.task.id,
              input.implementation.commitSha,
              input.task.baseCommit,
            );
            return {
              number: 7,
              url: "https://github.com/acme/test/pull/7",
              state: "OPEN",
            };
          },
        },
        command: new BunGitHubCommandRunner(),
        cwd: root,
        baseBranch: "main",
      });
      expect(await runner.runOnce(new AbortController().signal)).toBe(true);
      const task = await remote.store().get(41);
      expect(task.execution?.phase).toBe("awaiting_merge");
      expect(task.execution?.attempts.map((attempt) => attempt.status)).toEqual(
        expectedRoles.map(() => "succeeded"),
      );
      expect(roles).toEqual(expectedRoles);
      expect(
        clients.map(
          (client) =>
            client.requests.find(
              (request) => request.command === "set_thinking_level",
            )?.params?.level,
        ),
      ).toEqual(
        expectedRoles.map((role) => (role === "implement" ? "medium" : "high")),
      );
      expect(publications).toBe(1);
      expect(
        task.execution?.attempts.every((attempt) => attempt.usageKnown),
      ).toBe(true);
      expect(await readFile(join(root, "answer.ts"), "utf8")).toContain("=> 0");
      expect(
        await Bun.file(join(root, ".agile/runtime/agile.db")).exists(),
      ).toBe(false);
      const workspace = await branches.prepare(
        "issue-41",
        task.execution?.baseCommit,
      );
      expect(
        await readFile(join(workspace.path, "answer.ts"), "utf8"),
      ).toContain("=> 42");
      expect(await git(["status", "--porcelain"], workspace.path)).toBe("");
      const record = task.execution;
      const comment = remote.issue.comments.find(
        (item) => item.author?.login === "daemon",
      );
      if (!record?.publication || !comment)
        throw Error("Missing publication receipt");
      // Simulate a crash after PR creation but before the awaiting-merge write.
      record.phase = "publishing";
      comment.body = renderExecution(record);
      let merged = false;
      const realCommand = new BunGitHubCommandRunner();
      const recovered = new GitHubTaskRunner({
        store: remote.store(),
        branches,
        harness: createPiHarness({
          branches,
          startClient: async () => {
            throw Error("Saved results must not start another Pi role");
          },
        }),
        advisor: createModelAdvisor([]),
        publisher: {
          baseBranch: "main",
          async publish() {
            publications++;
            return {
              number: 7,
              url: "https://github.com/acme/test/pull/7",
              state: "OPEN",
            };
          },
        },
        command: {
          async run(input) {
            if (input.command[0] !== "gh") return realCommand.run(input);
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                state: merged ? "MERGED" : "OPEN",
                baseRefName: "main",
                headRefName: workspace.branch,
                headRefOid: record.publication?.commitSha,
                mergeCommit: merged
                  ? { oid: record.publication?.commitSha }
                  : null,
              }),
            };
          },
        },
        cwd: root,
        baseBranch: "main",
      });
      expect(await recovered.runOnce(new AbortController().signal)).toBe(true);
      expect(publications).toBe(2);
      expect(roles).toHaveLength(expectedRoles.length);
      await recovered.runOnce(new AbortController().signal);
      expect((await remote.store().get(41)).execution?.phase).toBe(
        "awaiting_merge",
      );
      await git(["push", "origin", `${workspace.branch}:main`], root);
      merged = true;
      await recovered.runOnce(new AbortController().signal);
      expect((await remote.store().get(41)).execution).toMatchObject({
        phase: "done",
        publication: { mergeCommit: record.publication.commitSha },
      });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
