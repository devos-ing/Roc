import { existsSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const root = process.argv[2];
if (root === undefined) throw new Error("expected test-owned repository");
const trigger = join(root, "allow-late-write");
const checkout = `${root}.agile-checkout`;
let armed = false;

// The watcher intentionally survives stdin EOF; the real client's close must kill this child.
watch(root, () => {
  if (armed && existsSync(trigger)) {
    armed = false;
    writeFileSync(
      join(checkout, "late-child-write.txt"),
      "old child wrote after session return\n",
    );
  }
});
process.on("SIGTERM", () => {});
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as { id?: number; method: string };
  if (message.method === "fixture/arm") armed = true;
  if (message.id !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { pid: process.pid, armed } })}\n`,
    );
  }
});
