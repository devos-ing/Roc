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
    installed: true,
    initiallySelected: true,
  },
  {
    identity: { name: "unslop", source: "backnotprop/pstack" },
    installed: false,
    initiallySelected: false,
  },
];

test("maps defaults and missing unslop into one optional multiselect", () => {
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
        value: '["backnotprop/pstack","unslop"]',
        label: "unslop",
        hint: "pstack · Not installed",
        disabled: true,
      },
    ],
  });
});

test("returns exact identities and permits an empty selection", async () => {
  const selected = await selectSkillAllowlist(candidates, async () => [
    '["mattpocock/skills","tdd"]',
  ]);
  expect(selected).toEqual({
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

test("filters a disabled missing unslop value from the selection", async () => {
  await expect(
    selectSkillAllowlist(candidates, async () => [
      '["backnotprop/pstack","unslop"]',
    ]),
  ).resolves.toEqual({ kind: "selected", identities: [] });
});

test("returns every selected installed candidate without a cap", async () => {
  const installedCandidates = [
    ...candidates.slice(0, 1),
    {
      identity: { name: "ponytail", source: "dietrichgebert/ponytail" },
      installed: true,
      initiallySelected: false,
    },
    {
      identity: { name: "i-have-adhd", source: "ayghri/i-have-adhd" },
      installed: true,
      initiallySelected: false,
    },
  ];
  await expect(
    selectSkillAllowlist(installedCandidates, async () => [
      '["mattpocock/skills","tdd"]',
      '["dietrichgebert/ponytail","ponytail"]',
      '["ayghri/i-have-adhd","i-have-adhd"]',
    ]),
  ).resolves.toEqual({
    kind: "selected",
    identities: [
      { name: "tdd", source: "mattpocock/skills" },
      { name: "ponytail", source: "dietrichgebert/ponytail" },
      { name: "i-have-adhd", source: "ayghri/i-have-adhd" },
    ],
  });
});

test("normalizes Ctrl-C without terminating the host process", async () => {
  const result = await selectSkillAllowlist(candidates, async () =>
    Symbol.for("clack:cancel"),
  );
  expect(result).toEqual({ kind: "cancelled" });
});

/** Runs the Clack fixture with an isolated color environment. */
async function renderFixture(color: boolean): Promise<string> {
  const env = { ...process.env };
  if (color) {
    delete env.NO_COLOR;
    env.FORCE_COLOR = "1";
  } else {
    env.NO_COLOR = "1";
    delete env.FORCE_COLOR;
  }
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

test("renders color and honors NO_COLOR", async () => {
  const colored = await renderFixture(true);
  const plain = await renderFixture(false);
  const ansiSgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);
  expect(colored).toMatch(ansiSgr);
  expect(colored).toContain("\u001B[32m");
  expect(colored).toContain("\u001B[36m◻\u001B[39m focus");
  expect(colored).toContain("\u001B[2m");
  expect(colored).toContain("focus");
  expect(plain).not.toMatch(ansiSgr);
  expect(plain).toContain("tdd");
  expect(plain).toContain("focus");
  expect(plain).toContain("unslop");
  expect(plain).toContain("Not installed");
});
