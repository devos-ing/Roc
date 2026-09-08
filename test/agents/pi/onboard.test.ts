import { expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCodex } from "../../../src/agents/pi/onboard";
import { ModelRuntime, SettingsManager } from "../../../src/agents/pi/sdk";

type Services = NonNullable<Parameters<typeof configureCodex>[2]>;

/** Uses the installed model catalog with isolated settings and deterministic provider responses. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "roc-model-setup-"));
  const catalog = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"),
  });
  const settings = SettingsManager.inMemory({
    defaultProvider: "anthropic",
    defaultModel: "prior",
    theme: "dark",
  });
  let authenticated = false;
  const browser = mock((_url: string) => {});
  const login = mock<Services["models"]["login"]>(
    async (_provider, _type, interaction) => {
      expect(
        await interaction.prompt({
          type: "select",
          message: "Choose login",
          options: [
            { id: "browser", label: "Browser" },
            { id: "device_code", label: "Device code" },
          ],
        }),
      ).toBe("browser");
      interaction.notify({
        type: "auth_url",
        url: "https://example.com/login",
      });
      const callback = new AbortController();
      const manual = interaction.prompt({
        type: "manual_code",
        message: "Browser or paste",
        signal: callback.signal,
      });
      callback.abort();
      await expect(manual).rejects.toThrow();
      authenticated = true;
      return {
        type: "oauth",
        access: "fixture",
        refresh: "fixture",
        expires: Date.now() + 60_000,
      };
    },
  );
  const complete = mock<Services["models"]["completeSimple"]>(
    async (model) => ({
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "ROC_OK" }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }),
  );
  const services: Services = {
    settings,
    openBrowser: browser,
    models: {
      getAuth: async () =>
        authenticated ? { auth: { apiKey: "fixture" } } : undefined,
      login,
      getModel: (provider, id) => catalog.getModel(provider, id),
      completeSimple: complete,
    },
  };
  const output: string[] = [];
  const io = {
    out: (text: string) => output.push(text),
    err: () => {},
    ask: async (_question: string, signal?: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) reject(new Error("cancelled"));
        else
          signal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
      }),
  };
  return {
    root,
    services,
    settings,
    login,
    complete,
    browser,
    io,
    output,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("browser login verifies Codex before saving defaults and reuses credentials on rerun", async () => {
  const f = await setup();
  try {
    expect(await configureCodex(f.io, f.root, f.services)).toBe(
      "openai-codex/gpt-5.5",
    );
    expect(f.settings.getDefaultProvider()).toBe("openai-codex");
    expect(f.settings.getDefaultModel()).toBe("gpt-5.5");
    expect(f.settings.getDefaultThinkingLevel()).toBe("high");
    expect(f.settings.getTheme()).toBe("dark");
    expect(f.browser).toHaveBeenCalledWith("https://example.com/login");
    expect(f.complete.mock.calls[0]?.[2]).toMatchObject({
      reasoning: "high",
      maxRetries: 0,
    });
    expect(await configureCodex(f.io, f.root, f.services)).toBe(
      "openai-codex/gpt-5.5",
    );
    expect(f.login).toHaveBeenCalledTimes(1);
    expect(f.complete).toHaveBeenCalledTimes(2);
  } finally {
    await f.cleanup();
  }
});

test("failed model response preserves previous defaults and hides provider secrets", async () => {
  const f = await setup();
  f.complete.mockImplementation(async () => {
    throw new Error("secret-access-token");
  });
  try {
    await expect(
      configureCodex(f.io, f.root, f.services),
    ).rejects.toMatchObject({ code: "CODEX_SETUP_FAILED" });
    expect(f.settings.getDefaultProvider()).toBe("anthropic");
    expect(f.settings.getDefaultModel()).toBe("prior");
    expect(f.output.join("\n")).not.toContain("secret-access-token");
  } finally {
    await f.cleanup();
  }
});

test("cancelling authentication restores signal handlers and never calls the model", async () => {
  const f = await setup();
  const listeners = process.listenerCount("SIGINT");
  f.login.mockImplementation(async (_provider, _type, interaction) => {
    process.emit("SIGINT");
    interaction.signal?.throwIfAborted();
    throw new Error("expected cancellation");
  });
  try {
    await expect(configureCodex(f.io, f.root, f.services)).rejects.toThrow(
      "cancelled",
    );
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.settings.getDefaultProvider()).toBe("anthropic");
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  } finally {
    await f.cleanup();
  }
});

test("a settings write failure is not reported as a successful connection", async () => {
  const f = await setup();
  f.services.settings = {
    ...f.services.settings,
    getDefaultProvider: () => undefined,
    getDefaultModel: () => undefined,
    setDefaultModelAndProvider: () => {},
    setDefaultThinkingLevel: () => {},
    flush: async () => {
      throw new Error("disk full");
    },
    drainErrors: () => [],
  };
  try {
    await expect(
      configureCodex(f.io, f.root, f.services),
    ).rejects.toMatchObject({ code: "CODEX_SETUP_FAILED" });
  } finally {
    await f.cleanup();
  }
});
