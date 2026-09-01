// Module scope keeps this script's declarations out of the shared fixture
// global namespace; Bun runs it directly as a child process.
export {};

type IncomingMessage = {
  type?: string;
  id?: string;
  message?: string;
  level?: string;
  cancelled?: boolean;
  provider?: string;
  modelId?: string;
};

const sessionId = "sess_fixture_1";
const sessionFile = "/tmp/pi-fixture/sessions/sess_fixture_1.jsonl";

const scoutOutput = {
  kind: "scout",
  summary: "Fixture scout summary",
  files: ["src/a.ts"],
  tests: ["test/a.test.ts"],
  risks: ["fixture risk"],
};

const uiResponses: Record<string, unknown>[] = [];

let keepAlive: ReturnType<typeof setInterval> | undefined;

function write(message: unknown, callback?: () => void): void {
  process.stdout.write(`${JSON.stringify(message)}\n`, callback);
}

function requestId(message: IncomingMessage): string {
  if (message.id === undefined) {
    throw new Error("fixture expected a request id");
  }
  return message.id;
}

function handleMessage(message: IncomingMessage): boolean {
  switch (message.type) {
    case "get_state":
      write({
        id: requestId(message),
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId,
          sessionFile,
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          autoCompactionEnabled: false,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      });
      return true;
    case "set_model":
      write({
        id: requestId(message),
        type: "response",
        command: "set_model",
        success: true,
        data: { provider: message.provider, modelId: message.modelId },
      });
      return true;
    case "set_thinking_level":
      write({
        id: requestId(message),
        type: "response",
        command: "set_thinking_level",
        success: true,
      });
      return true;
    case "prompt": {
      write({
        id: requestId(message),
        type: "response",
        command: "prompt",
        success: true,
      });
      write({ type: "agent_start" });
      write({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify(scoutOutput) }],
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: {
            input: 1000,
            output: 50,
            cacheRead: 400,
            cacheWrite: 0,
            reasoning: 20,
            totalTokens: 1050,
          },
          stopReason: "stop",
          timestamp: "2026-08-31T00:00:00.000Z",
        },
      });
      write({ type: "agent_settled" });
      return true;
    }
    case "abort":
      write({
        id: requestId(message),
        type: "response",
        command: "abort",
        success: true,
      });
      return true;
    case "get_entries":
      write({
        id: requestId(message),
        type: "response",
        command: "get_entries",
        success: true,
        data: { entries: [], leafId: "entry_fixture_3" },
      });
      return true;
    case "fixture/echoCwd":
      write({
        id: requestId(message),
        type: "response",
        command: "fixture/echoCwd",
        success: true,
        data: { cwd: process.cwd() },
      });
      return true;
    case "fixture/rpcError":
      write({
        id: requestId(message),
        type: "response",
        command: "fixture/rpcError",
        success: false,
        error: "provider failure detail pi-secret-sentinel-3f9c",
      });
      return true;
    case "fixture/emitUiRequest":
      write({
        id: requestId(message),
        type: "response",
        command: "fixture/emitUiRequest",
        success: true,
      });
      write({
        type: "extension_ui_request",
        id: "ui-fixture-1",
        method: "confirm",
        title: "Allow this action?",
      });
      return true;
    case "fixture/uiResponses":
      write({
        id: requestId(message),
        type: "response",
        command: "fixture/uiResponses",
        success: true,
        data: { responses: uiResponses },
      });
      return true;
    case "fixture/exit":
      write(
        {
          id: requestId(message),
          type: "response",
          command: "fixture/exit",
          success: true,
        },
        () => process.exit(0),
      );
      return false;
    default:
      throw new Error(
        `fixture received an unexpected message: ${message.type}`,
      );
  }
}

async function main(): Promise<void> {
  keepAlive = setInterval(() => {}, 1000);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(line);
        } catch {
          throw new Error("fixture received invalid JSON");
        }
        const asRecord = decoded as {
          type?: unknown;
          id?: unknown;
          cancelled?: unknown;
        };
        // An extension UI response arrives as
        // {type:"extension_ui_response", id, cancelled} with no command.
        if (asRecord.type === "extension_ui_response") {
          uiResponses.push({
            id: asRecord.id,
            cancelled: asRecord.cancelled,
          });
          continue;
        }
        handleMessage(decoded as IncomingMessage);
      }
      newline = buffer.indexOf("\n");
    }
  }
  if (keepAlive !== undefined) clearInterval(keepAlive);
}

void main();
