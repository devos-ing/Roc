import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createPiHarness } from "../../src/agents/pi/harness";
import { buildTaskBoardSnapshot } from "../../src/cli/task-board-model";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { BunGitHubCommandRunner } from "../../src/github/pr-publisher";
import { GitHubTaskPool } from "../../src/scheduler/github-pool";
import { createModelAdvisor } from "../../src/scheduler/model-routing";
import { createTaskBranchManager } from "../../src/workspace/task-branch";
import { messageEnd, RecordedPiClient } from "../agents/pi/fixtures";
import { git } from "../helpers/git";
import { barrier, memoryPlan } from "../helpers/github-plan";

test("two Pi role flows overlap in real worktrees and keep commits, model settings and board activity separate", async () => {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), "roc-parallel-pi-")),
  );
  const root = join(temp, "repo");
  const stop = new AbortController();
  const release = barrier();
  let pool: GitHubTaskPool | undefined;
  let run: Promise<void> | undefined;
  try {
    await git(["init", "--bare", join(temp, "origin.git")], temp);
    await git(["clone", join(temp, "origin.git"), root], temp);
    await git(["checkout", "-b", "main"], root);
    await git(["config", "user.name", "Roc Test"], root);
    await git(["config", "user.email", "roc@example.test"], root);
    for (const name of ["a.ts", "b.ts"])
      await writeFile(join(root, name), "export const answer = 0;\n");
    await git(["add", "."], root);
    await git(["commit", "-m", "seed"], root);
    await git(["push", "origin", "main"], root);
    const branches = await createTaskBranchManager(root, "HEAD");
    const remote = memoryPlan([["a.ts"], ["b.ts"]]);
    const entered = [barrier(), barrier()];
    const published = [barrier(), barrier()];
    const roles = new Map<string, string[]>();
    const clients: RecordedPiClient[] = [];
    const harness = createPiHarness({
      branches,
      startClient: async (cwd) => {
        const id = basename(cwd);
        const index = id === "issue-41" ? 0 : 1;
        const file = index === 0 ? "a.ts" : "b.ts";
        const history = roles.get(id) ?? [];
        const role = ["scout", "implement", "review"][history.length];
        if (!role) throw Error("Duplicate role execution");
        history.push(role);
        roles.set(id, history);
        const output =
          role === "scout"
            ? {
                kind: role,
                summary: "Inspect task file",
                files: [file],
                tests: [],
                risks: [],
              }
            : role === "implement"
              ? {
                  kind: role,
                  validation: ["fixture checks isolated edit"],
                  risks: [],
                  limitations: [],
                }
              : {
                  kind: role,
                  decision: "accepted",
                  findings: [],
                  remainingGaps: [],
                };
        const client = new RecordedPiClient(
          [
            messageEnd({ text: JSON.stringify(output) }),
            { type: "agent_settled" },
          ],
          {
            model: {
              provider: "test",
              id:
                role === "scout"
                  ? "luna"
                  : role === "implement"
                    ? "terra"
                    : "sol",
            },
          },
          async () => {
            if (role === "scout") {
              entered[index]?.release();
              await release.promise;
            }
            if (role === "implement")
              await writeFile(
                join(cwd, file),
                `export const answer = ${41 + index};\n`,
              );
          },
        );
        clients.push(client);
        return client;
      },
    });
    const realCommand = new BunGitHubCommandRunner();
    pool = new GitHubTaskPool({
      store: remote.store,
      branches,
      harness,
      advisor: createModelAdvisor(
        ["luna", "terra", "sol"].map((profile) => ({
          id: `test/${profile}`,
          supportedReasoningEfforts: ["medium", "high", "xhigh"],
        })),
        { luna: "test/luna", terra: "test/terra", sol: "test/sol" },
      ),
      publisher: {
        baseBranch: "main",
        async publish(input) {
          await branches.assertReviewReady(
            input.task.id,
            input.implementation.commitSha,
            input.task.baseCommit,
          );
          published[input.task.id === "issue-41" ? 0 : 1]?.release();
          return {
            number: Number(input.task.id.slice(6)),
            url: `https://github.com/acme/test/pull/${input.task.id.slice(6)}`,
            state: "OPEN",
          };
        },
      },
      command: {
        async run(input) {
          if (input.command[0] !== "gh") return realCommand.run(input);
          const number = Number(input.command[3]);
          const task = await remote.store.get(number);
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              state: "OPEN",
              baseRefName: "main",
              headRefName: task.execution?.publication?.branch,
              headRefOid: task.execution?.publication?.commitSha,
              mergeCommit: null,
            }),
          };
        },
      },
      cwd: root,
      baseBranch: "main",
    });
    run = pool.run(stop.signal).catch((error) => {
      if (!stop.signal.aborted) throw error;
    });
    await Promise.all(entered.map((item) => item.promise));
    const snapshot = await remote.store.list();
    const board = buildTaskBoardSnapshot({
      ...githubTaskSnapshot(snapshot.tasks),
      currentCycleId: "2026-W37",
      remoteCheckpoints: true,
    });
    expect(
      board.tasks
        .filter((task) => task.isActive)
        .map((task) => task.id)
        .sort(),
    ).toEqual(["issue-41", "issue-42"]);
    expect(board.scheduler.active).toHaveLength(2);
    release.release();
    await Promise.all(published.map((item) => item.promise));
    for (const [index, id] of ["issue-41", "issue-42"].entries()) {
      const task = await remote.store.get(41 + index);
      const workspace = await branches.prepare(id, task.execution?.baseCommit);
      expect(
        await git(
          ["diff", "--name-only", `${workspace.baseCommit}..HEAD`],
          workspace.path,
        ),
      ).toBe(index === 0 ? "a.ts" : "b.ts");
      expect(await git(["status", "--porcelain"], workspace.path)).toBe("");
      expect(roles.get(id)).toEqual(["scout", "implement", "review"]);
      expect(
        task.execution?.attempts.map((attempt) => [
          attempt.descriptor.model,
          attempt.descriptor.effort,
        ]),
      ).toEqual([
        ["test/luna", "high"],
        ["test/terra", "medium"],
        ["test/sol", "high"],
      ]);
    }
    expect(clients).toHaveLength(6);
    expect(await readFile(join(root, "a.ts"), "utf8")).toContain("= 0");
    expect(await readFile(join(root, "b.ts"), "utf8")).toContain("= 0");
  } finally {
    release.release();
    stop.abort();
    await pool?.cancel();
    await run;
    await rm(temp, { recursive: true, force: true });
  }
});
