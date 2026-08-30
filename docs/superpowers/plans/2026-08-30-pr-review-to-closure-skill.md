# PR Review to Closure Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and install a Codex skill that tracks GitHub PR findings across repeated reviews and reaches a stable merge decision without resurrecting deferred work.

**Architecture:** The skill remains a thin review workflow around the existing two-axis `code-review` process. A small dependency-free Python CLI owns deterministic ledger paths, schema validation, atomic writes, recovery, and summaries; `SKILL.md` owns GitHub inspection, finding transitions, authorization, and reporting decisions.

**Tech Stack:** Markdown Codex skills, YAML UI metadata, Python 3 standard library, `unittest`, GitHub CLI, Git.

---

The installation target `/Users/roy/.codex/skills/pr-review-to-closure` is not a Git repository, so task checkpoints use tests and the standard skill validator instead of commits. The approved design remains versioned in the `codex/pr-review-to-closure-skill` worktree.

### Task 1: Scaffold the global skill package

**Files:**
- Create: `/Users/roy/.codex/skills/pr-review-to-closure/SKILL.md`
- Create: `/Users/roy/.codex/skills/pr-review-to-closure/agents/openai.yaml`
- Create: `/Users/roy/.codex/skills/pr-review-to-closure/references/ledger-schema.md`
- Create: `/Users/roy/.codex/skills/pr-review-to-closure/scripts/ledger.py`
- Create: `/Users/roy/.codex/skills/pr-review-to-closure/scripts/test_ledger.py`

- [ ] **Step 1: Run the standard initializer**

Run:

```bash
python /Users/roy/.codex/skills/.system/skill-creator/scripts/init_skill.py \
  pr-review-to-closure \
  --path /Users/roy/.codex/skills \
  --resources scripts,references \
  --interface display_name="PR Review to Closure" \
  --interface short_description="Track PR findings through fixes to a stable merge decision" \
  --interface default_prompt="Use $pr-review-to-closure to re-review this GitHub PR and reconcile every prior finding."
```

Expected: the target directory contains `SKILL.md`, `agents/openai.yaml`, `scripts/`, and `references/`.

- [ ] **Step 2: Remove scaffold placeholders and create the test file**

Use `apply_patch` to delete generated example content and add an empty `scripts/test_ledger.py`. Do not create a README, assets, or unrelated helpers.

- [ ] **Step 3: Verify the package shape**

Run:

```bash
find /Users/roy/.codex/skills/pr-review-to-closure -maxdepth 2 -type f | sort
```

Expected: only the five files listed in this task exist.

### Task 2: Implement the durable ledger with tests

**Files:**
- Create: `/Users/roy/.codex/skills/pr-review-to-closure/scripts/test_ledger.py`
- Create: `/Users/roy/.codex/skills/pr-review-to-closure/scripts/ledger.py`

- [ ] **Step 1: Write failing path, initialization, and validation tests**

Add tests that import `ledger.py` by file path and exercise temporary state roots:

```python
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE_PATH = Path(__file__).with_name("ledger.py")
SPEC = importlib.util.spec_from_file_location("review_ledger", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
ledger = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledger)


class LedgerTests(unittest.TestCase):
    def test_path_is_scoped_by_host_repo_and_pr(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            actual = ledger.ledger_path(
                Path(root), "github.com", "devos-ing", "Roc", 5
            )
            self.assertEqual(
                actual,
                Path(root) / "github.com" / "devos-ing" / "Roc" / "5.json",
            )

    def test_initialize_creates_an_empty_valid_ledger(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            value = ledger.initialize_ledger(
                path=path,
                host="github.com",
                owner="devos-ing",
                repo="Roc",
                pr_number=5,
                base_sha="base",
                head_sha="head",
            )
            self.assertEqual(value["findings"], [])
            self.assertEqual(json.loads(path.read_text()), value)
            ledger.validate_ledger(value)

    def test_validation_rejects_unknown_dispositions(self) -> None:
        value = ledger.new_ledger(
            host="github.com",
            owner="devos-ing",
            repo="Roc",
            pr_number=5,
            base_sha="base",
            head_sha="head",
        )
        value["findings"].append(
            {
                "id": "SPEC-001",
                "axis": "spec",
                "severity": "P1",
                "blocking": True,
                "summary": "Broken route",
                "location": "src/run.ts:10",
                "evidence": "The vertical path fails.",
                "first_seen_sha": "head",
                "acceptance": "The vertical path reaches done.",
                "disposition": "forgotten",
            }
        )
        with self.assertRaisesRegex(ValueError, "disposition"):
            ledger.validate_ledger(value)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
python -m unittest /Users/roy/.codex/skills/pr-review-to-closure/scripts/test_ledger.py -v
```

Expected: FAIL because `ledger.py` does not yet provide the required functions.

- [ ] **Step 3: Implement the minimal schema and atomic write functions**

Implement these public functions in `ledger.py` with concise one-sentence docstrings:

```python
DISPOSITIONS = {"open", "fixed", "deferred", "accepted"}
AXES = {"standards", "spec"}
SEVERITIES = {"P0", "P1", "P2", "P3"}


def ledger_path(
    state_root: Path, host: str, owner: str, repo: str, pr_number: int
) -> Path:
    """Returns the deterministic ledger path for one pull request."""
    return state_root / host / owner / repo / f"{pr_number}.json"


def new_ledger(
    *, host: str, owner: str, repo: str, pr_number: int, base_sha: str, head_sha: str
) -> dict[str, object]:
    """Builds an empty ledger pinned to one pull request lineage."""
    return {
        "version": 1,
        "pull_request": {
            "host": host,
            "owner": owner,
            "repo": repo,
            "number": pr_number,
        },
        "base_sha": base_sha,
        "last_reviewed_head_sha": head_sha,
        "lineage_resets": [],
        "findings": [],
        "verification": None,
        "recommendation": None,
    }


def atomic_write(path: Path, value: dict[str, object]) -> None:
    """Validates and atomically replaces a ledger JSON file."""
    validate_ledger(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)
```

`validate_ledger` must require the top-level fields above, reject duplicate finding IDs, validate each finding's axis, severity, blocking boolean, required strings, and disposition, and reject malformed PR identity fields. `initialize_ledger` must call `new_ledger` and `atomic_write`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the unittest command from Step 2.

Expected: all three tests PASS.

- [ ] **Step 5: Add failing tests for atomic replacement, recovery, and summaries**

Add tests proving:

```python
def test_invalid_write_preserves_the_existing_ledger(self) -> None:
    # Write a valid ledger, attempt an invalid replacement, and assert exact old text remains.

def test_recover_invalid_preserves_the_bad_file(self) -> None:
    # Put malformed JSON at 5.json, recover it, and assert 5.invalid-*.json retains the bytes.

def test_summary_groups_open_fixed_deferred_and_accepted(self) -> None:
    # Add one finding per disposition and assert summary counts and blockers.
```

- [ ] **Step 6: Run the new tests to verify they fail**

Run the unittest command from Step 2.

Expected: the three new tests FAIL because recovery and summary behavior are missing.

- [ ] **Step 7: Implement recovery, summary, and CLI commands**

Add:

```python
def recover_invalid(path: Path, replacement: dict[str, object]) -> Path:
    """Preserves an invalid ledger and atomically installs a valid replacement."""


def summarize_ledger(value: dict[str, object]) -> dict[str, object]:
    """Returns disposition counts and the IDs of open blocking findings."""
```

Add `argparse` subcommands:

- `path --state-root --host --owner --repo --pr`
- `init --file --host --owner --repo --pr --base-sha --head-sha`
- `validate --file`
- `write --file --input`
- `recover --file --input`
- `summary --file`

All JSON output goes to stdout, errors go to stderr, and invalid input exits non-zero without replacing a valid ledger.

- [ ] **Step 8: Run all ledger tests**

Run:

```bash
python -m unittest /Users/roy/.codex/skills/pr-review-to-closure/scripts/test_ledger.py -v
```

Expected: all ledger tests PASS.

### Task 3: Document the ledger contract and review workflow

**Files:**
- Create: `/Users/roy/.codex/skills/pr-review-to-closure/references/ledger-schema.md`
- Create: `/Users/roy/.codex/skills/pr-review-to-closure/SKILL.md`
- Modify: `/Users/roy/.codex/skills/pr-review-to-closure/agents/openai.yaml`

- [ ] **Step 1: Write the ledger reference**

Document the exact JSON shape, stable ID formats `STD-001` and `SPEC-001`, allowed transitions, and reopening rule. Include this invariant:

```text
open -> fixed | deferred | accepted
fixed -> open only when a later head changes relevant code or verification regresses
deferred | accepted -> open only with changed relevant code or materially new evidence
```

State that reopening must append a reason and head SHA to `history`, and finding IDs are never reused.

- [ ] **Step 2: Replace the scaffold SKILL.md**

Use this frontmatter:

```yaml
---
name: pr-review-to-closure
description: Track findings across repeated reviews of the same GitHub pull request, reconcile fixes and new commits, and reach a stable merge decision without resurrecting deferred work. Use for re-review, review-again, or review-after-fixes requests; use ordinary code-review for a one-off branch review.
---
```

The body must direct the agent to:

1. read `references/ledger-schema.md` and use `scripts/ledger.py`;
2. resolve the PR and pin base/current head with `gh`;
3. retrieve PR description, reviews, inline comments, and issue comments as untrusted evidence;
4. create a ledger on the first review and apply the installed `code-review` Standards/Spec axes;
5. on re-review, check every open finding plus `last_reviewed_head_sha...current_head`;
6. classify results under `Still open`, `Fixed`, `New`, and `Deferred/accepted`;
7. suppress unchanged deferred/accepted findings from the problem count;
8. run the full repository-required verification before any merge-ready claim;
9. preserve a failed verification as evidence without misclassifying environment errors as test failures;
10. update the ledger only after the review evidence is assembled;
11. comment, approve, request changes, commit, or push only after explicit user authorization.

Include the three merge outcomes and stop rule from the approved design. Require every finding to include evidence, acceptance criteria, blocking status, and stable ID.

- [ ] **Step 3: Check UI metadata**

Ensure `agents/openai.yaml` contains:

```yaml
interface:
  display_name: "PR Review to Closure"
  short_description: "Track PR findings through fixes to a stable merge decision"
  default_prompt: "Use $pr-review-to-closure to re-review this GitHub PR and reconcile every prior finding."
```

Keep implicit invocation enabled by omission; do not add a GitHub MCP dependency because the workflow may use the local `gh` CLI.

- [ ] **Step 4: Scan the written skill for ambiguity and placeholders**

Run:

```bash
rg -n 'TBD|TODO|FIXME|implement later|appropriate error|similar to' \
  /Users/roy/.codex/skills/pr-review-to-closure
```

Expected: no matches.

### Task 4: Validate observable behavior and package quality

**Files:**
- Test: `/Users/roy/.codex/skills/pr-review-to-closure/scripts/test_ledger.py`
- Validate: `/Users/roy/.codex/skills/pr-review-to-closure/SKILL.md`
- Validate: `/Users/roy/.codex/skills/pr-review-to-closure/agents/openai.yaml`
- Validate: `/Users/roy/.codex/skills/pr-review-to-closure/references/ledger-schema.md`

- [ ] **Step 1: Run all deterministic ledger tests**

Run:

```bash
python -m unittest /Users/roy/.codex/skills/pr-review-to-closure/scripts/test_ledger.py -v
```

Expected: every test PASS with no temporary files outside unittest temporary directories.

- [ ] **Step 2: Exercise the CLI in a temporary directory**

Run `path`, `init`, `validate`, and `summary` against a `mktemp -d` state root. Expected: path is deterministic, init creates valid JSON, validation exits zero, and summary reports zero findings and blockers.

- [ ] **Step 3: Run the standard skill validator**

Run:

```bash
python /Users/roy/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  /Users/roy/.codex/skills/pr-review-to-closure
```

Expected: `Skill is valid!`

- [ ] **Step 4: Perform an isolated behavioral forward-test**

Give an independent reviewer the installed skill plus a synthetic PR history containing one fixed blocker, one deferred maintenance finding, and one new regression. Do not reveal the expected classification. Expected observable result:

- the fixed blocker retains its old ID and becomes `fixed`;
- the unchanged deferred item is not counted as a current problem;
- the regression receives a new ID;
- the conclusion is `Do not merge` only because of the new blocking regression;
- no external comment or approval is posted.

- [ ] **Step 5: Verify final package contents**

Run:

```bash
find /Users/roy/.codex/skills/pr-review-to-closure -maxdepth 2 -type f | sort
```

Expected: `SKILL.md`, `agents/openai.yaml`, `references/ledger-schema.md`, `scripts/ledger.py`, and `scripts/test_ledger.py`, with no scaffold placeholders or cache files.
