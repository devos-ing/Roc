import { expect, test } from "bun:test";
import type { BacklogManifest } from "../../src/domain/schemas";
import type { GitHubCommandRunner } from "../../src/github/pr-publisher";
import type { RemoteIssue } from "../../src/github/remote-source";
import { GitHubRemoteTaskSource } from "../../src/github/remote-source";
import {
  jsonHash,
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";
import {
  GitHubRemoteTaskWriter,
  sanitizeRemoteDiagnostic,
} from "../../src/github/remote-writeback";
import { openDatabase } from "../../src/store/database";
import { PlanningRepository } from "../../src/store/planning-repository";
import { RemoteTaskRepository } from "../../src/store/remote-task-repository";

const manifest: BacklogManifest = {
  cycleId: "2026-09-06-P7D",
  goal: "Write results back",
  tasks: [
    {
      id: "REMOTE",
      title: "Remote result",
      priority: 1,
      spec: {
        problem: "The result is local only",
        desiredOutcome: "The Issue shows it",
        scope: ["writeback"],
        nonGoals: [],
        acceptanceCriteria: ["one status comment"],
        validation: ["bun test"],
        dependencies: [],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 100,
      },
    },
  ],
};

test("recovers a lost status-comment acknowledgement without duplicating the comment", async () => {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db, () => "2026-09-06T00:00:00.000Z");
  planning.importBacklog(manifest);
  db.query(
    "UPDATE tasks SET status = 'done', updated_at = ? WHERE id = 'REMOTE'",
  ).run("2026-09-06T00:01:00.000Z");
  db.query(`
    INSERT INTO task_publications(
      task_id, branch, base_branch, commit_sha, status, pull_request_number,
      pull_request_url, pull_request_state, created_at, updated_at
    ) VALUES('REMOTE', 'agile/REMOTE', 'main', ?, 'published', 7, ?, 'OPEN', ?, ?)
  `).run(
    "a".repeat(40),
    "https://example.test/pull/7",
    "2026-09-06T00:01:00.000Z",
    "2026-09-06T00:01:00.000Z",
  );
  const envelope = remoteTaskEnvelope(manifest, "REMOTE");
  const remote = new RemoteTaskRepository(db, () => "2026-09-06T00:02:00.000Z");
  remote.add({
    taskId: "REMOTE",
    repository: "owner/repo",
    planId: envelope.planId,
    issueNumber: 10,
    issueUrl: "https://example.test/issues/10",
    envelopeHash: jsonHash(envelope),
    approvalAuthor: "trusted",
    approvalHash: jsonHash(envelope),
    remoteState: "OPEN",
  });
  const issue: RemoteIssue = {
    number: 10,
    title: "Remote result",
    body: renderRemoteTaskBody(envelope),
    url: "https://example.test/issues/10",
    state: "OPEN",
    labels: [{ name: "human:keep" }, { name: "roc:running" }],
    comments: [
      {
        body: renderRemoteTaskApproval(envelope),
        author: { login: "trusted" },
        databaseId: 50,
      },
      {
        body: "Quoted marker: <!-- roc:status task=REMOTE -->",
        author: { login: "human" },
        databaseId: 51,
      },
    ],
  };
  let loseFirstCommentAck = true;
  let transitionDuringPatch = true;
  const runner: GitHubCommandRunner = {
    async run({ command }) {
      if (command[1] === "label")
        return { exitCode: 0, stdout: "", stderr: "" };
      if (command[1] === "issue" && command[2] === "edit") {
        const remove = command.indexOf("--remove-label");
        const add = command.indexOf("--add-label");
        if (remove >= 0) {
          issue.labels = issue.labels.filter(
            (label) => label.name !== command[remove + 1],
          );
        }
        const addedLabel = command[add + 1];
        if (add >= 0 && addedLabel !== undefined) {
          issue.labels.push({ name: addedLabel });
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command[1] === "issue" && command[2] === "comment") {
        const path = command[command.indexOf("--body-file") + 1] ?? "";
        issue.comments.push({
          body: await Bun.file(path).text(),
          author: { login: "worker" },
          databaseId: 99,
        });
        if (loseFirstCommentAck) {
          loseFirstCommentAck = false;
          return { exitCode: 1, stdout: "", stderr: "timed out" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command[1] === "api") {
        const path = command[command.indexOf("--input") + 1] ?? "";
        const update = (await Bun.file(path).json()) as { body: string };
        const comment = issue.comments.find(
          (candidate) => candidate.databaseId === 99,
        );
        if (comment !== undefined) comment.body = update.body;
        if (transitionDuringPatch) {
          transitionDuringPatch = false;
          db.query(
            "UPDATE tasks SET status = 'needs_replan', updated_at = ? WHERE id = 'REMOTE'",
          ).run("2026-09-06T00:04:00.000Z");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command.join(" ")}`);
    },
  };
  const writer = new GitHubRemoteTaskWriter(
    "/repo",
    "owner/repo",
    "worker",
    remote,
    async () => [issue],
    runner,
  );

  await writer.sync();
  expect(remote.get("REMOTE")).toMatchObject({ pendingSync: true });
  await writer.sync();
  expect(remote.get("REMOTE")).toMatchObject({
    pendingSync: false,
    statusCommentId: 99,
  });
  expect(remote.pendingProjections()).toMatchObject([
    { taskId: "REMOTE", status: "needs_replan" },
  ]);
  await writer.sync();
  expect(
    issue.comments.filter(
      (comment) =>
        comment.author?.login === "worker" &&
        comment.body.includes("roc:status"),
    ),
  ).toHaveLength(1);
  expect(
    issue.comments.find((comment) => comment.databaseId === 51)?.body,
  ).toBe("Quoted marker: <!-- roc:status task=REMOTE -->");
  expect(issue.labels.map((label) => label.name)).toContain("human:keep");
  expect(issue.labels.map((label) => label.name)).toContain("roc:attention");
  expect(issue.comments.at(-1)?.body).toContain("Phase/outcome: needs_replan");
  db.close();
});

test("sanitizes secrets and machine-local paths before writeback", () => {
  expect(
    sanitizeRemoteDiagnostic(
      "Authorization: Bearer abc123 token=super-secret failed at /Users/alice/private/file",
    ),
  ).toBe(
    "Authorization: Bearer [redacted] token=[redacted] failed at [local-path]",
  );
});

test("projects the terminal attempt infrastructure failure", () => {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db);
  planning.importBacklog(manifest);
  db.query(
    "UPDATE tasks SET status = 'failed_infra' WHERE id = 'REMOTE'",
  ).run();
  db.query(`
    INSERT INTO attempts(
      id, task_id, role, model, model_profile, effort, status, retry_index,
      started_at, ended_at
    ) VALUES('attempt-failed', 'REMOTE', 'scout', 'luna', 'luna', 'high',
      'failed_infra', 2, '2026-09-06T00:00:00.000Z', '2026-09-06T00:01:00.000Z')
  `).run();
  db.query(`
    INSERT INTO events(
      idempotency_key, task_id, attempt_id, type, payload_json, occurred_at
    ) VALUES('failed-event', 'REMOTE', 'attempt-failed', 'attempt.failed_infra', ?, ?)
  `).run(
    JSON.stringify({ code: "worker_lost", message: "Worker connection ended" }),
    "2026-09-06T00:01:00.000Z",
  );
  const envelope = remoteTaskEnvelope(manifest, "REMOTE");
  const remote = new RemoteTaskRepository(db);
  remote.add({
    taskId: "REMOTE",
    repository: "owner/repo",
    planId: envelope.planId,
    issueNumber: 10,
    issueUrl: "https://example.test/issues/10",
    envelopeHash: jsonHash(envelope),
    approvalAuthor: "trusted",
    approvalHash: jsonHash(envelope),
    remoteState: "OPEN",
  });

  expect(remote.pendingProjections()).toMatchObject([
    { taskId: "REMOTE", summary: "Worker connection ended" },
  ]);
  db.close();
});

test("publishes one unapproved follow-up and later promotes that same local child", async () => {
  const db = openDatabase(":memory:");
  const planning = new PlanningRepository(db);
  planning.importBacklog(manifest);
  db.query("UPDATE tasks SET status = 'rejected' WHERE id = 'REMOTE'").run();
  db.query(`
    INSERT INTO attempts(
      id, task_id, role, model, model_profile, effort, status, retry_index, started_at, ended_at
    ) VALUES('review-attempt', 'REMOTE', 'review', 'sol', 'sol', 'high', 'succeeded', 0, ?, ?)
  `).run("2026-09-06T00:00:00.000Z", "2026-09-06T00:01:00.000Z");
  db.query(`
    INSERT INTO reviews(id, task_id, attempt_id, decision, findings_json)
    VALUES('review-1', 'REMOTE', 'review-attempt', 'rejected', '["Fix review boundary"]')
  `).run();
  const parentTask = manifest.tasks[0];
  if (parentTask === undefined)
    throw new Error("test manifest has no parent task");
  db.query(`
    INSERT INTO tasks(
      id, cycle_id, title, spec_json, status, priority, risk, token_ceiling,
      approval_required, approved, root_task_id, parent_task_id,
      discovered_from_review_id, created_at, updated_at
    ) VALUES('FOLLOW-UP', ?, ?, ?, 'draft', 1, 'medium', 100, 1, 0,
      'REMOTE', 'REMOTE', 'review-1', ?, ?)
  `).run(
    manifest.cycleId,
    "Remote result follow-up",
    JSON.stringify({ ...parentTask.spec, dependencies: [] }),
    "2026-09-06T00:02:00.000Z",
    "2026-09-06T00:02:00.000Z",
  );

  const parentEnvelope = remoteTaskEnvelope(manifest, "REMOTE");
  const remote = new RemoteTaskRepository(db);
  remote.add({
    taskId: "REMOTE",
    repository: "owner/repo",
    planId: parentEnvelope.planId,
    issueNumber: 40,
    issueUrl: "https://example.test/issues/40",
    envelopeHash: jsonHash(parentEnvelope),
    approvalAuthor: "trusted",
    approvalHash: jsonHash(parentEnvelope),
    remoteState: "OPEN",
  });
  const issues: RemoteIssue[] = [
    {
      number: 40,
      title: "Remote result",
      body: renderRemoteTaskBody(parentEnvelope),
      url: "https://example.test/issues/40",
      state: "OPEN",
      labels: [{ name: "roc:task" }],
      comments: [
        {
          body: renderRemoteTaskApproval(parentEnvelope),
          author: { login: "trusted" },
          databaseId: 140,
        },
      ],
    },
  ];
  let nextCommentId = 200;
  const runner: GitHubCommandRunner = {
    async run({ command }) {
      if (command[1] === "label")
        return { exitCode: 0, stdout: "", stderr: "" };
      if (command[1] === "issue" && command[2] === "create") {
        const path = command[command.indexOf("--body-file") + 1] ?? "";
        issues.push({
          number: 41,
          title: command[command.indexOf("--title") + 1] ?? "Follow-up",
          body: await Bun.file(path).text(),
          url: "https://example.test/issues/41",
          state: "OPEN",
          labels: [{ name: "roc:task" }, { name: "roc:draft" }],
          comments: [],
        });
        return { exitCode: 1, stdout: "", stderr: "timed out" };
      }
      if (command[1] === "issue" && command[2] === "edit") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command[1] === "issue" && command[2] === "comment") {
        const issue = issues.find(
          (candidate) => candidate.number === Number(command[3]),
        );
        const path = command[command.indexOf("--body-file") + 1] ?? "";
        if (issue !== undefined) {
          issue.comments.push({
            body: await Bun.file(path).text(),
            author: { login: "worker" },
            databaseId: nextCommentId++,
          });
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command[1] === "api") return { exitCode: 0, stdout: "", stderr: "" };
      throw new Error(`Unexpected command: ${command.join(" ")}`);
    },
  };
  const writer = new GitHubRemoteTaskWriter(
    "/repo",
    "owner/repo",
    "worker",
    remote,
    async () => issues,
    runner,
  );
  await writer.sync();
  await writer.sync();
  expect(issues.filter((issue) => issue.number === 41)).toHaveLength(1);
  expect(remote.get("FOLLOW-UP")).toMatchObject({ issueNumber: 41 });
  expect(remote.get("FOLLOW-UP")?.approvalHash).toBeUndefined();
  const parentStatus = issues[0]?.comments.find(
    (comment) =>
      comment.author?.login === "worker" && comment.body.includes("roc:status"),
  )?.body;
  expect(parentStatus).toContain("Fix review boundary");
  expect(parentStatus).toContain("https://example.test/issues/41");

  const childIssue = issues.find((issue) => issue.number === 41);
  if (childIssue === undefined)
    throw new Error("follow-up Issue was not published");
  const childEnvelope = remoteTaskEnvelope(
    {
      cycleId: manifest.cycleId,
      goal: manifest.goal,
      tasks: [
        {
          id: "FOLLOW-UP",
          title: "Remote result follow-up",
          priority: 1,
          spec: { ...parentTask.spec, dependencies: [] },
        },
      ],
    },
    "FOLLOW-UP",
  );
  childIssue.labels.push({ name: "roc:ready" });
  childIssue.comments.push({
    body: renderRemoteTaskApproval(childEnvelope),
    author: { login: "trusted" },
    databaseId: 300,
  });
  const source = new GitHubRemoteTaskSource(
    "owner/repo",
    new Set(["trusted"]),
    planning,
    remote,
    async () => issues,
  );
  await source.poll();
  expect(
    planning.listTasks().find((task) => task.id === "FOLLOW-UP"),
  ).toMatchObject({
    status: "ready",
    approved: true,
  });
  db.close();
});
