import { expect, test } from "bun:test";
import { runCli } from "../../src/cli/run";

test("empty arguments and help print the same production-only journey guide", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const emptyOutput: string[] = [];
  const emptyErrors: string[] = [];

  expect(
    await runCli(["help"], {
      out: (text) => output.push(text),
      err: (text) => errors.push(text),
    }),
  ).toBe(0);
  expect(
    await runCli([], {
      out: (text) => emptyOutput.push(text),
      err: (text) => emptyErrors.push(text),
    }),
  ).toBe(0);
  expect(errors).toEqual([]);
  expect(emptyErrors).toEqual([]);
  expect(output).toHaveLength(1);
  expect(emptyOutput).toEqual(output);

  const help = output[0]!;
  expect(help).toContain(
    "roc-it - run Codex agents through an agile software flow",
  );
  expect(help).toContain("Get started:");
  expect(help).toContain("Manage your cycle:");
  expect(help).toContain("Plan work:");
  expect(help).toContain("Run work:");
  expect(help).toContain("Get help:");
  expect(help).toContain("npx roc-it@latest onboard [--global] [--db PATH]");
  expect(help).toContain("Set up Roc, its skills, and your Agile cycle.");
  expect(help).toContain("npx roc-it@latest cycle current");
  expect(help).toContain("Show the current Agile cycle.");
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
  expect(help).toMatch(/Next:\n {2}npx roc-it@latest onboard$/);
});
