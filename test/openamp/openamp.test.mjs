import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenAmp } from "../../src/openamp/cli.mjs";
import {
  agentEnvironment,
  remoteMutationReason,
  runGit,
} from "../../src/openamp/command.mjs";
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
      "/usr/bin/git push origin HEAD",
      "gh issue comment 1 --body bypass",
      "gh release delete-asset v1 artifact --yes",
      "pnpm publish",
      "curl -T artifact https://uploads.example.test",
      "'git' push origin HEAD",
      "'gh' pr merge 1",
      "'pnpm' publish",
      "git \\\npush origin HEAD",
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
    const originalHome = process.env.HOME;
    const originalSshAgent = process.env.SSH_AUTH_SOCK;
    process.env.GH_TOKEN = "delivery-only-test-token";
    process.env.SSH_AUTH_SOCK = "/delivery-only/ssh-agent.sock";
    let runtimeEnvironment;
    class FakeInteractiveMode {
      /** Ends the TUI immediately after observing its process environment. */
      async run() {
        runtimeEnvironment = { ...process.env };
      }
    }
    try {
      await runOpenAmp([], {
        cwd: source,
        InteractiveMode: FakeInteractiveMode,
      });
      expect(runtimeEnvironment.GH_TOKEN).toBeUndefined();
      expect(runtimeEnvironment.SSH_AUTH_SOCK).toBeUndefined();
      expect(runtimeEnvironment.HOME).not.toBe(originalHome);
      expect(runtimeEnvironment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(process.env.GH_TOKEN).toBe("delivery-only-test-token");
      expect(process.env.SSH_AUTH_SOCK).toBe("/delivery-only/ssh-agent.sock");
      expect(process.env.HOME).toBe(originalHome);
    } finally {
      if (originalToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalToken;
      if (originalSshAgent === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = originalSshAgent;
    }
  });

  test("isolates credentials before recovering queued child agents", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-recovery-environment",
      base: "main",
    });
    await store.update((state) => {
      state.runs["run-queued-recovery"] = {
        id: "run-queued-recovery",
        role: "reviewer",
        prompt: "Review after restart",
        status: "queued",
        parentSessionId: null,
        deliveryOnly: true,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        cwd: null,
        sessionId: null,
        model: null,
        effort: null,
        resultId: null,
      };
    });
    const originalToken = process.env.GH_TOKEN;
    const originalHome = process.env.HOME;
    process.env.GH_TOKEN = "delivery-only-recovery-token";
    let recoveredEnvironment;
    let markRecovered;
    const recovered = new Promise((resolve) => {
      markRecovered = resolve;
    });
    class FakeInteractiveMode {
      /** Waits until queued recovery has constructed its isolated child. */
      async run() {
        await recovered;
      }
    }
    try {
      await runOpenAmp(["--resume", store.state.id], {
        cwd: source,
        InteractiveMode: FakeInteractiveMode,
        supervisorOptions: {
          clientFactory: (options) => {
            recoveredEnvironment = options.env;
            markRecovered();
            return new FakeRpcClient(options, async () => undefined);
          },
        },
      });
      expect(recoveredEnvironment.GH_TOKEN).toBeUndefined();
      expect(recoveredEnvironment.HOME).not.toBe(originalHome);
      expect(recoveredEnvironment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(process.env.GH_TOKEN).toBe("delivery-only-recovery-token");
      expect(process.env.HOME).toBe(originalHome);
    } finally {
      if (originalToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalToken;
    }
  });

  test("builds a child environment without normal publication stores", () => {
    const environment = agentEnvironment(
      {
        HOME: "/real-home",
        GH_TOKEN: "github-token",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "malicious-helper",
        NPM_TOKEN: "npm-token",
        npm_config_userconfig: "/credentialed/npmrc",
        "npm_config_//registry.npmjs.org/:_authToken": "registry-token",
        node_auth_token: "node-token",
        SSH_AUTH_SOCK: "/ssh-agent.sock",
      },
      "/isolated-home",
    );
    expect(environment).toMatchObject({
      HOME: "/isolated-home",
      XDG_CONFIG_HOME: "/isolated-home",
      GNUPGHOME: "/isolated-home",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GIT_CONFIG_COUNT).toBeUndefined();
    expect(environment.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(environment.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(environment.NPM_TOKEN).toBeUndefined();
    expect(environment.npm_config_userconfig).toBeUndefined();
    expect(
      environment["npm_config_//registry.npmjs.org/:_authToken"],
    ).toBeUndefined();
    expect(environment.node_auth_token).toBeUndefined();
    expect(environment.SSH_AUTH_SOCK).toBeUndefined();
  });

  test("forwards Pi tool cancellation to Delivery", async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), "openamp-state-")),
      "state.json",
    );
    temporaryDirectories.push(path.slice(0, path.lastIndexOf("/")));
    const store = new ChangeStore(path, {
      version: 1,
      id: "change-cancel-signal",
      workspace: "/tmp",
      phase: "active",
      inputGeneration: 3,
      runs: {},
      results: {},
      integratedResultIds: [],
      commandLedger: [],
    });
    let tool;
    let receivedSignal;
    const pi = {
      on: () => undefined,
      registerCommand: () => undefined,
      registerTool: (definition) => {
        if (definition.name === "deliver_change") tool = definition;
      },
    };
    const supervisor = {
      list: () => [],
      setDeliveryHandler: () => undefined,
    };
    const delivery = {
      deliver: async (_input, signal) => {
        receivedSignal = signal;
        throw new Error("cancelled for test");
      },
    };
    createOpenAmpExtension(store, supervisor, {}, delivery).factory(pi);
    const controller = new AbortController();
    await expect(
      tool.execute(
        "call-one",
        {
          title: "Feature",
          requirements: "Current requirements",
          validation_commands: ["npm test"],
        },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled for test");
    expect(receivedSignal).toBe(controller.signal);
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

  test("cancels a delivery reviewer instead of recording a stale result", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m2-review-cancel",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    let releasePrompt;
    class CancellableRpcClient extends FakeRpcClient {
      /** Blocks reviewer work until cancellation releases the fake prompt. */
      async prompt() {
        await new Promise((resolve) => {
          releasePrompt = resolve;
        });
      }

      /** Releases the fake prompt to model an aborted Pi child. */
      async abort() {
        releasePrompt?.();
      }
    }
    const supervisor = new AgentSupervisor(store, workspace, {
      clientFactory: (options) => new CancellableRpcClient(options, () => {}),
    });
    const controller = new AbortController();
    const review = supervisor.review(
      "Review exact change",
      "parent-session",
      controller.signal,
    );
    while (!releasePrompt) await Bun.sleep(1);
    controller.abort();
    await expect(review).rejects.toThrow();
    const reviewer = supervisor.list().find((run) => run.role === "reviewer");
    expect(reviewer.status).toBe("cancelled");
    expect(reviewer.resultId).toBeNull();
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
    const entries = [
      { type: "message", message: { role: "user", content: "request" } },
    ];
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
    expect(store.state.inputGeneration).toBe(1);
    const persistedInput = handlers.input({ source: "interactive" });
    expect(store.state.inputGeneration).toBe(2);
    await persistedInput;
    await handlers.input({ source: "extension" });
    expect(store.state.inputGeneration).toBe(2);
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
    let reviewPrompt;
    const supervisor = {
      list: () => [],
      review: async (prompt) => {
        reviews += 1;
        reviewPrompt = prompt;
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
    const remoteBase = store.state.baseCommit;
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
        const ref = args.at(-1);
        return {
          exitCode: 0,
          stdout:
            ref === `refs/heads/${store.state.baseBranch}`
              ? `${remoteBase}\t${ref}`
              : remoteHead
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
    const bundlePath = reviewPrompt.match(
      /immutable review bundle at (.*); it contains/u,
    )?.[1];
    expect(bundlePath).toBeTruthy();
    const bundle = await readFile(bundlePath, "utf8");
    expect(bundle).toContain(`Base commit: ${store.state.baseCommit}`);
    expect(bundle).toContain(`Final head: ${secondHead}`);
    expect(bundle).toContain("diff --git a/feature.txt b/feature.txt");
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
          return {
            exitCode: 0,
            stdout: `${store.state.baseCommit}\trefs/heads/${store.state.baseBranch}`,
          };
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
    expect(publicationCommands).toBe(1);
    expect(store.state.phase).toBe("review_rejected");
  });

  test("invalidates review when the remote base branch changes", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-base-moved",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "feature\n");
    let reviewCalls = 0;
    const delivery = new ChangeDelivery(
      store,
      workspace,
      {
        list: () => [],
        review: async () => {
          reviewCalls += 1;
          throw new Error("review must not run");
        },
      },
      {
        commandRunner: async () => ({
          exitCode: 0,
          stdout: `${"f".repeat(40)}\trefs/heads/main`,
          stderr: "",
        }),
      },
    );
    await expect(
      delivery.deliver({
        title: "Stale base",
        requirements: "Review only the current base",
        validationCommands: ["npm test"],
      }),
    ).rejects.toThrow("Remote base branch changed");
    expect(reviewCalls).toBe(0);
  });

  test("invalidates an accepted review when the remote base moves afterward", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-base-race",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "feature\n");
    let remoteBase = store.state.baseCommit;
    let mutations = 0;
    const delivery = new ChangeDelivery(
      store,
      workspace,
      {
        list: () => [],
        review: async () => {
          remoteBase = "e".repeat(40);
          return {
            summary: JSON.stringify({
              decision: "accepted",
              findings: [],
              summary: "correct",
            }),
          };
        },
      },
      {
        validationRunner: async () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        commandRunner: async (command, args) => {
          if (command === "git" && args[0] === "ls-remote") {
            return {
              exitCode: 0,
              stdout: `${remoteBase}\t${args.at(-1)}`,
              stderr: "",
            };
          }
          mutations += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    await expect(
      delivery.deliver({
        title: "Racing base",
        requirements: "Publish only against the reviewed base",
        validationCommands: ["npm test"],
      }),
    ).rejects.toThrow("Remote base branch changed after review");
    expect(mutations).toBe(0);
  });

  test("invalidates an accepted review when new user input arrives", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-new-input",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "feature\n");
    let publicationCommands = 0;
    const delivery = new ChangeDelivery(
      store,
      workspace,
      {
        list: () => [],
        review: async () => {
          await store.update((state) => {
            state.inputGeneration += 1;
          });
          return {
            summary: JSON.stringify({
              decision: "accepted",
              findings: [],
              summary: "stale",
            }),
          };
        },
      },
      {
        validationRunner: async () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        commandRunner: async () => {
          publicationCommands += 1;
          return {
            exitCode: 0,
            stdout: `${store.state.baseCommit}\trefs/heads/${store.state.baseBranch}`,
            stderr: "",
          };
        },
      },
    );
    await expect(
      delivery.deliver({
        title: "Stale requirements",
        requirements: "Original requirements",
        validationCommands: ["npm test"],
        inputGeneration: 0,
      }),
    ).rejects.toThrow("New user input invalidated");
    expect(publicationCommands).toBe(1);
  });

  test("cancels an in-flight review and requires replanning", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-review-cancelled",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "feature\n");
    const controller = new AbortController();
    const mutations = [];
    const delivery = new ChangeDelivery(
      store,
      workspace,
      {
        list: () => [],
        review: async (_prompt, _parentSessionId, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort();
          return {
            summary: JSON.stringify({
              decision: "accepted",
              findings: [],
              summary: "stale after cancellation",
            }),
          };
        },
      },
      {
        validationRunner: async () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        commandRunner: async (command, args) => {
          if (
            (command === "git" && args[0] === "push") ||
            (command === "gh" &&
              args[0] === "pr" &&
              ["create", "edit"].includes(args[1]))
          ) {
            mutations.push([command, ...args]);
          }
          return {
            exitCode: 0,
            stdout: `${store.state.baseCommit}\t${args.at(-1)}`,
            stderr: "",
          };
        },
      },
    );
    await expect(
      delivery.deliver(
        {
          title: "Cancelled review",
          requirements: "Cancellation must invalidate delivery",
          validationCommands: ["npm test"],
          inputGeneration: 0,
        },
        controller.signal,
      ),
    ).rejects.toThrow("Interaction cancellation invalidated");
    expect(mutations).toHaveLength(0);
    expect(store.state.phase).toBe("needs_replan");
    expect(store.state.inputGeneration).toBe(1);
  });

  test("stops before push when new input arrives during publication lookup", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-publication-input-race",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "feature\n");
    const mutations = [];
    const delivery = new ChangeDelivery(
      store,
      workspace,
      {
        list: () => [],
        review: async () => ({
          summary: JSON.stringify({
            decision: "accepted",
            findings: [],
            summary: "correct",
          }),
        }),
      },
      {
        validationRunner: async () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        commandRunner: async (command, args) => {
          if (command === "git" && args[0] === "push") {
            mutations.push([command, ...args]);
          }
          if (command === "gh" && args[0] === "auth") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "pr") {
            return { exitCode: 0, stdout: "[]", stderr: "" };
          }
          if (command === "gh" && args[0] === "repo") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ owner: { login: "owner" } }),
              stderr: "",
            };
          }
          if (command === "git" && args[0] === "ls-remote") {
            const ref = args.at(-1);
            if (ref === `refs/heads/${store.state.branch}`) {
              await store.update((state) => {
                state.inputGeneration += 1;
              });
              return { exitCode: 0, stdout: "", stderr: "" };
            }
            return {
              exitCode: 0,
              stdout: `${store.state.baseCommit}\t${ref}`,
              stderr: "",
            };
          }
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        },
      },
    );
    await expect(
      delivery.deliver({
        title: "Stale during publication",
        requirements: "Publish only the current requirements",
        validationCommands: ["npm test"],
        inputGeneration: 0,
      }),
    ).rejects.toThrow("New user input invalidated");
    expect(mutations).toHaveLength(0);
  });

  test("stops before push when cancellation arrives during publication lookup", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-publication-cancel-race",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "feature\n");
    const controller = new AbortController();
    const mutations = [];
    const delivery = new ChangeDelivery(
      store,
      workspace,
      {
        list: () => [],
        review: async () => ({
          summary: JSON.stringify({
            decision: "accepted",
            findings: [],
            summary: "correct",
          }),
        }),
      },
      {
        validationRunner: async () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        commandRunner: async (command, args) => {
          if (
            (command === "git" && args[0] === "push") ||
            (command === "gh" &&
              args[0] === "pr" &&
              ["create", "edit"].includes(args[1]))
          ) {
            mutations.push([command, ...args]);
          }
          if (command === "gh" && args[0] === "auth") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "pr") {
            controller.abort();
            return { exitCode: 0, stdout: "[]", stderr: "" };
          }
          if (command === "git" && args[0] === "ls-remote") {
            return {
              exitCode: 0,
              stdout: `${store.state.baseCommit}\t${args.at(-1)}`,
              stderr: "",
            };
          }
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        },
      },
    );
    await expect(
      delivery.deliver(
        {
          title: "Cancelled publication",
          requirements: "Never mutate after cancellation",
          validationCommands: ["npm test"],
          inputGeneration: 0,
        },
        controller.signal,
      ),
    ).rejects.toThrow("Interaction cancellation invalidated");
    expect(mutations).toHaveLength(0);
    expect(store.state.phase).toBe("needs_replan");
    expect(store.state.publication.status).toBe("cancelled");
  });

  test("reconciles a push response when cancellation arrives in flight", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-push-cancel-race",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "feature\n");
    const controller = new AbortController();
    let remoteHead = null;
    const calls = [];
    const delivery = new ChangeDelivery(
      store,
      workspace,
      {
        list: () => [],
        review: async () => ({
          summary: JSON.stringify({
            decision: "accepted",
            findings: [],
            summary: "correct",
          }),
        }),
      },
      {
        validationRunner: async () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        commandRunner: async (command, args) => {
          calls.push([command, ...args]);
          if (command === "gh" && args[0] === "auth") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "pr") {
            return { exitCode: 0, stdout: "[]", stderr: "" };
          }
          if (command === "gh" && args[0] === "repo") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ owner: { login: "owner" } }),
              stderr: "",
            };
          }
          if (command === "git" && args[0] === "push") {
            remoteHead = store.state.mainHead;
            controller.abort();
            return { exitCode: 1, stdout: "", stderr: "response lost" };
          }
          if (command === "git" && args[0] === "ls-remote") {
            const ref = args.at(-1);
            return {
              exitCode: 0,
              stdout:
                ref === `refs/heads/${store.state.baseBranch}`
                  ? `${store.state.baseCommit}\t${ref}`
                  : remoteHead
                    ? `${remoteHead}\t${ref}`
                    : "",
              stderr: "",
            };
          }
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        },
      },
    );
    await expect(
      delivery.deliver(
        {
          title: "Cancelled push",
          requirements: "Reconcile every started push",
          validationCommands: ["npm test"],
          inputGeneration: 0,
        },
        controller.signal,
      ),
    ).rejects.toThrow("Interaction cancellation invalidated");
    expect(remoteHead).toBe(store.state.mainHead);
    expect(
      calls.filter(
        ([command, operation]) =>
          command === "git" && operation === "ls-remote",
      ),
    ).toHaveLength(4);
    expect(
      calls.some(
        ([command, resource, operation]) =>
          command === "gh" &&
          resource === "pr" &&
          ["create", "edit"].includes(operation),
      ),
    ).toBeFalse();
    expect(store.state.phase).toBe("needs_replan");
    expect(store.state.publication.status).toBe("cancelled");
  });

  test("reconciles and records a PR created while cancellation is in flight", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-pr-cancel-race",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "feature\n");
    const controller = new AbortController();
    let remoteHead = null;
    let pullRequest = null;
    const calls = [];
    const delivery = new ChangeDelivery(
      store,
      workspace,
      {
        list: () => [],
        review: async () => ({
          summary: JSON.stringify({
            decision: "accepted",
            findings: [],
            summary: "correct",
          }),
        }),
      },
      {
        validationRunner: async () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        commandRunner: async (command, args) => {
          calls.push([command, ...args]);
          if (command === "gh" && args[0] === "auth") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "repo") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ owner: { login: "owner" } }),
              stderr: "",
            };
          }
          if (command === "gh" && args[0] === "pr" && args[1] === "list") {
            return {
              exitCode: 0,
              stdout: JSON.stringify(pullRequest ? [pullRequest] : []),
              stderr: "",
            };
          }
          if (command === "gh" && args[0] === "pr" && args[1] === "create") {
            pullRequest = {
              number: 17,
              url: "https://example.test/pr/17",
              state: "OPEN",
              title: args[args.indexOf("--title") + 1],
              body: args[args.indexOf("--body") + 1],
              headRefOid: store.state.mainHead,
              headRepositoryOwner: { login: "owner" },
            };
            controller.abort();
            return { exitCode: 1, stdout: "", stderr: "response lost" };
          }
          if (command === "git" && args[0] === "push") {
            remoteHead = store.state.mainHead;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "git" && args[0] === "ls-remote") {
            const ref = args.at(-1);
            return {
              exitCode: 0,
              stdout:
                ref === `refs/heads/${store.state.baseBranch}`
                  ? `${store.state.baseCommit}\t${ref}`
                  : remoteHead
                    ? `${remoteHead}\t${ref}`
                    : "",
              stderr: "",
            };
          }
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        },
      },
    );
    await expect(
      delivery.deliver(
        {
          title: "Cancelled PR creation",
          requirements: "Reconcile every started PR mutation",
          validationCommands: ["npm test"],
          inputGeneration: 0,
        },
        controller.signal,
      ),
    ).rejects.toThrow("Interaction cancellation invalidated");
    expect(
      calls.filter(
        ([command, resource, operation]) =>
          command === "gh" && resource === "pr" && operation === "create",
      ),
    ).toHaveLength(1);
    expect(pullRequest.number).toBe(17);
    expect(store.state.phase).toBe("needs_replan");
    expect(store.state.publication).toMatchObject({
      status: "published",
      pullRequestNumber: 17,
      pullRequestUrl: "https://example.test/pr/17",
      head: store.state.mainHead,
    });
  });

  test("preserves an unknown push when cancellation and reconciliation both fail", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-push-reconciliation-unavailable",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "feature\n");
    const controller = new AbortController();
    let pushStarted = false;
    let pullRequestMutations = 0;
    const supervisor = {
      list: () => [],
      review: async () => ({
        summary: JSON.stringify({
          decision: "accepted",
          findings: [],
          summary: "correct",
        }),
      }),
    };
    const delivery = new ChangeDelivery(store, workspace, supervisor, {
      validationRunner: async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
      commandRunner: async (command, args) => {
        if (command === "gh" && args[0] === "auth") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "gh" && args[0] === "repo") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ owner: { login: "owner" } }),
            stderr: "",
          };
        }
        if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
        if (
          command === "gh" &&
          args[0] === "pr" &&
          ["create", "edit"].includes(args[1])
        ) {
          pullRequestMutations += 1;
        }
        if (command === "git" && args[0] === "push") {
          pushStarted = true;
          controller.abort();
          return { exitCode: 1, stdout: "", stderr: "response lost" };
        }
        if (command === "git" && args[0] === "ls-remote") {
          const ref = args.at(-1);
          if (ref === `refs/heads/${store.state.baseBranch}`) {
            return {
              exitCode: 0,
              stdout: `${store.state.baseCommit}\t${ref}`,
              stderr: "",
            };
          }
          return pushStarted
            ? { exitCode: 1, stdout: "", stderr: "network unavailable" }
            : { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    await expect(
      delivery.deliver(
        {
          title: "Unknown push",
          requirements: "Never hide an unknown push outcome",
          validationCommands: ["npm test"],
          inputGeneration: 0,
        },
        controller.signal,
      ),
    ).rejects.toThrow("Interaction cancellation invalidated");
    expect(store.state.phase).toBe("needs_replan");
    expect(store.state.publication.status).toBe("reconcile_required");
    expect(
      store.state.commandLedger.find((entry) => entry.action === "push")
        ?.status,
    ).toBe("unknown");
    expect(pullRequestMutations).toBe(0);

    const resumed = await resumeChange(source, store.state.id);
    expect(resumed.state.publication.status).toBe("reconcile_required");
    let retryMutations = 0;
    const retry = new ChangeDelivery(
      resumed,
      new ChangeWorkspace(resumed),
      supervisor,
      {
        validationRunner: async () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        commandRunner: async (command, args) => {
          if (command === "gh" && args[0] === "auth") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "repo") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ owner: { login: "owner" } }),
              stderr: "",
            };
          }
          if (command === "gh" && args[0] === "pr") {
            return { exitCode: 0, stdout: "[]", stderr: "" };
          }
          if (command === "git" && args[0] === "ls-remote") {
            const ref = args.at(-1);
            return ref === `refs/heads/${resumed.state.baseBranch}`
              ? {
                  exitCode: 0,
                  stdout: `${resumed.state.baseCommit}\t${ref}`,
                  stderr: "",
                }
              : { exitCode: 1, stdout: "", stderr: "network unavailable" };
          }
          retryMutations += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    await expect(
      retry.deliver({
        title: "Unknown push",
        requirements: "Never hide an unknown push outcome",
        validationCommands: ["npm test"],
        inputGeneration: resumed.state.inputGeneration,
      }),
    ).rejects.toThrow("Cannot read the remote feature branch");
    expect(retryMutations).toBe(0);
    expect(resumed.state.publication.status).toBe("reconcile_required");
  });

  test("preserves an unknown PR creation when reconciliation is unavailable", async () => {
    const { source } = await fixtureRepository();
    const store = await createChange(source, {
      id: "change-m4-pr-reconciliation-unavailable",
      base: "main",
    });
    const workspace = new ChangeWorkspace(store);
    await writeFile(join(store.state.workspace, "feature.txt"), "feature\n");
    const controller = new AbortController();
    let remoteHead = null;
    let pullRequestLists = 0;
    let pullRequestCreates = 0;
    const supervisor = {
      list: () => [],
      review: async () => ({
        summary: JSON.stringify({
          decision: "accepted",
          findings: [],
          summary: "correct",
        }),
      }),
    };
    const delivery = new ChangeDelivery(store, workspace, supervisor, {
      validationRunner: async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
      commandRunner: async (command, args) => {
        if (command === "gh" && args[0] === "auth") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "gh" && args[0] === "repo") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ owner: { login: "owner" } }),
            stderr: "",
          };
        }
        if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          pullRequestLists += 1;
          return pullRequestLists === 1
            ? { exitCode: 0, stdout: "[]", stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "network unavailable" };
        }
        if (command === "gh" && args[0] === "pr" && args[1] === "create") {
          pullRequestCreates += 1;
          controller.abort();
          throw new Error("response lost");
        }
        if (command === "git" && args[0] === "push") {
          remoteHead = store.state.mainHead;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command === "git" && args[0] === "ls-remote") {
          const ref = args.at(-1);
          return {
            exitCode: 0,
            stdout:
              ref === `refs/heads/${store.state.baseBranch}`
                ? `${store.state.baseCommit}\t${ref}`
                : remoteHead
                  ? `${remoteHead}\t${ref}`
                  : "",
            stderr: "",
          };
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    });

    await expect(
      delivery.deliver(
        {
          title: "Unknown PR",
          requirements: "Never hide an unknown PR outcome",
          validationCommands: ["npm test"],
          inputGeneration: 0,
        },
        controller.signal,
      ),
    ).rejects.toThrow("Interaction cancellation invalidated");
    expect(pullRequestCreates).toBe(1);
    expect(store.state.phase).toBe("needs_replan");
    expect(store.state.publication.status).toBe("reconcile_required");
    expect(
      store.state.commandLedger.find((entry) => entry.action === "create-pr")
        ?.status,
    ).toBe("unknown");

    const resumed = await resumeChange(source, store.state.id);
    expect(resumed.state.publication.status).toBe("reconcile_required");
    let retryMutations = 0;
    const retry = new ChangeDelivery(
      resumed,
      new ChangeWorkspace(resumed),
      supervisor,
      {
        validationRunner: async () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        commandRunner: async (command, args) => {
          if (command === "git" && args[0] === "ls-remote") {
            const ref = args.at(-1);
            return {
              exitCode: 0,
              stdout: `${resumed.state.baseCommit}\t${ref}`,
              stderr: "",
            };
          }
          if (command === "gh" && args[0] === "auth") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "gh" && args[0] === "pr" && args[1] === "list") {
            return { exitCode: 1, stdout: "", stderr: "network unavailable" };
          }
          retryMutations += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );
    await expect(
      retry.deliver({
        title: "Unknown PR",
        requirements: "Never hide an unknown PR outcome",
        validationCommands: ["npm test"],
        inputGeneration: resumed.state.inputGeneration,
      }),
    ).rejects.toThrow("network unavailable");
    expect(retryMutations).toBe(0);
    expect(resumed.state.publication.status).toBe("reconcile_required");
  });
});
