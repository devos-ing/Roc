import { expect, test } from "bun:test";
import { runCli } from "../../src/cli/run";

/** Runs one help form and captures its public output. */
async function helpFor(args: string[]): Promise<string> {
  const output: string[] = [];
  const errors: string[] = [];
  expect(
    await runCli(args, {
      out: (text) => output.push(text),
      err: (text) => errors.push(text),
    }),
  ).toBe(0);
  expect(errors).toEqual([]);
  expect(output).toHaveLength(1);
  return output.at(0) ?? "";
}

test("empty arguments, help, and --help describe the public command tree", async () => {
  const help = await helpFor([]);
  expect(await helpFor(["help"])).toBe(help);
  expect(await helpFor(["--help"])).toBe(help);

  expect(help).toContain("Usage: roc-it");
  expect(help).toContain("onboard");
  expect(help).toContain("cycle");
  expect(help).toContain("task");
  expect(help).toContain("tokens");
  expect(help).toContain("tui");
  expect(help).toContain("scheduler");
  expect(help).not.toContain("--db");
  expect(help).not.toContain("--repo");
  expect(help).not.toContain("--backend");
  expect(help).not.toContain("--fake-script");
});

test("task help exposes the board and its all-cycles option", async () => {
  const help = await helpFor(["task", "--help"]);

  expect(help).toContain("board");
  expect(await helpFor(["task", "board", "--help"])).toContain("--all");
});
