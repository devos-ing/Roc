import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  type BacklogManifest,
  BacklogManifestSchema,
  BacklogTaskSchema,
} from "../domain/schemas";
import {
  BunGitHubCommandRunner,
  type GitHubCommandRunner,
} from "./pr-publisher";

const NonEmpty = z.string().trim().min(1);
const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ENVELOPE_START = "<!-- roc:task-envelope";
const ENVELOPE_END = "roc:task-envelope -->";
export const REMOTE_TASK_LABEL = "roc:task";
export const REMOTE_READY_LABEL = "roc:ready";

export const RemoteTaskEnvelopeSchema = z
  .object({
    version: z.literal(1),
    planId: Sha256,
    cycleId: NonEmpty,
    goal: NonEmpty,
    task: BacklogTaskSchema,
  })
  .strict();

export const RemoteTaskApprovalSchema = z
  .object({ version: z.literal(1), hash: Sha256 })
  .strict();

export type RemoteTaskEnvelope = z.infer<typeof RemoteTaskEnvelopeSchema>;
export type PublishedRemoteTask = {
  taskId: string;
  issueNumber: number;
  issueUrl: string;
  envelopeHash: string;
};

/** Writes a multiline GitHub body to a private temporary file for argv-only use. */
export async function withGitHubBodyFile<T>(
  body: string,
  action: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "roc-github-"));
  const path = join(directory, "body.md");
  try {
    await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
    return await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED";
};

const GitHubIssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: NonEmpty,
    body: z.string(),
    url: NonEmpty,
    state: z.enum(["OPEN", "CLOSED"]),
  })
  .strict();

/** Serializes JSON with recursively sorted object keys for stable identities and approvals. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Returns the prefixed SHA-256 identity of canonical JSON data. */
export function jsonHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Builds the stable plan identity from the complete validated manifest. */
export function remotePlanId(manifest: BacklogManifest): string {
  const parsed = BacklogManifestSchema.parse(manifest);
  return jsonHash({
    ...parsed,
    tasks: [...parsed.tasks].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  });
}

/** Builds and validates the immutable remote envelope for one manifest task. */
export function remoteTaskEnvelope(
  manifest: BacklogManifest,
  taskId: string,
): RemoteTaskEnvelope {
  const parsed = BacklogManifestSchema.parse(manifest);
  const task = parsed.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined)
    throw new Error(`Task not found in manifest: ${taskId}`);
  return RemoteTaskEnvelopeSchema.parse({
    version: 1,
    planId: remotePlanId(parsed),
    cycleId: parsed.cycleId,
    goal: parsed.goal,
    task,
  });
}

/** Escapes raw envelope delimiters while preserving their rendered prose. */
function escapeEnvelopeMarkers(value: string): string {
  return value
    .replaceAll(ENVELOPE_START, "&lt;!-- roc:task-envelope")
    .replaceAll(ENVELOPE_END, "roc:task-envelope --&gt;");
}

/** Renders a readable task description followed by its canonical machine envelope. */
export function renderRemoteTaskBody(
  envelope: RemoteTaskEnvelope,
  dependencyIssues: ReadonlyMap<string, number> = new Map(),
): string {
  const task = envelope.task;
  /** Renders a list with an explicit empty value. */
  const bullets = (items: string[]) =>
    items.length === 0 ? "- None" : items.map((item) => `- ${item}`).join("\n");
  const dependencies = task.spec.dependencies.map((id) => {
    const issue = dependencyIssues.get(id);
    return issue === undefined ? id : `${id} (#${issue})`;
  });
  const readable = [
    `# ${task.id} — ${task.title}`,
    `Plan: ${envelope.planId}\nCycle: ${envelope.cycleId}\nPriority: ${task.priority}\nRisk: ${task.spec.risk}\nToken ceiling: ${task.spec.tokenCeiling}`,
    "## Goal",
    envelope.goal,
    "## Problem",
    task.spec.problem,
    "## Desired outcome",
    task.spec.desiredOutcome,
    "## Scope",
    bullets(task.spec.scope),
    "## Non-goals",
    bullets(task.spec.nonGoals),
    "## Acceptance criteria",
    bullets(task.spec.acceptanceCriteria),
    "## Validation",
    bullets(task.spec.validation),
    "## Dependencies",
    bullets(dependencies),
  ]
    .map(escapeEnvelopeMarkers)
    .join("\n\n");
  const envelopeJson = JSON.stringify(envelope, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  const body = [readable, ENVELOPE_START, envelopeJson, ENVELOPE_END].join(
    "\n\n",
  );
  if (jsonHash(parseRemoteTaskEnvelope(body)) !== jsonHash(envelope)) {
    throw new Error(
      `Remote task envelope failed its publication round-trip: ${task.id}`,
    );
  }
  return body;
}

/** Extracts and strictly validates the single Roc envelope embedded in an Issue body. */
export function parseRemoteTaskEnvelope(body: string): RemoteTaskEnvelope {
  const startMarker = `\n${ENVELOPE_START}\n`;
  const endMarker = `\n${ENVELOPE_END}`;
  const start = body.indexOf(startMarker);
  const end = body.indexOf(endMarker, start + startMarker.length);
  if (
    start < 0 ||
    end < 0 ||
    end < start ||
    start !== body.lastIndexOf(startMarker) ||
    end !== body.lastIndexOf(endMarker) ||
    body.slice(end + endMarker.length).trim() !== ""
  ) {
    throw new Error("Issue body must contain exactly one Roc task envelope");
  }
  const json = body.slice(start + startMarker.length, end).trim();
  return RemoteTaskEnvelopeSchema.parse(JSON.parse(json));
}

/** Renders the trusted-author approval marker for one immutable envelope. */
export function renderRemoteTaskApproval(envelope: RemoteTaskEnvelope): string {
  return `<!-- roc:approval ${JSON.stringify({ version: 1, hash: jsonHash(envelope) })} -->\nApproved for Roc execution.`;
}

/** Parses an approval marker while rejecting unrelated comment prose. */
export function parseRemoteTaskApproval(
  body: string,
): z.infer<typeof RemoteTaskApprovalSchema> | undefined {
  const match = body.match(/<!-- roc:approval (\{[^\n]*\}) -->/);
  if (match?.[1] === undefined) return undefined;
  return RemoteTaskApprovalSchema.parse(JSON.parse(match[1]));
}

/** Publishes and reconciles one approved manifest as remote GitHub task Issues. */
export class GitHubTaskPublisher {
  /** Connects publication to one repository checkout and an injectable argv runner. */
  constructor(
    private readonly cwd: string,
    private readonly runner: GitHubCommandRunner = new BunGitHubCommandRunner(),
  ) {}

  /** Creates or reconciles every Issue before granting their trusted approvals. */
  async publish(
    manifestInput: BacklogManifest,
  ): Promise<PublishedRemoteTask[]> {
    const manifest = BacklogManifestSchema.parse(manifestInput);
    const repository = await this.repository();
    await this.ensureLabels(repository);
    let issues = await this.listIssues(repository);
    const envelopes = manifest.tasks.map((task) =>
      remoteTaskEnvelope(manifest, task.id),
    );
    const resolved = new Map<string, GitHubIssue>();

    for (const envelope of envelopes) {
      const matches = this.matches(issues, envelope);
      if (matches.length > 1) {
        throw new Error(
          `Conflicting remote task identity: ${envelope.planId}/${envelope.task.id}`,
        );
      }
      let issue = matches[0];
      if (issue === undefined) {
        const result = await withGitHubBodyFile(
          renderRemoteTaskBody(envelope),
          (path) =>
            this.run([
              "gh",
              "issue",
              "create",
              "--repo",
              repository,
              "--title",
              envelope.task.title,
              "--body-file",
              path,
              "--label",
              REMOTE_TASK_LABEL,
            ]),
        );
        issues = await this.listIssues(repository);
        const recovered = this.matches(issues, envelope);
        if (recovered.length !== 1) {
          const diagnostic = result.stderr.trim() || result.stdout.trim();
          throw new Error(
            `Remote Issue creation outcome is ambiguous for ${envelope.task.id}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
          );
        }
        issue = recovered[0];
      }
      if (issue === undefined) {
        throw new Error(
          `Remote Issue could not be resolved: ${envelope.task.id}`,
        );
      }
      resolved.set(envelope.task.id, issue);
    }

    const dependencyIssues = new Map(
      [...resolved].map(([id, issue]) => [id, issue.number]),
    );
    for (const envelope of envelopes) {
      const issue = this.resolvedIssue(resolved, envelope.task.id);
      const body = renderRemoteTaskBody(envelope, dependencyIssues);
      if (issue.body !== body) {
        await withGitHubBodyFile(body, (path) =>
          this.mustRun([
            "gh",
            "issue",
            "edit",
            String(issue.number),
            "--repo",
            repository,
            "--body-file",
            path,
          ]),
        );
      }
    }

    for (const envelope of envelopes) {
      const issue = this.resolvedIssue(resolved, envelope.task.id);
      await withGitHubBodyFile(renderRemoteTaskApproval(envelope), (path) =>
        this.mustRun([
          "gh",
          "issue",
          "comment",
          String(issue.number),
          "--repo",
          repository,
          "--body-file",
          path,
        ]),
      );
      await this.mustRun([
        "gh",
        "issue",
        "edit",
        String(issue.number),
        "--repo",
        repository,
        "--add-label",
        REMOTE_READY_LABEL,
      ]);
    }

    return envelopes.map((envelope) => {
      const issue = this.resolvedIssue(resolved, envelope.task.id);
      return {
        taskId: envelope.task.id,
        issueNumber: issue.number,
        issueUrl: issue.url,
        envelopeHash: jsonHash(envelope),
      };
    });
  }

  /** Resolves the explicit GitHub repository identity for this checkout. */
  private async repository(): Promise<string> {
    const output = await this.mustRun([
      "gh",
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]);
    return NonEmpty.parse(output.trim());
  }

  /** Ensures Roc-owned labels exist before any task is published. */
  private async ensureLabels(repository: string): Promise<void> {
    for (const [name, color] of [
      [REMOTE_TASK_LABEL, "5319E7"],
      [REMOTE_READY_LABEL, "0E8A16"],
    ] as const) {
      await this.mustRun([
        "gh",
        "label",
        "create",
        name,
        "--repo",
        repository,
        "--color",
        color,
        "--force",
      ]);
    }
  }

  /** Reads all managed Issues needed for deterministic identity reconciliation. */
  private async listIssues(repository: string): Promise<GitHubIssue[]> {
    const output = await this.mustRun([
      "gh",
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--label",
      REMOTE_TASK_LABEL,
      "--limit",
      "1000",
      "--json",
      "number,title,body,url,state",
    ]);
    const issues = z.array(GitHubIssueSchema).parse(JSON.parse(output));
    if (issues.length >= 1000) {
      throw new Error(
        "Remote Issue identity reconciliation reached its 1000-Issue safety bound",
      );
    }
    return issues;
  }

  /** Finds Issues carrying the exact repository-local plan and task identity. */
  private matches(
    issues: GitHubIssue[],
    envelope: RemoteTaskEnvelope,
  ): GitHubIssue[] {
    return issues.filter((issue) => {
      try {
        const existing = parseRemoteTaskEnvelope(issue.body);
        return (
          existing.planId === envelope.planId &&
          existing.task.id === envelope.task.id
        );
      } catch {
        return false;
      }
    });
  }

  /** Returns a reconciled Issue or reports an internal publication invariant failure. */
  private resolvedIssue(
    issues: ReadonlyMap<string, GitHubIssue>,
    taskId: string,
  ): GitHubIssue {
    const issue = issues.get(taskId);
    if (issue === undefined)
      throw new Error(`Remote Issue not resolved: ${taskId}`);
    return issue;
  }

  /** Runs one GitHub command and returns its result for ambiguity recovery. */
  private run(command: string[]) {
    return this.runner.run({ command, cwd: this.cwd });
  }

  /** Runs one GitHub command and throws a bounded diagnostic on failure. */
  private async mustRun(command: string[]): Promise<string> {
    const result = await this.run(command);
    if (result.exitCode === 0) return result.stdout;
    const diagnostic = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `${command[0] ?? "command"} failed${diagnostic === "" ? "" : `: ${diagnostic}`}`,
    );
  }
}
