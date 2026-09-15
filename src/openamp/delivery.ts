import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CommandResult,
  remoteMutationReason,
  runCommand,
  runGit,
} from "./command.js";
import type {
  ChangeState,
  ChangeStore,
  CommandLedgerEntry,
  ReviewDecision,
} from "./state.js";
import type { AgentSupervisor } from "./supervisor.js";
import type { ChangeWorkspace } from "./workspace.js";

export interface DeliveryInput {
  title: string;
  requirements: string;
  validationCommands: string[];
  inputGeneration?: number;
  /** Requests review unless explicitly disabled; the interactive tool defaults to false. */
  review?: boolean;
}

interface PullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  title: string;
  body: string;
  headRefOid: string;
  headRepositoryOwner?: { login?: string };
}

type ValidationRunner = (
  command: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<CommandResult>;

type DeliveryCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<CommandResult>;

export interface DeliveryOptions {
  validationRunner?: ValidationRunner;
  commandRunner?: DeliveryCommandRunner;
  environment?: NodeJS.ProcessEnv;
}

/** Returns the required publication record after its lifecycle has begun. */
function requirePublication(
  state: ChangeState,
): NonNullable<ChangeState["publication"]> {
  if (!state.publication) throw new Error("Publication state is missing");
  return state.publication;
}

/** Returns a just-recorded command ledger entry by its durable identifier. */
function requireLedgerEntry(
  state: ChangeState,
  id: string,
): CommandLedgerEntry {
  const entry = state.commandLedger.find((item) => item.id === id);
  if (!entry) throw new Error(`Command ledger entry is missing: ${id}`);
  return entry;
}

/** Hashes the exact current requirements bound to independent review. */
function requirementHash(requirements: string): string {
  return createHash("sha256").update(requirements).digest("hex");
}

/** Extracts the reviewer's single strict JSON object from plain or fenced output. */
export function parseReview(text: string): ReviewDecision {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const candidate =
    fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    throw new Error("Independent review did not return valid JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("decision" in value) ||
    !("findings" in value) ||
    !["accepted", "rejected"].includes(String(value.decision)) ||
    !Array.isArray(value.findings) ||
    value.findings.some(
      (finding: unknown) =>
        typeof finding !== "object" ||
        finding === null ||
        !("severity" in finding) ||
        !("message" in finding) ||
        !["blocking", "nonblocking"].includes(String(finding.severity)) ||
        typeof finding.message !== "string",
    )
  ) {
    throw new Error("Independent review returned an invalid decision schema");
  }
  const review = value as ReviewDecision;
  if (
    review.decision === "accepted" &&
    review.findings.some((finding) => finding.severity === "blocking")
  ) {
    throw new Error(
      "Independent review accepted while retaining a blocking finding",
    );
  }
  return review;
}

/** Runs one local verification command while forbidding publication side effects. */
async function defaultValidationRunner(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const reason = remoteMutationReason(command);
  if (reason) throw new Error(`Validation command rejected: ${reason}`);
  return runCommand("/bin/sh", ["-lc", command], {
    cwd,
    allowFailure: true,
    signal,
    timeoutMs: 30 * 60 * 1000,
  });
}

/** Renders the durable requirements, checks, review, and limitations for GitHub. */
function pullRequestBody(
  input: DeliveryInput,
  review: ReviewDecision | null,
  head: string,
  changeId: string,
): string {
  const validations = input.validationCommands.map(
    (command) => `- \`${command}\``,
  );
  const findings =
    review?.findings.map(
      (finding) => `- **${finding.severity}**: ${finding.message}`,
    ) ?? [];
  return [
    "## Requirements",
    input.requirements,
    "",
    "## Validation",
    ...validations,
    "",
    "## Independent review",
    ...(review
      ? [
          `Accepted for head \`${head}\`.`,
          ...(findings.length === 0 ? ["- No findings"] : findings),
        ]
      : [
          `Not requested for head \`${head}\`; no independent review approval is claimed.`,
        ]),
    "",
    "## OpenAmp",
    `Change ID: \`${changeId}\``,
    "Merge remains a user decision; OpenAmp did not enable auto-merge.",
  ].join("\n");
}

/** Publishes a validated feature head with optional review and reconciles uncertain responses. */
export class ChangeDelivery {
  readonly store: ChangeStore;
  readonly workspace: ChangeWorkspace;
  readonly supervisor: AgentSupervisor;
  readonly validationRunner: ValidationRunner;
  readonly commandRunner: DeliveryCommandRunner;

  /** Connects validation, review, and publication to one durable change. */
  constructor(
    store: ChangeStore,
    workspace: ChangeWorkspace,
    supervisor: AgentSupervisor,
    options: DeliveryOptions = {},
  ) {
    this.store = store;
    this.workspace = workspace;
    this.supervisor = supervisor;
    this.validationRunner = options.validationRunner ?? defaultValidationRunner;
    const deliveryEnvironment = { ...(options.environment ?? process.env) };
    this.commandRunner =
      options.commandRunner ??
      ((command, args, cwd, signal) =>
        runCommand(command, args, {
          cwd,
          env: deliveryEnvironment,
          allowFailure: true,
          signal,
          timeoutMs: 60_000,
        }));
  }

  /** Reads one exact remote branch head through the controlled Delivery runner. */
  async #readRemoteBranch(
    action: string,
    branch: string,
    inputGeneration?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.#run(
      action,
      "git",
      ["ls-remote", "origin", `refs/heads/${branch}`],
      inputGeneration,
      signal,
    );
    const head = result.stdout.split(/\s/u)[0] ?? "";
    if (result.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(head)) {
      throw new Error(`Cannot read remote branch: ${branch}`);
    }
    return head;
  }

  /** Writes the immutable review metadata and complete base-to-head patch for read-only agents. */
  async #writeReviewBundle(
    base: string,
    head: string,
    requirements: string,
    specHash: string,
  ): Promise<string> {
    const history = await runGit(this.store.state.workspace, [
      "log",
      "--format=%H %s",
      `${base}..${head}`,
    ]);
    const diff = await runGit(
      this.store.state.workspace,
      ["diff", "--no-ext-diff", "--binary", "--find-renames", base, head],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const directory = join(dirname(this.store.path), "reviews");
    const path = join(
      directory,
      `${this.store.state.id}-${head}-${specHash}.patch`,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      [
        `Base commit: ${base}`,
        `Final head: ${head}`,
        `Requirements SHA-256: ${specHash}`,
        "",
        "Requirements:",
        requirements,
        "",
        "Commits:",
        history.stdout,
        "",
        "Complete binary diff:",
        diff.stdout,
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    return path;
  }

  /** Rejects delivery when cancellation or newer user input invalidates the requirements. */
  #assertRequirementsCurrent(
    inputGeneration?: number,
    signal?: AbortSignal,
  ): void {
    if (signal?.aborted) {
      throw new Error("Interaction cancellation invalidated the delivery");
    }
    if ((this.store.state.inputGeneration ?? 0) !== inputGeneration) {
      throw new Error(
        "New user input invalidated the delivery requirements; process it before retrying",
      );
    }
  }

  /** Validates, optionally reviews, and creates or updates exactly one pull request. */
  async deliver(
    input: DeliveryInput,
    signal?: AbortSignal,
  ): Promise<PullRequest> {
    let cancellationWrite: Promise<unknown> | undefined;
    /** Persists one cancellation generation and prevents pending publication recovery. */
    const recordCancellation = () => {
      cancellationWrite ??= this.store.update((state) => {
        state.inputGeneration = (state.inputGeneration ?? 0) + 1;
        state.phase = "needs_replan";
        if (state.publication?.status === "pending") {
          state.publication.status = "cancelled";
        }
      });
      return cancellationWrite;
    };
    /** Starts durable cancellation recording without blocking the abort event. */
    const onAbort = () => {
      void recordCancellation();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (!this.store.state.repoRoot || !this.store.state.baseBranch) {
        throw new Error(
          "Automatic PR delivery requires a Git remote base branch",
        );
      }
      const active = this.supervisor
        .list()
        .filter((run) =>
          ["queued", "starting", "running", "cancelling"].includes(run.status),
        );
      if (active.length > 0)
        throw new Error("Delivery waits for all child agents to settle");

      const inputGeneration =
        input.inputGeneration ?? this.store.state.inputGeneration ?? 0;
      this.#assertRequirementsCurrent(inputGeneration, signal);
      const head = await this.workspace.checkpoint(
        `openamp(${this.store.state.id}): complete requested change`,
      );
      if (!head) throw new Error("Delivery requires a Git feature head");
      if (head === this.store.state.baseCommit) {
        throw new Error(
          "Delivery requires a change relative to the selected base",
        );
      }
      const base = this.store.state.baseCommit;
      if (!base) throw new Error("Delivery requires a recorded base commit");
      const remoteBase = await this.#readRemoteBranch(
        "read-review-base",
        this.store.state.baseBranch,
        inputGeneration,
        signal,
      );
      if (remoteBase !== base) {
        throw new Error(
          "Remote base branch changed; update the change before independent review",
        );
      }
      const requirements = input.requirements.trim();
      if (!requirements)
        throw new Error("Delivery requires the current requirements");
      if (
        !Array.isArray(input.validationCommands) ||
        input.validationCommands.length === 0
      ) {
        throw new Error("Delivery requires at least one validation command");
      }
      const validation: Array<{
        command: string;
        exitCode: number;
        output: string;
      }> = [];
      for (const command of input.validationCommands) {
        const result = await this.validationRunner(
          command,
          this.store.state.workspace,
          signal,
        );
        validation.push({
          command,
          exitCode: result.exitCode,
          output: (result.stdout || result.stderr || "").slice(-4_000),
        });
        if (result.exitCode !== 0) {
          await this.store.update((state) => {
            state.phase = "validation_failed";
            state.validation = { head, commands: validation };
          });
          throw new Error(`Validation failed: ${command}`);
        }
      }
      if ((await this.workspace.assertReady()) !== head) {
        throw new Error("Validation changed the feature workspace or head");
      }
      this.#assertRequirementsCurrent(inputGeneration, signal);

      const specHash = requirementHash(requirements);
      let review: ReviewDecision | null = null;
      if (input.review !== false) {
        const reviewBundle = await this.#writeReviewBundle(
          base,
          head,
          requirements,
          specHash,
        );
        const reviewResult = await this.supervisor.review(
          [
            "Independently review the exact current change. Do not modify files.",
            `Base commit: ${base}`,
            `Final head: ${head}`,
            `Requirements SHA-256: ${specHash}`,
            "Requirements:",
            requirements,
            `Read the immutable review bundle at ${reviewBundle}; it contains the commit list and complete binary base..head diff. Inspect relevant source and tests as needed.`,
            'Return only JSON: {"decision":"accepted|rejected","findings":[{"severity":"blocking|nonblocking","message":"..."}],"summary":"..."}',
          ].join("\n"),
          this.store.state.sessionId,
          signal,
        );
        const decision = parseReview(reviewResult.summary);
        review = decision;
        this.#assertRequirementsCurrent(inputGeneration, signal);
        if (decision.decision !== "accepted") {
          await this.store.update((state) => {
            state.phase = "review_rejected";
            state.review = {
              head,
              base,
              specHash,
              inputGeneration,
              ...decision,
            };
          });
          throw new Error("Independent review rejected the current change");
        }
      }
      this.#assertRequirementsCurrent(inputGeneration, signal);
      if ((await this.workspace.assertReady()) !== head) {
        throw new Error("Feature head changed before publication");
      }
      await this.store.update((state) => {
        const publicationStatus =
          state.publication?.status === "reconcile_required"
            ? "reconcile_required"
            : "pending";
        state.validation = { head, commands: validation };
        state.review = review
          ? { head, base, specHash, inputGeneration, ...review }
          : null;
        state.phase = "ready_to_publish";
        state.publication = {
          status: publicationStatus,
          repository: state.repoRoot,
          branch: state.branch,
          baseBranch: state.baseBranch,
          baseCommit: base,
          head,
          specHash,
          inputGeneration,
          pullRequestNumber: state.publication?.pullRequestNumber ?? null,
          pullRequestUrl: state.publication?.pullRequestUrl ?? null,
        };
      });

      const pullRequest = await this.#publish(
        { ...input, requirements },
        review,
        head,
        base,
        inputGeneration,
        signal,
      );
      this.#assertRequirementsCurrent(inputGeneration, signal);
      await this.store.update((state) => {
        state.phase = "pr_open";
        Object.assign(requirePublication(state), {
          status: "published",
          pullRequestNumber: pullRequest.number,
          pullRequestUrl: pullRequest.url,
          head,
        });
      });
      this.#assertRequirementsCurrent(inputGeneration, signal);
      return pullRequest;
    } catch (error) {
      if (signal?.aborted) {
        await recordCancellation();
        await this.store.update((state) => {
          state.phase = "needs_replan";
          if (state.publication?.status === "pending") {
            state.publication.status = "cancelled";
          }
        });
        throw new Error("Interaction cancellation invalidated the delivery", {
          cause: error,
        });
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Records and runs a controlled Delivery command without exposing a merge operation. */
  async #run(
    action: string,
    command: string,
    args: string[],
    inputGeneration?: number,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const mutatesRemote = ["push", "create-pr", "update-pr"].includes(action);
    if (
      command === "gh" &&
      args[0] === "pr" &&
      args[1] !== undefined &&
      ["merge", "close", "reopen"].includes(args[1])
    ) {
      throw new Error(
        "OpenAmp Delivery never merges or changes PR lifecycle state",
      );
    }
    const ledgerId = `command-${crypto.randomUUID().slice(0, 12)}`;
    await this.store.update((state) => {
      state.commandLedger.push({
        id: ledgerId,
        action,
        command,
        startedAt: new Date().toISOString(),
        status: "pending",
      });
    });
    if (inputGeneration !== undefined || signal) {
      try {
        this.#assertRequirementsCurrent(inputGeneration, signal);
      } catch (error) {
        await this.store.update((state) => {
          const entry = requireLedgerEntry(state, ledgerId);
          entry.status = "cancelled";
          entry.finishedAt = new Date().toISOString();
        });
        throw error;
      }
    }
    if (mutatesRemote) {
      await this.store.update((state) => {
        requirePublication(state).status = "reconcile_required";
      });
      try {
        this.#assertRequirementsCurrent(inputGeneration, signal);
      } catch (error) {
        await this.store.update((state) => {
          requirePublication(state).status = "pending";
          const entry = requireLedgerEntry(state, ledgerId);
          entry.status = "cancelled";
          entry.finishedAt = new Date().toISOString();
        });
        throw error;
      }
    }
    let result: CommandResult;
    try {
      result = await this.commandRunner(
        command,
        args,
        this.store.state.workspace,
        mutatesRemote ? undefined : signal,
      );
    } catch (error) {
      await this.store.update((state) => {
        const entry = requireLedgerEntry(state, ledgerId);
        entry.status = mutatesRemote
          ? "unknown"
          : signal?.aborted
            ? "cancelled"
            : "failed";
        entry.finishedAt = new Date().toISOString();
      });
      if (mutatesRemote) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
    await this.store.update((state) => {
      const entry = requireLedgerEntry(state, ledgerId);
      entry.status =
        result.exitCode === 0
          ? "completed"
          : mutatesRemote
            ? "unknown"
            : "failed";
      entry.finishedAt = new Date().toISOString();
      entry.exitCode = result.exitCode;
    });
    return result;
  }

  /** Queries the one same-repository PR associated with the feature branch and base. */
  async #findPullRequest(
    inputGeneration?: number,
    signal?: AbortSignal,
  ): Promise<PullRequest | undefined> {
    const state = this.store.state;
    if (!state.branch || !state.baseBranch) {
      throw new Error("PR lookup requires feature and base branches");
    }
    const result = await this.#run(
      "find-pr",
      "gh",
      [
        "pr",
        "list",
        "--head",
        state.branch,
        "--base",
        state.baseBranch,
        "--state",
        "all",
        "--json",
        "number,url,state,title,body,headRefOid,headRepositoryOwner",
      ],
      inputGeneration,
      signal,
    );
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "GitHub PR lookup failed");
    const repository = await this.#run(
      "repository",
      "gh",
      ["repo", "view", "--json", "owner"],
      inputGeneration,
      signal,
    );
    if (repository.exitCode !== 0)
      throw new Error("GitHub repository lookup failed");
    const owner = (
      JSON.parse(repository.stdout) as { owner: { login: string } }
    ).owner.login;
    const matches = (JSON.parse(result.stdout) as PullRequest[]).filter(
      (item) => item.headRepositoryOwner?.login === owner,
    );
    if (matches.length > 1)
      throw new Error("Multiple pull requests match this OpenAmp change");
    return matches[0];
  }

  /** Pushes the exact validated branch then creates or updates and re-reads its PR. */
  async #publish(
    input: DeliveryInput,
    review: ReviewDecision | null,
    head: string,
    base: string,
    inputGeneration: number,
    signal?: AbortSignal,
  ): Promise<PullRequest> {
    const state = this.store.state;
    if (!state.branch || !state.baseBranch) {
      throw new Error("Publication requires feature and base branches");
    }
    this.#assertRequirementsCurrent(inputGeneration, signal);
    const remoteBase = await this.#readRemoteBranch(
      "read-publication-base",
      state.baseBranch,
      inputGeneration,
      signal,
    );
    if (remoteBase !== base) {
      throw new Error(
        "Remote base branch changed after review; independent review is invalid",
      );
    }
    const auth = await this.#run(
      "auth",
      "gh",
      ["auth", "status"],
      inputGeneration,
      signal,
    );
    if (auth.exitCode !== 0) throw new Error("GitHub CLI is not authenticated");
    const existing = await this.#findPullRequest(inputGeneration, signal);
    if (existing?.state === "MERGED")
      throw new Error("The prior pull request is already merged");
    if (existing?.state === "CLOSED")
      throw new Error("The prior pull request is closed");

    const remote = await this.#run(
      "read-remote-head",
      "git",
      ["ls-remote", "origin", `refs/heads/${state.branch}`],
      inputGeneration,
      signal,
    );
    if (remote.exitCode !== 0)
      throw new Error("Cannot read the remote feature branch");
    const remoteHead = remote.stdout.split(/\s/u)[0] || null;
    if (remoteHead && remoteHead !== head) {
      const ancestor = await runGit(
        state.workspace,
        ["merge-base", "--is-ancestor", remoteHead, head],
        { allowFailure: true },
      );
      if (ancestor.exitCode !== 0) {
        throw new Error("Remote feature branch changed outside OpenAmp");
      }
    }
    if ((await this.workspace.assertReady()) !== head) {
      throw new Error("Feature head changed before publication");
    }
    this.#assertRequirementsCurrent(inputGeneration, signal);
    if (remoteHead !== head) {
      const push = await this.#run(
        "push",
        "git",
        [
          "push",
          `--force-with-lease=refs/heads/${state.branch}:${remoteHead ?? ""}`,
          "origin",
          `${head}:refs/heads/${state.branch}`,
        ],
        inputGeneration,
        signal,
      );
      if (push.exitCode !== 0 || signal?.aborted) {
        const reconciled = await this.#run("reconcile-push", "git", [
          "ls-remote",
          "origin",
          `refs/heads/${state.branch}`,
        ]);
        if (reconciled.stdout.split(/\s/u)[0] !== head) {
          await this.store.update((current) => {
            requirePublication(current).status = "reconcile_required";
          });
          throw new Error(
            "Feature branch push failed and could not be reconciled",
          );
        }
      }
    }
    await this.store.update((current) => {
      requirePublication(current).status = "pending";
    });
    this.#assertRequirementsCurrent(inputGeneration, signal);

    const finalBase = await this.#readRemoteBranch(
      "confirm-publication-base",
      state.baseBranch,
      inputGeneration,
      signal,
    );
    if (finalBase !== base) {
      throw new Error(
        "Remote base branch changed before PR publication; independent review is invalid",
      );
    }
    this.#assertRequirementsCurrent(inputGeneration, signal);
    const body = pullRequestBody(input, review, head, state.id);
    const mutation = existing
      ? [
          "pr",
          "edit",
          String(existing.number),
          "--title",
          input.title,
          "--body",
          body,
        ]
      : [
          "pr",
          "create",
          "--base",
          state.baseBranch,
          "--head",
          state.branch,
          "--title",
          input.title,
          "--body",
          body,
        ];
    const existingMatches =
      existing?.state === "OPEN" &&
      existing.headRefOid === head &&
      existing.title === input.title &&
      existing.body === body;
    const changed = existingMatches
      ? null
      : await this.#run(
          existing ? "update-pr" : "create-pr",
          "gh",
          mutation,
          inputGeneration,
          signal,
        );
    const finalPullRequest = existingMatches
      ? existing
      : await this.#findPullRequest();
    if (
      finalPullRequest?.state !== "OPEN" ||
      finalPullRequest.headRefOid !== head ||
      finalPullRequest.title !== input.title ||
      finalPullRequest.body !== body
    ) {
      await this.store.update((current) => {
        const publication = requirePublication(current);
        publication.status = "reconcile_required";
        publication.pullRequestNumber = finalPullRequest?.number ?? null;
        publication.pullRequestUrl = finalPullRequest?.url ?? null;
      });
      throw new Error(
        changed?.exitCode === 0
          ? "GitHub did not confirm the expected pull request head"
          : "PR mutation failed and could not be reconciled",
      );
    }
    await this.store.update((current) => {
      Object.assign(requirePublication(current), {
        status: "published",
        pullRequestNumber: finalPullRequest.number,
        pullRequestUrl: finalPullRequest.url,
        head,
      });
    });
    return finalPullRequest;
  }
}
