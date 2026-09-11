import type { TaskHook } from "../../src/domain/schemas";
import { GitHubExecutionStore } from "../../src/github/execution-store";
import type { RemoteIssue } from "../../src/github/issue-reader";
import {
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";

export const manifest = {
  cycleId: "2026-W37",
  goal: "GitHub execution",
  tasks: [
    {
      id: "T1",
      title: "Return 42",
      priority: 0,
      spec: {
        problem: "Wrong answer",
        desiredOutcome: "Return 42",
        scope: ["answer.ts"],
        nonGoals: [],
        acceptanceCriteria: ["answer is 42"],
        validation: ["bun test"],
        dependencies: [],
        risk: "medium" as const,
        contextCandidates: [],
        tokenCeiling: 10000,
      },
    },
  ],
};

/** Builds a fake GitHub boundary whose comments survive replacement store instances. */
export function memoryGitHub(posthook?: TaskHook) {
  const input = structuredClone(manifest);
  const envelope = remoteTaskEnvelope(
    posthook
      ? {
          ...input,
          tasks: input.tasks.map((task) => ({
            ...task,
            spec: { ...task.spec, posthook },
          })),
        }
      : input,
    "T1",
  );
  const issue: RemoteIssue = {
    number: 41,
    title: envelope.task.title,
    body: renderRemoteTaskBody(envelope),
    url: "https://github.com/acme/test/issues/41",
    state: "OPEN",
    labels: [{ name: "roc:task" }, { name: "roc:ready" }],
    comments: [
      {
        databaseId: 1,
        author: { login: "owner" },
        body: renderRemoteTaskApproval(envelope),
      },
    ],
  };
  let lostResponse = false;
  const closures: number[] = [];
  let denyClosure = false;
  const api = {
    async read() {
      return [structuredClone(issue)];
    },
    async get(_repo?: string, _number?: number) {
      return structuredClone(issue);
    },
    async getMany(repo: string, numbers: readonly number[]) {
      return Promise.all(numbers.map((number) => api.get(repo, number)));
    },
    async writeComment(
      _repo: string,
      _number: number,
      body: string,
      id?: number,
    ) {
      const existing = issue.comments.find(
        (comment) => comment.databaseId === id,
      );
      if (existing) existing.body = body;
      else
        issue.comments.push({
          databaseId: issue.comments.length + 1,
          author: { login: "daemon" },
          body,
        });
      if (lostResponse) {
        lostResponse = false;
        throw Error("response lost");
      }
    },
    async closeCompleted(_repo: string, number: number) {
      closures.push(number);
      if (denyClosure) throw Error("denied secret");
      if (issue.state === "OPEN") {
        issue.state = "CLOSED";
        issue.stateReason = "COMPLETED";
      }
    },
    async setStatusLabel() {},
  };
  return {
    issue,
    api,
    closures,
    denyClosure(value: boolean) {
      denyClosure = value;
    },
    loseNextResponse() {
      lostResponse = true;
    },
    store: () =>
      new GitHubExecutionStore("acme/test", "daemon", new Set(["owner"]), api),
  };
}
