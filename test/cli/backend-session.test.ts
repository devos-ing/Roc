import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCli } from "../../src/cli/run";
import { runBackendSession } from "../../src/cli/runtime";
import type { CliRuntime } from "../../src/cli/types";
import { GitHubExecutionStore } from "../../src/github/execution-store";
import { githubTaskSnapshot } from "../../src/github/execution-view";
import { BunGitHubCommandRunner } from "../../src/github/pr-publisher";
import { createFakeHarness } from "../../src/harness/fake";
import { saveRocSettings } from "../../src/settings";
import { acquireCheckoutOwnership } from "../../src/workspace/checkout-ownership";
import { git } from "../helpers/git";
import { memoryGitHub } from "../helpers/github-native";
import { barrier, memoryPlan } from "../helpers/github-plan";
import { graphqlResponse } from "../helpers/graphql-github";

/** Creates a seeded repository for deterministic backend cancellation races. */
async function cancellationRaceRepo() {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), "roc-cancel-race-")),
  );
  const root = join(temp, "repo");
  await git(["init", root], temp);
  await git(["config", "user.name", "Test"], root);
  await git(["config", "user.email", "test@example.test"], root);
  await writeFile(join(root, "README.md"), "fixture\n");
  await git(["add", "."], root);
  await git(["commit", "-m", "seed"], root);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"], root);
  return { temp, root };
}

type PtyMarker = { type: string } & Record<string, unknown>;

/** Closes a child's real controlling PTY after its backend reports an active attempt. */
async function runControllingPtyHangup(mode: "clean" | "uncertain") {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "roc-pty-hangup-")));
  const fixture = resolve("test/fixtures/tui-pty-hangup.ts");
  const python = `
import json, os, pty, signal, sys, time

bun, fixture, temp, mode = sys.argv[1:]
marker = os.path.join(temp, "events.jsonl")
pid, master = pty.fork()
if pid == 0:
    os.execv(bun, [bun, fixture, temp, mode])

def markers():
    try:
        with open(marker, encoding="utf-8") as source:
            return [json.loads(line) for line in source if line.strip()]
    except (FileNotFoundError, json.JSONDecodeError):
        return []

deadline = time.monotonic() + 5
while time.monotonic() < deadline and not any(item.get("type") == "active" for item in markers()):
    time.sleep(0.01)
if not any(item.get("type") == "active" for item in markers()):
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    raise RuntimeError("child did not reach an active backend attempt")

os.close(master)
status = None
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    waited, value = os.waitpid(pid, os.WNOHANG)
    if waited:
        status = value
        break
    time.sleep(0.01)
if status is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
    raise RuntimeError("child did not finish cleanup after terminal hangup")

print(json.dumps({
    "exitCode": os.waitstatus_to_exitcode(status),
    "signaled": os.WIFSIGNALED(status),
    "signal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
}))
`;
  const child = Bun.spawn({
    cmd: ["python3", "-c", python, process.execPath, fixture, temp, mode],
    cwd: resolve("."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`Controlling PTY probe failed: ${stderr || stdout}`);
  const report = JSON.parse(stdout) as {
    exitCode: number;
    signaled: boolean;
    signal: number | null;
  };
  const markers = (await readFile(join(temp, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as PtyMarker);
  return { temp, root: join(temp, "repo"), report, markers };
}

test.each([false, true])(
  "Stop during backend close preserves an earlier non-cancellation failure (abort name: %s)",
  async (abortName) => {
    const { temp, root } = await cancellationRaceRepo();
    const closing = barrier();
    const releaseClose = barrier();
    const stop = new AbortController();
    const originalFailure = abortName
      ? new DOMException("an unrelated request was aborted", "AbortError")
      : new Error("fixture task read failed");
    const remote = memoryGitHub();
    remote.api.read = async () => {
      throw originalFailure;
    };
    const real = new BunGitHubCommandRunner();
    const running = runBackendSession(
      async () => ({
        catalog: [],
        harness: {
          async step(): Promise<never> {
            throw Error("No task should start");
          },
          async cancel() {},
        },
        async close() {
          closing.release();
          await releaseClose.promise;
        },
      }),
      {
        backend: "pi",
        repoPath: root,
        baseBranch: "main",
        signal: stop.signal,
      },
      "failure-before-stop",
      {
        store: remote.store(),
        command: {
          async run(input) {
            if (input.command[0] === "gh")
              return {
                exitCode: 0,
                stdout: '{"nameWithOwner":"acme/test"}',
                stderr: "",
              };
            if (input.command[1] === "fetch")
              return { exitCode: 0, stdout: "", stderr: "" };
            return real.run(input);
          },
        },
      },
    );
    const outcome = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await closing.promise;
      stop.abort();
      releaseClose.release();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("cause", originalFailure);
      expect(await Bun.file(`${root}.agile-checkout.lock`).exists()).toBe(
        false,
      );
    } finally {
      stop.abort();
      releaseClose.release();
      await outcome;
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test("ownership release failure is not hidden by an earlier caller cancellation", async () => {
  const { temp, root } = await cancellationRaceRepo();
  const reading = barrier();
  const releaseRead = barrier();
  const stop = new AbortController();
  const remote = memoryGitHub();
  remote.issue.state = "CLOSED";
  const read = remote.api.read;
  remote.api.read = async () => {
    reading.release();
    await releaseRead.promise;
    return read();
  };
  const replacement = JSON.stringify({
    version: 1,
    ownerPid: process.pid,
    runId: "other-owner",
    ownerToken: "other-token",
    acquiredAt: new Date().toISOString(),
  });
  const real = new BunGitHubCommandRunner();
  const running = runBackendSession(
    async () => ({
      catalog: [],
      harness: {
        async step(): Promise<never> {
          throw Error("No task should start");
        },
        async cancel() {},
      },
      async close() {
        await writeFile(`${root}.agile-checkout.lock`, replacement);
      },
    }),
    { backend: "pi", repoPath: root, baseBranch: "main", signal: stop.signal },
    "release-after-abort",
    {
      store: remote.store(),
      command: {
        async run(input) {
          if (input.command[0] === "gh")
            return {
              exitCode: 0,
              stdout: '{"nameWithOwner":"acme/test"}',
              stderr: "",
            };
          if (input.command[1] === "fetch")
            return { exitCode: 0, stdout: "", stderr: "" };
          return real.run(input);
        },
      },
    },
  );
  const outcome = running.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await reading.promise;
    stop.abort();
    releaseRead.release();
    expect(await outcome).toBeInstanceOf(Error);
    expect(await Bun.file(`${root}.agile-checkout.lock`).text()).toBe(
      replacement,
    );
  } finally {
    stop.abort();
    releaseRead.release();
    await outcome;
    await rm(temp, { recursive: true, force: true });
  }
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
              if (command[2] === "graphql") {
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
                  stdout: JSON.stringify(
                    graphqlResponse([remote.issue], command),
                  ),
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
            if (command[2] === "graphql")
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify(
                  graphqlResponse([remote.issue], command),
                ),
              };
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

test("TUI SIGINT cancels an active backend before terminal restoration", async () => {
  class Input extends EventEmitter {
    isTTY = true;
    setRawMode() {
      return this;
    }
    resume() {
      return this;
    }
    pause() {
      return this;
    }
  }
  class Output extends EventEmitter {
    isTTY = true;
    columns = 120;
    rows = 40;
    restored = 0;
    write(value: string, callback?: () => void) {
      if (value === "\u001B[?1049l") this.restored++;
      callback?.();
      return true;
    }
  }
  const { temp, root } = await cancellationRaceRepo();
  const entered = barrier();
  const released = barrier();
  const remote = memoryPlan([["answer.ts"]]);
  const input = new Input();
  const output = new Output();
  const real = new BunGitHubCommandRunner();
  const order: string[] = [];
  const restoreGuardStates: boolean[] = [];
  let starts = 0;
  const cancelledAttempts = new Set<string>();
  let closes = 0;
  let outcome: Promise<number> | undefined;
  try {
    await saveRocSettings(
      { cycle: { type: "weekly" }, execution: { allowUnsandboxed: true } },
      temp,
    );
    const fake = createFakeHarness({
      attempts: [
        {
          taskId: "issue-41",
          role: "scout",
          retryIndex: 0,
          expect: { model: "luna", effort: "high" },
          deliveries: [
            {
              nextCursor: "started",
              event: {
                type: "attempt.started",
                eventId: "start",
                attemptId: "fixture",
                sequence: 1,
                occurredAt: new Date().toISOString(),
              },
            },
            {
              nextCursor: "blocked",
              event: {
                type: "attempt.blocked_policy",
                eventId: "blocked",
                attemptId: "fixture",
                sequence: 2,
                occurredAt: new Date().toISOString(),
                code: "cancelled",
                message: "Stopped",
              },
            },
          ],
        },
      ],
    });
    const runtime: CliRuntime = {
      projectRoot: root,
      homeRoot: temp,
      async schedulerMetadata() {
        return { repository: "acme/test", baseBranch: "main" };
      },
      async readTasks() {
        const { tasks, diagnostics } = await remote.store.list();
        return githubTaskSnapshot(tasks, diagnostics);
      },
      async runScheduler(options) {
        starts++;
        options.signal?.addEventListener("abort", () => order.push("abort"), {
          once: true,
        });
        await runBackendSession(
          async () => ({
            catalog: ["luna", "terra", "sol"].map((id) => ({
              id,
              supportedReasoningEfforts: ["medium", "high"],
            })),
            harness: {
              async step(request) {
                if (request.backendCursor !== undefined) {
                  entered.release();
                  await released.promise;
                }
                return fake.harness.step(request);
              },
              async cancel(attemptId) {
                cancelledAttempts.add(attemptId);
                order.push("cancel");
                released.release();
                await fake.harness.cancel(attemptId);
              },
            },
            async close() {
              closes++;
              order.push(
                existsSync(`${root}.agile-checkout.lock`)
                  ? "close-with-guard"
                  : "close-without-guard",
              );
            },
          }),
          options,
          "tui-active-stop",
          {
            store: remote.store,
            command: {
              async run(command) {
                if (
                  command.command[0] === "gh" ||
                  command.command[1] === "fetch"
                )
                  return {
                    exitCode: 0,
                    stdout: '{"nameWithOwner":"acme/test"}',
                    stderr: "",
                  };
                return real.run(command);
              },
            },
            onActivity: () => {},
          },
        );
        order.push(
          existsSync(`${root}.agile-checkout.lock`)
            ? "backend-return-with-guard"
            : "backend-return-without-guard",
        );
      },
    };
    const write = output.write.bind(output);
    output.write = (value, callback) => {
      if (value === "\u001B[?1049l") {
        restoreGuardStates.push(existsSync(`${root}.agile-checkout.lock`));
        order.push("restore");
      }
      return write(value, callback);
    };
    outcome = runCli(
      ["tui"],
      { input: input as never, output: output as never, out() {}, err() {} },
      runtime,
    );
    input.emit("data", "s");
    await entered.promise;
    process.emit("SIGINT");
    input.emit("data", "s");
    expect(await outcome).toBe(0);
    expect(starts).toBe(1);
    expect(cancelledAttempts.size).toBe(1);
    expect(closes).toBe(1);
    expect(output.restored).toBe(1);
    expect(restoreGuardStates).toEqual([false]);
    expect(order).toEqual(
      expect.arrayContaining([
        "abort",
        "cancel",
        "close-with-guard",
        "backend-return-without-guard",
        "restore",
      ]),
    );
    expect(order.indexOf("abort")).toBeLessThan(order.indexOf("cancel"));
    expect(order.indexOf("cancel")).toBeLessThan(
      order.indexOf("close-with-guard"),
    );
    expect(order.indexOf("close-with-guard")).toBeLessThan(
      order.indexOf("backend-return-without-guard"),
    );
    expect(order.indexOf("backend-return-without-guard")).toBeLessThan(
      order.indexOf("restore"),
    );
    expect(existsSync(`${root}.agile-checkout.lock`)).toBe(false);
    expect((await remote.store.get(41)).execution).toMatchObject({
      phase: "needs_replan",
    });
    expect(
      (await remote.store.get(41)).execution?.attempts.every(
        (attempt) => attempt.status !== "running",
      ),
    ).toBe(true);
    fake.assertComplete();
  } finally {
    released.release();
    await outcome;
    await rm(temp, { recursive: true, force: true });
  }
}, 10_000);

test.each(["clean", "uncertain"] as const)(
  "controlling PTY hangup completes active backend cleanup (%s)",
  async (mode) => {
    const fixture = await runControllingPtyHangup(mode);
    try {
      const types = fixture.markers.map((marker) => marker.type);
      const active = fixture.markers.find((marker) => marker.type === "active");
      const close = fixture.markers.find((marker) => marker.type === "close");
      const backend = fixture.markers.find((marker) =>
        ["backend-return", "backend-error"].includes(marker.type),
      );
      const restores = fixture.markers.filter(
        (marker) => marker.type === "restore",
      );
      const cancellations = fixture.markers.filter(
        (marker) => marker.type === "cancel",
      );
      const outcome = fixture.markers.find(
        (marker) => marker.type === "outcome",
      );

      expect(fixture.report).toMatchObject({ signaled: false, signal: null });
      expect(types).not.toContain("error");
      expect(types.filter((type) => type === "start")).toHaveLength(1);
      expect(types.filter((type) => type === "abort")).toHaveLength(1);
      expect(cancellations.length).toBeGreaterThan(0);
      expect(
        new Set(cancellations.map((marker) => marker.attemptId)).size,
      ).toBe(1);
      expect(active).toMatchObject({ lockExists: true });
      expect(close).toMatchObject({ lockExists: true });
      expect(restores).toHaveLength(1);
      expect(outcome).toMatchObject({
        starts: 1,
        steps: 2,
        signalListeners: 0,
      });
      expect(outcome?.code).toBe(fixture.report.exitCode);
      expect(types.indexOf("active")).toBeLessThan(types.indexOf("abort"));
      expect(types.indexOf("abort")).toBeLessThan(types.indexOf("cancel"));
      expect(types.indexOf("cancel")).toBeLessThan(types.indexOf("close"));
      expect(types.indexOf("close")).toBeLessThan(
        types.indexOf(backend?.type ?? "missing"),
      );
      expect(types.indexOf(backend?.type ?? "missing")).toBeLessThan(
        types.indexOf("restore"),
      );
      expect(types.indexOf("restore")).toBeLessThan(types.indexOf("outcome"));

      if (mode === "clean") {
        expect(backend).toMatchObject({
          type: "backend-return",
          lockExists: false,
        });
        expect(restores[0]).toMatchObject({ lockExists: false });
        expect(outcome).toMatchObject({
          phase: "needs_replan",
          running: false,
          lockExists: false,
        });
        expect(existsSync(`${fixture.root}.agile-checkout.lock`)).toBe(false);
      } else {
        expect(backend).toMatchObject({
          type: "backend-error",
          code: "SCHEDULER_CHECKOUT_RETAINED",
          lockExists: true,
        });
        expect(restores[0]).toMatchObject({ lockExists: true });
        expect(outcome).toMatchObject({ code: 1, lockExists: true });
        expect(existsSync(`${fixture.root}.agile-checkout.lock`)).toBe(true);
      }
    } finally {
      await rm(fixture.temp, { recursive: true, force: true });
    }
  },
  20_000,
);

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
