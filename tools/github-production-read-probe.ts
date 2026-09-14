import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { graphQLFailure, graphQLQuota } from "../src/github/graphql-reader";
import { GitHubRemoteIssueReader } from "../src/github/issue-reader";
import type { GitHubCommandRunner } from "../src/github/pr-publisher";
import { GitHubRateLimitRunner } from "../src/github/rate-limit";
import { canonicalDigest, ObservedGitHubRunner } from "./github-read-proof";

const BASELINE_READER_SHA =
  "eda5702963035790b3675cee20cf58c81e780b77cce6d36ff665ddf0289c354a";
type Leg = {
  kind: "rest" | "graphql";
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  httpRequests: number;
  overshoot: number;
  issueCount?: number;
  commentCount?: number;
  digest?: string;
  code?: string;
  queries: Array<{
    cost?: number;
    limit?: number;
    remaining?: number;
    resetAt?: number;
  }>;
  commands: ObservedGitHubRunner["commands"];
};

/** Parses the explicit live read envelope before loading a baseline or contacting GitHub. */
export function probeArguments(args: string[]) {
  const values = new Map<string, string>();
  let live = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--live" && !live) {
      live = true;
      continue;
    }
    if (
      !["--repo", "--baseline", "--cwd", "--max-http"].includes(key) ||
      values.has(key) ||
      !args[i + 1] ||
      args[i + 1]!.startsWith("--")
    )
      throw Error("Invalid production read probe arguments");
    values.set(key, args[++i]!);
  }
  const repository = values.get("--repo") ?? "";
  const baseline = values.get("--baseline");
  const maxHttp = Number(values.get("--max-http") ?? "199");
  if (
    !live ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !baseline ||
    !Number.isInteger(maxHttp) ||
    maxHttp < 1 ||
    maxHttp > 199
  )
    throw Error(
      "Require --live, --repo owner/name, --baseline frozen-workspace and --max-http 1..199",
    );
  return {
    repository,
    baseline: resolve(baseline),
    cwd: resolve(values.get("--cwd") ?? process.cwd()),
    maxHttp,
  };
}

/** Evaluates only complete, stable paired observations against the approved idle-read gates. */
export function productionReadGates(legs: Leg[]) {
  const rest = legs.filter((leg) => leg.kind === "rest");
  const graphql = legs.filter((leg) => leg.kind === "graphql");
  /** Returns the median only after exactly three observations are available. */
  const median = (values: number[]) =>
    values.length === 3 ? [...values].sort((a, b) => a - b)[1]! : Infinity;
  const complete =
    legs.length === 6 &&
    rest.length === 3 &&
    graphql.length === 3 &&
    legs.every(
      (leg) =>
        !leg.code && leg.digest && leg.httpRequests > 0 && leg.overshoot === 0,
    );
  const parity = complete && new Set(legs.map((leg) => leg.digest)).size === 1;
  return {
    complete,
    parity,
    http:
      complete &&
      graphql.every(
        (leg, index) => leg.httpRequests <= rest[index]!.httpRequests * 0.5,
      ),
    latency:
      complete &&
      median(graphql.map((leg) => leg.elapsedMs)) <=
        median(rest.map((leg) => leg.elapsedMs)) * 1.2,
    quota:
      complete &&
      graphql.every(
        (leg) =>
          leg.queries.length === leg.httpRequests &&
          leg.queries.every(
            (query) =>
              Number.isInteger(query.cost) &&
              (query.cost ?? -1) >= 0 &&
              Number.isInteger(query.limit) &&
              (query.limit ?? 0) > 0 &&
              Number.isInteger(query.remaining) &&
              (query.remaining ?? -1) > 0 &&
              (query.remaining ?? Infinity) <= (query.limit ?? 0) &&
              Number.isFinite(query.resetAt),
          ) &&
          leg.queries.reduce((sum, query) => sum + (query.cost ?? 0), 0) *
            120 <=
            Math.min(...leg.queries.map((query) => query.limit ?? 0)) * 0.2,
      ),
  };
}

/** Compares the production reader with the verified frozen REST reader using observed-stream accounting. */
export async function runProductionReadProbe(args: string[]) {
  const options = probeArguments(args);
  const readerPath = resolve(options.baseline, "src/github/issue-reader.ts");
  const baselineHash = createHash("sha256")
    .update(new Uint8Array(await Bun.file(readerPath).arrayBuffer()))
    .digest("hex");
  if (baselineHash !== BASELINE_READER_SHA)
    throw Error(
      "Frozen REST reader hash differs from the approved M1 baseline",
    );
  const baseline = await import(pathToFileURL(readerPath).href);
  const parent = new AbortController();
  /** Cancels only this isolated read probe and all of its owned gh children. */
  const stop = () => parent.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const legs: Leg[] = [];
  let observed = 0;
  try {
    for (const kind of [
      "rest",
      "graphql",
      "graphql",
      "rest",
      "rest",
      "graphql",
    ] as const) {
      if (parent.signal.aborted || observed >= options.maxHttp) break;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 30000);
      const signal = AbortSignal.any([parent.signal, timeout.signal]);
      const observer = new ObservedGitHubRunner(
        options.cwd,
        options.repository,
        signal,
        options.maxHttp - observed,
        undefined,
        true,
      );
      const queries: Leg["queries"] = [];
      const transport: GitHubCommandRunner = {
        /** Captures only quota metadata and stops before retry on any GraphQL error. */
        async run(input) {
          const result = await observer.run(input);
          if (input.intent === "graphql-read") {
            const quota = graphQLQuota(result.stdout);
            queries.push(quota ?? {});
            if (graphQLFailure(result) || quota?.remaining === 0)
              throw Error("PRODUCTION_GRAPHQL_STOP");
          }
          return result;
        },
      };
      const runner = new GitHubRateLimitRunner(transport, { signal });
      const started = performance.now();
      const leg: Leg = {
        kind,
        startedAt: new Date().toISOString(),
        endedAt: "",
        elapsedMs: 0,
        httpRequests: 0,
        overshoot: 0,
        queries,
        commands: observer.commands,
      };
      try {
        const reader =
          kind === "rest"
            ? new baseline.GitHubRemoteIssueReader(options.cwd, observer)
            : new GitHubRemoteIssueReader(options.cwd, runner);
        const issues = await reader.read(options.repository, signal);
        signal.throwIfAborted();
        leg.issueCount = issues.length;
        leg.commentCount = issues.reduce(
          (sum: number, issue: { comments: unknown[] }) =>
            sum + issue.comments.length,
          0,
        );
        leg.digest = canonicalDigest(issues);
      } catch {
        leg.code =
          observer.code ??
          (timeout.signal.aborted
            ? "PROBE_TIMEOUT"
            : parent.signal.aborted
              ? "PROBE_ABORTED"
              : "PROBE_READ_INCOMPLETE");
      } finally {
        clearTimeout(timer);
        leg.endedAt = new Date().toISOString();
        leg.elapsedMs = Math.round(performance.now() - started);
        leg.httpRequests = observer.httpRequests;
        leg.overshoot = observer.overshoot;
        observed += leg.httpRequests;
        legs.push(leg);
      }
      if (
        leg.code ||
        leg.digest !== legs[0]!.digest ||
        observed >= options.maxHttp
      )
        break;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  const gates = productionReadGates(legs);
  return {
    kind: "production-graphql-read-pairs",
    repository: options.repository,
    baselineReaderSha256: baselineHash,
    baselinePath: options.baseline,
    cwd: options.cwd,
    observedHttp: observed,
    observedStopThreshold: options.maxHttp,
    perLegTimeoutMs: 30000,
    accounting: "observed gh response stream; stop and drain can overshoot",
    gates,
    passed: Object.values(gates).every(Boolean),
    legs,
  };
}

if (import.meta.main) {
  try {
    const report = await runProductionReadProbe(Bun.argv.slice(2));
    console.log(JSON.stringify(report));
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    console.error(
      "Production read probe refused its input or frozen baseline; no comparison completed",
    );
    process.exitCode = 1;
  }
}
