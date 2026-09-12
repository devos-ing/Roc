import { AsyncLocalStorage } from "node:async_hooks";
import type { GitHubExecutionStore } from "../../src/github/execution-store";
import type { GitHubCommandRunner } from "../../src/github/pr-publisher";

type Scope = {
  area: "list" | "fresh-plan" | "checkpoint";
  checkpoint?: "before-write" | "readback" | "confirmed";
};
type Entry = {
  category: string;
  kind:
    | "fixture-github-dispatch"
    | "local-git-command"
    | "role-start"
    | "worktree-operation";
  fixtureGraphQLCost: number;
  localElapsedMs: number;
  failed: boolean;
  rateHeaderResponse: boolean;
};

/** Records only operation names and local measurements for the deterministic vertical fixture. */
export function githubWorkflowLedger() {
  const scopes = new AsyncLocalStorage<Scope>();
  const entries: Entry[] = [];
  const stages: Array<{
    boundary: string;
    fromEntry: number;
    toEntry: number;
    localElapsedMs: number;
    counts: Record<string, number>;
    fixtureGraphQLCostSum: number;
    failedDispatches: number;
    rateHeaderResponses: number;
  }> = [];
  const started = performance.now();
  let boundaryAt = started;
  let cursor = 0;

  /** Classifies every command in the fixture without retaining argv, bodies, paths or credentials. */
  function classify(command: string[]): Entry["category"] {
    if (command[0] === "git")
      return command[1] === "merge-base" ? "git-ancestry" : `git-${command[1]}`;
    if (command[0] !== "gh") throw Error("Unclassified workflow command");
    if (command[2] === "graphql") {
      const query = command.find((arg) => arg.startsWith("query=")) ?? "";
      if (query.startsWith("query=query ManagedIssues("))
        return "managed-issues-list";
      if (query.startsWith("query=query IssueComments("))
        return "nested-comment-page";
      if (query.startsWith("query=query IssueLabels("))
        return "nested-label-page";
      if (!query.startsWith("query=query KnownIssues("))
        throw Error("Unclassified GraphQL operation");
      const scope = scopes.getStore();
      if (scope?.area === "fresh-plan") return "known-issues-fresh-plan";
      if (scope?.area === "checkpoint")
        return `known-issues-checkpoint-${scope.checkpoint}`;
      return "known-issues-boundary-or-verification";
    }
    if (command[1] === "repo") return "repository-read";
    if (command[1] === "pr")
      return command[2] === "create" || command[2] === "edit"
        ? "publication-write"
        : "pr-read";
    if (
      command[1] === "label" ||
      (command[1] === "issue" && command[2] === "edit")
    )
      return "label-write";
    if (command[1] === "issue" && command[2] === "close") return "issue-close";
    if (
      command[1] === "api" &&
      (command.includes("POST") || command.includes("PATCH"))
    )
      return "checkpoint-write";
    if (command.includes("PUT")) return "merge-write";
    if (command[1] === "api")
      return command[2]?.includes("/pulls/") ? "pr-read" : "policy-read";
    throw Error("Unclassified workflow command");
  }

  /** Attaches store purpose to nested reads without replacing any production behavior. */
  function observeStore(store: GitHubExecutionStore): void {
    const list = store.list.bind(store);
    const freshPlan = store.freshPlan.bind(store);
    const save = store.save.bind(store);
    store.list = (...args) => scopes.run({ area: "list" }, () => list(...args));
    store.freshPlan = (...args) =>
      scopes.run({ area: "fresh-plan" }, () => freshPlan(...args));
    store.save = (...args) =>
      scopes.run({ area: "checkpoint", checkpoint: "before-write" }, () =>
        save(...args),
      );
  }

  /** Counts each dispatch including failed attempts and consumes its simulated GraphQL quota field. */
  function observeRunner(runner: GitHubCommandRunner): GitHubCommandRunner {
    return {
      async run(input) {
        const category = classify(input.command);
        const entry: Entry = {
          category,
          kind:
            input.command[0] === "git"
              ? "local-git-command"
              : "fixture-github-dispatch",
          fixtureGraphQLCost: 0,
          localElapsedMs: 0,
          failed: true,
          rateHeaderResponse: false,
        };
        entries.push(entry);
        const began = performance.now();
        const scope = scopes.getStore();
        try {
          const result = await runner.run(input);
          entry.rateHeaderResponse = result.rateLimit !== undefined;
          if (input.command[2] === "graphql") {
            const body = JSON.parse(result.stdout);
            const cost = body.data?.rateLimit?.cost;
            if (!Number.isInteger(cost) || cost < 0 || body.errors?.length)
              throw Error(
                "Missing fixture query cost or unexpected GraphQL error",
              );
            entry.fixtureGraphQLCost = cost;
          }
          if (scope?.area === "checkpoint") {
            if (category === "checkpoint-write") scope.checkpoint = "readback";
            else if (category === "known-issues-checkpoint-readback")
              scope.checkpoint = "confirmed";
          }
          entry.failed = result.exitCode !== 0;
          return result;
        } finally {
          entry.localElapsedMs = performance.now() - began;
        }
      },
    };
  }

  /** Counts one logical role start or worktree operation without claiming its internal subprocess count. */
  function event(
    category: string,
    kind: "role-start" | "worktree-operation",
  ): void {
    entries.push({
      category,
      kind,
      fixtureGraphQLCost: 0,
      localElapsedMs: 0,
      failed: false,
      rateHeaderResponse: false,
    });
  }

  /** Aggregates a contiguous range so stage totals can be checked against all recorded entries. */
  function summarize(slice: Entry[]) {
    const counts: Record<string, number> = {
      "managed-issues-list": 0,
      "known-issues-fresh-plan": 0,
      "known-issues-checkpoint-before-write": 0,
      "known-issues-checkpoint-readback": 0,
      "known-issues-checkpoint-confirmed": 0,
      "known-issues-boundary-or-verification": 0,
      "nested-comment-page": 0,
      "nested-label-page": 0,
      "pr-read": 0,
      "policy-read": 0,
      "repository-read": 0,
      "checkpoint-write": 0,
      "label-write": 0,
      "issue-close": 0,
      "publication-write": 0,
      "merge-write": 0,
      "git-ancestry": 0,
      "role-scout": 0,
      "role-implement": 0,
      "role-review": 0,
      "role-retry": 0,
      "worktree-refresh": 0,
    };
    for (const entry of slice)
      counts[entry.category] = (counts[entry.category] ?? 0) + 1;
    return {
      counts,
      fixtureGraphQLCostSum: slice.reduce(
        (sum, entry) => sum + entry.fixtureGraphQLCost,
        0,
      ),
      failedDispatches: slice.filter((entry) => entry.failed).length,
      rateHeaderResponses: slice.filter((entry) => entry.rateHeaderResponse)
        .length,
    };
  }

  /** Closes one measured interval at an explicit scheduler lifecycle boundary. */
  function snapshot(boundary: string): void {
    const now = performance.now();
    stages.push({
      boundary,
      fromEntry: cursor,
      toEntry: entries.length,
      localElapsedMs: now - boundaryAt,
      ...summarize(entries.slice(cursor)),
    });
    cursor = entries.length;
    boundaryAt = now;
  }

  /** Returns safe local-only evidence and keeps fixture dispatches distinct from actual network traffic. */
  function report() {
    if (cursor !== entries.length)
      throw Error(
        "Workflow operations remain outside the final ledger boundary",
      );
    return {
      kind: "local-simulated-github-workflow-ledger",
      units: {
        github: "fixture command dispatches; not actual HTTP",
        cost: "sum of fixture response data.rateLimit.cost; not live GitHub cost",
        latency: "local monotonic elapsed milliseconds; not network latency",
        git: "scheduler/publisher command boundary plus logical worktree calls; internal SimpleGit subprocesses and fixture setup/implementation/merge-simulation/verification helper commands are excluded",
      },
      transportRetries: 0,
      transportRetryBasis:
        "This fixture has no transport retry wrapper; every attempted dispatch is recorded, including failure and rate-header metadata. It returns no quota or header-retry responses.",
      localElapsedMs: boundaryAt - started,
      entries,
      stages,
      totals: summarize(entries),
    };
  }

  return { observeStore, observeRunner, event, snapshot, report };
}
