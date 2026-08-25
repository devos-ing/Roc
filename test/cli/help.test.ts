import { expect, test } from "bun:test";
import { helpText } from "../../src/cli/help";

test("help lists the foundation commands", () => {
  expect(helpText).toContain("agile init");
  expect(helpText).toContain("agile task list");
  expect(helpText).toContain("agile scheduler run --backend fake --fake-script PATH [--db PATH]");
  expect(helpText).toContain("agile scheduler run --backend codex --repo PATH [--base REF] [--db PATH]");
  expect(helpText).toContain("agile scheduler inspect [--db PATH]");
  expect(helpText).not.toContain("--low");
});
