import { expect, test } from "bun:test";
import { helpText } from "../../src/cli/help";

test("help lists the roc-it commands", () => {
  expect(helpText).toContain(
    "roc-it - run Codex agents through an agile software flow",
  );
  expect(helpText).toContain("roc-it init");
  expect(helpText).toContain("roc-it task list");
  expect(helpText).toContain("roc-it tokens [--db PATH] [--no-color]");
  expect(helpText).toContain(
    "roc-it scheduler run --backend fake --fake-script PATH [--db PATH]",
  );
  expect(helpText).toContain(
    "roc-it scheduler run --backend codex --repo PATH [--base REF] [--db PATH]",
  );
  expect(helpText).toContain("roc-it scheduler inspect [--db PATH]");
  expect(helpText).not.toMatch(/^\s*agile(?:\s|$)/m);
  expect(helpText).not.toContain("--low");
});
