# Roc architecture map

Open `roc-architecture.html` in a browser. GitHub displays the HTML source rather
than running the viewer. Authored content is Traditional Chinese; the fixed
viewer controls and HTML language use Archify's English fallback.

The diagram describes the implementation at `9f9cae0e8796a15e80903469f3e799c075d59773`.
Each component links to a source file at that revision. The per-task workflow,
including optional Scout omission and the rebase/re-review loop, is in the
[detailed guide](../../../README.details.zh-HK.md#每項任務的流程).

`roc-architecture.json` is the frozen authoring specification. `receipt.json`
records its SHA-256, the delivered HTML digest and the validation result:
9/9 showcase checks, zero errors and warnings. Light/dark screenshots were
inspected; 1440×900, 1600×1000, 1920×1080 and 2048×1320 had no overflow.

The README preview is [a captured light-theme view](../../../docs/assets/roc-architecture.png).
Generated files use this repository's existing Biome exclusion for `output/archify`.
Do not format or hand-edit the delivered HTML. Regenerate from the specification
with Archify's `validate`, `deliver` and `visual-check` commands, passing this
repository as `--repo-root` for source verification.
