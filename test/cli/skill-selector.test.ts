import { expect, test } from "bun:test";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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

/** Waits for a real terminal interaction to reach the expected state. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  expect(condition()).toBe(true);
}

type TtyInput = PassThrough & {
  isTTY: boolean;
  setRawMode(enabled: boolean): void;
};

type ResizableOutput = PassThrough & {
  isTTY: boolean;
  columns: number;
  rows: number;
};

test("NO_COLOR prompt forwards resize with live dimensions and cleans up", async () => {
  const previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  const input = new PassThrough() as TtyInput;
  input.isTTY = true;
  input.setRawMode = () => {};
  const size = { columns: 80, rows: 24 };
  const observed = { columns: [] as number[], rows: [] as number[] };
  const output = new PassThrough() as ResizableOutput;
  Object.defineProperties(output, {
    isTTY: { get: () => true },
    columns: {
      get: () => {
        observed.columns.push(size.columns);
        return size.columns;
      },
    },
    rows: {
      get: () => {
        observed.rows.push(size.rows);
        return size.rows;
      },
    },
  });
  const selection = selectSkillAllowlist(candidates, undefined, {
    input,
    output,
  });

  try {
    await waitFor(() => output.listenerCount("resize") === 1);
    size.columns = 120;
    size.rows = 35;
    output.emit("resize");
    input.write("\u001B[B");
    await waitFor(
      () => observed.columns.includes(120) && observed.rows.includes(35),
    );
    input.write("\r");
    await expect(selection).resolves.toEqual({
      kind: "selected",
      identities: [{ name: "tdd", source: "mattpocock/skills" }],
    });
    expect(output.listenerCount("resize")).toBe(0);
  } finally {
    input.write("\r");
    await selection.catch(() => {});
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
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
