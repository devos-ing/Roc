import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { selectAgileCycle } from "../../src/cli/cycle-selector";

test.each([
  { name: "default", initial: undefined, keys: "\r", expected: "weekly" },
  {
    name: "saved cycle",
    initial: "daily" as const,
    keys: "\r",
    expected: "daily",
  },
  {
    name: "arrow navigation",
    initial: undefined,
    keys: "\u001b[B\r",
    expected: "custom",
  },
  {
    name: "cancellation",
    initial: undefined,
    keys: "\u0003",
    expected: undefined,
  },
])("cycle selector handles $name", async ({ initial, keys, expected }) => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(enabled: boolean) {
      this.isRaw = enabled;
      return this;
    },
  });
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk) => {
    transcript += chunk.toString();
  });
  const selection = selectAgileCycle(initial, { input, output });
  try {
    for (let attempt = 0; !input.isRaw && attempt < 40; attempt++)
      await Bun.sleep(5);
    expect(input.isRaw).toBe(true);
    for (const key of keys === "\u001b[B\r" ? ["\u001b[B", "\r"] : [keys]) {
      input.write(key);
      await Bun.sleep(5);
    }
    expect(await selection).toBe(expected);
    expect(transcript).toContain("Daily");
    expect(transcript).toContain("Weekly");
    expect(transcript).toContain("Custom");
    expect(input.isRaw).toBe(false);
  } finally {
    input.write("\u0003");
    await selection;
    input.destroy();
    output.destroy();
  }
});
