import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { RemoteIssue } from "../src/github/issue-reader";
import type {
  GitHubCommandResult,
  GitHubCommandRunner,
} from "../src/github/pr-publisher";

export const GRAPHQL_PAGE_SIZE = 25;
export const GRAPHQL_ISSUE_SAFETY_BOUND = 1000;

type JsonRecord = Record<string, unknown>;
type IssueState = "OPEN" | "CLOSED";

export type GraphQLRateLimit = {
  cost?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
};

export type GraphQLTransportResponse = {
  status: number;
  body: unknown;
  httpRequests?: number;
  elapsedMs?: number;
  retryAfterMs?: number;
  rateLimit?: GraphQLRateLimit;
};

export type GraphQLTransport = {
  request(input: {
    operation: string;
    query: string;
    variables: Record<string, string | null>;
    signal: AbortSignal;
  }): Promise<GraphQLTransportResponse>;
};

export type GraphQLReadProofOptions = {
  signal?: AbortSignal;
  mode?: "offline" | "live";
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export type QueryObservation = {
  operation: string;
  httpRequests: number;
  status?: number;
  elapsedMs?: number;
  rateLimit?: GraphQLRateLimit;
};

export type GraphQLReadProofResult = {
  issues: RemoteIssue[];
  observations: QueryObservation[];
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type Page<T> = { totalCount: number; nodes: T[]; pageInfo: PageInfo };
type Label = { name: string };
type Comment = {
  databaseId: number;
  body: string;
  author: { login: string } | null;
};
type IssueSeed = {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: IssueState;
  labels: Page<Label>;
  comments: Page<Comment>;
};

const DISCOVERY_QUERY = `query ManagedIssueDiscovery($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 25, after: $cursor, states: [OPEN, CLOSED], labels: ["roc:task"], orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes {
        id number title body url state
        labels(first: 25) { totalCount pageInfo { hasNextPage endCursor } nodes { name } }
        comments(first: 25) { totalCount pageInfo { hasNextPage endCursor } nodes { databaseId body author { login } } }
      }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`;

const LABELS_QUERY = `query IssueLabels($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on Issue { labels(first: 25, after: $cursor) { totalCount pageInfo { hasNextPage endCursor } nodes { name } } }
  }
  rateLimit { cost limit remaining resetAt }
}`;

const COMMENTS_QUERY = `query IssueComments($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on Issue { comments(first: 25, after: $cursor) { totalCount pageInfo { hasNextPage endCursor } nodes { databaseId body author { login } } } }
  }
  rateLimit { cost limit remaining resetAt }
}`;

/** Signals that an independent GraphQL proof cannot safely return a snapshot. */
export class GraphQLReadProofError extends Error {
  /** Creates a sanitized proof failure with a stable operational code. */
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GraphQLReadProofError";
  }
}

/** Returns an object value or stops the proof before an incomplete value can escape. */
function object(value: unknown, field: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new GraphQLReadProofError("GQL_READ_INCOMPLETE", `Missing ${field}`);
  return value as JsonRecord;
}

/** Returns a required nonblank string while keeping remote content out of diagnostics. */
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new GraphQLReadProofError("GQL_READ_INCOMPLETE", `Missing ${field}`);
  return value;
}

/** Returns a required string that may intentionally be empty, such as an Issue body. */
function text(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new GraphQLReadProofError("GQL_READ_INCOMPLETE", `Missing ${field}`);
  return value;
}

/** Returns a required positive integer while rejecting nullable GraphQL identifiers. */
function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0)
    throw new GraphQLReadProofError("GQL_READ_INCOMPLETE", `Missing ${field}`);
  return value as number;
}

/** Parses GraphQL page metadata and rejects a cursor that cannot continue a page. */
function pageInfo(value: unknown, field: string): PageInfo {
  const record = object(value, `${field}.pageInfo`);
  if (typeof record.hasNextPage !== "boolean")
    throw new GraphQLReadProofError(
      "GQL_READ_INCOMPLETE",
      `Missing ${field}.hasNextPage`,
    );
  const endCursor = record.endCursor;
  if (endCursor !== null && typeof endCursor !== "string")
    throw new GraphQLReadProofError(
      "GQL_READ_INCOMPLETE",
      `Missing ${field}.endCursor`,
    );
  if (record.hasNextPage && (typeof endCursor !== "string" || endCursor === ""))
    throw new GraphQLReadProofError(
      "GQL_CURSOR_STALLED",
      `Unusable ${field} cursor`,
    );
  return {
    hasNextPage: record.hasNextPage,
    endCursor: endCursor as string | null,
  };
}

/** Parses one connection page and keeps its independently reported total count. */
function page<T>(
  value: unknown,
  field: string,
  item: (value: unknown) => T,
): Page<T> {
  const record = object(value, field);
  const nodes = record.nodes;
  if (!Array.isArray(nodes))
    throw new GraphQLReadProofError(
      "GQL_READ_INCOMPLETE",
      `Missing ${field}.nodes`,
    );
  const totalCount = record.totalCount;
  if (!Number.isInteger(totalCount) || (totalCount as number) < 0)
    throw new GraphQLReadProofError(
      "GQL_READ_INCOMPLETE",
      `Missing ${field}.totalCount`,
    );
  if (nodes.length > GRAPHQL_PAGE_SIZE)
    throw new GraphQLReadProofError(
      "GQL_READ_INCOMPLETE",
      `Oversized ${field} page`,
    );
  return {
    totalCount: totalCount as number,
    nodes: nodes.map(item),
    pageInfo: pageInfo(record.pageInfo, field),
  };
}

/** Parses a label into the only label field that participates in RemoteIssue equivalence. */
function label(value: unknown): Label {
  return { name: string(object(value, "label").name, "label.name") };
}

/** Parses a comment while preserving nullable authors without assigning trust. */
function comment(value: unknown): Comment {
  const record = object(value, "comment");
  const authorValue = record.author;
  const author =
    authorValue === null
      ? null
      : {
          login: string(
            object(authorValue, "comment.author").login,
            "comment.author.login",
          ),
        };
  return {
    databaseId: positiveInteger(record.databaseId, "comment.databaseId"),
    body: text(record.body, "comment.body"),
    author,
  };
}

/** Parses a discovered managed Issue and its first independent label and comment pages. */
function issueSeed(value: unknown): IssueSeed {
  const record = object(value, "issue");
  const state = record.state;
  if (state !== "OPEN" && state !== "CLOSED")
    throw new GraphQLReadProofError(
      "GQL_READ_INCOMPLETE",
      "Missing issue.state",
    );
  return {
    id: string(record.id, "issue.id"),
    number: positiveInteger(record.number, "issue.number"),
    title: string(record.title, "issue.title"),
    body: text(record.body, "issue.body"),
    url: string(record.url, "issue.url"),
    state,
    labels: page(record.labels, "issue.labels", label),
    comments: page(record.comments, "issue.comments", comment),
  };
}

/** Rejects duplicate stable identifiers before the candidate snapshot is assembled. */
function unique<T>(
  values: T[],
  key: (value: T) => string | number,
  field: string,
): void {
  const seen = new Set<string | number>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id))
      throw new GraphQLReadProofError("GQL_DUPLICATE", `Duplicate ${field}`);
    seen.add(id);
  }
}

/** Collects every page of one connection and detects count drift and cursor stalls. */
async function drain<T>(
  initial: Page<T>,
  next: (cursor: string) => Promise<Page<T>>,
  field: string,
): Promise<T[]> {
  const values = [...initial.nodes];
  const totalCount = initial.totalCount;
  let info = initial.pageInfo;
  const seenCursors = new Set<string>();
  let pages = 1;
  const maximumPages = Math.ceil(totalCount / GRAPHQL_PAGE_SIZE);
  if (values.length > totalCount || (info.hasNextPage && maximumPages === 0))
    throw new GraphQLReadProofError(
      "GQL_READ_INCOMPLETE",
      `Invalid ${field} page sequence`,
    );
  while (info.hasNextPage) {
    const cursor = info.endCursor;
    if (cursor === null || seenCursors.has(cursor) || pages >= maximumPages)
      throw new GraphQLReadProofError(
        "GQL_CURSOR_STALLED",
        `Non-progressing ${field} cursor`,
      );
    seenCursors.add(cursor);
    const following = await next(cursor);
    if (following.totalCount !== totalCount)
      throw new GraphQLReadProofError(
        "GQL_COUNT_DRIFT",
        `Changed ${field} count`,
      );
    values.push(...following.nodes);
    pages++;
    if (values.length > totalCount)
      throw new GraphQLReadProofError(
        "GQL_READ_INCOMPLETE",
        `Oversized ${field} page sequence`,
      );
    info = following.pageInfo;
  }
  if (values.length !== totalCount)
    throw new GraphQLReadProofError(
      "GQL_READ_INCOMPLETE",
      `Incomplete ${field} page sequence`,
    );
  return values;
}

/** Classifies remote failures without retaining GraphQL error messages or response bodies. */
function remoteFailure(
  response: GraphQLTransportResponse,
  body: JsonRecord,
): GraphQLReadProofError | undefined {
  const quota =
    response.status === 429 ||
    response.rateLimit?.remaining === 0 ||
    response.retryAfterMs !== undefined;
  if (quota)
    return new GraphQLReadProofError(
      "GQL_READ_QUOTA",
      "GitHub GraphQL quota rejected this read",
    );
  if (response.status === 401 || response.status === 403)
    return new GraphQLReadProofError(
      "GQL_READ_PERMISSION",
      "GitHub GraphQL permission rejected this read",
    );
  const errors = body.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const text = errors
    .map((value) =>
      value !== null && typeof value === "object"
        ? String(
            (value as JsonRecord).type ?? (value as JsonRecord).message ?? "",
          )
        : "",
    )
    .join(" ");
  const quotaError = /rate.?limit|abuse|quota/i.test(text);
  const permission =
    response.status === 401 ||
    /forbidden|unauthorized|resource not accessible/i.test(text);
  return new GraphQLReadProofError(
    quotaError
      ? "GQL_READ_QUOTA"
      : permission
        ? "GQL_READ_PERMISSION"
        : "GQL_READ_INCOMPLETE",
    quotaError
      ? "GitHub GraphQL quota rejected this read"
      : permission
        ? "GitHub GraphQL permission rejected this read"
        : "GitHub GraphQL returned errors",
  );
}

/** Parses a rate-limit object only when GitHub supplied a complete numeric field. */
function rateLimit(data: JsonRecord): GraphQLRateLimit | undefined {
  const value = data.rateLimit;
  if (value === undefined || value === null) return undefined;
  const record = object(value, "rateLimit");
  const output: GraphQLRateLimit = {};
  for (const key of ["cost", "limit", "remaining"] as const) {
    if (record[key] !== undefined) {
      if (!Number.isInteger(record[key]) || (record[key] as number) < 0)
        throw new GraphQLReadProofError(
          "GQL_READ_INCOMPLETE",
          `Invalid rateLimit.${key}`,
        );
      output[key] = record[key] as number;
    }
  }
  if (record.resetAt !== undefined)
    output.resetAt = string(record.resetAt, "rateLimit.resetAt");
  return output;
}

/** Splits an explicit owner/name repository argument without inferring a checkout or login. */
function repositoryParts(repository: string): { owner: string; name: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(repository);
  if (!match)
    throw new GraphQLReadProofError(
      "GQL_READ_INPUT",
      "Repository must be owner/name",
    );
  const owner = match[1];
  const name = match[2];
  if (owner === undefined || name === undefined)
    throw new GraphQLReadProofError(
      "GQL_READ_INPUT",
      "Repository must be owner/name",
    );
  return { owner, name };
}

/** Reads a complete non-authoritative managed-Issue snapshot through fixed GraphQL queries. */
export class GraphQLReadProof {
  private readonly signal: AbortSignal;
  private readonly mode: "offline" | "live";
  private readonly now: () => number;
  private readonly wait: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private pauseUntil = 0;
  private waiting?: Promise<void>;
  private observations: QueryObservation[] = [];

  /** Binds a fixed-query transport to a cancellable offline or live proof session. */
  constructor(
    private readonly transport: GraphQLTransport,
    options: GraphQLReadProofOptions = {},
  ) {
    this.signal = options.signal ?? new AbortController().signal;
    this.mode = options.mode ?? "offline";
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ??
      ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  }

  /** Reads every managed Issue, label, and comment page or returns no snapshot at all. */
  async read(repository: string): Promise<GraphQLReadProofResult> {
    this.observations = [];
    const { owner, name } = repositoryParts(repository);
    const outer = await drain(
      await this.discovery(owner, name, null),
      (cursor) => this.discovery(owner, name, cursor),
      "issues",
    );
    if (outer.length >= GRAPHQL_ISSUE_SAFETY_BOUND)
      throw new GraphQLReadProofError(
        "GQL_ISSUE_BOUND",
        "GitHub task source reached its 1000-Issue safety bound",
      );
    unique(outer, (issue) => issue.id, "Issue id");
    unique(outer, (issue) => issue.number, "Issue number");
    const issues: RemoteIssue[] = [];
    for (const issue of outer) {
      const labels = await drain(
        issue.labels,
        (cursor) => this.labels(issue.id, cursor),
        `Issue ${issue.number} labels`,
      );
      const comments = await drain(
        issue.comments,
        (cursor) => this.comments(issue.id, cursor),
        `Issue ${issue.number} comments`,
      );
      unique(labels, (item) => item.name, "label name");
      unique(comments, (item) => item.databaseId, "comment databaseId");
      issues.push({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        url: issue.url,
        state: issue.state,
        labels,
        comments,
      });
    }
    return { issues, observations: [...this.observations] };
  }

  /** Loads one outer Issue page with initial independent comment and label connections. */
  private async discovery(
    owner: string,
    name: string,
    cursor: string | null,
  ): Promise<Page<IssueSeed>> {
    const data = await this.query("ManagedIssueDiscovery", DISCOVERY_QUERY, {
      owner,
      name,
      cursor,
    });
    const repository = data.repository;
    if (repository === null || repository === undefined)
      throw new GraphQLReadProofError(
        "GQL_READ_INCOMPLETE",
        "Missing repository",
      );
    return page(
      object(repository, "repository").issues,
      "repository.issues",
      issueSeed,
    );
  }

  /** Loads the next label page for exactly one previously discovered Issue node. */
  private async labels(id: string, cursor: string): Promise<Page<Label>> {
    const data = await this.query("IssueLabels", LABELS_QUERY, { id, cursor });
    const node = data.node;
    if (node === null || node === undefined)
      throw new GraphQLReadProofError(
        "GQL_READ_INCOMPLETE",
        "Missing Issue label node",
      );
    return page(object(node, "Issue label node").labels, "Issue labels", label);
  }

  /** Loads the next comment page for exactly one previously discovered Issue node. */
  private async comments(id: string, cursor: string): Promise<Page<Comment>> {
    const data = await this.query("IssueComments", COMMENTS_QUERY, {
      id,
      cursor,
    });
    const node = data.node;
    if (node === null || node === undefined)
      throw new GraphQLReadProofError(
        "GQL_READ_INCOMPLETE",
        "Missing Issue comment node",
      );
    return page(
      object(node, "Issue comment node").comments,
      "Issue comments",
      comment,
    );
  }

  /** Executes one fixed read query, with offline-only quota retry and cancellable shared waiting. */
  private async query(
    operation: string,
    query: string,
    variables: Record<string, string | null>,
  ): Promise<JsonRecord> {
    for (let attempt = 0; ; attempt++) {
      this.signal.throwIfAborted();
      const response = await this.transport.request({
        operation,
        query,
        variables,
        signal: this.signal,
      });
      const httpRequests = response.httpRequests ?? 1;
      if (!Number.isInteger(httpRequests) || httpRequests < 1)
        throw new GraphQLReadProofError(
          "GQL_READ_INCOMPLETE",
          "Invalid HTTP request count",
        );
      const body = object(response.body, "GraphQL response");
      const failure = remoteFailure(response, body);
      if (failure !== undefined) {
        if (
          failure.code === "GQL_READ_QUOTA" &&
          this.mode === "offline" &&
          attempt === 0
        ) {
          await this.pause(response);
          continue;
        }
        throw failure;
      }
      if (response.status < 200 || response.status >= 300)
        throw new GraphQLReadProofError(
          response.status === 401 || response.status === 403
            ? "GQL_READ_PERMISSION"
            : "GQL_READ_INCOMPLETE",
          "GitHub GraphQL read did not succeed",
        );
      const data = body.data;
      if (data === null || data === undefined)
        throw new GraphQLReadProofError(
          "GQL_READ_INCOMPLETE",
          "Missing GraphQL data",
        );
      const parsed = object(data, "GraphQL data");
      this.observations.push({
        operation,
        httpRequests,
        ...(response.elapsedMs === undefined
          ? {}
          : { elapsedMs: response.elapsedMs }),
        rateLimit: rateLimit(parsed) ?? response.rateLimit,
      });
      return parsed;
    }
  }

  /** Shares a bounded fake-clock quota wait and stops immediately when cancellation wins. */
  private async pause(response: GraphQLTransportResponse): Promise<void> {
    const until =
      response.retryAfterMs === undefined
        ? response.rateLimit?.resetAt === undefined
          ? 0
          : Date.parse(response.rateLimit.resetAt)
        : this.now() + response.retryAfterMs;
    if (!Number.isFinite(until) || until <= this.now())
      throw new GraphQLReadProofError(
        "GQL_READ_QUOTA",
        "GitHub GraphQL quota rejected this read",
      );
    this.pauseUntil = Math.max(this.pauseUntil, until);
    const milliseconds = this.pauseUntil - this.now();
    this.waiting ??= this.wait(milliseconds, this.signal).finally(() => {
      this.waiting = undefined;
    });
    await this.waiting;
    this.signal.throwIfAborted();
  }
}

/** Produces the comparison representation while excluding GraphQL-only fields and source ordering. */
export function canonicalRemoteIssues(issues: RemoteIssue[]): RemoteIssue[] {
  return issues
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      state: issue.state,
      labels: issue.labels
        .map((label) => ({ name: label.name }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      comments: issue.comments
        .map((comment) => ({
          databaseId: comment.databaseId,
          body: comment.body,
          author:
            comment.author === null ? null : { login: comment.author.login },
        }))
        .sort((left, right) => left.databaseId - right.databaseId),
    }))
    .sort((left, right) => left.number - right.number);
}

/** Hashes the canonical RemoteIssue representation without emitting its potentially sensitive bodies. */
export function canonicalDigest(issues: RemoteIssue[]): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalRemoteIssues(issues)))
    .digest("hex")}`;
}

type FixedGraphQLRequest = {
  operation: "ManagedIssueDiscovery" | "IssueLabels" | "IssueComments";
  query: string;
  variables: Record<string, string | null>;
  signal: AbortSignal;
};

export type LiveRequestExecutor = {
  prepare?(signal: AbortSignal): Promise<void>;
  execute(input: FixedGraphQLRequest): Promise<GraphQLTransportResponse>;
};

/** Rejects arbitrary queries and malformed variables before a live transport can send a request. */
function fixedRequest(input: {
  operation: string;
  query: string;
  variables: Record<string, string | null>;
  signal: AbortSignal;
}): FixedGraphQLRequest {
  const expected =
    input.operation === "ManagedIssueDiscovery"
      ? { query: DISCOVERY_QUERY, keys: ["owner", "name", "cursor"] }
      : input.operation === "IssueLabels"
        ? { query: LABELS_QUERY, keys: ["id", "cursor"] }
        : input.operation === "IssueComments"
          ? { query: COMMENTS_QUERY, keys: ["id", "cursor"] }
          : undefined;
  if (
    expected === undefined ||
    input.query !== expected.query ||
    /\bmutation\b/iu.test(input.query) ||
    Object.keys(input.variables).length !== expected.keys.length ||
    !expected.keys.every((key) => Object.hasOwn(input.variables, key))
  )
    throw new GraphQLReadProofError(
      "GQL_READ_INPUT",
      "Live transport accepts only fixed read operations",
    );
  if (
    Object.values(input.variables).some(
      (value) => value !== null && (typeof value !== "string" || value === ""),
    )
  )
    throw new GraphQLReadProofError(
      "GQL_READ_INPUT",
      "Live transport received invalid variables",
    );
  return input as FixedGraphQLRequest;
}

/** Reads the existing gh credential locally and terminates the helper if it cannot finish promptly. */
async function authToken(
  signal: AbortSignal,
  spawn: ProofSpawn,
  cwd: string,
): Promise<string> {
  signal.throwIfAborted();
  const helper = spawn({ command: ["gh", "auth", "token"], cwd });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  /** Terminates the authentication helper and bounds its cancellation drain. */
  const stop = () => {
    if (killTimer !== undefined) return;
    helper.kill("SIGTERM");
    killTimer = setTimeout(() => helper.kill("SIGKILL"), 1_000);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const [exit, output, diagnostic] = await Promise.allSettled([
      helper.exited,
      new Response(helper.stdout).text().catch(() => {
        stop();
        return "";
      }),
      traceLines(helper.stderr, () => {}).catch(() => {
        stop();
        throw new GraphQLReadProofError(
          "GQL_READ_PERMISSION",
          "Authentication helper did not drain",
        );
      }),
    ]);
    signal.throwIfAborted();
    const exitCode = exit.status === "fulfilled" ? exit.value : 1;
    const stdout = output.status === "fulfilled" ? output.value : "";
    if (
      exitCode !== 0 ||
      stdout.trim() === "" ||
      diagnostic.status === "rejected"
    )
      throw new GraphQLReadProofError(
        "GQL_READ_PERMISSION",
        "GitHub authentication is unavailable",
      );
    return stdout.trim();
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer);
    signal.removeEventListener("abort", stop);
  }
}

/** Executes one direct no-redirect GraphQL HTTP request using an in-memory existing gh credential. */
class FetchGraphQLExecutor implements LiveRequestExecutor {
  private token = "";

  /** Binds local authentication to the same cancellable process seam as baseline reads. */
  constructor(
    private readonly spawn: ProofSpawn = spawnProof,
    private readonly cwd = process.cwd(),
  ) {}

  /** Acquires one in-memory credential per leg before an HTTP attempt is reserved. */
  async prepare(signal: AbortSignal): Promise<void> {
    if (this.token === "")
      this.token = await authToken(signal, this.spawn, this.cwd);
  }

  /** Sends one fixed query without redirect following, retries, raw logging, or persistent credentials. */
  async execute(input: FixedGraphQLRequest): Promise<GraphQLTransportResponse> {
    input.signal.throwIfAborted();
    const started = performance.now();
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: input.signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": "roc-graphql-read-proof",
      },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const retry = response.headers.get("retry-after");
    return {
      status: response.status,
      body,
      httpRequests: 1,
      elapsedMs: Math.round(performance.now() - started),
      ...(retry === null ? {} : { retryAfterMs: Number(retry) * 1_000 }),
      rateLimit: {
        ...(remaining === null ? {} : { remaining: Number(remaining) }),
        ...(reset === null
          ? {}
          : { resetAt: new Date(Number(reset) * 1_000).toISOString() }),
      },
    };
  }
}

/** Executes fixed GraphQL reads through a no-redirect one-request transport with a hard attempt ceiling. */
export class LiveGraphQLTransport implements GraphQLTransport {
  private used = 0;
  readonly observations: QueryObservation[] = [];

  /** Creates a live read-only transport with an exact per-session HTTP ceiling. */
  constructor(
    private readonly maxHttp: number,
    private readonly executor: LiveRequestExecutor = new FetchGraphQLExecutor(),
  ) {
    validateMaxHttp(maxHttp);
  }

  /** Returns reserved direct HTTP attempts, including requests that fail before a response. */
  get httpRequests(): number {
    return this.used;
  }

  /** Sends one explicit query and discards all raw diagnostic and response content after parsing. */
  async request(input: {
    operation: string;
    query: string;
    variables: Record<string, string | null>;
    signal: AbortSignal;
  }): Promise<GraphQLTransportResponse> {
    const fixed = fixedRequest(input);
    fixed.signal.throwIfAborted();
    if (this.used >= this.maxHttp)
      throw new GraphQLReadProofError(
        "GQL_HTTP_BOUND",
        "Live HTTP safety bound reached",
      );
    await this.executor.prepare?.(fixed.signal);
    fixed.signal.throwIfAborted();
    // Recheck after asynchronous preparation so concurrent callers cannot exceed the ceiling.
    if (this.used >= this.maxHttp)
      throw new GraphQLReadProofError(
        "GQL_HTTP_BOUND",
        "Live HTTP safety bound reached",
      );
    // Reserve before dispatch: failures and a response with an error still consume one attempt.
    this.used++;
    const started = performance.now();
    const observation: QueryObservation = {
      operation: fixed.operation,
      httpRequests: 1,
    };
    this.observations.push(observation);
    try {
      const response = await this.executor.execute(fixed);
      observation.status = response.status;
      observation.rateLimit = safeResponseRate(response);
      if (response.httpRequests !== undefined && response.httpRequests !== 1)
        throw new GraphQLReadProofError(
          "GQL_HTTP_AUDIT",
          "Live executor did not report one direct HTTP request",
        );
      return { ...response, httpRequests: 1 };
    } catch (error) {
      if (error instanceof GraphQLReadProofError) throw error;
      if (fixed.signal.aborted)
        throw fixed.signal.reason ?? new DOMException("Aborted", "AbortError");
      throw new GraphQLReadProofError(
        "GQL_READ_INCOMPLETE",
        "GitHub GraphQL request did not complete",
      );
    } finally {
      observation.elapsedMs = Math.round(performance.now() - started);
    }
  }
}

/** Retains only valid numeric quota fields and an ISO reset timestamp from a query response. */
function safeResponseRate(
  response: GraphQLTransportResponse,
): GraphQLRateLimit | undefined {
  let supplied = response.rateLimit;
  try {
    const body = object(response.body, "response");
    if (body.data !== undefined && body.data !== null)
      supplied = rateLimit(object(body.data, "data")) ?? supplied;
  } catch {
    /* Invalid metadata cannot satisfy the quota criterion. */
  }
  if (supplied === undefined) return undefined;
  const safe: GraphQLRateLimit = {};
  for (const key of ["cost", "limit", "remaining"] as const) {
    const value = supplied[key];
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0)
      safe[key] = value;
  }
  if (
    supplied.resetAt !== undefined &&
    Number.isFinite(Date.parse(supplied.resetAt))
  )
    safe.resetAt = new Date(supplied.resetAt).toISOString();
  return safe;
}

type SafeRateHeaders = {
  remaining?: number;
  limit?: number;
  resetAt?: string;
};

export type ProofProcess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
};

export type ProofSpawn = (input: {
  command: string[];
  cwd: string;
}) => ProofProcess;

/** Starts an argv-only child with piped output for observation and cancellation. */
function spawnProof(input: { command: string[]; cwd: string }): ProofProcess {
  return Bun.spawn({
    cmd: input.command,
    cwd: input.cwd,
    env: { ...process.env, GH_DEBUG: input.command[1] === "auth" ? "" : "api" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Rejects session ceilings before any authentication or network work starts. */
function validateMaxHttp(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 199)
    throw new GraphQLReadProofError(
      "GQL_READ_INPUT",
      "maxHttp must be an integer from 1 through 199",
    );
}

/** Drains stderr into bounded lines, discarding oversized payload lines immediately. */
async function traceLines(
  stream: ReadableStream<Uint8Array>,
  observe: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let oversized = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const character of decoder.decode(chunk.value, { stream: true })) {
        if (character === "\n") {
          if (!oversized) observe(pending.trimEnd());
          pending = "";
          oversized = false;
        } else if (!oversized) {
          pending += character;
          if (pending.length > 512) {
            pending = "";
            oversized = true;
          }
        }
      }
    }
    if (pending && !oversized) observe(pending.trimEnd());
  } finally {
    reader.releaseLock();
  }
}

type CommandObservation = {
  shape: "issue-list" | "issue-comments" | "graphql-read";
  startedAt: string;
  endedAt?: string;
  elapsedMs?: number;
  exitCode?: number;
  httpRequests: number;
  statuses: number[];
  rateHeaders: SafeRateHeaders[];
};

/** Runs the original reader commands with a shared observed-stream stop threshold. */
export class ObservedGitHubRunner implements GitHubCommandRunner {
  private observed = 0;
  private stopCode: string | undefined;
  private readonly active = new Set<() => void>();
  private readonly headers: SafeRateHeaders[] = [];
  readonly commands: CommandObservation[] = [];

  /** Connects the unchanged baseline to one shared session remainder and injectable child launcher. */
  constructor(
    private readonly cwd: string,
    private readonly repository: string,
    private readonly signal: AbortSignal,
    private readonly threshold = 199,
    private readonly spawn: ProofSpawn = spawnProof,
    private readonly allowProductionGraphQL = false,
  ) {
    validateMaxHttp(threshold);
  }

  /** Returns every observed HTTP response, including responses drained after stopping. */
  get httpRequests(): number {
    return this.observed;
  }

  /** Returns the observed responses beyond the permitted REST stop threshold. */
  get overshoot(): number {
    return Math.max(0, this.observed - this.threshold);
  }

  /** Returns only parsed allowlisted response headers. */
  get rateHeaders(): SafeRateHeaders[] {
    return [...this.headers];
  }

  /** Returns the first operational failure that stopped this baseline. */
  get code(): string | undefined {
    return this.stopCode;
  }

  /** Indicates whether a stopped or cancelled baseline cannot schedule another command. */
  get shouldStop(): boolean {
    return this.stopCode !== undefined || this.signal.aborted;
  }

  /** Stops every active process while preserving the first failure category. */
  private stopAll(code: string): void {
    this.stopCode ??= code;
    for (const stop of this.active) stop();
  }

  /** Executes an exact baseline argv and drains its output even when a peer stops the session. */
  async run(input: {
    command: string[];
    cwd: string;
    intent?: "graphql-read";
  }): Promise<GitHubCommandResult> {
    this.signal.throwIfAborted();
    if (this.stopCode)
      throw new GraphQLReadProofError(this.stopCode, "REST baseline stopped");
    const list = [
      "gh",
      "issue",
      "list",
      "--repo",
      this.repository,
      "--state",
      "all",
      "--label",
      "roc:task",
      "--limit",
      "1000",
      "--json",
      "number,title,body,url,state,labels",
    ];
    const endpoint = input.command[4] ?? "";
    const prefix = `repos/${this.repository}/issues/`;
    const isList = input.command.join("\0") === list.join("\0");
    const isComments =
      input.command.length === 5 &&
      input.command[0] === "gh" &&
      input.command[1] === "api" &&
      input.command[2] === "--paginate" &&
      input.command[3] === "--slurp" &&
      endpoint.startsWith(prefix) &&
      /^[1-9]\d*\/comments\?per_page=100$/u.test(endpoint.slice(prefix.length));
    const isGraphQL =
      this.allowProductionGraphQL &&
      input.intent === "graphql-read" &&
      input.command.slice(0, 3).join(" ") === "gh api graphql" &&
      input.command.some((arg) =>
        /^query=query (ManagedIssues|KnownIssues|IssueLabels|IssueComments)\(/u.test(
          arg,
        ),
      );
    if (input.cwd !== this.cwd || (!isList && !isComments && !isGraphQL))
      throw new GraphQLReadProofError(
        "GQL_READ_INPUT",
        "Observed baseline accepts only managed read commands",
      );
    const started = performance.now();
    const observation: CommandObservation = {
      shape: isGraphQL
        ? "graphql-read"
        : isList
          ? "issue-list"
          : "issue-comments",
      startedAt: new Date().toISOString(),
      httpRequests: 0,
      statuses: [],
      rateHeaders: [],
    };
    this.commands.push(observation);
    let child: ProofProcess;
    try {
      child = this.spawn(input);
    } catch {
      this.stopAll("GQL_READ_INCOMPLETE");
      throw new GraphQLReadProofError(
        "GQL_READ_INCOMPLETE",
        "REST child could not start",
      );
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    /** Terminates this child once, then escalates if it has not exited in one second. */
    const stop = () => {
      if (killTimer !== undefined) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    /** Propagates the parent cancellation to all concurrent baseline children. */
    const abort = () => this.stopAll("GQL_READ_ABORTED");
    this.active.add(stop);
    this.signal.addEventListener("abort", abort, { once: true });
    if (this.signal.aborted) abort();
    let current: SafeRateHeaders | undefined;
    /** Consumes only status and rate-header lines, incrementing the shared count immediately. */
    const observe = (line: string) => {
      const status = /^(?:<\s*)?HTTP\/[\d.]+\s+(\d{3})\b/iu.exec(line);
      if (status) {
        const value = Number(status[1]);
        this.observed++;
        observation.httpRequests++;
        observation.statuses.push(value);
        current = {};
        this.headers.push(current);
        observation.rateHeaders.push(current);
        if (value === 429) this.stopAll("GQL_READ_QUOTA");
        else if (value === 401 || value === 403)
          this.stopAll("GQL_READ_PERMISSION");
        else if (value >= 400) this.stopAll("GQL_READ_INCOMPLETE");
        if (this.observed >= this.threshold) this.stopAll("GQL_HTTP_BOUND");
        return;
      }
      if (current === undefined) return;
      const header =
        /^(?:<\s*)?x-ratelimit-(remaining|limit|reset):\s*(\d+)\s*$/iu.exec(
          line,
        );
      if (!header) return;
      const value = Number(header[2]);
      if (!Number.isSafeInteger(value)) return;
      switch (header[1]?.toLowerCase()) {
        case "remaining":
          current.remaining = value;
          if (value === 0) {
            if (this.stopCode === "GQL_READ_PERMISSION")
              this.stopCode = "GQL_READ_QUOTA";
            this.stopAll("GQL_READ_QUOTA");
          }
          break;
        case "limit":
          current.limit = value;
          break;
        case "reset":
          if (Number.isFinite(new Date(value * 1_000).getTime()))
            current.resetAt = new Date(value * 1_000).toISOString();
          break;
      }
    };
    try {
      const drained = await Promise.allSettled([
        child.exited,
        new Response(child.stdout).text().catch(() => {
          this.stopAll("GQL_READ_INCOMPLETE");
          return "";
        }),
        traceLines(child.stderr, observe).catch(() =>
          this.stopAll("GQL_READ_INCOMPLETE"),
        ),
      ]);
      const exit = drained[0];
      const output = drained[1];
      const exitCode = exit?.status === "fulfilled" ? exit.value : 1;
      const stdout = output?.status === "fulfilled" ? output.value : "";
      observation.exitCode = exitCode;
      if (exitCode !== 0 || observation.httpRequests === 0)
        this.stopAll("GQL_READ_INCOMPLETE");
      const status = observation.statuses.at(-1);
      return {
        exitCode: this.shouldStop ? exitCode || 1 : exitCode,
        stdout,
        stderr: status === undefined ? "" : `HTTP ${status}`,
        ...(status === undefined ? {} : { httpStatus: status }),
      };
    } finally {
      if (killTimer !== undefined) clearTimeout(killTimer);
      this.active.delete(stop);
      this.signal.removeEventListener("abort", abort);
      observation.endedAt = new Date().toISOString();
      observation.elapsedMs = Math.round(performance.now() - started);
    }
  }
}

export type MeasuredLeg = {
  kind: "rest" | "graphql";
  status: "complete" | "incomplete";
  code?: string;
  startedAt: string;
  endedAt: string;
  digest?: string;
  issueCount?: number;
  commentCount?: number;
  maxComments?: number;
  httpRequests: number;
  overshoot: number;
  elapsedMs: number;
  rateHeaders: GraphQLRateLimit[];
  costs: number[];
  queries: QueryObservation[];
  commands: CommandObservation[];
};

export type PairOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  spawn?: ProofSpawn;
  executor?: LiveRequestExecutor;
};

/** Reads a whole leg with linked cancellation and retains safe accounting on every failure. */
export async function measuredLeg(
  kind: "rest" | "graphql",
  repository: string,
  cwd: string,
  remaining: number,
  options: PairOptions = {},
): Promise<MeasuredLeg> {
  validateMaxHttp(remaining);
  /** Reads the monotonic clock used for complete-leg timing. */
  const now = options.now ?? performance.now.bind(performance);
  const started = now();
  const startedAt = new Date().toISOString();
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("Leg timed out", "TimeoutError")),
    options.timeoutMs ?? 30_000,
  );
  const signal = AbortSignal.any([
    timeout.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const runner = new ObservedGitHubRunner(
    cwd,
    repository,
    signal,
    remaining,
    options.spawn,
  );
  const transport = new LiveGraphQLTransport(
    remaining,
    options.executor ?? new FetchGraphQLExecutor(options.spawn, cwd),
  );
  let issues: RemoteIssue[] | undefined;
  let code: string | undefined;
  let snapshot: Pick<
    MeasuredLeg,
    "digest" | "issueCount" | "commentCount" | "maxComments"
  > = {};
  try {
    signal.throwIfAborted();
    if (kind === "rest")
      throw new GraphQLReadProofError(
        "GQL_HISTORICAL_ONLY",
        "M1 REST pairing is retired in this checkout; use the frozen M1 snapshot or the production read probe",
      );
    else
      issues = (
        await new GraphQLReadProof(transport, { signal, mode: "live" }).read(
          repository,
        )
      ).issues;
    snapshot = {
      digest: canonicalDigest(issues),
      issueCount: issues.length,
      commentCount: issues.reduce(
        (sum, issue) => sum + issue.comments.length,
        0,
      ),
      maxComments: Math.max(0, ...issues.map((issue) => issue.comments.length)),
    };
    if (now() - started >= (options.timeoutMs ?? 30_000))
      timeout.abort(new DOMException("Leg timed out", "TimeoutError"));
    signal.throwIfAborted();
  } catch (error) {
    snapshot = {};
    code = signal.aborted
      ? signal.reason?.name === "TimeoutError"
        ? "GQL_READ_TIMEOUT"
        : "GQL_READ_ABORTED"
      : (runner.code ??
        (error instanceof GraphQLReadProofError
          ? error.code
          : "GQL_READ_INCOMPLETE"));
  } finally {
    clearTimeout(timer);
  }
  const queries = transport.observations;
  return {
    kind,
    status: code === undefined ? "complete" : "incomplete",
    ...(code ? { code } : {}),
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Math.round(now() - started),
    ...snapshot,
    httpRequests:
      kind === "rest" ? runner.httpRequests : transport.httpRequests,
    overshoot: kind === "rest" ? runner.overshoot : 0,
    rateHeaders:
      kind === "rest"
        ? runner.rateHeaders
        : queries.flatMap((query) =>
            query.rateLimit ? [query.rateLimit] : [],
          ),
    costs: queries.flatMap((query) =>
      query.rateLimit?.cost === undefined ? [] : [query.rateLimit.cost],
    ),
    queries,
    commands: runner.commands,
  };
}

/** Checks that every dispatched GraphQL query supplied complete, usable quota metadata. */
function completeQuota(leg: MeasuredLeg): boolean {
  return (
    leg.status === "complete" &&
    leg.queries.length === leg.httpRequests &&
    leg.queries.length > 0 &&
    leg.queries.every(
      ({ rateLimit: rate }) =>
        rate !== undefined &&
        Number.isInteger(rate.cost) &&
        (rate.cost ?? -1) >= 0 &&
        Number.isInteger(rate.limit) &&
        (rate.limit ?? 0) > 0 &&
        Number.isInteger(rate.remaining) &&
        (rate.remaining ?? -1) >= 0 &&
        (rate.remaining ?? Infinity) <= (rate.limit ?? 0) &&
        typeof rate.resetAt === "string" &&
        Number.isFinite(Date.parse(rate.resetAt)),
    )
  );
}

/** Computes the middle observation only for a nonempty completed sample set. */
function median(values: number[]): number | null {
  return (
    values
      .sort((left, right) => left - right)
      .at(Math.floor(values.length / 2)) ?? null
  );
}

/** Runs three alternating equal pairs, allowing one replacement only for detected connection-count drift. */
export async function runPairedComparison(
  repository: string,
  cwd: string,
  maxHttp: number,
  options: PairOptions = {},
) {
  validateMaxHttp(maxHttp);
  repositoryParts(repository);
  /** Reads the monotonic clock used for the full measurement session. */
  const now = options.now ?? performance.now.bind(performance);
  const started = now();
  const startedAt = new Date().toISOString();
  const pairs: Array<{
    order: Array<"rest" | "graphql">;
    legs: MeasuredLeg[];
    equal: boolean;
    driftEvidence?: "GQL_COUNT_DRIFT";
  }> = [];
  const valid: Array<{ rest: MeasuredLeg; graphql: MeasuredLeg }> = [];
  let observed = 0;
  let code: string | undefined;
  let replacements = 0;
  for (let attempt = 0; attempt < 4 && valid.length < 3; attempt++) {
    const order: Array<"rest" | "graphql"> =
      attempt % 2 === 0 ? ["rest", "graphql"] : ["graphql", "rest"];
    const pair: (typeof pairs)[number] = { order, legs: [], equal: false };
    pairs.push(pair);
    for (const kind of order) {
      if (options.signal?.aborted) {
        code = "GQL_READ_ABORTED";
        break;
      }
      if (observed >= maxHttp) {
        code = "GQL_HTTP_BOUND";
        break;
      }
      const leg = await measuredLeg(
        kind,
        repository,
        cwd,
        maxHttp - observed,
        options,
      );
      pair.legs.push(leg);
      observed += leg.httpRequests;
      if (leg.status !== "complete") {
        code = leg.code ?? "GQL_READ_INCOMPLETE";
        break;
      }
    }
    if (
      code === "GQL_COUNT_DRIFT" &&
      replacements === 0 &&
      observed < maxHttp &&
      !options.signal?.aborted
    ) {
      pair.driftEvidence = "GQL_COUNT_DRIFT";
      replacements++;
      code = undefined;
      continue;
    }
    if (code) break;
    const rest = pair.legs.find((leg) => leg.kind === "rest");
    const graphql = pair.legs.find((leg) => leg.kind === "graphql");
    if (!rest || !graphql || !rest.digest || !graphql.digest) {
      code = "GQL_READ_INCOMPLETE";
      break;
    }
    pair.equal = rest.digest === graphql.digest;
    if (!pair.equal) {
      code = "GQL_PARITY_MISMATCH";
      break;
    }
    valid.push({ rest, graphql });
  }
  const restMedian = median(valid.map((pair) => pair.rest.elapsedMs));
  const graphqlMedian = median(valid.map((pair) => pair.graphql.elapsedMs));
  const maxCost =
    valid.length === 0
      ? null
      : Math.max(
          ...valid.map((pair) =>
            pair.graphql.costs.reduce((sum, cost) => sum + cost, 0),
          ),
        );
  const reportedLimits = valid.flatMap((pair) =>
    pair.graphql.rateHeaders.flatMap((rate) =>
      rate.limit === undefined ? [] : [rate.limit],
    ),
  );
  const limit =
    reportedLimits.length === 0 ? null : Math.min(...reportedLimits);
  const complete = code === undefined && valid.length === 3;
  const criteria = {
    parity:
      complete &&
      new Set(valid.flatMap((pair) => [pair.rest.digest, pair.graphql.digest]))
        .size === 1,
    requestReduction:
      complete &&
      valid.every(
        (pair) => pair.graphql.httpRequests <= pair.rest.httpRequests * 0.5,
      ),
    latency:
      complete &&
      restMedian !== null &&
      graphqlMedian !== null &&
      graphqlMedian <= restMedian * 1.2,
    quota:
      complete &&
      valid.every((pair) => completeQuota(pair.graphql)) &&
      limit !== null &&
      maxCost !== null &&
      maxCost * 120 <= limit * 0.2,
  };
  const passed = Object.values(criteria).every(Boolean);
  return {
    kind: "graphql-read-proof-pairs",
    repository,
    maxHttp,
    status: passed
      ? "passed"
      : code === "GQL_PARITY_MISMATCH" || complete
        ? "failed"
        : "incomplete",
    exitCode: passed ? 0 : 1,
    ...(code
      ? { code }
      : !passed
        ? { code: complete ? "GQL_CRITERIA_FAILED" : "GQL_READ_INCOMPLETE" }
        : {}),
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Math.round(now() - started),
    observedHttp: observed,
    overshoot: Math.max(0, observed - maxHttp),
    restBudgetPolicy:
      "observed-stream-stop; in-flight pagination may overshoot",
    pairs,
    validPairs: valid.length,
    replacements,
    criteria,
    medians: {
      restMs: restMedian,
      graphqlMs: graphqlMedian,
      ratio:
        restMedian === null || restMedian === 0 || graphqlMedian === null
          ? null
          : graphqlMedian / restMedian,
    },
    maxima: {
      restMs: valid.length
        ? Math.max(...valid.map((pair) => pair.rest.elapsedMs))
        : null,
      graphqlMs: valid.length
        ? Math.max(...valid.map((pair) => pair.graphql.elapsedMs))
        : null,
    },
    maxCost,
    reportedHourlyLimit: limit,
  };
}

/** Parses the small read-only CLI surface without accepting a user-supplied query or command. */
export function liveArguments(argv: string[]): {
  repository: string;
  maxHttp: number;
  pair: boolean;
} {
  let repository: string | undefined;
  let maxHttp: number | undefined;
  let live = false;
  let pair = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--live") {
      if (live)
        throw new GraphQLReadProofError(
          "GQL_READ_INPUT",
          "--live may appear once",
        );
      live = true;
    } else if (argument === "--pair") {
      if (pair)
        throw new GraphQLReadProofError(
          "GQL_READ_INPUT",
          "--pair may appear once",
        );
      pair = true;
    } else if (argument === "--repo") {
      if (repository !== undefined || argv[index + 1] === undefined)
        throw new GraphQLReadProofError(
          "GQL_READ_INPUT",
          "--repo requires one value",
        );
      repository = argv[++index];
    } else if (argument === "--max-http") {
      if (maxHttp !== undefined || argv[index + 1] === undefined)
        throw new GraphQLReadProofError(
          "GQL_READ_INPUT",
          "--max-http requires one value",
        );
      maxHttp = Number(argv[++index]);
    } else
      throw new GraphQLReadProofError(
        "GQL_READ_INPUT",
        "Usage: bun tools/github-read-proof.ts --live --repo owner/name --max-http 199",
      );
  }
  if (!live || repository === undefined || maxHttp === undefined)
    throw new GraphQLReadProofError(
      "GQL_READ_INPUT",
      "Usage: bun tools/github-read-proof.ts --live --repo owner/name --max-http 199",
    );
  repositoryParts(repository);
  validateMaxHttp(maxHttp);
  return { repository, maxHttp, pair };
}

/** Runs one bounded GraphQL comparison leg and emits only counts, timings, rate metadata, and a digest. */
export async function runLiveProof(argv: string[]): Promise<void> {
  let repository = "unknown";
  let maxHttp = 0;
  const controller = new AbortController();
  /** Cancels every active leg when the parent CLI receives a termination signal. */
  const stop = () =>
    controller.abort(new DOMException("Interrupted", "AbortError"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const arguments_ = liveArguments(argv);
    repository = arguments_.repository;
    maxHttp = arguments_.maxHttp;
    if (arguments_.pair) {
      throw new GraphQLReadProofError(
        "GQL_HISTORICAL_ONLY",
        "M1 --pair is historical-only; use the frozen M1 snapshot with the production read probe",
      );
    } else {
      const leg = await measuredLeg(
        "graphql",
        repository,
        process.cwd(),
        maxHttp,
        { signal: controller.signal },
      );
      const exitCode = leg.status === "complete" ? 0 : 1;
      console.log(
        JSON.stringify({
          ...leg,
          kind: "graphql-read-proof",
          repository,
          maxHttp,
          exitCode,
        }),
      );
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        kind: "graphql-read-proof",
        status: "incomplete",
        exitCode: 1,
        repository,
        maxHttp,
        httpRequests: 0,
        code:
          error instanceof GraphQLReadProofError
            ? error.code
            : "GQL_READ_INCOMPLETE",
      }),
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) await runLiveProof(Bun.argv.slice(2));
