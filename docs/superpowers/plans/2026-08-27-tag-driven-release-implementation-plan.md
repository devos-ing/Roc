# Tag-Driven Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the version in a stable `vX.Y.Z` tag to npm through trusted publishing, create a generated-notes GitHub Release, and make README production examples lead with `npx roc-it`.

**Architecture:** A single tag-triggered GitHub Actions job validates the tag against `package.json`, runs the existing Bun release gate, packs the exact tagged source, and publishes through npm OIDC. The job is rerunnable: an existing npm version must have identical integrity, and an existing GitHub Release is left unchanged.

**Tech Stack:** GitHub Actions, Bash, GitHub CLI, Node 24, npm 12.0.2, npm trusted publishing/OIDC, Bun 1.3.8, Bun Test, actionlint 1.7.12

---

## File map

- Create `.github/workflows/release.yml`: own tag validation, checks, npm OIDC publication, integrity recovery, and GitHub Release creation.
- Create `test/release-workflow.test.ts`: protect the workflow's security, ordering, rerun, and README contracts as repository behavior.
- Modify `README.md`: lead with `npx`, retain alternatives, link Releases, and explain the maintainer tag flow.

## Known repository constraint

The existing Husky pre-commit hook runs Git-creating tests while Git has exported
its parent repository variables. In this linked worktree, those nested test
commits can target the parent index. This is outside the approved release-workflow
scope. For each implementation commit below, first run the specified focused and
full checks outside the hook, then commit with `HUSKY=0`. Stage only the listed
files and inspect the staged names before committing. Do not change the hook in
this plan.

### Task 1: Add the tested tag-release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `test/release-workflow.test.ts`

- [ ] **Step 1: Write the failing workflow contract test**

Create `test/release-workflow.test.ts` with:

```ts
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

async function readProjectFile(path: string): Promise<string> {
  return readFile(resolve(projectRoot, path), "utf8");
}

function expectInOrder(source: string, parts: string[]): void {
  let cursor = -1;
  for (const part of parts) {
    const next = source.indexOf(part, cursor + 1);
    expect(next).toBeGreaterThan(cursor);
    cursor = next;
  }
}

test("stable tags publish with OIDC before creating a generated GitHub Release", async () => {
  const workflow = await readProjectFile(".github/workflows/release.yml");

  expect(workflow).toContain('      - "v*.*.*"');
  expect(workflow).toContain(
    "permissions:\n  contents: write\n  id-token: write\n\nconcurrency:",
  );
  expect(workflow).not.toContain("NPM_TOKEN");
  expect(workflow).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+$');
  expect(workflow).toContain('[[ "$tag" == "v$version" ]]');
  expect(workflow).toContain("bun install --frozen-lockfile");
  expect(workflow).toContain("npm view \"roc-it@$VERSION\" dist.integrity");
  expect(workflow).toContain("roc-it@$VERSION exists with different bytes");
  expect(workflow).toContain('echo "publish=false" >> "$GITHUB_OUTPUT"');
  expect(workflow).toContain('grep -q "E404" "$error_file"');
  expect(workflow).toContain("npm publish --access public");
  expect(workflow).toContain('gh release view "$GITHUB_REF_NAME"');
  expect(workflow).toContain("--generate-notes");

  expectInOrder(workflow, [
    "Validate tag and package version",
    "bun install --frozen-lockfile",
    "bun run check",
    "npm pack --json --ignore-scripts",
    "npm publish --access public",
    "Verify published package integrity",
    'gh release create "$GITHUB_REF_NAME"',
  ]);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
rtk bun test test/release-workflow.test.ts
```

Expected: FAIL because `.github/workflows/release.yml` does not exist.

- [ ] **Step 3: Create the minimal complete workflow**

Create `.github/workflows/release.yml` with:

```yaml
name: Release

on:
  push:
    tags:
      - "v*.*.*"

permissions:
  contents: write
  id-token: write

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    name: Publish npm package and GitHub Release
    runs-on: ubuntu-latest
    steps:
      - name: Check out tagged source
        uses: actions/checkout@v6

      - name: Set up Node and npm registry
        uses: actions/setup-node@v6
        with:
          node-version: "24"
          registry-url: https://registry.npmjs.org
          package-manager-cache: false

      - name: Install trusted-publishing npm CLI
        run: npm install --global npm@12.0.2

      - name: Set up Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.8

      - name: Validate tag and package version
        id: version
        shell: bash
        run: |
          set -euo pipefail
          tag="$GITHUB_REF_NAME"
          version="$(node -p 'require("./package.json").version')"
          if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "Expected a stable vX.Y.Z tag, received: $tag" >&2
            exit 1
          fi
          if [[ "$tag" != "v$version" ]]; then
            echo "Tag $tag does not match package.json version $version" >&2
            exit 1
          fi
          echo "version=$version" >> "$GITHUB_OUTPUT"

      - name: Install locked dependencies
        run: bun install --frozen-lockfile

      - name: Run release checks
        run: bun run check

      - name: Pack tagged source
        id: pack
        shell: bash
        run: |
          set -euo pipefail
          pack_json="$(npm pack --json --ignore-scripts)"
          archive="$(jq -r '.[0].filename' <<<"$pack_json")"
          integrity="$(jq -r '.[0].integrity' <<<"$pack_json")"
          if [[ ! -f "$archive" || "$integrity" != sha512-* ]]; then
            echo "npm pack did not produce a valid archive and integrity" >&2
            exit 1
          fi
          echo "archive=$archive" >> "$GITHUB_OUTPUT"
          echo "integrity=$integrity" >> "$GITHUB_OUTPUT"

      - name: Check npm publication state
        id: registry
        shell: bash
        env:
          EXPECTED_INTEGRITY: ${{ steps.pack.outputs.integrity }}
          VERSION: ${{ steps.version.outputs.version }}
        run: |
          set -euo pipefail
          error_file="$(mktemp)"
          trap 'rm -f "$error_file"' EXIT
          if published_integrity="$(npm view "roc-it@$VERSION" dist.integrity 2>"$error_file")"; then
            if [[ "$published_integrity" != "$EXPECTED_INTEGRITY" ]]; then
              echo "roc-it@$VERSION exists with different bytes" >&2
              exit 1
            fi
            echo "publish=false" >> "$GITHUB_OUTPUT"
          elif grep -q "E404" "$error_file"; then
            echo "publish=true" >> "$GITHUB_OUTPUT"
          else
            cat "$error_file" >&2
            exit 1
          fi

      - name: Publish package through npm OIDC
        if: steps.registry.outputs.publish == 'true'
        run: npm publish --access public

      - name: Verify published package integrity
        shell: bash
        env:
          EXPECTED_INTEGRITY: ${{ steps.pack.outputs.integrity }}
          VERSION: ${{ steps.version.outputs.version }}
        run: |
          set -euo pipefail
          for attempt in {1..12}; do
            if published_integrity="$(npm view "roc-it@$VERSION" dist.integrity 2>/dev/null)"; then
              if [[ "$published_integrity" != "$EXPECTED_INTEGRITY" ]]; then
                echo "Published roc-it@$VERSION does not match the tagged archive" >&2
                exit 1
              fi
              exit 0
            fi
            sleep 5
          done
          echo "roc-it@$VERSION did not become visible in the npm registry" >&2
          exit 1

      - name: Create GitHub Release
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          if gh release view "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
            echo "GitHub Release $GITHUB_REF_NAME already exists"
            exit 0
          fi
          gh release create "$GITHUB_REF_NAME" \
            --repo "$GITHUB_REPOSITORY" \
            --verify-tag \
            --title "$GITHUB_REF_NAME" \
            --generate-notes
```

- [ ] **Step 4: Run the focused contract test and confirm GREEN**

Run:

```bash
rtk bun test test/release-workflow.test.ts
```

Expected: 1 pass, 0 fail.

- [ ] **Step 5: Lint the workflow with the official pinned actionlint image**

Run:

```bash
rtk docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color
```

Expected: exit 0 with no workflow errors.

- [ ] **Step 6: Run the full project check outside the Git hook**

Run:

```bash
rtk bun run check
```

Expected: 0 failures; the one real-Codex integration test remains intentionally skipped.

- [ ] **Step 7: Inspect and commit only the workflow slice**

Run:

```bash
rtk git add .github/workflows/release.yml test/release-workflow.test.ts
rtk git diff --cached --name-only
rtk git diff --cached --check
rtk env HUSKY=0 git commit -m "ci: publish tagged Roc releases"
```

Expected staged names: only `.github/workflows/release.yml` and
`test/release-workflow.test.ts`. The commit succeeds after the already-passing
focused, actionlint, and full checks.

### Task 2: Make README production usage npx-first

**Files:**
- Modify: `test/release-workflow.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add the failing README release contract**

Append to `test/release-workflow.test.ts`:

```ts
test("README leads with npx production commands and explains tagged releases", async () => {
  const readme = await readProjectFile("README.md");

  expect(readme.indexOf("npx roc-it help")).toBeLessThan(
    readme.indexOf("bunx roc-it help"),
  );
  expect(readme).toContain("npx roc-it init");
  expect(readme).toContain("npx roc-it task list");
  expect(readme).toContain("npx roc-it tokens");
  expect(readme).toContain(
    "npx roc-it scheduler run --backend codex --repo /absolute/path/to/project",
  );
  expect(readme).toContain("https://github.com/devos-ing/Roc/releases");
  expect(readme).toContain("git tag vX.Y.Z");
  expect(readme).toContain("git push origin vX.Y.Z");
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
rtk bun test test/release-workflow.test.ts
```

Expected: the workflow contract passes and the README contract fails because
`bunx` is still first and no Releases section exists.

- [ ] **Step 3: Replace the Quick Start production command blocks**

In `README.md`, replace the section from `Run Roc without installing it:`
through the Codex scheduler command with:

````markdown
Run the production package without installing it:

```bash
npx roc-it help
```

You can also use Bun:

```bash
bunx roc-it help
```

Or install the command globally:

```bash
npm install -g roc-it
roc-it help
```

Create and inspect the local task database:

```bash
npx roc-it init
npx roc-it task list
npx roc-it tokens
```

Roc does not yet have a public command for adding tickets, so the scheduler
needs a prepared backlog.

Run that backlog with Codex:

```bash
npx roc-it scheduler run --backend codex --repo /absolute/path/to/project
```
````

Keep the existing checkout-safety paragraph immediately after this block.

- [ ] **Step 4: Add the Releases section before Development**

Insert this section immediately before `## Development`:

````markdown
## Releases

See every published version and its notes on [GitHub Releases](https://github.com/devos-ing/Roc/releases).

To publish a stable version, a maintainer updates `package.json` and `bun.lock`,
merges that version, then tags the exact release commit:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

The tag must match the version in `package.json`. GitHub Actions runs the checks,
publishes the package to npm, and creates the GitHub Release.
````

- [ ] **Step 5: Run the focused tests and confirm GREEN**

Run:

```bash
rtk bun test test/release-workflow.test.ts
```

Expected: 2 pass, 0 fail.

- [ ] **Step 6: Run the package boundary and full project checks**

Run:

```bash
rtk bun test test/package.test.ts
rtk bun run check
```

Expected: all package tests pass, all project checks pass, and only the one
real-Codex integration test is skipped.

- [ ] **Step 7: Inspect and commit only the README slice**

Run:

```bash
rtk git add README.md test/release-workflow.test.ts
rtk git diff --cached --name-only
rtk git diff --cached --check
rtk env HUSKY=0 git commit -m "docs: document automated Roc releases"
```

Expected staged names: only `README.md` and `test/release-workflow.test.ts`.

### Task 3: Final release-workflow verification

**Files:** No planned changes.

- [ ] **Step 1: Confirm the branch contains only the planned commits and is clean**

Run:

```bash
rtk git status --short --branch
rtk git log --oneline origin/main..HEAD
rtk git diff --check origin/main..HEAD
```

Expected: a clean `codex/tag-release-workflow` branch with the design, workflow,
and README commits only.

- [ ] **Step 2: Re-run workflow syntax and repository checks from fresh state**

Run:

```bash
rtk docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color
rtk bun install --frozen-lockfile
rtk bun test test/release-workflow.test.ts
rtk bun test test/package.test.ts
rtk bun run check
rtk npm publish --dry-run --access public
```

Expected: actionlint exits 0; 2 release-workflow tests pass; 2 package tests
pass; the full check has 0 failures and one intentional skip; npm dry-run
packages `roc-it` without attempting OIDC publication.

- [ ] **Step 3: Verify no tag or publish side effect occurred**

Run:

```bash
rtk git status --short --branch
rtk git tag --points-at HEAD
rtk npm view roc-it version
```

Expected: the branch is clean, no new tag points at the feature commit, and npm
still reports the previously released version until an authorized maintainer
later updates the manifest and pushes a matching stable tag.

## Operator setup after merge

Before pushing the first automated release tag, configure npm trusted publishing
for package `roc-it` with these exact values:

- provider: GitHub Actions;
- organization or user: `devos-ing`;
- repository: `Roc`;
- workflow filename: `release.yml`;
- allowed action: `npm publish`.

Also configure a GitHub tag ruleset for `v*` so only administrators or selected
release maintainers can create matching tags. Neither external settings change
is performed by this implementation plan.
