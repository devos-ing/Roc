import { expect, test } from "bun:test";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  buildSkillPromptConfig,
  selectSkillAllowlist,
} from "../../src/cli/skill-selector";

const candidates = [
  {
    identity: { name: "tdd", source: "mattpocock/skills" },
    initiallySelected: true,
  },
  {
    identity: { name: "i-have-adhd:focus", source: "ayghri/i-have-adhd" },
    initiallySelected: false,
  },
];

test("maps trusted installed skills into one optional multiselect", () => {
  const config = buildSkillPromptConfig(candidates);
  expect({
    ...config,
    options: config.options.map((option) => ({
      ...option,
      hint: stripVTControlCharacters(option.hint),
    })),
  }).toMatchObject({
    message: "Use Roc's default skill allowlist?",
    required: false,
    initialValues: ['["mattpocock/skills","tdd"]'],
    options: [
      {
        value: '["mattpocock/skills","tdd"]',
        label: "tdd",
        hint: "mattpocock/skills",
        disabled: false,
      },
      {
        value: '["ayghri/i-have-adhd","i-have-adhd:focus"]',
        label: "i-have-adhd:focus",
        hint: "ayghri/i-have-adhd",
        disabled: false,
      },
    ],
  });
});

test("returns exact identities and permits an empty selection", async () => {
  await expect(
    selectSkillAllowlist(candidates, async () => [
      '["mattpocock/skills","tdd"]',
    ]),
  ).resolves.toEqual({
    kind: "selected",
    identities: [{ name: "tdd", source: "mattpocock/skills" }],
  });
  await expect(
    selectSkillAllowlist(candidates, async () => []),
  ).resolves.toEqual({
    kind: "selected",
    identities: [],
  });
});

test("ignores a selection outside the trusted candidates", async () => {
  await expect(
    selectSkillAllowlist(candidates, async () => [
      '["backnotprop/pstack","unslop"]',
      '["dietrichgebert/ponytail","ponytail:ponytail"]',
    ]),
  ).resolves.toEqual({ kind: "selected", identities: [] });
});

test("normalizes Ctrl-C without terminating the host process", async () => {
  const result = await selectSkillAllowlist(candidates, async () =>
    Symbol.for("clack:cancel"),
  );
  expect(result).toEqual({ kind: "cancelled" });
});

/** Runs the Clack fixture with an isolated color environment. */
async function renderFixture(): Promise<string> {
  const env = { ...process.env, FORCE_COLOR: "1" };
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "..", "fixtures", "skill-selector-runner.ts"),
    ],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return stdout;
}

test("renders colored onboarding and keyboard selectors", async () => {
  const colored = await renderFixture();
  const plain = stripVTControlCharacters(colored);
  const ansiSgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);
  expect(colored).toMatch(ansiSgr);
  expect(colored).toContain("\u001B[32m");
  expect(colored).toContain("\u001B[36m◻\u001B[39m i-have-adhd:focus");
  expect(colored).toContain("\u001B[2m");
  expect(plain).not.toMatch(ansiSgr);
  expect(plain).toContain("tdd");
  expect(plain).toContain("focus");
  expect(colored).toContain("Welcome to Roc");
  expect(plain).toContain("Welcome to Roc");
  expect(plain).toContain("Choose your Agile cycle");
  expect(plain).toContain("Result: Complete");
});
