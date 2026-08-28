# Production Help and Chinese README Design

## Goal

Keep Roc's public help and README focused on commands that normal users should
run, while moving contributor-only information into a dedicated guide and
adding a complete Traditional Chinese README.

## Public CLI help

`roc-it help` will list only these production commands:

```text
roc-it init [--db PATH]
roc-it task list [--db PATH]
roc-it tokens [--db PATH] [--no-color]
roc-it scheduler run --backend codex --repo PATH [--base REF] [--db PATH]
roc-it help
```

The fake scheduler command and `scheduler inspect` will remain implemented and
callable. They will only be removed from the public help text. Roc will not add
a second `--dev` or `--all` help mode in this change.

## Public READMEs

`README.md` will remain the English source for public product documentation.
It will:

- add a small `English | 繁體中文` language switch near the top;
- keep Quick Start, How it works, Milestones, production Commands, References,
  and License;
- remove the fake scheduler and `scheduler inspect` lines from Commands;
- remove the Releases and Development sections.

`README.zh-HK.md` will be a complete Traditional Chinese version of that public
README, not a short summary. It will keep command names, code blocks, URLs,
product names, and Mermaid node identifiers unchanged so examples work in both
languages. Its language switch will link back to `README.md`.

The two READMEs should describe the same features, limitations, milestones,
production commands, references, and license. Wording can be natural in each
language instead of matching sentence by sentence.

## Contributor guide

Add an English `CONTRIBUTING.md` as the single home for maintainer and
contributor instructions removed from the public README. It will contain:

- local prerequisites and source-checkout setup;
- development, type-checking, testing, and full-check commands;
- the hidden fake scheduler and `scheduler inspect` commands, clearly labelled
  as development tools;
- links to architecture, domain, specification, decision, research, and testing
  policy documents;
- the existing safety rules and focused testing guidance;
- the stable release process, including version bumps, locked installs, checks,
  tags, pushes, npm publishing, and GitHub Releases.

The public READMEs will link to `CONTRIBUTING.md` without repeating those
instructions.

## Tests

Use one behavior test at the real CLI boundary: call `runCli(["help"], io)` and
assert the user-visible output contains every production command but not fake,
`--fake-script`, or `scheduler inspect`. Existing CLI and scheduler tests will
continue proving the hidden commands work; their dispatch will not change.

README and contributor prose will not gain text-matching tests. Verify their
language links, public sections, `@latest` examples, production command lists,
and contributor-only content directly while implementing them. Remove the old
README release-prose test because release instructions no longer belong there.

Run the focused CLI tests, the remaining release-workflow tests, and then
`bun run check`.

## Non-goals

- Removing or disabling fake scheduler and inspection behavior.
- Adding a developer help flag.
- Changing the release workflow or npm package behavior.
- Translating internal architecture, specifications, or contributor docs.
- Rewriting Roc's product behavior or milestone scope.
