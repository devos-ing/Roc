# Roc npm Release Design

## Goal

Publish Roc as the public npm package `roc-it` at version `0.0.1`. The package
exposes the `roc-it` command and requires Bun. Users can run it without a global
install through `bunx roc-it` or `npx roc-it`.

The release also renames the README section `Run it` to `Quick Start` and shows
the published commands before the source-based development commands.

## Package identity

`package.json` will use:

- `name`: `roc-it`
- `version`: `0.0.1`
- `private`: removed
- `bin`: `roc-it` mapped to `src/cli/main.ts`
- `engines.bun`: `>=1.3.0`; release checks run with Bun 1.3.8 or newer
- `license`: `Apache-2.0`
- public repository, homepage, issue tracker, description, and search keywords
- `publishConfig.access`: `public`

The existing CLI entry already uses `#!/usr/bin/env bun`. Version `0.0.1` will
publish the TypeScript source instead of adding a Node build. Bun remains a
required prerequisite because the implementation uses `bun:sqlite`.

## Published files

Use a `files` allowlist so the package contains only:

- `src/`
- `README.md`
- `LICENSE`

Package metadata is included by npm automatically. Tests, design documents,
local databases, generated images, worktrees, and agent state must not ship.

The README avatar will use
`https://raw.githubusercontent.com/devos-ing/Roc/main/output/imagegen/roc-avatar-tech.png`.
This keeps it visible on GitHub and npm without adding the large PNG to the
package archive.

## Quick Start

The README will introduce the shortest path first:

```bash
bunx roc-it help
```

It will also document the npm alternatives:

```bash
npx roc-it help
npm install -g roc-it
roc-it help
```

The existing source commands remain in the Development section. Supported CLI
arguments and current product limits do not change in this release.

## Release checks

Before publishing:

1. Recheck that `roc-it` is unclaimed in the npm registry.
2. Confirm npm authentication with `npm whoami`.
3. Run `bun run check`.
4. Run `npm pack --dry-run --json` and verify the exact file allowlist.
5. Create a package archive and install it into a temporary project.
6. Run `roc-it help` from that installed archive with Bun.
7. Run `npm publish --dry-run --access public`.

Publishing must stop if authentication is missing, the name is no longer
available, the archive contains an unexpected file, or any check fails. The
release name, version, runtime, and file list must not change silently.

## Publishing and verification

After the release commit is pushed to `origin/main`:

1. Publish with `npm publish --access public`.
2. Confirm `roc-it@0.0.1` from the public npm registry.
3. Run `bunx roc-it help` from a clean temporary directory.
4. Tag the exact release commit as `v0.0.1` and push the tag.

If npm asks for login or a one-time password, the user completes that step
locally. Secrets must never be pasted into chat or committed to the repository.

## Tests

Keep the test set small and focused:

- the existing project check must pass;
- the packed file list must contain only the allowed release files;
- a temporary install of the archive must run `roc-it help` successfully;
- the public package must pass the same help-command smoke test after publish.

No scheduler behavior changes in this release, so no new scheduler test matrix
is required.
