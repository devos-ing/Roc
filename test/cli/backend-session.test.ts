import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBackendModelAdvisor,
  runBackendSession,
} from "../../src/cli/runtime";
import { GitHubExecutionStore } from "../../src/github/execution-store";
import { BunGitHubCommandRunner } from "../../src/github/pr-publisher";
import { acquireCheckoutOwnership } from "../../src/workspace/checkout-ownership";
import { git } from "../helpers/git";
import { memoryGitHub } from "../helpers/github-native";
import { barrier, memoryPlan } from "../helpers/github-plan";

test("backend session routing uses its immutable policy snapshot", () => {
  const advisor = createBackendModelAdvisor({
    catalog: [
      {
        id: "openai-codex/gpt-5.6-sol",
        supportedReasoningEfforts: ["medium", "high"],
      },
      { id: "kimi-coding/k3", supportedReasoningEfforts: ["high"] },
    ],
    modelMapping: {
      luna: "openai-codex/gpt-5.6-sol",
      terra: "kimi-coding/k3",
      sol: "openai-codex/gpt-5.6-sol",
    },
    modelRoutingPolicy: {
      allowlist: ["openai-codex/gpt-5.6-sol", "kimi-coding/k3"],
      implementPrimaryEffort: "high",
    },
    harness: {
      async step(): Promise<never> {
        throw Error("No task should run");
      },
      async cancel() {},
    },
    async close() {},
  });
  expect(
    advisor.decide({ role: "implement", risk: "medium", retryIndex: 0 }),
  ).toMatchObject({ model: "kimi-coding/k3", effort: "high" });
});

test("a scheduler waits through comment-read rate limits and remains cancellable without retaining an idle guard", async () => {
  for (const cancel of [false, true]) {
    const temp = await realpath(
      await mkdtemp(join(tmpdir(), "roc-rate-limit-")),
    );
    const root = join(temp, "repo");
    try {
      await git(["init", root], temp);
      await git(["config", "user.name", "Test"], root);
      await git(["config", "user.email", "test@example.test"], root);
      await writeFile(join(root, "README.md"), "fixture\n");
      await git(["add", "."], root);
      await git(["commit", "-m", "seed"], root);
      await git(["update-ref", "refs/remotes/origin/main", "HEAD"], root);
      const remote = memoryGitHub();
      remote.issue.state = "CLOSED";
      const limited = barrier();
      let comments = 0;
      let closes = 0;
      const real = new BunGitHubCommandRunner();
      const session = runBackendSession(
        async () => ({
          catalog: [],
          harness: {
            async step(): Promise<never> {
              throw Error("No task should run");
            },
            async cancel() {},
          },
          async close() {
            closes++;
          },
        }),
        { backend: "pi", repoPath: root, baseBranch: "main", once: true },
        "rate-limit",
        {
          command: {
            async run(input) {
              const command = input.command;
              if (command[0] !== "gh")
                return command[1] === "fetch"
                  ? { exitCode: 0, stdout: "", stderr: "" }
                  : real.run(input);
              if (command.some((part) => part.includes("/comments?"))) {
                comments++;
                if (comments === 1) {
                  limited.release();
                  return {
                    exitCode: 1,
                    stdout: "",
                    stderr: "API rate limit exceeded (HTTP 403)",
                    rateLimit: {
                      remaining: 0,
                      resetAt: Date.now() + (cancel ? 60_000 : 25),
                    },
                  };
                }
                return {
                  exitCode: 0,
                  stdout: JSON.stringify([
                    remote.issue.comments.map((c) => ({
                      id: c.databaseId,
                      body: c.body,
                      user: c.author,
                    })),
                  ]),
                  stderr: "",
                };
              }
              const stdout =
                command[1] === "issue"
                  ? JSON.stringify([remote.issue])
                  : command[2] === "user"
                    ? "owner"
                    : command.includes("--jq")
                      ? "acme/test"
                      : '{"nameWithOwner":"acme/test"}';
              return { exitCode: 0, stdout, stderr: "" };
            },
          },
        },
      );
      const outcome = session.catch((error: unknown) => error);
      await limited.promise;
      if (cancel) process.emit("SIGINT");
      expect(await outcome).toBeUndefined();
      expect(comments).toBe(cancel ? 1 : 2);
      expect(closes).toBe(1);
      expect(await Bun.file(`${root}.agile-checkout.lock`).exists()).toBe(
        false,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 10_000);

test("active shutdown persists needs_replan through the wrapped production GitHub store", async () => {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), "roc-rate-cleanup-")),
  );
  const root = join(temp, "repo");
  const entered = barrier();
  const released = barrier();
  try {
    await git(["init", root], temp);
    await git(["config", "user.name", "Test"], root);
    await git(["config", "user.email", "test@example.test"], root);
    await writeFile(join(root, "README.md"), "fixture\n");
    await git(["add", "."], root);
    await git(["commit", "-m", "seed"], root);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"], root);
    const remote = memoryGitHub();
    const real = new BunGitHubCommandRunner();
    const session = runBackendSession(
      async () => ({
        catalog: ["luna", "terra", "sol"].map((id) => ({
          id,
          supportedReasoningEfforts: ["high", "xhigh"],
        })),
        harness: {
          async step(request) {
            const event = {
              eventId: `${request.attempt.attemptId}-start`,
              attemptId: request.attempt.attemptId,
              sequence: 1,
              occurredAt: new Date().toISOString(),
            };
            if (!request.backendCursor)
              return {
                kind: "event",
                nextCursor: "started",
                event: { ...event, type: "attempt.started" },
              };
            entered.release();
            await released.promise;
            return {
              kind: "event",
              nextCursor: "blocked",
              event: {
                ...event,
                sequence: 2,
                type: "attempt.blocked_policy",
                code: "cancelled",
                message: "Stopped",
              },
            };
          },
          async cancel() {
            released.release();
          },
        },
        async close() {
          released.release();
        },
      }),
      { backend: "pi", repoPath: root, baseBranch: "main" },
      "wrapped-cleanup",
      {
        onActivity: () => {},
        command: {
          async run(input) {
            const command = input.command;
            if (command[0] !== "gh")
              return command[1] === "fetch"
                ? { exitCode: 0, stdout: "", stderr: "" }
                : real.run(input);
            if (command[1] === "repo")
              return {
                exitCode: 0,
                stdout: command.includes("--jq")
                  ? "acme/test"
                  : '{"nameWithOwner":"acme/test"}',
                stderr: "",
              };
            if (command[1] === "auth")
              return { exitCode: 0, stdout: "", stderr: "" };
            if (command[1] === "label")
              return { exitCode: 0, stdout: "", stderr: "" };
            if (command[1] === "issue") {
              if (command[2] === "edit") {
                const added = command[command.indexOf("--add-label") + 1];
                if (command.includes("--add-label") && added)
                  remote.issue.labels.push({ name: added });
              }
              return {
                exitCode: 0,
                stdout: JSON.stringify(
                  command[2] === "list" ? [remote.issue] : remote.issue,
                ),
                stderr: "",
              };
            }
            if (command[2] === "user")
              return { exitCode: 0, stdout: "owner", stderr: "" };
            const endpoint =
              command.find((arg) => arg.startsWith("repos/")) ?? "";
            if (command.includes("--input")) {
              const path = command[command.indexOf("--input") + 1];
              if (!path) throw Error("Missing checkpoint body");
              const { body } = await Bun.file(path).json();
              const id = endpoint.includes("/issues/comments/")
                ? Number(endpoint.split("/").at(-1))
                : undefined;
              const existing = remote.issue.comments.find(
                (c) => c.databaseId === id,
              );
              if (existing) existing.body = body;
              else
                remote.issue.comments.push({
                  databaseId: remote.issue.comments.length + 1,
                  author: { login: "owner" },
                  body,
                });
              return { exitCode: 0, stdout: "{}", stderr: "" };
            }
            return {
              exitCode: 0,
              stdout: JSON.stringify([
                remote.issue.comments.map((c) => ({
                  id: c.databaseId,
                  body: c.body,
                  user: c.author,
                })),
              ]),
              stderr: "",
            };
          },
        },
      },
    );
    const outcome = session.catch((error: unknown) => error);
    await entered.promise;
    process.emit("SIGINT");
    expect(await outcome).toBeUndefined();
    const checkpoint = (
      await new GitHubExecutionStore(
        "acme/test",
        "owner",
        new Set(["owner"]),
        remote.api,
      ).get(41)
    ).execution;
    expect(checkpoint?.phase).toBe("needs_replan");
    expect(
      checkpoint?.attempts.every((attempt) => attempt.status !== "running"),
    ).toBe(true);
    expect(await Bun.file(`${root}.agile-checkout.lock`).exists()).toBe(false);
  } finally {
    released.release();
    await rm(temp, { recursive: true, force: true });
  }
}, 10_000);

test("shutdown cancels both workers and retains the guard when either cancellation fails", async () => {
  for (const failCancel of [false, true]) {
    const temp = await realpath(
      await mkdtemp(join(tmpdir(), "roc-pool-cleanup-")),
    );
    const root = join(temp, "repo");
    const releases = [barrier(), barrier()];
    try {
      await git(["init", root], temp);
      await git(["config", "user.name", "Test"], root);
      await git(["config", "user.email", "test@example.test"], root);
      await writeFile(join(root, "README.md"), "fixture\n");
      await git(["add", "."], root);
      await git(["commit", "-m", "seed"], root);
      await git(["update-ref", "refs/remotes/origin/main", "HEAD"], root);
      const remote = memoryPlan([["a.ts"], ["b.ts"]]);
      const entered = [barrier(), barrier()];
      const cancelled = new Set<string>();
      const owners = new Map<string, number>();
      const real = new BunGitHubCommandRunner();
      const command = {
        async run(input: { command: string[]; cwd: string }) {
          return input.command[0] === "gh" || input.command[1] === "fetch"
            ? {
                exitCode: 0,
                stdout: '{"nameWithOwner":"acme/test"}',
                stderr: "",
              }
            : real.run(input);
        },
      };
      const session = runBackendSession(
        async () => ({
          catalog: ["luna", "terra", "sol"].map((id) => ({
            id,
            supportedReasoningEfforts: ["high", "xhigh"],
          })),
          harness: {
            async step(request) {
              const index = request.attempt.taskId === "issue-41" ? 0 : 1;
              owners.set(request.attempt.attemptId, index);
              const event = {
                eventId: `${request.attempt.attemptId}-start`,
                attemptId: request.attempt.attemptId,
                sequence: 1,
                occurredAt: new Date().toISOString(),
              };
              if (!request.backendCursor)
                return {
                  kind: "event",
                  nextCursor: "started",
                  event: { ...event, type: "attempt.started" },
                };
              entered[index]?.release();
              await releases[index]?.promise;
              return {
                kind: "event",
                nextCursor: "blocked",
                event: {
                  ...event,
                  sequence: 2,
                  type: "attempt.blocked_policy",
                  code: "cancelled",
                  message: "Stopped",
                },
              };
            },
            async cancel(id) {
              const index = owners.get(id);
              if (index === undefined) throw Error("Unknown attempt");
              cancelled.add(`issue-${41 + index}`);
              if (failCancel && index === 0)
                throw Error("Unconfirmed cancellation");
              releases[index]?.release();
            },
          },
          async close() {
            for (const release of releases) release.release();
          },
        }),
        { backend: "pi", repoPath: root, baseBranch: "main", concurrency: 2 },
        "pool-cleanup",
        { store: remote.store, command, onActivity: () => {} },
      );
      const outcome = session.then(
        () => undefined,
        (error) => error,
      );
      await Promise.all(entered.map((item) => item.promise));
      process.emit("SIGINT");
      const error = await outcome;
      expect([...cancelled].sort()).toEqual(["issue-41", "issue-42"]);
      expect(await Bun.file(`${root}.agile-checkout.lock`).exists()).toBe(
        failCancel,
      );
      if (failCancel) {
        expect(error).toBeDefined();
        await expect(
          acquireCheckoutOwnership(root, "successor"),
        ).rejects.toMatchObject({ code: "SCHEDULER_CHECKOUT_IN_USE" });
      } else expect(error).toBeUndefined();
    } finally {
      for (const release of releases) release.release();
      await rm(temp, { recursive: true, force: true });
    }
  }
}, 15_000);

test("GitHub-only sessions release confirmed cleanup and retain ownership after a close timeout", async () => {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), "roc-native-session-")),
  );
  const root = join(temp, "repo");
  try {
    await git(["init", "--bare", join(temp, "origin.git")], temp);
    await git(["clone", join(temp, "origin.git"), root], temp);
    await git(["checkout", "-b", "main"], root);
    await git(["config", "user.name", "Test"], root);
    await git(["config", "user.email", "test@example.test"], root);
    await writeFile(join(root, "README.md"), "fixture\n");
    await git(["add", "."], root);
    await git(["commit", "-m", "seed"], root);
    await git(["push", "origin", "main"], root);
    const remote = memoryGitHub();
    const store = new GitHubExecutionStore(
      "acme/test",
      "daemon",
      new Set(["owner"]),
      {
        ...remote.api,
        async read() {
          return [];
        },
      },
    );
    const realCommand = new BunGitHubCommandRunner();
    const command = {
      async run(input: { command: string[]; cwd: string }) {
        return input.command[0] === "gh"
          ? { exitCode: 0, stdout: '{"nameWithOwner":"acme/test"}', stderr: "" }
          : realCommand.run(input);
      },
    };
    const input = {
      backend: "pi" as const,
      repoPath: root,
      baseBranch: "main",
      once: true,
    };
    const harness = {
      async step(): Promise<never> {
        throw Error("No task should run");
      },
      async cancel() {},
    };
    let closes = 0;
    await runBackendSession(
      async () => ({
        catalog: [],
        harness,
        async close() {
          closes++;
        },
      }),
      input,
      "clean",
      { store, command },
    );
    expect(closes).toBe(1);
    expect(await Bun.file(`${root}.agile-checkout.lock`).exists()).toBe(false);
    expect(await Bun.file(join(root, ".agile/runtime/agile.db")).exists()).toBe(
      false,
    );
    let finishClose: (() => void) | undefined;
    const pendingClose = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    await expect(
      runBackendSession(
        async () => ({
          catalog: [],
          harness,
          async close() {
            return pendingClose;
          },
        }),
        input,
        "uncertain",
        { store, command },
      ),
    ).rejects.toMatchObject({ code: "SCHEDULER_CHECKOUT_RETAINED" });
    await expect(
      acquireCheckoutOwnership(root, "successor"),
    ).rejects.toMatchObject({ code: "SCHEDULER_CHECKOUT_IN_USE" });
    finishClose?.();
    await pendingClose;
    expect(await Bun.file(`${root}.agile-checkout.lock`).exists()).toBe(true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
