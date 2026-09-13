import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenAmp } from "../../src/openamp/cli.mjs";
import { remoteMutationReason, runGit } from "../../src/openamp/command.mjs";
import { ChangeDelivery, parseReview } from "../../src/openamp/delivery.mjs";
import { createOpenAmpExtension } from "../../src/openamp/extension.mjs";
import { ChangeStore } from "../../src/openamp/state.mjs";
import { AgentSupervisor } from "../../src/openamp/supervisor.mjs";
import {
  ChangeWorkspace,
  createChange,
  resumeChange,
} from "../../src/openamp/workspace.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "openamp-test-"));
  temporaryDirectories.push(
    root,
    `${root}/source.openamp-worktrees`,
    `${root}/source.openamp-agents`,
  );
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  await runGit(root, ["init", "--bare", remote]);
  await runGit(root, ["clone", remote, source]);
  await writeFile(join(source, "base.txt"), "base\n");
  await runGit(source, ["add", "base.txt"]);
  await runGit(source, ["commit", "-m", "base"]);
  await runGit(source, ["branch", "-M", "main"]);
  await runGit(source, ["push", "-u", "origin", "main"]);
  await runGit(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, remote, source };
}

class FakeRpcClient {
  constructor(options, behavior) {
    this.options = options;
    this.behavior = behavior;
    this.stopped = false;
  }

  async start() {}
  async getState() {
    return {
      sessionId: `session-${crypto.randomUUID()}`,
      model: { provider: "fake", id: "model" },
      thinkingLevel: "medium",
    };
  }
  async prompt(message) {
    await this.behavior(this.options.cwd, message);
  }
  async waitForIdle() {}
  async getLastAssistantText() {
    return "completed with evidence";
  }
  async steer() {}
  async abort() {}
  async stop() {
    this.stopped = true;
  }
}

describe("M1 feature conversations", () => {
  test("creates and resumes a dedicated branch without touching source dirt", async () => {
    const { source } = await fixtureRepository();
    await writeFile(join(source, "local-only.txt"), "keep me\n");
    const store = await createChange(source, {
      id: "change-m1-test",
      base: "main",
    });
    expect(store.state.branch).toBe("openamp/change-m1-test");
    expect(store.state.workspace).not.toBe(source);
    expect(await readFile(join(source, "local-only.txt"), "utf8")).toBe(
      "keep me\n",
    );
    expect(
      await readFile(
        join(store.state.workspace, "local-only.txt"),
        "utf8",
      ).catch(() => undefined),
    ).toBeUndefined();

    store.state.sessionId = "session-m1";
    await store.update(() => undefined);
    const resumed = await resumeChange(source, "change-m1-test");
    expect(resumed.state.sessionId).toBe("session-m1");
    expect(resumed.state.workspace).toBe(store.state.workspace);
  });

  test("rejects direct remote mutations on the normal agent path", () => {
    expect(remoteMutationReason("npm test && git push origin HEAD")).toContain(
      "only Delivery",
    );
    expect(remoteMutationReason("gh pr merge 42 --squash")).toContain(
      "only Delivery",
    );
    expect(remoteMutationReason("git -C . push origin HEAD")).toContain(
      "only Delivery",
    );
    for (const command of [
      "git send-pack origin HEAD",
      "gh issue create --title bypass",
      "gh release create v1.0.0",
      "npm publish",
      "curl -X POST https://api.github.com/repos/example/example/issues",
      "ssh github.example mutate-repository",
    ]) {
      expect(remoteMutationReason(command), command).toContain("only Delivery");
    }
    expect(remoteMutationReason("git status")).toBeUndefined();
    expect(
      remoteMutationReason("curl https://api.github.com/rate_limit"),
    ).toBeUndefined();
  });

  test("ignores ambient Git repository overrides", async () => {
    const { source } = await fixtureRepository();
    const result = await runGit(source, ["rev-parse", "--show-toplevel"], {
      env: {
        ...process.env,
        GIT_DIR: "/does/not/exist",
        GIT_INDEX_FILE: "/does/not/exist",
        GIT_WORK_TREE: "/does/not/exist",
      },
    });
    expect(result.stdout).toBe(source);
  });

  test("hides publication credentials from the interactive agent runtime", async () => {
    const { source } = await fixtureRepository();
    const originalToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "delivery-only-test-token";
    let runtimeToken;
    class FakeInteractiveMode {
      /** Ends the TUI immediately after observing its process environment. */
      async run() {
        runtimeToken = process.env.GH_TOKEN;
      }
    }
    try {
      await runOpenAmp([], {
        cwd: source,
        InteractiveMode: FakeInteractiveMode,
      });
      expect(runtimeToken).toBeUndefined();
      expect(process.env.GH_TOKEN).toBe("delivery-only-test-token");
    } finally {
      if (originalToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalToken;
    }
  });
});

describe("M2 reliable delegation", () => {
  test("bounds children, targets steering, and delivers each result once", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m2-test",
      base: "main",
    });
    store.state.sessionId = "parent-session";
    const workspace = new ChangeWorkspace(store);
    let active = 0;
    let maximum = 0;
    const supervisor = new AgentSupervisor(store, workspace, {
      maxActive: 2,
      clientFactory: (options) =>
        new FakeRpcClient(options, async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await Bun.sleep(20);
          active -= 1;
        }),
    });
    const delivered = [];
    supervisor.setDeliveryHandler(async (result) => delivered.push(result.id));
    const runs = [];
    const initialStatuses = [];
    for (const number of [1, 2, 3]) {
      const run = await supervisor.delegate({
        role: "researcher",
        prompt: `research ${number}`,
        parentSessionId: "parent-session",
      });
      runs.push(run);
      initialStatuses.push(run.status);
    }
    expect(initialStatuses).toContain("queued");
    await Promise.all(runs.map((run) => supervisor.wait(run.id)));
    expect(maximum).toBe(2);
    expect(new Set(delivered).size).toBe(3);
    expect(delivered).toHaveLength(3);
  });

  test("serializes concurrent admissions before assigning capacity", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m2-concurrent",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    const supervisor = new AgentSupervisor(store, workspace, {
      maxActive: 2,
      clientFactory: (options) =>
        new FakeRpcClient(options, async () => Bun.sleep(25)),
    });
    const runs = await Promise.all(
      [1, 2, 3].map((number) =>
        supervisor
          .delegate({
            role: "researcher",
            prompt: `parallel ${number}`,
          })
          .then((run) => ({ id: run.id, initialStatus: run.status })),
      ),
    );
    const statuses = runs.map((run) => store.state.runs[run.id].status);
    expect(
      statuses.filter((status) => ["starting", "running"].includes(status)),
    ).toHaveLength(2);
    expect(statuses.filter((status) => status === "queued")).toHaveLength(1);
    await Promise.all(runs.map((run) => supervisor.wait(run.id)));
  });

  test("recovers custom results once and never routes them to another session", async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), "openamp-state-")),
      "state.json",
    );
    temporaryDirectories.push(path.slice(0, path.lastIndexOf("/")));
    const result = {
      id: "result-one",
      runId: "run-one",
      role: "researcher",
      summary: "evidence",
      commit: null,
      deliveredSessionId: null,
    };
    const state = {
      version: 1,
      id: "change-result-test",
      workspace: "/tmp",
      phase: "active",
      runs: {
        "run-one": {
          id: "run-one",
          parentSessionId: "parent-one",
          deliveryOnly: false,
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      results: { "result-one": result },
      integratedResultIds: [],
      commandLedger: [],
    };
    const store = new ChangeStore(path, state);
    const handlers = {};
    const entries = [];
    const messages = [];
    let persistMessages = false;
    const supervisor = {
      list: () => Object.values(state.runs),
      setDeliveryHandler: (handler) => {
        supervisor.delivery = handler;
      },
    };
    const pi = {
      on: (name, handler) => {
        handlers[name] = handler;
      },
      registerTool: () => undefined,
      registerCommand: () => undefined,
      sendMessage: (message) => {
        messages.push(message);
        if (persistMessages) {
          entries.push({
            type: "custom_message",
            customType: message.customType,
            details: message.details,
          });
        }
      },
    };
    createOpenAmpExtension(store, supervisor, {}, {}).factory(pi);
    const context = {
      sessionManager: {
        getSessionId: () => "other-session",
        getSessionFile: () => "session.jsonl",
        getBranch: () => entries,
      },
      ui: {
        setTitle: () => undefined,
        setStatus: () => undefined,
        setWidget: () => undefined,
      },
    };
    await handlers.session_start({}, context);
    expect(messages).toHaveLength(0);
    context.sessionManager.getSessionId = () => "parent-one";
    await handlers.session_start({}, context);
    expect(messages).toHaveLength(1);
    expect(store.state.results["result-one"].deliveredSessionId).toBeNull();
    persistMessages = true;
    await handlers.session_start({}, context);
    await handlers.session_start({}, context);
    expect(messages).toHaveLength(2);
    expect(store.state.results["result-one"].deliveredSessionId).toBe(
      "parent-one",
    );
  });
});

describe("M3 collaborative implementation", () => {
  test("integrates two independently verified writer commits in sequence", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m3-test",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    let writer = 0;
    const supervisor = new AgentSupervisor(store, workspace, {
      clientFactory: (options) =>
        new FakeRpcClient(options, async (cwd) => {
          writer += 1;
          await writeFile(
            join(cwd, `writer-${writer}.txt`),
            `writer ${writer}\n`,
          );
        }),
    });
    const first = await supervisor.delegate({
      role: "writer",
      prompt: "first",
    });
    const firstResult = await supervisor.wait(first.id);
    await workspace.integrate(firstResult.id);
    const second = await supervisor.delegate({
      role: "writer",
      prompt: "second",
    });
    const secondResult = await supervisor.wait(second.id);
    await workspace.integrate(secondResult.id);

    expect(
      await readFile(join(store.state.workspace, "writer-1.txt"), "utf8"),
    ).toBe("writer 1\n");
    expect(
      await readFile(join(store.state.workspace, "writer-2.txt"), "utf8"),
    ).toBe("writer 2\n");
    expect(store.state.integratedResultIds).toEqual([
      firstResult.id,
      secondResult.id,
    ]);
  });

  test("preserves both writer worktrees when sequential integration conflicts", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m3-conflict",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    const supervisor = new AgentSupervisor(store, workspace, {
      clientFactory: (options) =>
        new FakeRpcClient(options, async (cwd, message) => {
          await writeFile(
            join(cwd, "shared.txt"),
            message.includes("first") ? "first\n" : "second\n",
          );
        }),
    });
    const first = await supervisor.delegate({
      role: "writer",
      prompt: "first",
    });
    const second = await supervisor.delegate({
      role: "writer",
      prompt: "second",
    });
    const [firstResult, secondResult] = await Promise.all([
      supervisor.wait(first.id),
      supervisor.wait(second.id),
    ]);
    await workspace.integrate(firstResult.id);
    await expect(workspace.integrate(secondResult.id)).rejects.toThrow(
      "conflicted",
    );
    expect(store.state.phase).toBe("needs_attention");
    expect(await readFile(join(firstResult.cwd, "shared.txt"), "utf8")).toBe(
      "first\n",
    );
    expect(await readFile(join(secondResult.cwd, "shared.txt"), "utf8")).toBe(
      "second\n",
    );
  });

  test("reconciles a completed cherry-pick whose state receipt was interrupted", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m3-recovery",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    const supervisor = new AgentSupervisor(store, workspace, {
      clientFactory: (options) =>
        new FakeRpcClient(options, async (cwd) => {
          await writeFile(join(cwd, "recovered.txt"), "recovered\n");
        }),
    });
    const run = await supervisor.delegate({ role: "writer", prompt: "write" });
    const result = await supervisor.wait(run.id);
    const expectedHead = await workspace.head();
    await store.update((state) => {
      state.integration = {
        resultId: result.id,
        expectedHead,
        status: "pending",
      };
    });
    await runGit(store.state.workspace, ["cherry-pick", result.commit]);

    const resumed = await resumeChange(source, store.state.id);
    expect(resumed.state.integration.status).toBe("integrated");
    expect(resumed.state.integratedResultIds).toContain(result.id);
    expect(resumed.state.mainHead).toBe(
      (await runGit(store.state.workspace, ["rev-parse", "HEAD"])).stdout,
    );
  });
});

describe("M4 reviewed PR delivery", () => {
  test("reconciles lost responses, updates one PR, and never invokes merge", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-test",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "one\n");
    await workspace.checkpoint();
    let reviews = 0;
    const supervisor = {
      list: () => [],
      review: async () => {
        reviews += 1;
        return {
          summary: JSON.stringify({
            decision: "accepted",
            findings: [],
            summary: "correct",
          }),
        };
      },
    };
    let remoteHead = null;
    let pullRequest = null;
    const calls = [];
    const commandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (command === "gh" && args[0] === "auth")
        return { exitCode: 0, stdout: "" };
      if (command === "gh" && args[0] === "repo") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ owner: { login: "owner" } }),
        };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(pullRequest ? [pullRequest] : []),
        };
      }
      if (command === "git" && args[0] === "ls-remote") {
        return {
          exitCode: 0,
          stdout: remoteHead
            ? `${remoteHead}\trefs/heads/${store.state.branch}`
            : "",
        };
      }
      if (command === "git" && args[0] === "push") {
        remoteHead = store.state.mainHead;
        return { exitCode: 1, stdout: "", stderr: "response lost" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        pullRequest = {
          number: 7,
          url: "https://example.test/pr/7",
          state: "OPEN",
          title: args[args.indexOf("--title") + 1],
          body: args[args.indexOf("--body") + 1],
          headRefOid: store.state.mainHead,
          headRepositoryOwner: { login: "owner" },
        };
        return { exitCode: 1, stdout: "", stderr: "response lost" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "edit") {
        pullRequest.title = args[args.indexOf("--title") + 1];
        pullRequest.body = args[args.indexOf("--body") + 1];
        pullRequest.headRefOid = store.state.mainHead;
        return { exitCode: 0, stdout: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    const delivery = new ChangeDelivery(store, workspace, supervisor, {
      validationRunner: async () => ({
        exitCode: 0,
        stdout: "passed",
        stderr: "",
      }),
      commandRunner,
    });
    const first = await delivery.deliver({
      title: "Feature",
      requirements: "Add feature one",
      validationCommands: ["npm test"],
    });
    const firstHead = store.state.mainHead;
    expect(first.number).toBe(7);
    await writeFile(join(store.state.workspace, "feature.txt"), "two\n");
    const second = await delivery.deliver({
      title: "Feature updated",
      requirements: "Add feature one and follow-up two",
      validationCommands: ["npm test"],
    });
    const secondHead = store.state.mainHead;
    expect(second.number).toBe(7);
    expect(reviews).toBe(2);
    expect(
      calls.filter((call) => call[0] === "gh" && call[2] === "create"),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call[0] === "gh" && call[2] === "edit"),
    ).toHaveLength(1);
    expect(calls.some((call) => call.includes("merge"))).toBeFalse();
    const pushes = calls.filter(
      ([command, operation]) => command === "git" && operation === "push",
    );
    expect(pushes).toHaveLength(2);
    expect(
      pushes.map((call) =>
        call.find((argument) => argument.endsWith(`/${store.state.branch}`)),
      ),
    ).toEqual([
      `${firstHead}:refs/heads/${store.state.branch}`,
      `${secondHead}:refs/heads/${store.state.branch}`,
    ]);
    expect(
      pushes.every((call) =>
        call.some((argument) => argument.startsWith("--force-with-lease=")),
      ),
    ).toBeTrue();
  });

  test("rejects malformed or internally contradictory review evidence", () => {
    expect(() => parseReview("not json")).toThrow("valid JSON");
    expect(() =>
      parseReview(
        JSON.stringify({
          decision: "accepted",
          findings: [{ severity: "blocking", message: "broken" }],
        }),
      ),
    ).toThrow("blocking finding");
  });

  test("does not publish when independent review rejects the exact head", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-reject",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "unsafe.txt"), "unsafe\n");
    let publicationCommands = 0;
    const delivery = new ChangeDelivery(
      store,
      workspace,
      {
        list: () => [],
        review: async () => ({
          summary: JSON.stringify({
            decision: "rejected",
            findings: [{ severity: "blocking", message: "unsafe" }],
          }),
        }),
      },
      {
        validationRunner: async () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        commandRunner: async () => {
          publicationCommands += 1;
          return { exitCode: 0, stdout: "" };
        },
      },
    );
    await expect(
      delivery.deliver({
        title: "Unsafe",
        requirements: "Must be safe",
        validationCommands: ["npm test"],
      }),
    ).rejects.toThrow("rejected");
    expect(publicationCommands).toBe(0);
    expect(store.state.phase).toBe("review_rejected");
  });
});
