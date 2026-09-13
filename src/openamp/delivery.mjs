import { createHash } from "node:crypto";
import { remoteMutationReason, runCommand, runGit } from "./command.mjs";

/** Hashes the exact current requirements bound to independent review. */
function requirementHash(requirements) {
  return createHash("sha256").update(requirements).digest("hex");
}

/** Extracts the reviewer's single strict JSON object from plain or fenced output. */
export function parseReview(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const candidate =
    fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let value;
  try {
    value = JSON.parse(candidate);
  } catch {
    throw new Error("Independent review did not return valid JSON");
  }
  if (
    !["accepted", "rejected"].includes(value?.decision) ||
    !Array.isArray(value?.findings) ||
    value.findings.some(
      (finding) =>
        !["blocking", "nonblocking"].includes(finding?.severity) ||
        typeof finding?.message !== "string",
    )
  ) {
    throw new Error("Independent review returned an invalid decision schema");
  }
  if (
    value.decision === "accepted" &&
    value.findings.some((finding) => finding.severity === "blocking")
  ) {
    throw new Error(
      "Independent review accepted while retaining a blocking finding",
    );
  }
  return value;
}

/** Runs one local verification command while forbidding publication side effects. */
async function defaultValidationRunner(command, cwd) {
  const reason = remoteMutationReason(command);
  if (reason) throw new Error(`Validation command rejected: ${reason}`);
  return runCommand("/bin/sh", ["-lc", command], {
    cwd,
    allowFailure: true,
    timeoutMs: 30 * 60 * 1000,
  });
}

/** Renders the durable requirements, checks, review, and limitations for GitHub. */
function pullRequestBody(input, review, head, changeId) {
  const validations = input.validationCommands.map(
    (command) => `- \`${command}\``,
  );
  const findings = review.findings.map(
    (finding) => `- **${finding.severity}**: ${finding.message}`,
  );
  return [
    "## Requirements",
    input.requirements,
    "",
    "## Validation",
    ...validations,
    "",
    "## Independent review",
    `Accepted for head \`${head}\`.`,
    ...(findings.length === 0 ? ["- No findings"] : findings),
    "",
    "## OpenAmp",
    `Change ID: \`${changeId}\``,
    "Merge remains a user decision; OpenAmp did not enable auto-merge.",
  ].join("\n");
}

/** Publishes only a fully bound reviewed feature head and reconciles uncertain responses. */
export class ChangeDelivery {
  /** Connects validation, review, and publication to one durable change. */
  constructor(store, workspace, supervisor, options = {}) {
    this.store = store;
    this.workspace = workspace;
    this.supervisor = supervisor;
    this.validationRunner = options.validationRunner ?? defaultValidationRunner;
    this.commandRunner =
      options.commandRunner ??
      ((command, args, cwd) =>
        runCommand(command, args, {
          cwd,
          allowFailure: true,
          timeoutMs: 60_000,
        }));
  }

  /** Verifies, independently reviews, and creates or updates exactly one pull request. */
  async deliver(input) {
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

    const head = await this.workspace.checkpoint(
      `openamp(${this.store.state.id}): complete requested change`,
    );
    if (head === this.store.state.baseCommit) {
      throw new Error(
        "Delivery requires a change relative to the selected base",
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
    const validation = [];
    for (const command of input.validationCommands) {
      const result = await this.validationRunner(
        command,
        this.store.state.workspace,
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

    const specHash = requirementHash(requirements);
    const reviewResult = await this.supervisor.review(
      [
        "Independently review the exact current change. Do not modify files.",
        `Base commit: ${this.store.state.baseCommit}`,
        `Final head: ${head}`,
        `Requirements SHA-256: ${specHash}`,
        "Requirements:",
        requirements,
        "Inspect the complete base..head diff and relevant tests.",
        'Return only JSON: {"decision":"accepted|rejected","findings":[{"severity":"blocking|nonblocking","message":"..."}],"summary":"..."}',
      ].join("\n"),
      this.store.state.sessionId,
    );
    const review = parseReview(reviewResult.summary);
    if (review.decision !== "accepted") {
      await this.store.update((state) => {
        state.phase = "review_rejected";
        state.review = { head, base: state.baseCommit, specHash, ...review };
      });
      throw new Error("Independent review rejected the current change");
    }
    if ((await this.workspace.assertReady()) !== head) {
      throw new Error("Feature head changed after independent review");
    }
    await this.store.update((state) => {
      state.validation = { head, commands: validation };
      state.review = { head, base: state.baseCommit, specHash, ...review };
      state.phase = "ready_to_publish";
      state.publication = {
        status: "pending",
        repository: state.repoRoot,
        branch: state.branch,
        baseBranch: state.baseBranch,
        head,
        specHash,
        pullRequestNumber: state.publication?.pullRequestNumber ?? null,
        pullRequestUrl: state.publication?.pullRequestUrl ?? null,
      };
    });

    const pullRequest = await this.#publish(
      { ...input, requirements },
      review,
      head,
    );
    await this.store.update((state) => {
      state.phase = "pr_open";
      Object.assign(state.publication, {
        status: "published",
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        head,
      });
    });
    return pullRequest;
  }

  /** Records and runs a controlled Delivery command without exposing a merge operation. */
  async #run(action, command, args) {
    if (
      command === "gh" &&
      args[0] === "pr" &&
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
    const result = await this.commandRunner(
      command,
      args,
      this.store.state.workspace,
    );
    await this.store.update((state) => {
      const entry = state.commandLedger.find((item) => item.id === ledgerId);
      entry.status = result.exitCode === 0 ? "completed" : "failed";
      entry.finishedAt = new Date().toISOString();
      entry.exitCode = result.exitCode;
    });
    return result;
  }

  /** Queries the one same-repository PR associated with the feature branch and base. */
  async #findPullRequest() {
    const state = this.store.state;
    const result = await this.#run("find-pr", "gh", [
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
    ]);
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "GitHub PR lookup failed");
    const repository = await this.#run("repository", "gh", [
      "repo",
      "view",
      "--json",
      "owner",
    ]);
    if (repository.exitCode !== 0)
      throw new Error("GitHub repository lookup failed");
    const owner = JSON.parse(repository.stdout).owner.login;
    const matches = JSON.parse(result.stdout).filter(
      (item) => item.headRepositoryOwner?.login === owner,
    );
    if (matches.length > 1)
      throw new Error("Multiple pull requests match this OpenAmp change");
    return matches[0];
  }

  /** Pushes the exact reviewed branch then creates or updates and re-reads its PR. */
  async #publish(input, review, head) {
    const state = this.store.state;
    const auth = await this.#run("auth", "gh", ["auth", "status"]);
    if (auth.exitCode !== 0) throw new Error("GitHub CLI is not authenticated");
    const existing = await this.#findPullRequest();
    if (existing?.state === "MERGED")
      throw new Error("The prior pull request is already merged");
    if (existing?.state === "CLOSED")
      throw new Error("The prior pull request is closed");

    const remote = await this.#run("read-remote-head", "git", [
      "ls-remote",
      "origin",
      `refs/heads/${state.branch}`,
    ]);
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
    const push = await this.#run("push", "git", [
      "push",
      "origin",
      state.branch,
    ]);
    if (push.exitCode !== 0) {
      const reconciled = await this.#run("reconcile-push", "git", [
        "ls-remote",
        "origin",
        `refs/heads/${state.branch}`,
      ]);
      if (reconciled.stdout.split(/\s/u)[0] !== head) {
        throw new Error(
          "Feature branch push failed and could not be reconciled",
        );
      }
    }

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
    const changed = await this.#run(
      existing ? "update-pr" : "create-pr",
      "gh",
      mutation,
    );
    const finalPullRequest = await this.#findPullRequest();
    if (
      finalPullRequest?.state !== "OPEN" ||
      finalPullRequest.headRefOid !== head ||
      finalPullRequest.title !== input.title ||
      finalPullRequest.body !== body
    ) {
      throw new Error(
        changed.exitCode === 0
          ? "GitHub did not confirm the expected pull request head"
          : "PR mutation failed and could not be reconciled",
      );
    }
    return finalPullRequest;
  }
}
