# Oh My Pi plugin implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Oh My Pi users inspect Roc from their current project without moving Roc's scheduler into OMP.

**Architecture:** Add one OMP extension to the existing `roc-it` package. The extension registers `/roc` and maps two read-only actions to the packaged Roc CLI. Roc still owns SQLite, task state, Git branches, commits, and pull requests. This work does not change the existing `pi` backend.

**Tech Stack:** Bun, TypeScript, OMP extension API, Bun Test.

---

## Scope

This plan tests whether OMP users will install Roc and use it from an OMP session.

The first version supports:

```text
/roc status
/roc tasks
```

It does not change the existing Pi execution backend. It also leaves `/roc run` out. A scheduler run may last for hours, and an OMP command should not own that process yet.

## Milestones

| Milestone | Result | Exit check |
|---|---|---|
| M0 | OMP loads the Roc extension and `/roc` calls the existing CLI | One focused test passes and registration has no side effects |
| M1 | The npm package and READMEs describe the plugin clearly | Package dry-run includes the extension and the normal project checks pass |

## Files

| File | Change |
|---|---|
| `src/integrations/omp/extension.ts` | Register `/roc` and call the existing CLI with direct argv |
| `test/integrations/omp/extension.test.ts` | Check registration, argument mapping, output limits, and invalid input |
| `package.json` | Declare the OMP extension and add OMP as a type-only development dependency |
| `bun.lock` | Lock the development dependency |
| `README.md` | Add English installation and usage |
| `README.zh-HK.md` | Add the same instructions in Traditional Chinese |

## M0: build the plugin

### Task 1: register one `/roc` command

**Files:**
- Create: `src/integrations/omp/extension.ts`
- Create: `test/integrations/omp/extension.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Add the OMP type dependency and manifest**

Run:

```bash
rtk bun add --dev @oh-my-pi/pi-coding-agent@18.1.2
```

Add this top-level field to `package.json`:

```json
"omp": {
  "extensions": ["./src/integrations/omp/extension.ts"]
}
```

Expected: `package.json` contains the manifest and exact development dependency. `bun.lock` changes once.

- [ ] **Step 2: Write the failing extension test**

Create `test/integrations/omp/extension.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import rocExtension from "../../../src/integrations/omp/extension";

type CommandContext = {
  cwd: string;
  ui: {
    notify(message: string, kind: "info" | "warning" | "error"): void;
  };
};

type CommandHandler = (args: string, context: CommandContext) => Promise<void>;

test("registers one read-only Roc command", async () => {
  let handler: CommandHandler | undefined;
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const notices: Array<{ message: string; kind: string }> = [];

  const api = {
    registerCommand(
      name: string,
      options: { handler: CommandHandler },
    ): void {
      expect(name).toBe("roc");
      handler = options.handler;
    },
    async exec(
      command: string,
      args: string[],
      options: { cwd: string },
    ) {
      calls.push({ command, args, cwd: options.cwd });
      return {
        stdout: "x".repeat(5000),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  } as unknown as ExtensionAPI;

  rocExtension(api);
  expect(calls).toEqual([]);
  expect(handler).toBeDefined();

  const context: CommandContext = {
    cwd: "/tmp/project",
    ui: {
      notify(message, kind): void {
        notices.push({ message, kind });
      },
    },
  };

  await handler?.("status", context);
  await handler?.("tasks", context);
  await handler?.("unknown", context);

  expect(calls).toHaveLength(2);
  expect(calls[0]?.command).toBe("bun");
  expect(calls[0]?.args.slice(-2)).toEqual(["scheduler", "inspect"]);
  expect(calls[0]?.cwd).toBe("/tmp/project");
  expect(calls[1]?.args.slice(-2)).toEqual(["task", "list"]);
  expect(notices[0]?.message).toHaveLength(4000);
  expect(notices[0]?.kind).toBe("info");
  expect(notices.at(-1)).toEqual({
    message: "Usage: /roc status | /roc tasks",
    kind: "warning",
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run:

```bash
rtk bun test test/integrations/omp/extension.test.ts
```

Expected: FAIL because `src/integrations/omp/extension.ts` does not exist.

- [ ] **Step 4: Add the extension**

Create `src/integrations/omp/extension.ts`:

```ts
import { resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const actions = {
  status: ["scheduler", "inspect"],
  tasks: ["task", "list"],
} as const;

/** Registers read-only Roc commands in an Oh My Pi session. */
export default function rocExtension(pi: ExtensionAPI): void {
  const cliPath = resolve(import.meta.dir, "../../cli/main.ts");

  pi.registerCommand("roc", {
    description: "Inspect Roc with /roc status or /roc tasks",
    handler: async (rawArgs, context) => {
      const action = rawArgs.trim() as keyof typeof actions;
      const actionArgs = actions[action];
      if (actionArgs === undefined) {
        context.ui.notify("Usage: /roc status | /roc tasks", "warning");
        return;
      }

      const result = await pi.exec("bun", [cliPath, ...actionArgs], {
        cwd: context.cwd,
        timeout: 30_000,
      });
      const message =
        result.stdout.trim() ||
        result.stderr.trim() ||
        `roc-it exited with code ${String(result.code)}`;
      context.ui.notify(message.slice(0, 4000), result.code === 0 ? "info" : "error");
    },
  });
}
```

No code runs during extension registration. The command passes an argv array to `pi.exec`; it never invokes a shell.

- [ ] **Step 5: Run the focused checks**

Run:

```bash
rtk bun test test/integrations/omp/extension.test.ts
rtk bun run typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/omp/extension.ts test/integrations/omp/extension.test.ts package.json bun.lock
git commit -m "feat: add Oh My Pi plugin"
```

## M1: package and explain it

### Task 2: add user instructions and verify the package

**Files:**
- Modify: `README.md`
- Modify: `README.zh-HK.md`

- [ ] **Step 1: Add the English instructions**

Add an "Oh My Pi plugin" section to `README.md` with these facts:

```markdown
## Oh My Pi plugin

Install Roc through Oh My Pi with `omp plugin install roc-it`.

Run OMP inside a project that has completed `npx roc-it@latest onboard`, then use
`/roc status` or `/roc tasks`.

The plugin reads Roc state through the existing CLI. It does not run the
scheduler or choose a backend. Start a Pi-backed run in a
separate terminal with
`npx roc-it@latest scheduler run --backend pi --base-branch main`.
```

- [ ] **Step 2: Add the Traditional Chinese instructions**

Add a matching section to `README.zh-HK.md`:

```markdown
## Oh My Pi plugin

使用 `omp plugin install roc-it` 透過 Oh My Pi 安裝 Roc。

請先在專案完成 `npx roc-it@latest onboard`，再於 OMP 使用 `/roc status` 或
`/roc tasks`。

Plugin 只會透過現有 CLI 讀取 Roc 狀態，不會啟動 scheduler 或選擇
backend。若要以 Pi 執行，請在另一個終端執行
`npx roc-it@latest scheduler run --backend pi --base-branch main`。
```

- [ ] **Step 3: Check the package contents**

Run:

```bash
rtk bun pm pack --dry-run
```

Expected: the output includes `src/integrations/omp/extension.ts`, the two READMEs, `skills/`, and `package.json`.

- [ ] **Step 4: Run the project checks**

Run:

```bash
rtk bun run check
```

Expected: lint, typecheck, and tests pass.

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh-HK.md
git commit -m "docs: explain Oh My Pi plugin"
```

## Backend boundary

The existing `pi` backend already owns OMP execution. This plugin only adds commands for reading Roc state. Keep backend changes out of this plan.

## Final check

Run:

```bash
rtk bun test test/integrations/omp/extension.test.ts
rtk bun run check
rtk bun pm pack --dry-run
```

Expected: the extension test and project checks pass, and the package contains the extension.
