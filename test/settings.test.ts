import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRocSettings, saveRocSettings } from "../src/settings";

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
  await expect(loadRocSettings(homeRoot)).rejects.toThrow(
    "Run npx roc-it@latest onboard",
  );
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
