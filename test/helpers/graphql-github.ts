import { readFile } from "node:fs/promises";
import { GitHubExecutionStore } from "../../src/github/execution-store";
import {
  GitHubRemoteIssueReader,
  type RemoteIssue,
} from "../../src/github/issue-reader";
import type { GitHubCommandRunner } from "../../src/github/pr-publisher";

/** Builds protocol pages with independent cursors scoped to their Issue and connection. */
export function protocolPage<T>(
  nodes: T[],
  cursor: string | undefined,
  key: string,
) {
  const offset =
    cursor === undefined ? 0 : Number(cursor.slice(key.length + 1));
  if (
    cursor !== undefined &&
    (!cursor.startsWith(`${key}:`) || !Number.isInteger(offset))
  )
    throw Error("Wrong cursor");
  const end = Math.min(offset + 25, nodes.length);
  return {
    totalCount: nodes.length,
    nodes: structuredClone(nodes.slice(offset, end)),
    pageInfo: {
      hasNextPage: end < nodes.length,
      endCursor: end === 0 ? null : `${key}:${end}`,
    },
  };
}

/** Answers only the fixed production GraphQL operation shapes from mutable remote Issue state. */
export function graphqlResponse(issues: RemoteIssue[], command: string[]) {
  const variables = Object.fromEntries(
    command
      .filter((arg) => /^[A-Za-z][A-Za-z0-9]*=/u.test(arg))
      .map((arg) => [
        arg.slice(0, arg.indexOf("=")),
        arg.slice(arg.indexOf("=") + 1),
      ]),
  );
  const query = variables.query ?? "";
  const quota = {
    cost: 1,
    limit: 5000,
    remaining: 4999,
    resetAt: "2099-09-11T00:00:00Z",
  };
  const seed = (issue: RemoteIssue) => ({
    ...issue,
    id: `I_${issue.number}`,
    labels: protocolPage(issue.labels, undefined, `L_${issue.number}`),
    comments: protocolPage(issue.comments, undefined, `C_${issue.number}`),
  });
  if (query.startsWith("query ManagedIssues(")) {
    const page = protocolPage(
      issues.filter((issue) =>
        issue.labels.some((label) => label.name === "roc:task"),
      ),
      variables.cursor,
      "issues",
    );
    return {
      data: {
        repository: { issues: { ...page, nodes: page.nodes.map(seed) } },
        rateLimit: quota,
      },
    };
  }
  if (query.startsWith("query KnownIssues(")) {
    const aliases = Object.keys(variables).filter((key) => /^n\d+$/u.test(key));
    return {
      data: {
        repository: Object.fromEntries(
          aliases.map((key) => {
            const issue = issues.find(
              (item) => item.number === Number(variables[key]),
            );
            return [`i${key.slice(1)}`, issue ? seed(issue) : null];
          }),
        ),
        rateLimit: quota,
      },
    };
  }
  const issue = issues.find((item) => `I_${item.number}` === variables.id);
  if (!issue) return { data: { node: null, rateLimit: quota } };
  if (query.startsWith("query IssueLabels("))
    return {
      data: {
        node: {
          id: variables.id,
          labels: protocolPage(
            issue.labels,
            variables.cursor,
            `L_${issue.number}`,
          ),
        },
        rateLimit: quota,
      },
    };
  if (query.startsWith("query IssueComments("))
    return {
      data: {
        node: {
          id: variables.id,
          comments: protocolPage(
            issue.comments,
            variables.cursor,
            `C_${issue.number}`,
          ),
        },
        rateLimit: quota,
      },
    };
  throw Error("Unexpected GraphQL query");
}

/** Supplies mutable GitHub protocol state while every task read passes through the production parser and pager. */
export function protocolGitHub(issues: RemoteIssue[], cwd = "/fixture") {
  const commands: string[][] = [];
  let writes = 0;
  let nextId =
    Math.max(
      0,
      ...issues.flatMap((issue) =>
        issue.comments.map((comment) => comment.databaseId),
      ),
    ) + 1;
  const faults = {
    hideWrites: false,
    lostWrite: false,
    beforeRead: undefined as undefined | ((command: string[]) => void),
    afterRead: undefined as
      | undefined
      | ((body: unknown, command: string[]) => unknown),
  };
  const command: GitHubCommandRunner = {
    async run(input) {
      commands.push(input.command);
      const args = input.command;
      let body: unknown = {};
      if (args[2] === "graphql") {
        if (input.intent !== "graphql-read") throw Error("Read intent missing");
        faults.beforeRead?.(args);
        body = graphqlResponse(issues, args);
        body = faults.afterRead?.(body, args) ?? body;
      } else if (args.includes("POST") || args.includes("PATCH")) {
        writes++;
        const endpoint = args.find((arg) => arg.startsWith("repos/"))!;
        const id = Number(endpoint.match(/issues\/comments\/(\d+)/u)?.[1]);
        const number = Number(endpoint.match(/issues\/(\d+)\/comments/u)?.[1]);
        const issue = issues.find(
          (item) =>
            item.number === number ||
            item.comments.some((comment) => comment.databaseId === id),
        );
        if (!issue) throw Error("Unknown write target");
        const content = JSON.parse(
          await readFile(args[args.indexOf("--input") + 1]!, "utf8"),
        ).body;
        if (!faults.hideWrites) {
          const comment = issue.comments.find((item) => item.databaseId === id);
          if (comment) comment.body = content;
          else
            issue.comments.push({
              databaseId: nextId++,
              body: content,
              author: { login: "daemon" },
            });
        }
        if (faults.lostWrite) {
          faults.lostWrite = false;
          throw Error("secret lost response");
        }
      } else if (args[1] === "label") {
        // The label catalog has no authority-bearing state.
      } else if (args[1] === "issue" && args[2] === "edit") {
        const issue = issues.find((item) => item.number === Number(args[3]))!;
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--remove-label")
            issue.labels = issue.labels.filter(
              (label) => label.name !== args[i + 1],
            );
          if (
            args[i] === "--add-label" &&
            !issue.labels.some((label) => label.name === args[i + 1])
          )
            issue.labels.push({ name: args[i + 1]! });
        }
      } else if (args[1] === "issue" && args[2] === "close") {
        issues.find((item) => item.number === Number(args[3]))!.state =
          "CLOSED";
      } else throw Error("Unexpected protocol command");
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(body) };
    },
  };
  const reader = new GitHubRemoteIssueReader(cwd, command);
  return {
    issues,
    commands,
    faults,
    command,
    reader,
    writes: () => writes,
    store: () =>
      new GitHubExecutionStore(
        "acme/test",
        "daemon",
        new Set(["owner"]),
        reader,
      ),
  };
}
