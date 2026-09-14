import { z } from "zod";
import { AgileError } from "../runtime/errors";
import type { RemoteIssue } from "./issue-reader";
import type { GitHubCommandResult, GitHubCommandRunner } from "./pr-publisher";

const SIZE = 25;
const NonEmpty = z.string().trim().min(1);
const PageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: NonEmpty.nullable(),
});
const Label = z.object({ name: NonEmpty });
const Comment = z.object({
  databaseId: z.number().int().positive().safe(),
  body: z.string(),
  author: z.object({ login: NonEmpty }).nullable(),
});

/** Defines the required count, nodes and cursor for a bounded GitHub connection page. */
function connection<T extends z.ZodType>(node: T) {
  return z.object({
    totalCount: z.number().int().nonnegative().safe(),
    nodes: z.array(node).max(SIZE),
    pageInfo: PageInfo,
  });
}

const Issue = z.object({
  id: NonEmpty,
  number: z.number().int().positive().safe(),
  title: NonEmpty,
  body: z.string(),
  url: NonEmpty,
  state: z.enum(["OPEN", "CLOSED"]),
  labels: connection(Label),
  comments: connection(Comment),
});
type Seed = z.infer<typeof Issue>;
type Page<T> = {
  totalCount: number;
  nodes: T[];
  pageInfo: z.infer<typeof PageInfo>;
};
const FIELDS = `id number title body url state
  labels(first: 25) { totalCount pageInfo { hasNextPage endCursor } nodes { name } }
  comments(first: 25) { totalCount pageInfo { hasNextPage endCursor } nodes { databaseId body author { login } } }`;
const RATE = "rateLimit { cost limit remaining resetAt }";
const DISCOVERY = `query ManagedIssues($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 25, after: $cursor, states: [OPEN, CLOSED], labels: ["roc:task"], orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount pageInfo { hasNextPage endCursor } nodes { ${FIELDS} }
    }
  } ${RATE}
}`;
const LABELS = `query IssueLabels($id: ID!, $cursor: String) { node(id: $id) { ... on Issue { id labels(first: 25, after: $cursor) { totalCount pageInfo { hasNextPage endCursor } nodes { name } } } } ${RATE} }`;
const COMMENTS = `query IssueComments($id: ID!, $cursor: String) { node(id: $id) { ... on Issue { id comments(first: 25, after: $cursor) { totalCount pageInfo { hasNextPage endCursor } nodes { databaseId body author { login } } } } } ${RATE} }`;

/** Classifies GraphQL errors even when gh reports HTTP 200, without retaining remote messages. */
export function graphQLFailure(
  result: GitHubCommandResult,
): "quota" | "permission" | "incomplete" | undefined {
  if (result.httpStatus === 401) return "permission";
  let body: { errors?: unknown };
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return "incomplete";
  }
  if (!body || typeof body !== "object") return "incomplete";
  if (body.errors === undefined) return undefined;
  if (!Array.isArray(body.errors)) return "incomplete";
  if (!body.errors.length) return undefined;
  const kinds = body.errors.map((error) => {
    const type = String(
      error?.type ?? error?.extensions?.type ?? error?.extensions?.code ?? "",
    );
    if (/^(FORBIDDEN|UNAUTHORIZED|INSUFFICIENT_SCOPES|NOT_FOUND)$/u.test(type))
      return "permission";
    if (
      type === "RATE_LIMITED" ||
      /(?:api rate limit (?:already )?exceeded|secondary rate limit)/iu.test(
        String(error?.message ?? ""),
      )
    )
      return "quota";
    return "incomplete";
  });
  if (kinds.includes("permission")) return "permission";
  return kinds.every((kind) => kind === "quota") ? "quota" : "incomplete";
}

/** Extracts optional quota telemetry without treating telemetry as Issue authority. */
export function graphQLQuota(stdout: string): GitHubCommandResult["rateLimit"] {
  try {
    const quota = z
      .object({
        cost: z.number().nonnegative(),
        limit: z.number().nonnegative(),
        remaining: z.number().nonnegative(),
        resetAt: z.string().datetime(),
      })
      .parse(JSON.parse(stdout).data?.rateLimit);
    return { ...quota, resetAt: Date.parse(quota.resetAt) };
  } catch {
    return undefined;
  }
}

/** Constructs a sanitized failure before any incomplete snapshot can leave the reader. */
function incomplete(): AgileError {
  return new AgileError({
    code: "GITHUB_READ_INCOMPLETE",
    category: "infra",
    component: "github-state",
    retryable: false,
    message:
      "GitHub GraphQL task read is incomplete or changed; retry a complete read before authorizing work",
  });
}

/** Collects complete managed Issues through fixed GraphQL queries and independently checked cursors. */
export class GitHubGraphQLReader {
  /** Binds reads to the existing command transport and checkout. */
  constructor(
    private readonly cwd: string,
    private readonly runner: GitHubCommandRunner,
  ) {}

  /** Validates repository coordinates without embedding user values in query text. */
  private coordinates(repository: string): { owner: string; name: string } {
    const parts = repository.split("/");
    if (
      parts.length !== 2 ||
      parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))
    )
      throw incomplete();
    return {
      owner: z.string().parse(parts[0]),
      name: z.string().parse(parts[1]),
    };
  }

  /** Dispatches one explicit read and rejects all GraphQL errors and malformed responses. */
  private async query(
    query: string,
    variables: Record<string, string | number | null>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const command = ["gh", "api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value === null) continue;
      command.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    }
    const result = await this.runner.run({
      command,
      cwd: this.cwd,
      signal,
      intent: "graphql-read",
    });
    signal?.throwIfAborted();
    const failure = graphQLFailure(result);
    if (result.exitCode !== 0 || failure) {
      const permission =
        failure === "permission" ||
        result.httpStatus === 401 ||
        result.httpStatus === 403 ||
        /HTTP (?:401|403)\b/u.test(result.stderr);
      throw new AgileError({
        code:
          failure === "quota"
            ? "GITHUB_RATE_LIMITED"
            : permission
              ? "GITHUB_READ_FORBIDDEN"
              : failure === "incomplete" && result.exitCode === 0
                ? "GITHUB_READ_INCOMPLETE"
                : "GITHUB_READ_FAILED",
        category: "infra",
        component: "github-state",
        retryable: !permission && !failure,
        message: `GitHub GraphQL task read failed (${failure === "quota" ? "quota" : permission ? "permission" : result.exitCode === 124 ? "timeout" : "incomplete response"}); check connection and repository access`,
      });
    }
    return z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(result.stdout).data);
  }

  /** Accumulates one connection while rejecting duplicate identities, count drift and stalled cursors. */
  private async collect<T>(
    first: Page<T>,
    next: (cursor: string) => Promise<Page<T>>,
    identity: (node: T) => string | number,
    signal?: AbortSignal,
    bound?: number,
  ): Promise<T[]> {
    const nodes: T[] = [];
    const ids = new Set<string | number>();
    const cursors = new Set<string>();
    let page = first;
    while (true) {
      signal?.throwIfAborted();
      if (
        page.totalCount !== first.totalCount ||
        (bound !== undefined && page.totalCount >= bound)
      )
        throw incomplete();
      for (const node of page.nodes) {
        const id = identity(node);
        if (ids.has(id)) throw incomplete();
        ids.add(id);
        nodes.push(node);
      }
      if (nodes.length > first.totalCount) throw incomplete();
      if (!page.pageInfo.hasNextPage) {
        if (nodes.length !== first.totalCount) throw incomplete();
        return nodes;
      }
      const cursor = page.pageInfo.endCursor;
      if (
        !cursor ||
        cursors.has(cursor) ||
        !page.nodes.length ||
        nodes.length >= first.totalCount
      )
        throw incomplete();
      cursors.add(cursor);
      signal?.throwIfAborted();
      page = await next(cursor);
    }
  }

  /** Expands each Issue's comments and labels independently before projecting the domain contract. */
  private async complete(
    seed: Seed,
    signal?: AbortSignal,
  ): Promise<RemoteIssue> {
    const labels = await this.collect(
      seed.labels,
      async (cursor) => {
        const data = await this.query(LABELS, { id: seed.id, cursor }, signal);
        const node = z
          .object({ id: z.literal(seed.id), labels: connection(Label) })
          .parse(data.node);
        return node.labels;
      },
      (label) => label.name,
      signal,
    );
    const comments = await this.collect(
      seed.comments,
      async (cursor) => {
        const data = await this.query(
          COMMENTS,
          { id: seed.id, cursor },
          signal,
        );
        const node = z
          .object({ id: z.literal(seed.id), comments: connection(Comment) })
          .parse(data.node);
        return node.comments;
      },
      (comment) => comment.databaseId,
      signal,
    );
    return {
      number: seed.number,
      title: seed.title,
      body: seed.body,
      url: seed.url,
      state: seed.state,
      labels,
      comments,
    };
  }

  /** Rejects schema exceptions with one safe operational error and preserves cancellation. */
  private async guarded<T>(
    read: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await read();
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AgileError) throw error;
      throw incomplete();
    }
  }

  /** Reads all OPEN and CLOSED managed Issues, rejecting the 1000-Issue safety bound. */
  async read(repository: string, signal?: AbortSignal): Promise<RemoteIssue[]> {
    return this.guarded(async () => {
      const coordinates = this.coordinates(repository);
      /** Reads a managed connection page using the cursor only as a query variable. */
      const page = async (cursor: string | null) => {
        const data = await this.query(
          DISCOVERY,
          { ...coordinates, cursor },
          signal,
        );
        return z.object({ issues: connection(Issue) }).parse(data.repository)
          .issues;
      };
      const seeds = await this.collect(
        await page(null),
        page,
        (issue) => issue.id,
        signal,
        1000,
      );
      if (new Set(seeds.map((seed) => seed.number)).size !== seeds.length)
        throw incomplete();
      const issues: RemoteIssue[] = [];
      for (const seed of seeds) issues.push(await this.complete(seed, signal));
      signal?.throwIfAborted();
      return issues;
    }, signal);
  }

  /** Reads validated Issue numbers in fixed aliases with batches of at most 25 and complete nested pages. */
  async getMany(
    repository: string,
    numbers: readonly number[],
    signal?: AbortSignal,
  ): Promise<RemoteIssue[]> {
    return this.guarded(async () => {
      const coordinates = this.coordinates(repository);
      if (
        numbers.some(
          (number) =>
            !Number.isSafeInteger(number) || number <= 0 || number > 2147483647,
        ) ||
        new Set(numbers).size !== numbers.length
      )
        throw incomplete();
      const issues: RemoteIssue[] = [];
      const ids = new Set<string>();
      for (let offset = 0; offset < numbers.length; offset += SIZE) {
        const batch = numbers.slice(offset, offset + SIZE);
        const declarations = batch
          .map((_, index) => `$n${index}: Int!`)
          .join(", ");
        const aliases = batch
          .map(
            (_, index) => `i${index}: issue(number: $n${index}) { ${FIELDS} }`,
          )
          .join("\n");
        const variables = Object.fromEntries(
          batch.map((number, index) => [`n${index}`, number]),
        );
        const data = await this.query(
          `query KnownIssues($owner: String!, $name: String!, ${declarations}) { repository(owner: $owner, name: $name) { ${aliases} } ${RATE} }`,
          { ...coordinates, ...variables },
          signal,
        );
        const repositoryData = z
          .record(z.string(), z.unknown())
          .parse(data.repository);
        if (Object.keys(repositoryData).length !== batch.length)
          throw incomplete();
        for (let index = 0; index < batch.length; index++) {
          const seed = Issue.parse(repositoryData[`i${index}`]);
          if (seed.number !== batch[index] || ids.has(seed.id))
            throw incomplete();
          ids.add(seed.id);
          issues.push(await this.complete(seed, signal));
        }
      }
      signal?.throwIfAborted();
      return issues;
    }, signal);
  }
}
