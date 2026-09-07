import type { CliIo } from "../../cli/types";
import { AgileError } from "../../runtime/errors";
import { getAgentDir, ModelRuntime, SettingsManager } from "./sdk";

const provider = "openai-codex";
const defaultModel = "gpt-5.5";

type SetupServices = {
  models: Pick<
    ModelRuntime,
    "getAuth" | "login" | "getModel" | "completeSimple"
  >;
  settings: Pick<
    SettingsManager,
    | "getDefaultProvider"
    | "getDefaultModel"
    | "setDefaultModelAndProvider"
    | "setDefaultThinkingLevel"
    | "flush"
    | "drainErrors"
  >;
  openBrowser: (url: string) => void;
};

/** Opens the provider's HTTPS login URL with the system browser when available. */
function openBrowser(url: string): void {
  if (new URL(url).protocol !== "https:") throw new Error("Invalid login URL");
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  try {
    const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    child.unref();
  } catch {
    // The terminal also prints the URL for hosts without a desktop browser.
  }
}

/** Connects Codex using Pi's auth flow and saves the default only after a real model response. */
export async function configureCodex(
  io: CliIo,
  cwd: string,
  services?: SetupServices,
): Promise<string> {
  const ask = io.ask;
  if (!ask) throw new Error("Interactive input is required for Codex setup");
  const controller = new AbortController();
  /** Cancels provider authentication and any pending connection check. */
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timeout = setTimeout(cancel, 5 * 60_000);
  try {
    const {
      models,
      settings,
      openBrowser: open,
    } = services ?? {
      models: await ModelRuntime.create(),
      settings: SettingsManager.create(cwd, getAgentDir(), {
        projectTrusted: false,
      }),
      openBrowser,
    };
    if (settings.drainErrors().length)
      throw new Error("Model settings could not be loaded");
    io.out(
      "Connecting Codex. This sends a small test prompt using your model quota.",
    );
    const auth = await models.getAuth(provider).catch(() => undefined);
    if (!auth) {
      io.out(
        "Sign in with your ChatGPT account in the browser. Press Ctrl-C to cancel.",
      );
      await models.login(provider, "oauth", {
        signal: controller.signal,
        prompt: async (prompt) => {
          if (prompt.type === "select") {
            const browser = prompt.options.find(
              (option) => option.id === "browser",
            );
            if (!browser) throw new Error("Codex browser login is unavailable");
            return browser.id;
          }
          if (prompt.type !== "manual_code" && prompt.type !== "text")
            throw new Error("Unsupported Codex login prompt");
          const signal = prompt.signal
            ? AbortSignal.any([controller.signal, prompt.signal])
            : controller.signal;
          signal.throwIfAborted();
          return ask(prompt.message, signal);
        },
        notify: (event) => {
          if (event.type === "auth_url") {
            io.out(`Open this link if the browser does not open: ${event.url}`);
            open(event.url);
          }
        },
      });
    }
    controller.signal.throwIfAborted();
    const selectedId =
      settings.getDefaultProvider() === provider
        ? (settings.getDefaultModel() ?? defaultModel)
        : defaultModel;
    const model = models.getModel(provider, selectedId);
    if (!model?.reasoning || model.thinkingLevelMap?.high === null) {
      throw new Error("Codex model must support high reasoning");
    }
    const result = await models.completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Reply with exactly ROC_OK.",
            timestamp: Date.now(),
          },
        ],
      },
      {
        reasoning: "high",
        maxTokens: 512,
        maxRetries: 0,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(60_000),
        ]),
      },
    );
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    if (result.stopReason !== "stop" || text !== "ROC_OK")
      throw new Error("Codex connection check did not complete");
    controller.signal.throwIfAborted();
    settings.setDefaultModelAndProvider(provider, model.id);
    settings.setDefaultThinkingLevel("high");
    await settings.flush();
    if (settings.drainErrors().length)
      throw new Error("Model settings could not be saved");
    return `${provider}/${model.id}`;
  } catch (cause) {
    throw new AgileError({
      code: "CODEX_SETUP_FAILED",
      category: "startup",
      retryable: true,
      component: "pi-onboard",
      message: controller.signal.aborted
        ? "Codex setup cancelled or timed out. Run onboard to retry."
        : "Could not connect or save Codex settings. Check your connection and account access, then run onboard to retry.",
      cause,
    });
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
