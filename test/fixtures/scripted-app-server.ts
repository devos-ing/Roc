type RpcId = string | number;

type IncomingMessage = {
  method?: string;
  id?: RpcId;
  params?: unknown;
};

let sawInitialize = false;
let initializedCount = 0;

function write(message: unknown, callback?: () => void): void {
  process.stdout.write(`${JSON.stringify(message)}\n`, callback);
}

function requestId(message: IncomingMessage): RpcId {
  if (message.id === undefined) {
    throw new Error("fixture expected a request id");
  }
  return message.id;
}

function handleMessage(message: IncomingMessage): boolean {
  if (!sawInitialize) {
    if (message.method !== "initialize") {
      throw new Error("fixture expected initialize first");
    }
    sawInitialize = true;
    write({ id: requestId(message), result: { serverInfo: { name: "scripted-fixture" } } });
    return true;
  }

  switch (message.method) {
    case "initialized":
      initializedCount += 1;
      if (initializedCount !== 1) {
        throw new Error("fixture received initialized more than once");
      }
      write({ method: "warning", params: { message: "scripted fixture warning" } });
      return true;
    case "model/list":
      if (initializedCount !== 1) {
        throw new Error("fixture expected initialized before model/list");
      }
      write({
        id: requestId(message),
        result: {
          data: [{
            id: "gpt-5.6-terra",
            hidden: false,
            supportedReasoningEfforts: [{
              reasoningEffort: "high",
              description: "default",
            }],
          }],
          nextCursor: null,
        },
      });
      return true;
    case "fixture/exit":
      write({ id: requestId(message), result: {} }, () => process.exit(0));
      return false;
    case "fixture/modelUnavailable":
      write({
        id: requestId(message),
        error: {
          code: -32602,
          message: "provider detail must stay private",
          data: {
            message: "model gpt-next was not found",
            codexErrorInfo: "badRequest",
          },
        },
      });
      return true;
    default:
      throw new Error("fixture received an unexpected method");
  }
}

async function main(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0 && !handleMessage(JSON.parse(line) as IncomingMessage)) {
        return;
      }
      newline = buffer.indexOf("\n");
    }
  }
}

void main().catch(() => {
  process.stderr.write("scripted app-server fixture failed\n");
  process.exit(1);
});
