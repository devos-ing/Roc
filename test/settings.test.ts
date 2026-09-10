import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RocSettingsSchema } from "../src/domain/agile-cycle";
import { AgileError } from "../src/runtime/errors";
import {
  loadRocSettings,
  loadRocSettingsIfPresent,
  rocSettingsPath,
  saveRocSettings,
} from "../src/settings";

test("round-trips optional profile mappings and rejects malformed configuration", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "roc-model-settings-"));
  const settings = {
    cycle: { type: "weekly" as const },
    models: { luna: "openai-codex/gpt-5.6-luna" },
    efforts: { implement: "xhigh" as const },
  };
  await saveRocSettings(settings, homeRoot);
  expect(await loadRocSettings(homeRoot)).toEqual(settings);
  for (const models of [
    { scout: "provider/model" },
    { luna: "model" },
    { luna: "provider/" },
    { luna: "provider/model\nsecret" },
  ]) {
    expect(
      RocSettingsSchema.safeParse({ cycle: { type: "weekly" }, models })
        .success,
    ).toBe(false);
  }
  for (const efforts of [
    { coder: "high" },
    { implement: "low" },
    { implement: "max" },
    { scout: "medium", review: "secret-effort" },
    "high",
  ]) {
    expect(
      RocSettingsSchema.safeParse({ cycle: { type: "weekly" }, efforts })
        .success,
    ).toBe(false);
  }
});

test("rejects malformed efforts with bounded diagnostics", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "roc-effort-settings-"));
  await saveRocSettings({ cycle: { type: "weekly" } }, homeRoot);
  const path = rocSettingsPath(homeRoot);

  for (const [source, expected] of [
    [
      '{"cycle":{"type":"weekly"},"efforts":{"implementer":"secret-effort"}}',
      "Unsupported fields: 1 other field name(s) hidden.",
    ],
    [
      '{"cycle":{"type":"weekly"},"efforts":{"implement":"ultra-secret"}}',
      "Invalid settings data; check the supported settings types and structure.",
    ],
  ] as const) {
    await writeFile(path, source);
    const error = await loadRocSettings(homeRoot).then(
      () => undefined,
      (failure: AgileError) => failure,
    );
    expect(error).toBeInstanceOf(AgileError);
    expect(error?.message).toContain(expected);
    expect(error?.message).not.toContain("secret");
  }
});

test("saves and loads strict global settings", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "roc-settings-"));
  const path = await saveRocSettings(
    { cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" } },
    homeRoot,
  );

  expect(path).toBe(
    join(await realpath(homeRoot), ".config", "roc", "settings.json"),
  );
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" },
  });
  expect(await loadRocSettings(homeRoot)).toEqual({
    cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" },
  });

  await writeFile(
    path,
    '{"cycle":{"type":"custom","days":0,"anchorDate":"2026-08-28"}}',
  );
  await expect(loadRocSettings(homeRoot)).rejects.toThrow("Invalid cycle data");
});

test("refuses a symbolic-link settings directory", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "roc-settings-home-"));
  const outside = await mkdtemp(join(tmpdir(), "roc-settings-outside-"));
  await mkdir(join(homeRoot, ".config"));
  await symlink(outside, join(homeRoot, ".config", "roc"));

  await expect(
    saveRocSettings({ cycle: { type: "weekly" } }, homeRoot),
  ).rejects.toThrow("symbolic link");
});

test("preserves legacy settings and exact skill selections", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "roc-settings-skills-"));

  await saveRocSettings({ cycle: { type: "weekly" } }, homeRoot);
  expect(await loadRocSettings(homeRoot)).toEqual({
    cycle: { type: "weekly" },
  });

  await saveRocSettings(
    {
      cycle: { type: "weekly" },
      skills: {
        allowlist: [
          { name: "grilling", source: "mattpocock/skills" },
          { name: "unslop", source: "backnotprop/pstack" },
        ],
      },
    },
    homeRoot,
  );
  expect(await loadRocSettings(homeRoot)).toMatchObject({
    skills: {
      allowlist: [
        { name: "grilling", source: "mattpocock/skills" },
        { name: "unslop", source: "backnotprop/pstack" },
      ],
    },
  });

  await saveRocSettings(
    { cycle: { type: "weekly" }, skills: { allowlist: [] } },
    homeRoot,
  );
  expect((await loadRocSettings(homeRoot)).skills?.allowlist).toEqual([]);
});

test("loads repeat-onboarding settings only when present", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "roc-settings-optional-"));
  expect(await loadRocSettingsIfPresent(homeRoot)).toBeUndefined();

  await saveRocSettings({ cycle: { type: "weekly" } }, homeRoot);
  await writeFile(
    rocSettingsPath(homeRoot),
    '{"cycle":{"type":"weekly"},"skills":{"allowlist":[{"name":"","source":"backnotprop/pstack"}]}}',
  );
  await expect(loadRocSettingsIfPresent(homeRoot)).rejects.toThrow(
    "Invalid settings data",
  );
});

test("missing settings recommend onboarding with stable error metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-settings-missing-"));
  try {
    expect(await loadRocSettingsIfPresent(home)).toBeUndefined();
    await expect(loadRocSettings(home)).rejects.toMatchObject({
      code: "ROC_SETTINGS_INVALID",
      category: "startup",
      retryable: false,
      component: "settings",
      message: `Roc settings at ${rocSettingsPath(home)}: Settings file is missing. Run npx roc-it@latest onboard to configure an Agile cycle`,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("invalid settings give bounded, secret-safe repair guidance without changing bytes", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-settings-diagnostics-"));
  const secret = "SECRET_VALUE_DO_NOT_PRINT";
  const secretKey = "SECRET_KEY_DO_NOT_PRINT";
  const cases = [
    { source: `{"${secretKey}":"${secret}",`, diagnostic: "Invalid JSON." },
    {
      source: JSON.stringify({ cycle: { type: "weekly" }, type: secret }),
      diagnostic: "Unsupported fields: type.",
    },
    {
      source: JSON.stringify({
        cycle: { type: "weekly" },
        models: { models: secret },
      }),
      diagnostic: "Unsupported fields: models.",
    },
    {
      source: JSON.stringify({
        cycle: { type: "custom", days: 0, anchorDate: "2026-02-30" },
      }),
      diagnostic: "Invalid cycle data",
    },
    {
      source: JSON.stringify({ cycle: { type: secret } }),
      diagnostic: "Invalid cycle data",
    },
    {
      source: JSON.stringify({
        cycle: { type: "custom", days: 1, anchorDate: secret },
      }),
      diagnostic: "Invalid settings data; check cycle data",
    },
    {
      source: JSON.stringify({
        cycle: { type: "weekly" },
        execution: { allowUnsandboxed: secret },
      }),
      diagnostic: "Invalid settings data",
    },
    {
      source: JSON.stringify({
        cycle: { type: "weekly" },
        skills: {
          allowlist: [{ name: "", source: secret, [secretKey]: secret }],
        },
      }),
      diagnostic:
        "Unsupported fields: 1 other field name(s) hidden. Invalid settings data",
    },
    {
      source: JSON.stringify({
        cycle: { type: "weekly" },
        models: { [secretKey]: secret, luna: secret },
      }),
      diagnostic:
        "Unsupported fields: 1 other field name(s) hidden. Invalid settings data",
    },
    {
      source: JSON.stringify({
        cycle: { type: "weekly" },
        type: secret,
        days: secret,
        anchorDate: secret,
        allowlist: secret,
        ...Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [
            `${secretKey}_${index}`,
            secret,
          ]),
        ),
      }),
      diagnostic:
        "Unsupported fields: allowlist, anchorDate, days, 101 other field name(s) hidden.",
    },
  ];
  try {
    const path = await saveRocSettings({ cycle: { type: "weekly" } }, home);
    for (const { source, diagnostic } of cases) {
      const bytes = Buffer.from(` \n${source}\n`);
      await writeFile(path, bytes);
      for (const load of [loadRocSettings, loadRocSettingsIfPresent]) {
        const error = await load(home).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(AgileError);
        if (!(error instanceof AgileError))
          throw new Error("Expected settings error");
        expect(error.code).toBe("ROC_SETTINGS_INVALID");
        expect(error.message).toContain(rocSettingsPath(home));
        expect(error.message).toContain(diagnostic);
        expect(error.message).toContain(
          "Back up this file, then repair it manually",
        );
        expect(error.message).toContain(
          "onboarding reads the same file and cannot repair it",
        );
        expect(error.message).not.toContain("Run npx roc-it@latest onboard");
        expect(error.message).not.toContain("Settings file is missing");
        expect(error.message.length).toBeLessThan(path.length + 600);
        expect(Bun.inspect(error)).not.toContain(secret);
        expect(Bun.inspect(error)).not.toContain(secretKey);
        expect(error.cause).toBeUndefined();
        expect(await readFile(path)).toEqual(bytes);
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("both loaders reject unreadable settings with file and permission checks", async () => {
  const home = await mkdtemp(join(tmpdir(), "roc-settings-read-failure-"));
  const path = rocSettingsPath(home);
  try {
    // A directory fails deterministically even when tests have elevated privileges.
    await mkdir(path, { recursive: true });
    for (const load of [loadRocSettings, loadRocSettingsIfPresent]) {
      const error = await load(home).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AgileError);
      if (!(error instanceof AgileError))
        throw new Error("Expected settings error");
      expect(error.code).toBe("ROC_SETTINGS_INVALID");
      expect(error.message).toContain(path);
      expect(error.message).toContain("Could not read settings");
      expect(error.message).toContain("regular file");
      expect(error.message).toContain("permissions");
      expect(error.message).not.toContain("onboard");
      expect(error.message).not.toContain("EISDIR");
      expect(error.cause).toBeUndefined();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
