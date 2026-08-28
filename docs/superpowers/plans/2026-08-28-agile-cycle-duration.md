# Configurable Agile Cycles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select a global Daily, Weekly, or Custom Agile cycle during onboarding and use that cycle consistently for task creation, persistence, and token reporting.

**Architecture:** Two plain modules own the behavior: `agile-cycle.ts` validates settings and calculates cycle windows, while `settings.ts` safely persists the global JSON file. Existing Week domain and SQLite names are renamed to Cycle through one data-preserving migration, and all consumers use the same `activeAgileCycle` function through the CLI.

**Tech Stack:** Bun, TypeScript, Zod, `bun:sqlite`, Node standard-library path/filesystem/readline APIs, Biome, Bun test.

---

## File map

- Create `src/domain/agile-cycle.ts`: setting schema and pure calendar logic.
- Create `src/settings.ts`: safe global settings path, load, and save functions.
- Create `test/domain/agile-cycle.test.ts`: Daily, Weekly, and Custom boundaries.
- Create `test/settings.test.ts`: settings persistence and validation boundaries.
- Modify `src/cli/main.ts`: production readline prompt.
- Modify `src/cli/run.ts`: onboarding prompt, `cycle current`, and configured token lookup.
- Modify `src/cli/help.ts`: production help for `cycle current`.
- Modify `src/domain/schemas.ts`: Cycle names and `cycleId` contracts.
- Modify `src/store/migrations.ts`: schema version 4 rename migration.
- Modify `src/store/planning-repository.ts`: Cycle planning and manifest import.
- Modify `src/store/orchestration-repository.ts`: Cycle fields, usage, and inspection.
- Modify `src/artifacts/writer.ts`, scheduler/harness code, and their tests: exact `weekId` to `cycleId` field rename.
- Modify `src/cli/token-chart.ts`: Cycle labels; move ISO week calculation to the cycle module.
- Modify `skills/roc-create-tasks/SKILL.md`: resolve `cycleId` through Roc.
- Modify `README.md`, `README.zh-HK.md`, `CONTEXT.md`, and `docs/architecture.md`: user and current-system documentation.

### Task 1: AC-01 — Calculate and store Agile cycles

**Files:**
- Create: `src/domain/agile-cycle.ts`
- Create: `src/settings.ts`
- Create: `test/domain/agile-cycle.test.ts`
- Create: `test/settings.test.ts`
- Reuse: `src/runtime/safe-file.ts`

- [ ] **Step 1: Write the failing cycle calculation test**

```typescript
import { describe, expect, test } from "bun:test";
import { activeAgileCycle } from "../../src/domain/agile-cycle";

describe("activeAgileCycle", () => {
  test("uses local calendar days", () => {
    expect(
      activeAgileCycle({ type: "daily" }, new Date(2026, 7, 28, 23, 59)),
    ).toEqual({
      id: "2026-08-28",
      startDate: "2026-08-28",
      endDate: "2026-08-28",
    });
  });

  test("uses Monday through Sunday ISO weeks", () => {
    expect(
      activeAgileCycle({ type: "weekly" }, new Date(2026, 7, 31, 12)),
    ).toEqual({
      id: "2026-W36",
      startDate: "2026-08-31",
      endDate: "2026-09-06",
    });
  });

  test("advances at a custom duration boundary", () => {
    expect(
      activeAgileCycle(
        { type: "custom", days: 14, anchorDate: "2026-08-01" },
        new Date(2026, 7, 15, 12),
      ),
    ).toEqual({
      id: "2026-08-15-P14D",
      startDate: "2026-08-15",
      endDate: "2026-08-28",
    });
  });

  test("rejects dates before a custom anchor", () => {
    expect(() =>
      activeAgileCycle(
        { type: "custom", days: 14, anchorDate: "2026-08-15" },
        new Date(2026, 7, 14, 12),
      ),
    ).toThrow("Current date is before the custom cycle anchor");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bun test test/domain/agile-cycle.test.ts`

Expected: FAIL because `src/domain/agile-cycle.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure cycle module**

```typescript
import { z } from "zod";

const dayMilliseconds = 86_400_000;
const LocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Invalid calendar date");

export const AgileCycleSettingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daily") }).strict(),
  z.object({ type: z.literal("weekly") }).strict(),
  z
    .object({
      type: z.literal("custom"),
      days: z.number().int().positive(),
      anchorDate: LocalDateSchema,
    })
    .strict(),
]);

export const RocSettingsSchema = z
  .object({ cycle: AgileCycleSettingSchema })
  .strict();

export type AgileCycleSetting = z.infer<typeof AgileCycleSettingSchema>;
export type RocSettings = z.infer<typeof RocSettingsSchema>;
export type ActiveAgileCycle = {
  id: string;
  startDate: string;
  endDate: string;
};

/** Formats a Date as a local ISO calendar date. */
function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Converts an ISO calendar date to an integer UTC day number. */
function dayNumber(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year!, month! - 1, day!) / dayMilliseconds);
}

/** Formats an integer UTC day number as an ISO calendar date. */
function dateForDayNumber(value: number): string {
  return new Date(value * dayMilliseconds).toISOString().slice(0, 10);
}

/** Returns the ISO week identifier containing a local calendar date. */
function isoWeekId(value: string): string {
  const target = new Date(dayNumber(value) * dayMilliseconds);
  const mondayBasedDay = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - mondayBasedDay + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / 604_800_000);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Calculates the active cycle for validated settings and a local clock. */
export function activeAgileCycle(
  input: AgileCycleSetting,
  now = new Date(),
): ActiveAgileCycle {
  const setting = AgileCycleSettingSchema.parse(input);
  const today = localDate(now);
  const todayNumber = dayNumber(today);
  if (setting.type === "daily") {
    return { id: today, startDate: today, endDate: today };
  }
  if (setting.type === "weekly") {
    const current = new Date(todayNumber * dayMilliseconds);
    const startNumber = todayNumber - ((current.getUTCDay() + 6) % 7);
    return {
      id: isoWeekId(today),
      startDate: dateForDayNumber(startNumber),
      endDate: dateForDayNumber(startNumber + 6),
    };
  }
  const anchorNumber = dayNumber(setting.anchorDate);
  if (todayNumber < anchorNumber) {
    throw new Error("Current date is before the custom cycle anchor");
  }
  const startNumber =
    anchorNumber +
    Math.floor((todayNumber - anchorNumber) / setting.days) * setting.days;
  const startDate = dateForDayNumber(startNumber);
  return {
    id: `${startDate}-P${setting.days}D`,
    startDate,
    endDate: dateForDayNumber(startNumber + setting.days - 1),
  };
}
```

- [ ] **Step 4: Write the failing settings boundary test**

```typescript
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRocSettings, saveRocSettings } from "../src/settings";

test("safely saves and loads strict global settings", async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), "roc-settings-"));
  const path = await saveRocSettings(
    { cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" } },
    homeRoot,
  );
  expect(path).toBe(join(homeRoot, ".config", "roc", "settings.json"));
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" },
  });
  expect(await loadRocSettings(homeRoot)).toEqual({
    cycle: { type: "custom", days: 14, anchorDate: "2026-08-28" },
  });

  await writeFile(path, '{"cycle":{"type":"custom","days":0,"anchorDate":"2026-08-28"}}');
  await expect(loadRocSettings(homeRoot)).rejects.toThrow();
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
```

- [ ] **Step 5: Implement settings persistence with existing safe-path checks**

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type RocSettings,
  RocSettingsSchema,
} from "./domain/agile-cycle";
import { AgileError } from "./runtime/errors";
import { prepareSafeFilePath } from "./runtime/safe-file";

/** Resolves Roc's global settings file beneath an injectable home directory. */
export function rocSettingsPath(homeRoot = homedir()): string {
  return join(homeRoot, ".config", "roc", "settings.json");
}

/** Loads and strictly validates Roc's global settings. */
export async function loadRocSettings(
  homeRoot = homedir(),
): Promise<RocSettings> {
  try {
    return RocSettingsSchema.parse(
      JSON.parse(await readFile(rocSettingsPath(homeRoot), "utf8")),
    );
  } catch (error) {
    throw new AgileError({
      code: "ROC_SETTINGS_INVALID",
      category: "startup",
      retryable: false,
      component: "settings",
      message: "Run npx roc-it@latest onboard to configure an Agile cycle",
      cause: error,
    });
  }
}

/** Validates and safely writes Roc's global settings. */
export async function saveRocSettings(
  input: RocSettings,
  homeRoot = homedir(),
): Promise<string> {
  const settings = RocSettingsSchema.parse(input);
  const path = prepareSafeFilePath(rocSettingsPath(homeRoot));
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}
```

- [ ] **Step 6: Run the focused tests and commit**

Run: `bun test test/domain/agile-cycle.test.ts test/settings.test.ts`

Expected: 6 tests pass and 0 fail.

```bash
git add src/domain/agile-cycle.ts src/settings.ts test/domain/agile-cycle.test.ts test/settings.test.ts
git commit -m "feat: calculate and store Agile cycles"
```

### Task 2: AC-02 — Configure the cycle during onboarding

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/cli/run.ts`
- Modify: `test/cli/run.test.ts`

- [ ] **Step 1: Add failing onboarding tests for all prompt paths**

Add a test I/O helper that records output and returns queued answers:

```typescript
/** Creates deterministic interactive CLI I/O from queued answers. */
function interactiveIo(answers: string[]) {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      out: (text: string) => output.push(text),
      err: (text: string) => errors.push(text),
      ask: async () => answers.shift() ?? "",
    },
    output,
    errors,
  };
}
```

Test Daily with `['1']`, Weekly with `['2']`, and Custom with `['3', '14']`.
For each run, inject `homeRoot`, `projectRoot`, and `now: () => new Date(2026,
7, 28, 12)`, then assert the exact parsed settings JSON. Add one test proving
`['3', '0']` returns exit code 1 and does not create `settings.json`.

- [ ] **Step 2: Run the onboarding tests and verify they fail**

Run: `bun test test/cli/run.test.ts --test-name-pattern onboard`

Expected: FAIL because `CliIo` has no prompt and onboarding does not save
settings.

- [ ] **Step 3: Add the minimal prompt boundary and onboarding selection**

Extend the existing types:

```typescript
export type CliIo = {
  out(text: string): void;
  err(text: string): void;
  ask?(question: string): Promise<string>;
};

export type CliRuntime = {
  runScheduler(input: SchedulerRunInput): Promise<void>;
  logError?(
    error: AgileError,
    input: { dbPath: string; repoPath?: string },
  ): Promise<void>;
  projectRoot?: string;
  homeRoot?: string;
  now?: () => Date;
};
```

Add one prompt function in `src/cli/run.ts`:

```typescript
/** Prompts for and validates one global Agile cycle setting. */
async function promptCycleSetting(
  io: CliIo,
  now: Date,
): Promise<AgileCycleSetting> {
  if (!io.ask) throw new Error("Interactive input is required for onboard");
  const choice = (await io.ask("Agile cycle: 1) Daily 2) Weekly 3) Custom")).trim();
  if (choice === "1") return { type: "daily" };
  if (choice === "2") return { type: "weekly" };
  if (choice !== "3") throw new Error("Choose Daily, Weekly, or Custom");
  const days = Number((await io.ask("Custom cycle duration in days")).trim());
  return AgileCycleSettingSchema.parse({
    type: "custom",
    days,
    anchorDate: activeAgileCycle({ type: "daily" }, now).id,
  });
}
```

In the successful onboard path, after installing the skill and before emitting
the success output, call:

```typescript
const setting = await promptCycleSetting(io, runtime.now?.() ?? new Date());
const settingsPath = await saveRocSettings(
  { cycle: setting },
  runtime.homeRoot ?? homedir(),
);
io.out(`Saved ${settingsPath}`);
```

- [ ] **Step 4: Implement production readline and close it reliably**

Replace `src/cli/main.ts` with:

```typescript
#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { runCli } from "./run";

if (import.meta.main) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.exitCode = await runCli(Bun.argv.slice(2), {
      out: (text) => process.stdout.write(`${text}\n`),
      err: (text) => process.stderr.write(`${text}\n`),
      ask: (question) => prompt.question(`${question}: `),
    });
  } finally {
    prompt.close();
  }
}
```

- [ ] **Step 5: Run focused checks and commit**

Run: `bun test test/cli/run.test.ts --test-name-pattern onboard`

Expected: all onboarding tests pass.

Run: `bun run typecheck`

Expected: exit 0.

```bash
git add src/cli/main.ts src/cli/run.ts test/cli/run.test.ts
git commit -m "feat: configure Agile cycle during onboarding"
```

### Task 3: AC-03 — Rename Week persistence and contracts to Cycle

**Files:**
- Modify: `src/domain/schemas.ts`
- Modify: `src/store/migrations.ts`
- Modify: `src/store/planning-repository.ts`
- Modify: `src/store/orchestration-repository.ts`
- Modify: `src/artifacts/writer.ts`
- Modify: `src/harness/contracts.ts`
- Modify: `src/scheduler/scheduler.ts`
- Modify: `src/cli/run.ts`
- Modify: all affected files under `test/`

- [ ] **Step 1: Write the migration survival test first**

In `test/store/database.test.ts`, create a raw version-3 database, insert a
`weeks` row plus related `tasks` and `usage` rows, run `migrate(db)`, and assert:

```typescript
expect(
  db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cycles'",
  ).get(),
).toEqual({ name: "cycles" });
expect(
  db.query<{ cycle_id: string }, []>("SELECT cycle_id FROM tasks").get(),
).toEqual({ cycle_id: "2026-W35" });
expect(
  db.query<{ cycle_id: string; category: string }, []>(
    "SELECT cycle_id, category FROM usage",
  ).get(),
).toEqual({ cycle_id: "2026-W35", category: "cycle_grilling" });
expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
```

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `bun test test/store/database.test.ts --test-name-pattern "renames weeks"`

Expected: FAIL because schema version 4 and `cycles` do not exist.

- [ ] **Step 3: Add the native SQLite rename migration**

```typescript
const migration4 = `
ALTER TABLE weeks RENAME TO cycles;
ALTER TABLE tasks RENAME COLUMN week_id TO cycle_id;
ALTER TABLE usage RENAME COLUMN week_id TO cycle_id;
UPDATE usage SET category = 'cycle_grilling' WHERE category = 'weekly_grilling';
`;
```

Raise the supported version to 4. Apply `migration4` transactionally when the
current version is 3, run `PRAGMA foreign_key_check`, fail with the violating
table and row if needed, and set `PRAGMA user_version = 4`. Keep migrations 1–3
unchanged because they describe the released version-3 schema.

- [ ] **Step 4: Rename the domain contract and planning repository**

Use these exact public replacements:

```text
WeeklyPlanSchema      -> AgileCyclePlanSchema
WeeklyPlan            -> AgileCyclePlan
weekId                -> cycleId
createWeek            -> createCycle
weeks                 -> cycles
week_id               -> cycle_id
weekly_grilling       -> cycle_grilling
getWeekCategoryUsage  -> getCycleCategoryUsage
WeekCategoryUsage     -> CycleCategoryUsage
WeekIdSchema          -> CycleIdSchema
InspectionWeekSchema  -> InspectionCycleSchema
InspectionWeek        -> InspectionCycle
```

The core schema becomes:

```typescript
export const AgileCyclePlanSchema = z
  .object({
    id: NonEmpty,
    goal: NonEmpty,
    nonGoals: z.array(NonEmpty),
    tokenBudget: z.number().int().positive(),
    ticketIds: z.array(NonEmpty),
  })
  .strict();

export const TaskCreateSchema = z
  .object({
    id: NonEmpty,
    cycleId: AgileCyclePlanSchema.shape.id,
    title: NonEmpty,
    spec: TicketSpecSchema,
    priority: z.number().int().min(0),
    approvalRequired: z.boolean(),
    approved: z.boolean(),
  })
  .strict();

export const BacklogManifestSchema = z
  .object({
    cycleId: AgileCyclePlanSchema.shape.id,
    goal: NonEmpty,
    tasks: z.array(BacklogTaskSchema).min(1),
  })
  .strict();
```

Rename the inspection result field from `weeks` to `cycles`. Apply the
replacement table to repository row types, SQL, bind parameters, local variable
names, scheduler/harness inputs, artifacts, and fixtures. Preserve historical
`weeks` and `week_id` only inside migrations 1–4 and the migration test setup.

- [ ] **Step 5: Add the explicit old-manifest error before database access**

In the `task import` parse failure path, detect an object with `weekId` and no
`cycleId`, then emit `Manifest uses weekId; replace it with cycleId`. Preserve
the existing strict Zod error for every other invalid manifest.

- [ ] **Step 6: Run the rename checks and remove accidental old terminology**

Run: `bun test test/store/database.test.ts test/store/planning-repository.test.ts test/store/orchestration-repository.test.ts test/domain/schemas.test.ts test/cli/run.test.ts`

Expected: all selected tests pass.

Run: `rg -n "WeeklyPlan|weekId|createWeek|getWeekCategoryUsage|WeekCategoryUsage|WeekIdSchema|weekly_grilling" src test --glob '!src/store/migrations.ts' --glob '!test/store/database.test.ts'`

Expected: no output. Historical `weeks` and `week_id` remain only in
`src/store/migrations.ts` and the version-3 migration test setup.

- [ ] **Step 7: Run typecheck and commit the coherent rename**

Run: `bun run typecheck`

Expected: exit 0.

```bash
git add src test
git commit -m "refactor: rename Agile weeks to cycles"
```

### Task 4: AC-04 — Use the active cycle and document it

**Files:**
- Modify: `src/cli/run.ts`
- Modify: `src/cli/help.ts`
- Modify: `src/cli/token-chart.ts`
- Modify: `test/cli/run.test.ts`
- Modify: `test/cli/help.test.ts`
- Modify: `test/cli/token-chart.test.ts`
- Modify: `skills/roc-create-tasks/SKILL.md`
- Modify: `README.md`
- Modify: `README.zh-HK.md`
- Modify: `CONTEXT.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Write failing CLI tests for the configured active cycle**

Add tests that save settings beneath an injected `homeRoot`, inject a fixed
`runtime.now`, and assert:

```typescript
expect(await runCli(["cycle", "current"], io, runtime)).toBe(0);
expect(output).toEqual(["2026-08-28-P14D"]);
```

For `tokens`, insert usage for that exact `cycle_id` and assert the heading is
`Token usage · 2026-08-28-P14D`. Add one missing-settings test that expects exit
1 and the onboarding instruction.

- [ ] **Step 2: Run the CLI tests and verify they fail**

Run: `bun test test/cli/run.test.ts --test-name-pattern "cycle|tokens"`

Expected: FAIL because `cycle current` is unknown and tokens still use ISO week
logic directly.

- [ ] **Step 3: Route both commands through the shared calculation**

Add one helper in `src/cli/run.ts`:

```typescript
/** Loads settings and calculates the active Agile cycle for the CLI clock. */
async function currentCycle(runtime: CliRuntime) {
  const settings = await loadRocSettings(runtime.homeRoot ?? homedir());
  return activeAgileCycle(settings.cycle, runtime.now?.() ?? new Date());
}
```

Handle `cycle current` with strict positional and option validation, then print
`(await currentCycle(runtime)).id`. In `tokens`, replace the direct ISO-week
calculation with the same helper and call `getCycleCategoryUsage(cycle.id)`.
Add `npx roc-it@latest cycle current` to production help with the description
“Show the active Agile cycle.”

Rename `renderTokenUsageChart(weekId, ...)` to use a `cycleId` parameter and the
JSDoc “current cycle's token usage.” Delete `currentIsoWeekId` from
`token-chart.ts`; its only remaining implementation is the private ISO helper in
`agile-cycle.ts`.

- [ ] **Step 4: Update the skill and production documentation**

In `skills/roc-create-tasks/SKILL.md`, replace the ISO-week instruction with:

````markdown
Before creating the manifest, run:

```bash
npx roc-it@latest cycle current
```

Use its output as `cycleId`. If Roc says settings are missing or invalid, stop
and ask the user to run `npx roc-it@latest onboard`.
````

Replace the manifest's `weekId` example with `cycleId` and preview “cycle goal.”

Add a short README section in both languages containing:

````markdown
### Agile cycle

During onboarding, choose Daily, Weekly, or a custom number of days. Roc saves
the choice for all projects in `~/.config/roc/settings.json`.

```json
{ "cycle": { "type": "weekly" } }
```
````

Add `Agile Cycle` to `CONTEXT.md`: “The calendar window that groups a goal,
tasks, and usage. It can be Daily, Weekly, or a custom number of days.” Update
`docs/architecture.md` to state that the global setting selects the active cycle
used by manifests and token reporting.

- [ ] **Step 5: Run focused tests and package verification**

Run: `bun test test/cli/run.test.ts test/cli/help.test.ts test/cli/token-chart.test.ts test/package.test.ts`

Expected: all selected tests pass.

Run: `npm pack --dry-run --json --ignore-scripts`

Expected: exit 0 and the package includes both READMEs and
`skills/roc-create-tasks/SKILL.md`.

- [ ] **Step 6: Run Standards and Spec reviews**

Review fixed point: `6d60867`.

Standards sources: `AGENTS.md`, project testing policy, function-documentation
rule, and Ponytail full-intensity constraints. Spec source:
`docs/superpowers/specs/2026-08-28-agile-cycle-duration-design.md`.

Verify every named production function has one concise JSDoc sentence. Verify
there is no new dependency, provider interface, strategy class, factory, or
general settings framework. Verify every approved behavior and non-goal against
the diff.

- [ ] **Step 7: Run fresh full verification and commit**

Run: `bun run check`

Expected: lint and typecheck exit 0; all non-skipped tests pass.

Run: `git diff --check`

Expected: no output.

```bash
git add README.md README.zh-HK.md CONTEXT.md docs/architecture.md src test skills/roc-create-tasks/SKILL.md docs/superpowers/specs/2026-08-28-agile-cycle-duration-design.md
git commit -m "feat: use configurable Agile cycles"
```

- [ ] **Step 8: Collect native structured verification evidence**

Create the ignored scratch runner at
`.scratch/deliver-code/agile-cycle-duration/collect-verification.mjs`:

```javascript
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  collectVerificationEvidence,
  evaluateVerificationEvidence,
  renderVerificationOutcome,
} from "/Users/roy/.codex/skills/deliver-code/scripts/verification-evidence.mjs";

const workspacePath = process.cwd();
const evidencePath =
  ".scratch/deliver-code/agile-cycle-duration/verification-evidence.json";

/** Returns a stable fingerprint of the checked-out commit and tracked status. */
function fingerprint(cwd) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  const status = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd,
    encoding: "utf8",
  });
  return `sha256:${createHash("sha256").update(head).update(status).digest("hex")}`;
}

/** Runs one approved verification command and records its fresh result. */
async function runner(input) {
  const result = spawnSync("zsh", ["-lc", input.command], {
    cwd: input.cwd,
    encoding: "utf8",
  });
  return {
    availability: result.error ? "unavailable" : "available",
    exitCode: result.error ? null : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
    workspaceFingerprint: fingerprint(input.cwd),
  };
}

const expectedWorkspaceFingerprint = fingerprint(workspacePath);
const evidence = await collectVerificationEvidence({
  mode: "direct",
  workspacePath,
  changeCompletedAt: new Date().toISOString(),
  expectedWorkspaceFingerprint,
  workspaceFingerprint: expectedWorkspaceFingerprint,
  requirements: [
    { id: "cycle-calculation", text: "Daily, Weekly, and Custom cycles calculate correctly" },
    { id: "global-settings", text: "Global settings are validated and written safely" },
    { id: "interactive-onboarding", text: "Onboarding saves the selected cycle" },
    { id: "persistence-rename", text: "Existing Week data migrates to Cycle names" },
    { id: "task-manifest", text: "Task manifests and the installed skill use cycleId" },
    { id: "token-reporting", text: "Token reporting uses the configured active cycle" },
    { id: "production-docs", text: "Both READMEs document cycle choices and settings" },
  ],
  commands: [
    {
      id: "full-project-check",
      command: "rtk bun run check",
      requirementIds: [
        "cycle-calculation",
        "global-settings",
        "interactive-onboarding",
        "persistence-rename",
        "task-manifest",
        "token-reporting",
      ],
    },
    {
      id: "package-dry-run",
      command: "rtk npm pack --dry-run --json --ignore-scripts",
      requirementIds: ["task-manifest", "production-docs"],
    },
  ],
  runner,
});
const outcome = evaluateVerificationEvidence(evidence);
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(renderVerificationOutcome(outcome));
if (outcome.status !== "passed") process.exitCode = 1;
```

Run: `node .scratch/deliver-code/agile-cycle-duration/collect-verification.mjs`

Expected: `Completion verified: every approved requirement is backed by fresh passing command evidence.`

Update `state.json` to `activeStage: "awaiting_acceptance"`,
`gate: "awaiting_acceptance"`, and point `lastVerification` to the generated
evidence path, fingerprint, collection time, and `passed` status.

## Plan approval package

- **Mode:** direct.
- **Immutable scope:** global Daily, Weekly, or positive-integer-day Custom
  cycles selected interactively during onboarding; full Week-to-Cycle rename;
  configured task creation and token reporting.
- **Non-goals:** per-project settings, simultaneous schedules, separate settings
  command, sub-day duration, moving old tasks, accepting new `weekId` manifests.
- **Route:** four sequential vertical tickets in the local scratch tracker.
- **Ready frontier:** AC-01 only; each later ticket depends on the previous one.
- **Acceptance criteria:** the approved design's Global settings, Cycle
  calculation, Onboarding, Public task manifest, Persistence migration, Token
  reporting, Error handling, Documentation, and Verification sections.
- **Approved public test seams:** pure `activeAgileCycle`, settings load/save,
  `runCli`, SQLite migration/repositories, package contents, and full CLI checks.
- **Artifact changes:** the files in the File map; no ADR and no GitHub Issues.
- **Review fixed point:** `6d60867`.
- **Standards sources:** `AGENTS.md`, Ponytail, project testing and JSDoc rules.
- **Spec source:** `docs/superpowers/specs/2026-08-28-agile-cycle-duration-design.md`.
- **Verification commands:** focused Bun tests per ticket, `bun run typecheck`,
  `npm pack --dry-run --json --ignore-scripts`, `bun run check`, and
  `git diff --check 6d60867..HEAD`.
- **Risks:** SQLite rename behavior and local-calendar boundaries; both have
  focused tests. The CLI manifest rename is intentionally breaking at version
  0.0.1 and has an actionable error.
- **Mutation envelope on approval:** code edits: yes; GitHub Issue publication:
  no; commits: yes; other external action: push the completed feature branch to
  `origin` after fresh verification.
