import { z } from "zod";
import type { RemoteTaskRepository } from "../store/remote-task-repository";
import type { GitHubCommandRunner } from "./pr-publisher";

const PullRequestMergeSchema = z
  .object({
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    baseRefName: z.string().trim().min(1),
    mergedAt: z.string().datetime().nullable(),
    mergeCommit: z
      .object({ oid: z.string().regex(/^[0-9a-f]{40}$/) })
      .nullable(),
  })
  .strict();

/** Fetches the target branch and pins dependency-safe bases for new remote tasks. */
export class GitHubRemoteDependencyGate {
  /** Connects dependency checks to one repository, target branch, store, and runner. */
  constructor(
    private readonly cwd: string,
    private readonly repositoryName: string,
    private readonly baseBranch: string,
    private readonly remote: RemoteTaskRepository,
    private readonly runner: GitHubCommandRunner,
  ) {
    if (
      baseBranch === "" ||
      baseBranch === "HEAD" ||
      baseBranch.startsWith("-") ||
      /[~^:?*\\[\]]/u.test(baseBranch)
    ) {
      throw new Error(`Invalid remote dependency target branch: ${baseBranch}`);
    }
  }

  /** Pins the next eligible ready task while leaving unmerged dependencies blocked. */
  async prepare(): Promise<void> {
    if (this.remote.hasActiveTask()) return;
    for (const task of this.remote.readyDependencyChecks()) {
      const mergedDependencies: Array<{
        taskId: string;
        mergeCommit: string;
      }> = [];
      let blocked = false;
      for (const dependency of task.dependencies) {
        const replaced = dependency.status === "retired";
        const status = dependency.status;
        const pullRequestNumber = dependency.pullRequestNumber;
        if (status !== "done") {
          if (
            replaced ||
            status === "rejected" ||
            status === "failed_infra" ||
            status === "needs_replan" ||
            status === "needs_input"
          ) {
            this.remote.pauseTask(
              task.taskId,
              "needs_replan",
              `Dependency ${dependency.taskId} requires an explicitly replanned replacement`,
            );
          }
          blocked = true;
          break;
        }
        if (pullRequestNumber === undefined) {
          this.remote.pauseTask(
            task.taskId,
            "needs_replan",
            `Dependency ${dependency.taskId} has no pull request receipt`,
          );
          blocked = true;
          break;
        }
        const pullRequest = PullRequestMergeSchema.parse(
          JSON.parse(
            await this.mustRun([
              "gh",
              "pr",
              "view",
              String(pullRequestNumber),
              "--repo",
              this.repositoryName,
              "--json",
              "state,baseRefName,mergedAt,mergeCommit",
            ]),
          ),
        );
        if (pullRequest.baseRefName !== this.baseBranch) {
          this.remote.pauseTask(
            task.taskId,
            "needs_replan",
            `Dependency ${dependency.taskId} targets ${pullRequest.baseRefName}, not ${this.baseBranch}`,
          );
          blocked = true;
          break;
        }
        if (pullRequest.state === "OPEN") {
          blocked = true;
          break;
        }
        if (
          pullRequest.state !== "MERGED" ||
          pullRequest.mergedAt === null ||
          pullRequest.mergeCommit === null
        ) {
          this.remote.pauseTask(
            task.taskId,
            "needs_replan",
            `Dependency ${dependency.taskId} pull request closed without merge`,
          );
          blocked = true;
          break;
        }
        mergedDependencies.push({
          taskId: dependency.taskId,
          mergeCommit: pullRequest.mergeCommit.oid,
        });
      }
      if (blocked) continue;
      await this.mustRun(["git", "fetch", "origin", this.baseBranch]);
      const baseCommit = (
        await this.mustRun([
          "git",
          "rev-parse",
          "--verify",
          `refs/remotes/origin/${this.baseBranch}^{commit}`,
        ])
      ).trim();
      if (!/^[0-9a-f]{40}$/u.test(baseCommit)) {
        throw new Error(
          `Git returned an invalid target base commit: ${baseCommit}`,
        );
      }
      for (const dependency of mergedDependencies) {
        const result = await this.runner.run({
          command: [
            "git",
            "merge-base",
            "--is-ancestor",
            dependency.mergeCommit,
            baseCommit,
          ],
          cwd: this.cwd,
        });
        if (result.exitCode !== 0) {
          if (result.exitCode === 1) {
            this.remote.pauseTask(
              task.taskId,
              "needs_replan",
              `Fetched ${this.baseBranch} does not contain dependency merge ${dependency.mergeCommit}`,
            );
            blocked = true;
            break;
          }
          throw new Error(
            result.stderr.trim() || "Git merge-base verification failed",
          );
        }
      }
      if (blocked) continue;
      for (const dependency of mergedDependencies) {
        this.remote.markDependencyMerged(dependency.taskId);
      }
      this.remote.pinBaseCommit(task.taskId, baseCommit);
      return;
    }
  }

  /** Runs one bounded GitHub or Git command and surfaces its diagnostic. */
  private async mustRun(command: string[]): Promise<string> {
    const result = await this.runner.run({ command, cwd: this.cwd });
    if (result.exitCode === 0) return result.stdout;
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `${command[0]} failed`,
    );
  }
}
