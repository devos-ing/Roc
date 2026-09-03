import { closeSync, readSync, writeSync } from "node:fs";

// Read the handshake without a stream duplicating stdin's descriptor, then
// close the pipe before acknowledging it so the next client write must fail.
const buffer = Buffer.alloc(4096);
let input = "";
while (!input.includes("\n")) {
  const count = readSync(0, buffer);
  if (count === 0) throw new Error("Expected a handshake before stdin EOF");
  input += buffer.subarray(0, count).toString();
}
const message = JSON.parse(input);
closeSync(0);
const response =
  message.method === undefined
    ? {
        id: message.id,
        type: "response",
        command: message.type,
        success: true,
      }
    : { id: message.id, result: {} };
writeSync(1, `${JSON.stringify(response)}\n`);
const exitDelayMs = message.params?.exitDelayMs ?? message.exitDelayMs;
if (exitDelayMs !== undefined) {
  setTimeout(() => process.exit(0), exitDelayMs);
} else {
  // Keep the child alive until the client terminates the broken transport.
  setInterval(() => {}, 1000);
}
