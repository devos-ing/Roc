import type { BacklogManifest } from "../../src/domain/schemas";
import { GitHubExecutionStore } from "../../src/github/execution-store";
import type { RemoteIssue } from "../../src/github/issue-reader";
import {
  remoteTaskEnvelope,
  renderRemoteTaskApproval,
  renderRemoteTaskBody,
} from "../../src/github/remote-tasks";
import { manifest } from "./github-native";

/** Creates several approved Issues backed by one complete in-memory GitHub plan. */
export function memoryPlan(scopes: string[][]) {
  const template = manifest.tasks[0];
  if (!template) throw Error("Missing task fixture");
  const plan: BacklogManifest = {
    ...manifest,
    tasks: scopes.map((scope, index) => ({
      ...template,
      id: `T${index + 1}`,
      title: `Task ${index + 1}`,
      priority: index,
      spec: { ...template.spec, scope },
    })),
  };
  const issues: RemoteIssue[] = plan.tasks.map((task, index) => {
    const envelope = remoteTaskEnvelope(plan, task.id);
    return {
      number: 41 + index,
      title: task.title,
      body: renderRemoteTaskBody(envelope),
      url: `https://github.com/acme/test/issues/${41 + index}`,
      state: "OPEN",
      labels: [{ name: "roc:task" }, { name: "roc:ready" }],
      comments: [
        {
          databaseId: index + 1,
          author: { login: "owner" },
          body: renderRemoteTaskApproval(envelope),
        },
      ],
    };
  });
  let commentId = 100;
  const api = {
    async read() {
      return structuredClone(issues);
    },
    async get(_repo: string, number: number) {
      const issue = issues.find((item) => item.number === number);
      if (!issue) throw Error("Missing fixture Issue");
      return structuredClone(issue);
    },
    async writeComment(
      _repo: string,
      number: number,
      body: string,
      id?: number,
    ) {
      const issue = issues.find((item) => item.number === number);
      if (!issue) throw Error("Missing fixture Issue");
      const comment = issue.comments.find((item) => item.databaseId === id);
      if (comment) comment.body = body;
      else
        issue.comments.push({
          databaseId: commentId++,
          author: { login: "daemon" },
          body,
        });
    },
    async closeCompleted(_repo: string, number: number) {
      const issue = issues.find((item) => item.number === number);
      if (!issue) throw Error("Missing fixture Issue");
      if (issue.state === "OPEN") {
        issue.state = "CLOSED";
        issue.stateReason = "COMPLETED";
      }
    },
    async setStatusLabel() {},
  };
  return {
    issues,
    api,
    store: new GitHubExecutionStore(
      "acme/test",
      "daemon",
      new Set(["owner"]),
      api,
    ),
  };
}

/** Exposes a test-controlled asynchronous barrier without using a timing threshold. */
export function barrier() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
