# Roc npm Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the Bun-based Roc CLI as the public npm package `roc-it@0.0.1`, runnable through `bunx roc-it`, `npx roc-it`, or a global `roc-it` command.

**Architecture:** Keep the existing TypeScript CLI and Bun shebang. Rename only the public command, add strict npm metadata and a `files` allowlist, verify the real npm archive in a focused boundary test, and publish only after local archive smoke tests pass.

**Tech Stack:** Bun 1.3+, TypeScript, Bun Test, npm registry, Git, GitHub

---

## File map

- Modify `src/cli/help.ts`: show `roc-it` in all public help text.
- Modify `test/cli/help.test.ts`: lock the public command name and supported commands.
- Modify `package.json`: define the npm identity, executable, runtime, release files, repository links, and publish guard.
- Modify `bun.lock`: update the root package name after the manifest changes.
- Create `LICENSE`: include the approved Apache License 2.0 text.
- Create `test/package.test.ts`: verify release metadata and the real `npm pack` file list.
- Modify `README.md`: use the public avatar URL, add Quick Start commands, update the command reference, and retain source-based development instructions.

### Task 1: Rename the public CLI help to `roc-it`

**Files:**
- Modify: `test/cli/help.test.ts`
- Modify: `src/cli/help.ts`

- [ ] **Step 1: Replace the help test with the new public command expectations**

```ts
import { expect, test } from "bun:test";
import { helpText } from "../../src/cli/help";

test("help lists the roc-it commands", () => {
  expect(helpText).toContain("roc-it - run Codex agents through an agile software flow");
  expect(helpText).toContain("roc-it init");
  expect(helpText).toContain("roc-it task list");
  expect(helpText).toContain("roc-it tokens [--db PATH] [--no-color]");
  expect(helpText).toContain("roc-it scheduler run --backend fake --fake-script PATH [--db PATH]");
  expect(helpText).toContain("roc-it scheduler run --backend codex --repo PATH [--base REF] [--db PATH]");
  expect(helpText).toContain("roc-it scheduler inspect [--db PATH]");
  expect(helpText).not.toContain("agile ");
  expect(helpText).not.toContain("--low");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
rtk bun test test/cli/help.test.ts
```

Expected: FAIL because `helpText` still starts with `agile` and lists `agile` commands.

- [ ] **Step 3: Replace the help text with the `roc-it` command**

```ts
export const helpText = `roc-it - run Codex agents through an agile software flow

Usage:
  roc-it init [--db PATH]
  roc-it task list [--db PATH]
  roc-it tokens [--db PATH] [--no-color]
  roc-it scheduler run --backend fake --fake-script PATH [--db PATH]
  roc-it scheduler run --backend codex --repo PATH [--base REF] [--db PATH]
  roc-it scheduler inspect [--db PATH]
  roc-it help
`;
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
rtk bun test test/cli/help.test.ts
```

Expected: 1 pass, 0 fail.

- [ ] **Step 5: Commit the CLI branding change**

```bash
rtk git add src/cli/help.ts test/cli/help.test.ts
rtk git commit -m "feat: rename CLI command to roc-it"
```

### Task 2: Define and test the npm package boundary

**Files:**
- Create: `test/package.test.ts`
- Create: `LICENSE`
- Modify: `package.json`
- Modify: `bun.lock`

- [ ] **Step 1: Add the failing package metadata and archive test**

Create `test/package.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

type PackageManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  description?: string;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  publishConfig?: Record<string, string>;
  scripts?: Record<string, string>;
};

type PackResult = {
  files: Array<{ path: string }>;
};

async function readManifest(): Promise<PackageManifest> {
  const text = await readFile(resolve(projectRoot, "package.json"), "utf8");
  return JSON.parse(text) as PackageManifest;
}

test("package metadata exposes roc-it as a public Bun CLI", async () => {
  const manifest = await readManifest();

  expect(manifest.name).toBe("roc-it");
  expect(manifest.version).toBe("0.0.1");
  expect(manifest.private).toBeUndefined();
  expect(manifest.license).toBe("Apache-2.0");
  expect(manifest.bin).toEqual({ "roc-it": "./src/cli/main.ts" });
  expect(manifest.files).toEqual(["src", "README.md", "LICENSE"]);
  expect(manifest.engines).toEqual({ bun: ">=1.3.0" });
  expect(manifest.publishConfig).toEqual({ access: "public" });
  expect(manifest.scripts?.prepublishOnly).toBe("bun run check");
});

test("npm archive contains only runtime files", async () => {
  const child = Bun.spawn(
    ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`npm pack failed: ${stderr}`);
  }

  const results = JSON.parse(stdout) as PackResult[];
  expect(results).toHaveLength(1);

  const paths = results[0]!.files.map((file) => file.path).sort();
  const allowedRootFiles = new Set(["LICENSE", "README.md", "package.json"]);
  const unexpected = paths.filter(
    (path) => !allowedRootFiles.has(path) && !path.startsWith("src/"),
  );

  expect(unexpected).toEqual([]);
  expect(paths).toContain("LICENSE");
  expect(paths).toContain("README.md");
  expect(paths).toContain("package.json");
  expect(paths).toContain("src/cli/main.ts");
});
```

- [ ] **Step 2: Run the package test and verify it fails**

Run:

```bash
rtk bun test test/package.test.ts
```

Expected: FAIL because the manifest is still named `agile-agents`, is private, uses version `0.1.0`, and exposes the `agile` binary.

- [ ] **Step 3: Add the approved Apache License 2.0 text**

Copy the already approved license from the main workspace and verify its bytes:

```bash
rtk cp /Users/roy/Documents/ChatGPT/agile-agents/LICENSE LICENSE
rtk sha256sum LICENSE
```

Expected SHA-256:

```text
c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4  LICENSE
```

- [ ] **Step 4: Replace `package.json` with the release manifest**

```json
{
  "name": "roc-it",
  "version": "0.0.1",
  "description": "Run Codex agents through a durable Scout, Implement, and Review flow.",
  "license": "Apache-2.0",
  "type": "module",
  "bin": {
    "roc-it": "./src/cli/main.ts"
  },
  "files": [
    "src",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "bun": ">=1.3.0"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/devos-ing/Roc.git"
  },
  "homepage": "https://github.com/devos-ing/Roc#readme",
  "bugs": {
    "url": "https://github.com/devos-ing/Roc/issues"
  },
  "keywords": [
    "ai-agents",
    "agile",
    "bun",
    "cli",
    "codex",
    "orchestration"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "test": "mkdir -p .tmp-agile-tests && PATH=/Applications/Xcode.app/Contents/Developer/usr/bin:$PATH TMPDIR=$PWD/.tmp-agile-tests bun test --timeout 120000",
    "typecheck": "tsc --noEmit",
    "check": "bun run typecheck && bun run test",
    "prepublishOnly": "bun run check"
  },
  "dependencies": {
    "simple-git": "^3.36.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "latest"
  }
}
```

- [ ] **Step 5: Refresh the lockfile root package name**

Run:

```bash
rtk bun install
```

Expected: `bun.lock` changes `workspaces[""].name` from `agile-agents` to `roc-it`; dependency versions do not change unexpectedly.

- [ ] **Step 6: Run the package test and full project check**

Run:

```bash
rtk bun test test/package.test.ts
rtk bun run check
```

Expected: package test reports 2 pass and the full check reports 0 failures.

- [ ] **Step 7: Inspect the exact staged package changes**

Run:

```bash
rtk git diff --check
rtk git diff -- package.json bun.lock LICENSE test/package.test.ts
```

Expected: no whitespace errors; no dependency version changes beyond lockfile metadata required by `bun install`.

- [ ] **Step 8: Commit the npm package boundary**

```bash
rtk git add package.json bun.lock LICENSE test/package.test.ts
rtk git commit -m "build: prepare roc-it npm package"
```

### Task 3: Write the public Quick Start

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Use the public GitHub avatar URL**

Replace the current image tag with:

```html
<p align="center">
  <img src="https://raw.githubusercontent.com/devos-ing/Roc/main/output/imagegen/roc-avatar-tech.png" alt="Roc project avatar" width="220" />
</p>
```

- [ ] **Step 2: Replace `Run it` with the public Quick Start**

Use this section:

````markdown
## Quick Start

Prerequisites:

- [Bun](https://bun.sh/)
- Git
- [Codex CLI](https://github.com/openai/codex) for Codex mode

Run Roc without installing it:

```bash
bunx roc-it help
```

You can also use npm:

```bash
npx roc-it help
```

Or install the command globally:

```bash
npm install -g roc-it
roc-it help
```

Create and inspect the local task database:

```bash
bunx roc-it init
bunx roc-it task list
bunx roc-it tokens
```

Roc does not yet have a public command for adding tickets, so the scheduler
needs a prepared backlog.

Run that backlog with Codex:

```bash
bunx roc-it scheduler run --backend codex --repo /absolute/path/to/project
```

Codex mode creates or reuses a work folder at `<project>.agile-checkout`. Roc
never switches branches or makes commits in the source folder passed through
`--repo`.
````

- [ ] **Step 3: Replace the Commands block with installed command examples**

````markdown
## Commands

```bash
roc-it init [--db PATH]
roc-it task list [--db PATH]
roc-it tokens [--db PATH] [--no-color]
roc-it scheduler run --backend fake --fake-script PATH [--db PATH]
roc-it scheduler run --backend codex --repo PATH [--base REF] [--db PATH]
roc-it scheduler inspect [--db PATH]
roc-it help
```
````

- [ ] **Step 4: Keep source commands under Development and add the license**

Place this block before the development document links:

````markdown
From a source checkout:

```bash
bun install
bun run src/cli/main.ts help
bun run typecheck
bun run test
bun run check
```
````

Append this section:

```markdown
## License

Roc uses the [Apache License 2.0](LICENSE). You may use, change, and share it,
including for commercial work, as long as you follow the license terms.
```

- [ ] **Step 5: Verify the README uses the public command and simple headings**

Run:

```bash
rtk rg -n "^## Quick Start$|bunx roc-it|npx roc-it|npm install -g roc-it|^roc-it scheduler" README.md
rtk rg -n "^## Run it$|What informed Agile Agents" README.md
rtk git diff --check
```

Expected: the first search finds every public usage form; the second search returns no matches; the diff check exits successfully.

- [ ] **Step 6: Run the package and full project checks**

```bash
rtk bun test test/package.test.ts
rtk bun run check
```

Expected: 0 failures and the archive test confirms `README.md` and `LICENSE` are included.

- [ ] **Step 7: Commit the Quick Start**

```bash
rtk git add README.md
rtk git commit -m "docs: add roc-it Quick Start"
```

### Task 4: Smoke test the packed package locally

**Files:** None

- [ ] **Step 1: Create an isolated release test directory and package archive**

```bash
roc_release_tmp="$(mktemp -d /tmp/roc-release.XXXXXX)"
rtk npm pack --pack-destination "$roc_release_tmp"
rtk file "$roc_release_tmp/roc-it-0.0.1.tgz"
```

Expected: npm creates `/tmp/roc-release.*/roc-it-0.0.1.tgz`.

- [ ] **Step 2: Install the archive into a clean Bun project**

```bash
rtk mkdir -p "$roc_release_tmp/project"
rtk bun init -y
rtk bun add "$roc_release_tmp/roc-it-0.0.1.tgz"
```

Run the last two commands with working directory `$roc_release_tmp/project`.

Expected: Bun installs `roc-it@0.0.1` and its production dependencies without using the repository's `node_modules`.

- [ ] **Step 3: Run both package launch paths from the clean project**

Run with working directory `$roc_release_tmp/project`:

```bash
rtk bunx --no-install roc-it help
rtk npx --no-install roc-it help
```

Expected: both commands exit 0 and print `roc-it - run Codex agents through an agile software flow` plus the command list.

- [ ] **Step 4: Run npm's publication dry run**

Run from the release worktree root:

```bash
rtk npm publish --dry-run --access public
```

Expected: the prepublish check passes, npm reports `roc-it@0.0.1`, and the archive contains only `LICENSE`, `README.md`, `package.json`, and `src/**`.

- [ ] **Step 5: Remove only the validated temporary release directory**

```bash
case "$roc_release_tmp" in
  /tmp/roc-release.*) rtk rm -rf -- "$roc_release_tmp" ;;
  *) print "Refusing to remove unexpected path: $roc_release_tmp"; exit 1 ;;
esac
```

Expected: the temporary directory is removed; the repository remains unchanged.

### Task 5: Rebase, verify, and push the release commit to `main`

**Files:** No planned file changes; conflicts must be resolved explicitly if upstream changed.

- [ ] **Step 1: Confirm the feature branch is clean and contains only planned commits**

```bash
rtk git status --short --branch
rtk git log --oneline origin/main..HEAD
```

Expected: clean `codex/roc-npm-release`; commits cover the design, CLI rename, package boundary, and Quick Start only.

- [ ] **Step 2: Fetch and rebase onto the current remote main**

```bash
rtk git fetch origin
rtk git rebase origin/main
```

Expected: fast success. If a conflict appears, stop and use the `resolving-merge-conflicts` skill; do not discard either side.

- [ ] **Step 3: Reinstall and rerun all release checks after the rebase**

```bash
rtk bun install
rtk bun run check
rtk npm publish --dry-run --access public
rtk git status --short --branch
```

Expected: all checks pass and the worktree is clean.

- [ ] **Step 4: Push the exact release commit to main**

```bash
rtk git push origin HEAD:main
rtk git rev-parse HEAD
rtk git rev-parse origin/main
```

Expected: push succeeds and both commit hashes are identical. If main moved again, return to Step 2 instead of force-pushing.

### Task 6: Publish `0.0.1`, verify it, and tag it

**Files:** None

- [ ] **Step 1: Recheck the npm name immediately before publication**

```bash
rtk npm view roc-it name version --json
```

Expected before the first release: npm returns `E404`. If it returns an existing package, stop; do not rename or publish over it.

- [ ] **Step 2: Confirm npm authentication**

```bash
rtk npm whoami
```

Expected: the npm username that will own `roc-it`. If npm returns `E401`, pause and ask the user to run `npm login` locally. Never request credentials in chat.

- [ ] **Step 3: Confirm the publish source is the tested main commit**

```bash
rtk git status --short --branch
rtk git rev-parse HEAD
rtk git rev-parse origin/main
```

Expected: clean worktree and identical hashes.

- [ ] **Step 4: Publish the public package**

```bash
rtk npm publish --access public
```

Expected: npm reports `+ roc-it@0.0.1`. If npm requests a one-time password, pause for the user to complete it locally. Do not retry with different metadata.

- [ ] **Step 5: Verify the public registry metadata**

```bash
rtk npm view roc-it@0.0.1 name version bin engines license repository.url --json
```

Expected: `roc-it`, `0.0.1`, the `roc-it` binary, Bun `>=1.3.0`, Apache-2.0, and the Roc GitHub repository.

- [ ] **Step 6: Verify fresh public `bunx` and `npx` runs**

```bash
roc_public_cache="$(mktemp -d /tmp/roc-public-cache.XXXXXX)"
BUN_INSTALL_CACHE_DIR="$roc_public_cache/bun" rtk bunx roc-it@0.0.1 help
npm_config_cache="$roc_public_cache/npm" rtk npx --yes roc-it@0.0.1 help
```

Expected: both commands download the public package, exit 0, and show the `roc-it` help text.

- [ ] **Step 7: Tag the exact published commit and push the tag**

```bash
rtk git tag -a v0.0.1 -m "Release v0.0.1"
rtk git push origin v0.0.1
```

Expected: `v0.0.1` points to the same commit published to npm.

- [ ] **Step 8: Clean the public smoke-test cache safely**

```bash
case "$roc_public_cache" in
  /tmp/roc-public-cache.*) rtk rm -rf -- "$roc_public_cache" ;;
  *) print "Refusing to remove unexpected path: $roc_public_cache"; exit 1 ;;
esac
```

Expected: only the temporary cache is removed.
