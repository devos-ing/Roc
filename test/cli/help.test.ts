import { expect, test } from "bun:test";
import { helpText } from "../../src/cli/help";

test("help lists the foundation commands", () => {
  expect(helpText).toContain("agile init");
  expect(helpText).toContain("agile task list");
  expect(helpText).not.toContain("--low");
});
