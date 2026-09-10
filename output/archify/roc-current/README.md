# Roc architecture map

Open `roc-architecture.html` in a browser. The map and viewer controls are in
English. GitHub displays the HTML source instead of running the viewer.

The map describes commit `bd0587ab64a6c4824696101175aa071f03b5cf21`, including
the merged GitHub-native scheduler and the 1–8 concurrency setting. Its nine
components link to fourteen source references at that exact revision.

Read the main [README](../../../README.md#how-it-works) for the daily workflow
and task-state guide. The [detailed guide](../../../README.details.md#per-task-workflow)
covers optional Scout omission, independent Review, and rebase/re-review paths.
The [full-size PNG](../../../docs/assets/roc-architecture.png) is a captured
light-theme view of this delivered HTML.

`roc-architecture.json` is the frozen authoring specification. `receipt.json`
records the specification and artifact SHA-256 digests, byte counts, fourteen
verified repository references, and 9/9 showcase checks with zero errors or warnings.
`roc-architecture.visual-check.json` records containment and screenshot evidence
at 1440×900, 1600×1000, 1920×1080, and 2048×1320.
`visual-review.json` records the completed inspection of the light/dark captures.

Regenerate with the installed Archify CLI:

```bash
node /path/to/archify/bin/archify.mjs validate architecture output/archify/roc-current/roc-architecture.json --quality showcase --repo-root . --json
node /path/to/archify/bin/archify.mjs deliver architecture output/archify/roc-current/roc-architecture.json output/archify/roc-current/roc-architecture.html --quality showcase --repo-root . --json
node /path/to/archify/bin/archify.mjs visual-check output/archify/roc-current/roc-architecture.html --json
```

Generated files use this repository's Biome exclusion for `output/archify`.
Do not format or hand-edit the delivered HTML. Update the specification first,
validate it, and generate a new delivery receipt.
