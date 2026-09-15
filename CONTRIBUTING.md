# Contributing to Pied Piper

Pied Piper uses Node.js 22.19+ in production and Bun for repository checks. Install
the locked dependencies with:

```bash
bun install --frozen-lockfile
```

Run the interactive source entry with `bun dev` or directly with Node:

```bash
bun dev -- --help
node dist/piedpiper/main.js --help
```

Use a disposable Git repository for live Pied Piper tests. Starting a new change
creates sibling worktree directories. PR publication is a real external side
effect and must only be tested against an explicitly approved repository.

Before submitting changes, run:

```bash
bun run typecheck
bun test
bun run lint
npm pack --dry-run --json --ignore-scripts
```

The generated design-diagram HTML is retained evidence; do not reformat it by
hand. New tests should focus on recovery and safety boundaries: source dirt is
preserved, child capacity is bounded, results are not duplicated or misrouted,
Git conflicts retain work, Review binds the exact final head, uncertain remote
responses reconcile before retry, and no Pied Piper path merges a PR.

The repository-local `pr-review-to-closure` skill is only for reviewing this
repository's own PRs. It is not included in the npm package or Pied Piper runtime.

Architecture: [docs/architecture.md](docs/architecture.md). Historical Roc
operator material is under [docs/legacy](docs/legacy/).

Only maintainers publish releases. The stable `vX.Y.Z` tag must exactly match
`package.json`; the release workflow runs all checks, publishes `piedpiper` with
npm trusted publishing, verifies integrity, and creates the GitHub release.
`openamp` has no executable alias.
