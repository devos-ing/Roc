import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiHarness } from "../../src/agents/pi/harness";
import { renderExecution } from "../../src/github/execution-store";
import { BunGitHubCommandRunner } from "../../src/github/pr-publisher";
import { GitHubTaskRunner } from "../../src/scheduler/github-runner";
import { createModelAdvisor } from "../../src/scheduler/model-routing";
import { createTaskBranchManager } from "../../src/workspace/task-branch";
import { messageEnd, RecordedPiClient } from "../agents/pi/fixtures";
import { git } from "../helpers/git";
import { memoryGitHub } from "../helpers/github-native";

test("GitHub checkpoints drive a real worktree through Pi and independent Review without SQLite", async () => {
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
      { kind: "review", decision: "accepted", findings: [], remainingGaps: [] },
    ];
    const roles: string[] = [];
    const harness = createPiHarness({
      branches,
      startClient: async (cwd) => {
        const index = roles.length;
        const output = outputs[index];
        if (!output) throw Error("Unexpected additional role");
        roles.push(output.kind);
        return new RecordedPiClient(
          [
            messageEnd({ text: JSON.stringify(output) }),
            { type: "agent_settled" },
          ],
          {},
          async () => {
            if (output.kind === "implement")
              await writeFile(
                join(cwd, "answer.ts"),
                "export const answer = () => 42;\n",
              );
          },
        );
      },
    });
    const model = "anthropic/claude-sonnet-4-6";
    let publications = 0;
    const runner = new GitHubTaskRunner({
      store: remote.store(),
      harness,
      branches,
      advisor: createModelAdvisor(
        [{ id: model, supportedReasoningEfforts: ["high", "xhigh"] }],
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
    expect(task.execution?.attempts.map((attempt) => attempt.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(roles).toEqual(["scout", "implement", "review"]);
    expect(publications).toBe(1);
    expect(
      task.execution?.attempts.every((attempt) => attempt.usageKnown),
    ).toBe(true);
    expect(await readFile(join(root, "answer.ts"), "utf8")).toContain("=> 0");
    expect(await Bun.file(join(root, ".agile/runtime/agile.db")).exists()).toBe(
      false,
    );
    const workspace = await branches.prepare(
      "issue-41",
      task.execution?.baseCommit,
    );
    expect(await readFile(join(workspace.path, "answer.ts"), "utf8")).toContain(
      "=> 42",
    );
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
    expect(roles).toHaveLength(3);
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
