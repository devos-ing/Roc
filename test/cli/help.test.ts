import { expect, test } from "bun:test";
import { runCli } from "../../src/cli/run";

test("help prints only production roc-it commands", async () => {
  const output: string[] = [];
  const errors: string[] = [];

  expect(
    await runCli(["help"], {
      out: (text) => output.push(text),
      err: (text) => errors.push(text),
    }),
  ).toBe(0);
  expect(errors).toEqual([]);
  expect(output).toHaveLength(1);

  const help = output[0]!;
  expect(help).toContain(
    "roc-it - run Codex agents through an agile software flow",
  );
  expect(help).toContain("npx roc-it@latest onboard [--global] [--db PATH]");
  expect(help).toContain("npx roc-it@latest cycle current");
  expect(help).toContain("Show the active Agile cycle.");
  expect(help).toContain("npx roc-it@latest task import FILE [--db PATH]");
  expect(help).toContain("npx roc-it@latest task list [--db PATH]");
  expect(help).toContain("npx roc-it@latest tokens [--db PATH] [--no-color]");
  expect(help).toContain(
    "npx roc-it@latest scheduler run --backend codex --repo PATH [--base REF] [--db PATH]",
  );
  expect(help).toContain("npx roc-it@latest help");
  expect(help).not.toContain("--backend fake");
  expect(help).not.toContain("--fake-script");
  expect(help).not.toContain("scheduler inspect");
  expect(help).not.toContain("roc-it init");
  expect(help).not.toMatch(/^\s*agile(?:\s|$)/m);
  expect(help).not.toContain("--low");
});
