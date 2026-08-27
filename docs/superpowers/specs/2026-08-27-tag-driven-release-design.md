# Tag-Driven Release Design

## Goal

Publish a new Roc version when an authorized maintainer pushes a stable version
tag such as `v0.0.2`. One GitHub Actions workflow will verify the tagged source,
publish the matching `roc-it` version to npm through trusted publishing, and
create a GitHub Release with generated notes.

The README will lead with the production command `npx roc-it` and link to the
public GitHub Releases page.

## Scope

This change adds:

- `.github/workflows/release.yml` for stable `vX.Y.Z` tags;
- a focused workflow contract test;
- README changes for `npx`-first production usage and maintainer releases.

It does not bump versions, create tags, change scheduler behavior, publish
prereleases, or store a long-lived npm token.

## Release Trigger and Authority

The workflow runs when GitHub receives a pushed tag matching `v*.*.*`. Its
first gate applies a strict stable-version check: the tag must match
`v<major>.<minor>.<patch>` and must equal `v` plus the exact `version` in
`package.json`. A mismatch fails before tests or publication.

GitHub Actions cannot make a tag administrative merely because of its name.
The repository must therefore use a GitHub tag ruleset for `v*` that restricts
tag creation to administrators or the chosen release maintainers. The pushed
tag is the human approval to release; the workflow adds no second approval.

The existing `v0.0.1` tag will not trigger retroactively. Automation begins
with the next tag pushed after the workflow reaches the default branch.

## Workflow

The release job runs on a GitHub-hosted Ubuntu runner and performs these steps
in order:

1. Check out the exact tagged commit.
2. Set up Node 24 and the current npm CLI required by npm trusted publishing.
3. Set up Bun 1.3.8 or newer.
4. Verify the stable tag and `package.json` version are identical.
5. Install dependencies from `bun.lock` without changing the lockfile.
6. Run `bun run check`.
7. Create the npm archive and retain its name and integrity as release evidence.
8. Check whether `roc-it@<version>` already exists.
9. Publish it with `npm publish --access public` through npm OIDC when absent.
10. When already present, continue only if the public package integrity equals
    the freshly packed tagged source; otherwise fail closed.
11. Create the GitHub Release for the tag with the tag as its title and GitHub's
    generated release notes. If that release already exists, leave it unchanged.

The package's existing `prepublishOnly` script runs the full check again before
the first publication. Release creation happens only after npm publication or
an exact public-integrity match.

## Permissions and Authentication

The workflow grants only:

- `contents: write`, needed to create the GitHub Release;
- `id-token: write`, needed for npm's short-lived OIDC credential.

It does not read an `NPM_TOKEN`. The npm package owner must configure one
trusted publisher for:

- GitHub owner: `devos-ing`
- repository: `Roc`
- workflow filename: `release.yml`
- allowed action: `npm publish`

The exact workflow filename is part of npm's trust policy. The GitHub-hosted
runner and OIDC publication also provide npm provenance automatically.

References:

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [GitHub Actions workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

## Failure and Recovery

Any invalid tag, version mismatch, install failure, failed project check,
archive failure, npm rejection, or integrity mismatch stops the job without
creating a GitHub Release.

The job is safe to rerun after a partial success:

- if npm publication succeeded but release creation failed, the rerun compares
  the public package with the exact tagged archive and then creates the missing
  release;
- if the GitHub Release already exists, the rerun does not replace or edit it;
- an existing npm version with different integrity is never overwritten or
  treated as success.

npm versions and Git tags are immutable release identities. Recovery never
renames a version, moves a tag, force-pushes, or republishes different bytes.

## README

The Quick Start will lead with:

```bash
npx roc-it help
```

All runnable Quick Start examples will use `npx roc-it`. Bun remains a runtime
prerequisite, and `bunx roc-it` plus global npm installation remain documented
as alternatives. The command reference continues to show the installed
`roc-it` executable.

A Releases link will point to <https://github.com/devos-ing/Roc/releases>. A
short maintainer note will say to update `package.json` and `bun.lock`, merge
that version, then push the matching stable tag. The workflow owns npm
publication and GitHub Release creation after that tag is pushed.

## Verification

A focused test will read the workflow and protect these load-bearing rules:

- stable version tags are the only trigger;
- the tag must match `package.json`;
- permissions are limited to `contents: write` and `id-token: write`;
- the lockfile install and full check happen before npm publication;
- publication uses npm OIDC without `NPM_TOKEN`;
- existing versions require an integrity match;
- the GitHub Release is created only after npm success and uses generated notes;
- reruns do not overwrite an existing release.

The normal `bun run check` remains the local release gate. Workflow syntax will
also be checked with `actionlint` during implementation.

Before calling the change complete, the contract test and `actionlint` must pass
without pushing a test tag. The first real new version is the end-to-end proof
of the npm trust configuration, because npm validates the configured workflow
identity only during publication.
