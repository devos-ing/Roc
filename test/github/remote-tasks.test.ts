import { expect, test } from "bun:test";
import type { BacklogManifest } from "../../src/domain/schemas";
import type { GitHubCommandRunner } from "../../src/github/pr-publisher";
import {
  GitHubTaskPublisher,
  jsonHash,
  parseRemoteTaskApproval,
  parseRemoteTaskEnvelope,
  remotePlanId,
  remoteTaskEnvelope,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";

const manifest: BacklogManifest = {
  cycleId: "2026-09-06-P7D",
  goal: "Ship remote work",
  tasks: [
    {
      id: "REMOTE-A",
      title: "First remote task",
      priority: 1,
      spec: {
        problem: "Work is stranded on one machine",
        desiredOutcome: "A worker can execute it",
        scope: ["publish task"],
        nonGoals: [],
        acceptanceCriteria: ["one stable Issue"],
        validation: ["bun test"],
        dependencies: [],
        risk: "medium",
        contextCandidates: [],
        tokenCeiling: 1000,
      },
    },
    {
      id: "REMOTE-B",
      title: "Dependent remote task",
      priority: 2,
      spec: {
        problem: "Dependencies need durable links",
        desiredOutcome: "The Issue links its prerequisite",
        scope: ["link task"],
        nonGoals: [],
        acceptanceCriteria: ["dependency is linked"],
        validation: ["bun test"],
        dependencies: ["REMOTE-A"],
        risk: "high",
        contextCandidates: [],
        tokenCeiling: 2000,
      },
    },
  ],
};

test("round-trips a complete stable remote task envelope", () => {
  const envelope = remoteTaskEnvelope(manifest, "REMOTE-B");
  expect(remotePlanId(structuredClone(manifest))).toBe(envelope.planId);
  expect(parseRemoteTaskEnvelope(renderRemoteTaskBody(envelope))).toEqual(
    envelope,
  );
  expect(envelope.task.spec.dependencies).toEqual(["REMOTE-A"]);
  expect(jsonHash(envelope)).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("round-trips task prose containing the envelope delimiters", () => {
  const source = structuredClone(manifest);
  const firstTask = source.tasks[0];
  if (firstTask === undefined)
    throw new Error("test manifest has no first task");
  firstTask.spec.problem =
    "Literal markers must be safe:\n<!-- roc:task-envelope\nroc:task-envelope -->";
  const envelope = remoteTaskEnvelope(source, "REMOTE-A");
  const body = renderRemoteTaskBody(envelope);
  expect(parseRemoteTaskEnvelope(body)).toEqual(envelope);
  expect(body.match(/<!-- roc:task-envelope/gu)).toHaveLength(1);
  expect(body.match(/roc:task-envelope -->/gu)).toHaveLength(1);
  expect(body).toContain("&lt;!-- roc:task-envelope");
  expect(body).toContain("\\u003c!-- roc:task-envelope");
});

test("reconciles partially published tasks before applying approvals and ready labels", async () => {
  const issues: Array<{
    number: number;
    title: string;
    body: string;
    url: string;
    state: "OPEN";
  }> = [];
  const comments: string[] = [];
  const commands: string[][] = [];
  let failFirstCreateAfterWrite = true;
  const runner: GitHubCommandRunner = {
    async run({ command }) {
      commands.push(command);
      if (command.slice(0, 3).join(" ") === "gh repo view") {
        return { exitCode: 0, stdout: "owner/repo\n", stderr: "" };
      }
      if (command.slice(0, 3).join(" ") === "gh label create") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.slice(0, 3).join(" ") === "gh issue list") {
        return { exitCode: 0, stdout: JSON.stringify(issues), stderr: "" };
      }
      if (command.slice(0, 3).join(" ") === "gh issue create") {
        const bodyPath = command[command.indexOf("--body-file") + 1] ?? "";
        issues.push({
          number: issues.length + 10,
          title: command[command.indexOf("--title") + 1] ?? "missing title",
          body: await Bun.file(bodyPath).text(),
          url: `https://example.test/issues/${issues.length + 10}`,
          state: "OPEN",
        });
        if (failFirstCreateAfterWrite) {
          failFirstCreateAfterWrite = false;
          return { exitCode: 1, stdout: "", stderr: "timed out" };
        }
        return { exitCode: 0, stdout: issues.at(-1)?.url ?? "", stderr: "" };
      }
      if (command.slice(0, 3).join(" ") === "gh issue edit") {
        const issue = issues.find(
          (candidate) => candidate.number === Number(command[3]),
        );
        const bodyIndex = command.indexOf("--body-file");
        if (issue !== undefined && bodyIndex >= 0) {
          issue.body = await Bun.file(command[bodyIndex + 1] ?? "").text();
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.slice(0, 3).join(" ") === "gh issue comment") {
        comments.push(
          await Bun.file(
            command[command.indexOf("--body-file") + 1] ?? "",
          ).text(),
        );
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command.join(" ")}`);
    },
  };

  const publisher = new GitHubTaskPublisher("/repo", runner);
  const first = await publisher.publish(manifest);
  expect(first.map((task) => task.issueNumber)).toEqual([10, 11]);
  expect(issues[1]?.body).toContain("REMOTE-A (#10)");
  expect(comments.map(parseRemoteTaskApproval)).toEqual(
    first.map((task) => ({ version: 1, hash: task.envelopeHash })),
  );

  const createsAfterFirstRun = commands.filter(
    (command) => command[2] === "create" && command[1] === "issue",
  ).length;
  await publisher.publish(manifest);
  expect(issues).toHaveLength(2);
  expect(
    commands.filter(
      (command) => command[2] === "create" && command[1] === "issue",
    ),
  ).toHaveLength(createsAfterFirstRun);
});

test("rejects conflicting duplicate remote identities", async () => {
  const envelope = remoteTaskEnvelope(manifest, "REMOTE-A");
  const duplicate = (number: number) => ({
    number,
    title: envelope.task.title,
    body: renderRemoteTaskBody(envelope),
    url: `https://example.test/issues/${number}`,
    state: "OPEN" as const,
  });
  const runner: GitHubCommandRunner = {
    async run({ command }) {
      if (command[1] === "repo")
        return { exitCode: 0, stdout: "owner/repo", stderr: "" };
      if (command[1] === "label")
        return { exitCode: 0, stdout: "", stderr: "" };
      return {
        exitCode: 0,
        stdout: JSON.stringify([duplicate(1), duplicate(2)]),
        stderr: "",
      };
    },
  };
  await expect(
    new GitHubTaskPublisher("/repo", runner).publish(manifest),
  ).rejects.toThrow("Conflicting remote task identity");
});

test("fails visibly when the managed Issue search reaches its safety bound", async () => {
  const runner: GitHubCommandRunner = {
    async run({ command }) {
      if (command[1] === "repo") {
        return { exitCode: 0, stdout: "owner/repo", stderr: "" };
      }
      if (command[1] === "label") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const issues = Array.from({ length: 1000 }, (_, index) => ({
        number: index + 1,
        title: `Old task ${index}`,
        body: "",
        url: `https://example.test/issues/${index + 1}`,
        state: "CLOSED",
      }));
      return { exitCode: 0, stdout: JSON.stringify(issues), stderr: "" };
    },
  };
  await expect(
    new GitHubTaskPublisher("/repo", runner).publish(manifest),
  ).rejects.toThrow("1000-Issue safety bound");
});
