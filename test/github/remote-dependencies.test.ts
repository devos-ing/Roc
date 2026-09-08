import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogManifest } from "../../src/domain/schemas";
import {
  BunGitHubCommandRunner,
  type GitHubCommandRunner,
} from "../../src/github/pr-publisher";
import { GitHubRemoteDependencyGate } from "../../src/github/remote-dependencies";
import { remoteTaskEnvelope } from "../../src/github/remote-tasks";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";
import { RemoteTaskRepository } from "../../src/store/remote-task-repository";

/** Runs one Git command and returns its trimmed stdout. */
async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

const manifest: BacklogManifest = {
  cycleId: "2026-09-06-P7D",
  goal: "Use merged dependency bases",
  tasks: [
    {
      id: "UPSTREAM",
      title: "Upstream",
      priority: 1,
      spec: {
        problem: "Need upstream",
        desiredOutcome: "Upstream merged",
        scope: ["upstream"],
        nonGoals: [],
        acceptanceCriteria: ["merged"],
        validation: ["test"],
        dependencies: [],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 100,
      },
    },
    {
      id: "DOWNSTREAM",
      title: "Downstream",
      priority: 2,
      spec: {
        problem: "Need downstream",
        desiredOutcome: "Starts from merge",
        scope: ["downstream"],
        nonGoals: [],
        acceptanceCriteria: ["base contains merge"],
        validation: ["test"],
        dependencies: ["UPSTREAM"],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 100,
      },
    },
  ],
};

test("waits for merge then pins the fetched target commit containing its squash result", async () => {
  const root = await mkdtemp(join(tmpdir(), "roc-remote-deps-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  await git(root, ["init", "--bare", origin]);
  await git(root, ["clone", origin, work]);
  await git(work, ["config", "user.name", "Roc Test"]);
  await git(work, ["config", "user.email", "roc@example.test"]);
  await writeFile(join(work, "base.txt"), "base\n");
  await git(work, ["add", "base.txt"]);
  await git(work, ["commit", "-m", "base"]);
  await git(work, ["branch", "-M", "main"]);
  await git(work, ["push", "-u", "origin", "main"]);

  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db);
  planning.importBacklog(manifest);
  db.query("UPDATE tasks SET status = 'done' WHERE id = 'UPSTREAM'").run();
  db.query(`
    INSERT INTO task_publications(
      task_id, branch, base_branch, commit_sha, status, pull_request_number,
      pull_request_url, pull_request_state, created_at, updated_at
    ) VALUES('UPSTREAM', 'agile/UPSTREAM', 'main', ?, 'published', 8, ?, 'OPEN', ?, ?)
  `).run(
    "a".repeat(40),
    "https://example.test/pull/8",
    new Date().toISOString(),
    new Date().toISOString(),
  );
  const remote = new RemoteTaskRepository(db);
  for (const task of manifest.tasks) {
    const envelope = remoteTaskEnvelope(manifest, task.id);
    remote.add({
      taskId: task.id,
      repository: "owner/repo",
      planId: envelope.planId,
      issueNumber: task.id === "UPSTREAM" ? 1 : 2,
      issueUrl: `https://example.test/issues/${task.id}`,
      envelopeHash: "sha256:" + "a".repeat(64),
      approvalAuthor: "trusted",
      approvalHash: "sha256:" + "a".repeat(64),
      remoteState: "OPEN",
    });
  }
  let state: "OPEN" | "MERGED" | "CLOSED" = "OPEN";
  let mergeCommit = "";
  const real = new BunGitHubCommandRunner();
  const runner: GitHubCommandRunner = {
    async run(input) {
      if (input.command[0] === "git") return real.run(input);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          state,
          baseRefName: "main",
          mergedAt: state === "MERGED" ? new Date().toISOString() : null,
          mergeCommit: state === "MERGED" ? { oid: mergeCommit } : null,
        }),
        stderr: "",
      };
    },
  };
  const gate = new GitHubRemoteDependencyGate(
    work,
    "owner/repo",
    "main",
    remote,
    runner,
  );
  try {
    await gate.prepare();
    expect(
      planning.listTasks().find((task) => task.id === "DOWNSTREAM")?.baseCommit,
    ).toBeUndefined();

    db.query(
      "UPDATE tasks SET status = 'claimed' WHERE id = 'DOWNSTREAM'",
    ).run();
    await writeFile(join(work, "merged.txt"), "squash merge result\n");
    await git(work, ["add", "merged.txt"]);
    await git(work, ["commit", "-m", "squashed upstream"]);
    await git(work, ["push", "origin", "main"]);
    mergeCommit = await git(work, ["rev-parse", "HEAD"]);
    await gate.prepare();
    expect(
      planning.listTasks().find((task) => task.id === "DOWNSTREAM")?.baseCommit,
    ).toBeUndefined();
    db.query("UPDATE tasks SET status = 'ready' WHERE id = 'DOWNSTREAM'").run();
    state = "MERGED";
    await gate.prepare();
    expect(
      planning.listTasks().find((task) => task.id === "DOWNSTREAM")?.baseCommit,
    ).toBe(mergeCommit);

    db.query(
      "UPDATE tasks SET base_commit = NULL, status = 'ready' WHERE id = 'DOWNSTREAM'",
    ).run();
    state = "CLOSED";
    await gate.prepare();
    expect(
      planning.listTasks().find((task) => task.id === "DOWNSTREAM")?.status,
    ).toBe("needs_replan");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
