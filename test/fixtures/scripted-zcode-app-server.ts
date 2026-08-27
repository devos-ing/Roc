// Module scope keeps this script's declarations out of the shared fixture
// global namespace; Bun runs it directly as a child process.
export {};

type RpcId = string | number;

type IncomingMessage = {
  method?: string;
  id?: RpcId;
  params?: {
    sessionId?: string;
    content?: string;
    workspace?: { workspacePath?: string };
  };
};

let sawCreate = false;
let preferencesAnswered = false;
let pendingCreateId: RpcId | undefined;
let keepAlive: ReturnType<typeof setInterval> | undefined;

function write(message: unknown, callback?: () => void): void {
  process.stdout.write(`${JSON.stringify(message)}\n`, callback);
}

function requestId(message: IncomingMessage): RpcId {
  if (message.id === undefined) {
    throw new Error("fixture expected a request id");
  }
  return message.id;
}

const sessionId = "sess_fixture_1";

const scoutOutput = {
  kind: "scout",
  summary: "Fixture scout summary",
  files: ["src/a.ts"],
  tests: ["test/a.test.ts"],
  risks: ["fixture risk"],
};

function handleMessage(message: IncomingMessage): boolean {
  switch (message.method) {
    case "session/create":
      if (sawCreate) {
        throw new Error("fixture received session/create more than once");
      }
      sawCreate = true;
      pendingCreateId = requestId(message);
      write({
        id: "server-1",
        method: "session/requestRuntimePreferences",
        params: { sessionId, scope: "runtime-materialization" },
      });
      return true;
    case "session/subscribe":
      write({ id: requestId(message), result: { sessionId, eventSeq: 0 } });
      return true;
    case "session/send": {
      if (!preferencesAnswered) {
        throw new Error("fixture expected the preferences handshake first");
      }
      write({ id: requestId(message), result: { accepted: true } });
      write({
        method: "session/event",
        params: {
          sessionId,
          type: "turn.completed",
          payload: {
            response: JSON.stringify(scoutOutput),
            usage: {
              inputTokens: 1000,
              outputTokens: 50,
              reasoningTokens: 20,
              cacheReadTokens: 400,
              cacheWriteTokens: 0,
            },
            resultType: "success",
            toolCallCount: 0,
          },
        },
      });
      return true;
    }
    case "fixture/exit":
      write({ id: requestId(message), result: {} }, () => process.exit(0));
      return false;
    default:
      throw new Error(
        `fixture received an unexpected message: ${message.method}`,
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
        // A response to the server-initiated preferences request arrives as
        // {id:"server-1", result:{...}} with no method field.
        const asRecord = decoded as { method?: unknown; id?: unknown };
        if (asRecord.method === undefined && asRecord.id === "server-1") {
          preferencesAnswered = true;
          if (pendingCreateId !== undefined) {
            write({ id: pendingCreateId, result: { session: { sessionId } } });
            pendingCreateId = undefined;
          }
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
