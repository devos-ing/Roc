from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).with_name("ledger.py")
SPEC = importlib.util.spec_from_file_location("review_ledger", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
ledger = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledger)


def finding(
    identifier: str = "SPEC-001",
    *,
    axis: str = "spec",
    disposition: str = "open",
    blocking: bool = False,
    first_seen_sha: str = "head-0001",
    history: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return {
        "id": identifier,
        "axis": axis,
        "severity": "P1",
        "blocking": blocking,
        "summary": "Broken route",
        "location": "src/run.ts:10",
        "evidence": "The vertical path fails.",
        "first_seen_sha": first_seen_sha,
        "acceptance": "The vertical path reaches done.",
        "disposition": disposition,
        "history": [] if history is None else history,
    }


def verification(head_sha: str = "head-0001", status: str = "passed") -> dict[str, object]:
    return {
        "command": "python -B -m unittest",
        "head_sha": head_sha,
        "status": status,
        "output": "All required checks passed." if status == "passed" else "Checks did not pass.",
    }


def recommendation(
    head_sha: str = "head-0001",
    *,
    outcome: str = "merge_ready",
) -> dict[str, object]:
    return {
        "kind": "merge_decision",
        "outcome": outcome,
        "head_sha": head_sha,
        "reasons": ["The current findings and verification support this decision."],
    }


def indeterminate(head_sha: str = "head-0001") -> dict[str, object]:
    return {
        "kind": "indeterminate",
        "status": "merge_readiness_not_established",
        "head_sha": head_sha,
        "reasons": ["An unresolved condition prevents a positive merge decision."],
    }


def review_evidence(*missing_sources: str, head_sha: str = "head-0001") -> dict[str, object]:
    sources = {
        name: {
            "status": "missing" if name in missing_sources else "read",
            "detail": "The source could not be read." if name in missing_sources else "The source was read.",
        }
        for name in (
            "pr_metadata",
            "pr_description",
            "reviews",
            "inline_comments",
            "issue_comments",
            "repository_standards",
        )
    }
    return {"head_sha": head_sha, "sources": sources}


def ledger_value(
    *,
    revision: int = 0,
    review_state: str = "complete",
    host: str = "github.com",
    owner: str = "devos-ing",
    repo: str = "Roc",
    pr_number: int = 5,
    base_sha: str = "base-0001",
    head_sha: str = "head-0001",
    findings: list[dict[str, object]] | None = None,
    verification_value: dict[str, object] | None = None,
    review_evidence_value: dict[str, object] | None = None,
    recommendation_value: dict[str, object] | None = None,
    lineage_resets: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    if review_state == "complete":
        review_evidence_value = (
            review_evidence(head_sha=head_sha)
            if review_evidence_value is None
            else review_evidence_value
        )
        verification_value = verification(head_sha) if verification_value is None else verification_value
        recommendation_value = recommendation(head_sha) if recommendation_value is None else recommendation_value
    return {
        "version": 1,
        "revision": revision,
        "review_state": review_state,
        "pull_request": {
            "host": host,
            "owner": owner,
            "repo": repo,
            "number": pr_number,
        },
        "base_sha": base_sha,
        "last_reviewed_head_sha": head_sha,
        "lineage_resets": [] if lineage_resets is None else lineage_resets,
        "findings": [] if findings is None else findings,
        "review_evidence": review_evidence_value,
        "verification": verification_value,
        "recommendation": recommendation_value,
    }


def run_cli(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-B", str(MODULE_PATH), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )


class PathSafetyTests(unittest.TestCase):
    def test_path_is_scoped_by_host_repo_and_pr(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            actual = ledger.ledger_path(Path(root), "github.com", "devos-ing", "Roc", 5)
            self.assertEqual(actual, Path(root).resolve() / "github.com" / "devos-ing" / "Roc" / "5.json")

    def test_path_accepts_a_safe_leading_dot_repository_name(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            actual = ledger.ledger_path(Path(root), "github.com", "devos-ing", ".github", 5)
            self.assertEqual(actual, Path(root).resolve() / "github.com" / "devos-ing" / ".github" / "5.json")

    def test_path_rejects_unsafe_components(self) -> None:
        invalid = ("", ".", "..", "owner/repo", "owner\\repo", "/absolute", "white space", "☃")
        with tempfile.TemporaryDirectory() as root:
            for component in invalid:
                with self.subTest(component=component), self.assertRaises(ValueError):
                    ledger.ledger_path(Path(root), component, "owner", "repo", 5)
                with self.subTest(owner=component), self.assertRaises(ValueError):
                    ledger.ledger_path(Path(root), "github.com", component, "repo", 5)
                with self.subTest(repo=component), self.assertRaises(ValueError):
                    ledger.ledger_path(Path(root), "github.com", "owner", component, 5)

    def test_path_rejects_non_positive_or_boolean_pr_numbers(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            for number in (0, -1, True):
                with self.subTest(number=number), self.assertRaises(ValueError):
                    ledger.ledger_path(Path(root), "github.com", "owner", "repo", number)

    def test_path_rejects_a_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            Path(root, "github.com").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "state root"):
                ledger.ledger_path(Path(root), "github.com", "owner", "repo", 5)

    def test_path_cli_prints_a_raw_filesystem_path(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            result = run_cli(
                "path",
                "--state-root", root,
                "--host", "github.com",
                "--owner", "owner",
                "--repo", "repo",
                "--pr", "5",
            )
            expected = str(Path(root).resolve() / "github.com" / "owner" / "repo" / "5.json")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, expected + "\n")


class InitializationTests(unittest.TestCase):
    def test_initialize_creates_incomplete_revision_zero(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            value = ledger.initialize_ledger(path, "github.com", "devos-ing", "Roc", 5, "base-0001", "head-0001")
            self.assertEqual(value["revision"], 0)
            self.assertEqual(value["review_state"], "incomplete")
            self.assertIsNone(value["review_evidence"])
            self.assertIsNone(value["verification"])
            self.assertIsNone(value["recommendation"])
            self.assertEqual(json.loads(path.read_text()), value)
            ledger.validate_ledger(value)

    def test_incomplete_ledger_cannot_be_used_as_a_completed_review(self) -> None:
        value = ledger_value(review_state="incomplete")
        ledger.validate_ledger(value)
        with self.assertRaisesRegex(ValueError, "complete"):
            ledger.validate_ledger(value, require_complete=True)
        with self.assertRaisesRegex(ValueError, "complete"):
            ledger.summarize_ledger(value)

    def test_cli_require_complete_rejects_an_interrupted_initialization(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            ledger.initialize_ledger(path, "github.com", "devos-ing", "Roc", 5, "base-0001", "head-0001")
            result = run_cli("validate", "--file", str(path), "--require-complete")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("complete", result.stderr)

    def test_initialize_refuses_to_overwrite_existing_state(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            path.write_bytes(b"existing bytes\n")
            with self.assertRaises(FileExistsError):
                ledger.initialize_ledger(path, "github.com", "devos-ing", "Roc", 5, "base-0001", "head-0001")
            self.assertEqual(path.read_bytes(), b"existing bytes\n")

    def test_initialize_refuses_pristine_state_when_an_orphan_backup_exists(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            path.with_name("5.invalid-20260831T010203000000Z-deadbeef.json").write_bytes(b"lost canonical\n")
            with self.assertRaisesRegex(ValueError, "recovery"):
                ledger.initialize_ledger(path, "github.com", "devos-ing", "Roc", 5, "base-0001", "head-0001")


class ContractValidationTests(unittest.TestCase):
    def test_complete_ledger_with_canonical_metadata_is_valid(self) -> None:
        ledger.validate_ledger(ledger_value(), require_complete=True)

    def test_validation_requires_exact_top_level_and_identity_fields(self) -> None:
        cases: list[tuple[str, dict[str, object]]] = []
        missing = ledger_value()
        missing.pop("revision")
        cases.append(("missing", missing))
        extra = ledger_value()
        extra["surprise"] = True
        cases.append(("extra", extra))
        identity_extra = ledger_value()
        identity_extra["pull_request"]["url"] = "https://example.invalid"
        cases.append(("identity-extra", identity_extra))
        boolean_revision = ledger_value()
        boolean_revision["revision"] = True
        cases.append(("boolean-revision", boolean_revision))
        array_state = ledger_value()
        array_state["review_state"] = []
        cases.append(("array-review-state", array_state))
        for name, value in cases:
            with self.subTest(name=name), self.assertRaises(ValueError):
                ledger.validate_ledger(value)

    def test_validation_enforces_incomplete_shape(self) -> None:
        value = ledger_value(review_state="incomplete")
        value["findings"] = [finding()]
        with self.assertRaisesRegex(ValueError, "incomplete"):
            ledger.validate_ledger(value)

    def test_validation_enforces_canonical_verification(self) -> None:
        mutations = {
            "unknown-status": {**verification(), "status": "unknown"},
            "wrong-head": verification("head-other"),
            "extra-field": {**verification(), "duration": 4},
            "non-string-output": {**verification(), "output": []},
        }
        for name, metadata in mutations.items():
            with self.subTest(name=name), self.assertRaises(ValueError):
                ledger.validate_ledger(ledger_value(verification_value=metadata))

    def test_missing_review_evidence_prevents_a_positive_recommendation(self) -> None:
        incomplete_evidence = review_evidence("inline_comments")
        indeterminate_value = ledger_value(recommendation_value=indeterminate())
        indeterminate_value["review_evidence"] = incomplete_evidence
        ledger.validate_ledger(indeterminate_value)

        positive_value = ledger_value()
        positive_value["review_evidence"] = incomplete_evidence
        with self.assertRaisesRegex(ValueError, "evidence"):
            ledger.validate_ledger(positive_value)

    def test_do_not_merge_requires_and_follows_an_open_blocker(self) -> None:
        blocker = finding(blocking=True)
        valid = ledger_value(
            findings=[blocker],
            verification_value=verification(status="not_run"),
            recommendation_value=recommendation(outcome="do_not_merge"),
        )
        ledger.validate_ledger(valid)
        with self.assertRaisesRegex(ValueError, "open blocking"):
            ledger.validate_ledger(ledger_value(recommendation_value=recommendation(outcome="do_not_merge")))
        with self.assertRaisesRegex(ValueError, "do_not_merge"):
            ledger.validate_ledger(ledger_value(findings=[blocker], recommendation_value=indeterminate()))

    def test_open_non_blocker_keeps_merge_readiness_indeterminate(self) -> None:
        advisory = finding(blocking=False)
        ledger.validate_ledger(ledger_value(findings=[advisory], recommendation_value=indeterminate()))
        with self.assertRaisesRegex(ValueError, "open finding"):
            ledger.validate_ledger(ledger_value(findings=[advisory], recommendation_value=recommendation()))

    def test_positive_recommendations_require_passed_verification_and_total_dispositions(self) -> None:
        failed = ledger_value(verification_value=verification(status="failed"), recommendation_value=recommendation())
        with self.assertRaisesRegex(ValueError, "verification"):
            ledger.validate_ledger(failed)
        deferred_item = finding(disposition="deferred", history=[{
            "from": "open", "to": "deferred", "reason": "The owner accepted follow-up work.", "head_sha": "head-0001",
        }])
        with self.assertRaisesRegex(ValueError, "follow"):
            ledger.validate_ledger(ledger_value(findings=[deferred_item], recommendation_value=recommendation()))
        ledger.validate_ledger(ledger_value(
            findings=[deferred_item],
            recommendation_value=recommendation(outcome="merge_ready_with_follow_ups"),
        ))
        with self.assertRaisesRegex(ValueError, "follow"):
            ledger.validate_ledger(ledger_value(recommendation_value=recommendation(outcome="merge_ready_with_follow_ups")))

    def test_validation_enforces_finding_ids_and_axis_prefixes(self) -> None:
        cases = (
            finding("STD-01", axis="standards"),
            finding("STD-000", axis="standards"),
            finding("SPEC-001", axis="standards"),
            finding("STD-001", axis="spec"),
        )
        for item in cases:
            with self.subTest(identifier=item["id"], axis=item["axis"]), self.assertRaisesRegex(ValueError, "id"):
                ledger.validate_ledger(ledger_value(findings=[item], recommendation_value=indeterminate()))

    def test_validation_enforces_canonical_history_and_allowed_transitions(self) -> None:
        invalid_histories = (
            [{"from": "open", "to": "fixed", "reason": "done", "head_sha": "head-0001", "extra": True}],
            [{"from": "open", "to": "open", "reason": "same", "head_sha": "head-0001"}],
            [{"from": "fixed", "to": "deferred", "reason": "changed", "head_sha": "head-0001"}],
        )
        for history in invalid_histories:
            item = finding(disposition=str(history[-1]["to"]), history=history)
            with self.subTest(history=history), self.assertRaisesRegex(ValueError, "history"):
                ledger.validate_ledger(ledger_value(findings=[item], recommendation_value=indeterminate()))
        mismatch = finding(disposition="open", history=[{
            "from": "open", "to": "fixed", "reason": "The route now passes.", "head_sha": "head-0001",
        }])
        with self.assertRaisesRegex(ValueError, "history"):
            ledger.validate_ledger(ledger_value(findings=[mismatch], recommendation_value=indeterminate()))

    def test_validation_enforces_canonical_lineage_resets(self) -> None:
        invalid = {
            "kind": "base_drift",
            "previous_base_sha": "base-0001",
            "current_base_sha": "base-0001",
            "previous_head_sha": "head-0001",
            "current_head_sha": "head-0002",
            "reason": "The base changed.",
        }
        with self.assertRaisesRegex(ValueError, "base_drift"):
            ledger.validate_ledger(ledger_value(lineage_resets=[invalid]))


class CompareAndReplaceTests(unittest.TestCase):
    def test_first_complete_write_creates_revision_zero(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            value = ledger_value()
            ledger.atomic_write(path, value)
            self.assertEqual(json.loads(path.read_text()), value)

    def test_first_complete_write_upgrades_an_initialized_ledger(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            ledger.initialize_ledger(path, "github.com", "devos-ing", "Roc", 5, "base-0001", "head-0001")
            replacement = ledger_value(revision=1)
            ledger.atomic_write(path, replacement, expected_revision=0)
            self.assertEqual(json.loads(path.read_text()), replacement)
            ledger.validate_ledger(replacement, require_complete=True)

    def test_replacing_existing_ledger_requires_expected_revision(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            ledger.atomic_write(path, ledger_value())
            old_bytes = path.read_bytes()
            with self.assertRaisesRegex(ValueError, "expected revision"):
                ledger.atomic_write(path, ledger_value(revision=1, head_sha="head-0002"))
            self.assertEqual(path.read_bytes(), old_bytes)

    def test_stale_or_skipped_revision_preserves_existing_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            ledger.atomic_write(path, ledger_value())
            old_bytes = path.read_bytes()
            for expected, next_revision in ((-1, 1), (0, 2)):
                with self.subTest(expected=expected, next_revision=next_revision), self.assertRaises(ValueError):
                    ledger.atomic_write(path, ledger_value(revision=next_revision, head_sha="head-0002"), expected_revision=expected)
                self.assertEqual(path.read_bytes(), old_bytes)

    def test_same_expected_revision_cannot_replace_twice(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            ledger.atomic_write(path, ledger_value())
            first = ledger_value(revision=1, head_sha="head-0002")
            second = ledger_value(revision=1, head_sha="head-0003")
            ledger.atomic_write(path, first, expected_revision=0)
            with self.assertRaisesRegex(ValueError, "stale"):
                ledger.atomic_write(path, second, expected_revision=0)
            self.assertEqual(json.loads(path.read_text()), first)

    def test_changed_head_rejects_review_evidence_from_the_previous_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            original = ledger_value()
            ledger.atomic_write(path, original)
            replacement = ledger_value(
                revision=1,
                head_sha="head-0002",
                review_evidence_value=copy.deepcopy(original["review_evidence"]),
            )

            with self.assertRaisesRegex(ValueError, "review_evidence.head_sha"):
                ledger.atomic_write(path, replacement, expected_revision=0)

    def test_update_preserves_pr_identity_findings_and_immutable_fields(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            original = ledger_value(findings=[finding()], recommendation_value=indeterminate())
            ledger.atomic_write(path, original)
            mutations: list[tuple[str, dict[str, object]]] = []
            changed_pr = copy.deepcopy(original)
            changed_pr["revision"] = 1
            changed_pr["pull_request"]["number"] = 6
            mutations.append(("identity", changed_pr))
            removed = copy.deepcopy(original)
            removed["revision"] = 1
            removed["findings"] = []
            removed["recommendation"] = recommendation()
            mutations.append(("removed", removed))
            changed_axis = copy.deepcopy(original)
            changed_axis["revision"] = 1
            changed_axis["findings"][0]["axis"] = "standards"
            changed_axis["findings"][0]["id"] = "STD-001"
            mutations.append(("axis", changed_axis))
            changed_first_seen = copy.deepcopy(original)
            changed_first_seen["revision"] = 1
            changed_first_seen["findings"][0]["first_seen_sha"] = "head-other"
            mutations.append(("first-seen", changed_first_seen))
            for name, replacement in mutations:
                with self.subTest(name=name), self.assertRaises(ValueError):
                    ledger.atomic_write(path, replacement, expected_revision=0)

    def test_update_requires_append_only_history_for_disposition_changes(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            original = ledger_value(findings=[finding()], recommendation_value=indeterminate())
            ledger.atomic_write(path, original)
            missing_history = copy.deepcopy(original)
            missing_history["revision"] = 1
            missing_history["last_reviewed_head_sha"] = "head-0002"
            missing_history["review_evidence"] = review_evidence(head_sha="head-0002")
            missing_history["verification"] = verification("head-0002")
            missing_history["recommendation"] = recommendation("head-0002")
            missing_history["findings"][0]["disposition"] = "fixed"
            with self.assertRaisesRegex(ValueError, "history"):
                ledger.atomic_write(path, missing_history, expected_revision=0)
            reopened = copy.deepcopy(original)
            reopened["revision"] = 1
            reopened["last_reviewed_head_sha"] = "head-0002"
            reopened["review_evidence"] = review_evidence(head_sha="head-0002")
            reopened["verification"] = verification("head-0002")
            reopened["recommendation"] = indeterminate("head-0002")
            reopened["findings"][0]["history"] = [
                {"from": "open", "to": "fixed", "reason": "The route passed at the first new commit.", "head_sha": "head-0002"},
                {"from": "fixed", "to": "open", "reason": "Verification regressed at the reviewed head.", "head_sha": "head-0002"},
            ]
            ledger.atomic_write(path, reopened, expected_revision=0)
            self.assertEqual(json.loads(path.read_text()), reopened)

    def test_update_rejects_truncated_history_and_wrong_transition_head(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            old_history = [{"from": "open", "to": "deferred", "reason": "The owner accepted follow-up work.", "head_sha": "head-0001"}]
            original = ledger_value(
                findings=[finding(disposition="deferred", history=old_history)],
                recommendation_value=recommendation(outcome="merge_ready_with_follow_ups"),
            )
            ledger.atomic_write(path, original)
            truncated = copy.deepcopy(original)
            truncated["revision"] = 1
            truncated["last_reviewed_head_sha"] = "head-0002"
            truncated["review_evidence"] = review_evidence(head_sha="head-0002")
            truncated["verification"] = verification("head-0002")
            truncated["recommendation"] = recommendation("head-0002", outcome="merge_ready_with_follow_ups")
            truncated["findings"][0]["history"] = []
            with self.assertRaisesRegex(ValueError, "history"):
                ledger.atomic_write(path, truncated, expected_revision=0)
            wrong_head = copy.deepcopy(original)
            wrong_head["revision"] = 1
            wrong_head["last_reviewed_head_sha"] = "head-0002"
            wrong_head["review_evidence"] = review_evidence(head_sha="head-0002")
            wrong_head["verification"] = verification("head-0002")
            wrong_head["recommendation"] = indeterminate("head-0002")
            wrong_head["findings"][0]["disposition"] = "open"
            wrong_head["findings"][0]["history"].append({
                "from": "deferred", "to": "open", "reason": "Relevant code changed.", "head_sha": "head-wrong",
            })
            with self.assertRaisesRegex(ValueError, "head"):
                ledger.atomic_write(path, wrong_head, expected_revision=0)

    def test_new_finding_uses_current_head_and_monotonic_axis_id(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            original = ledger_value(findings=[finding("SPEC-002")], recommendation_value=indeterminate())
            ledger.atomic_write(path, original)
            cases = (
                (finding("SPEC-003", first_seen_sha="head-old"), "current head"),
                (finding("SPEC-001", first_seen_sha="head-0002"), "above the prior"),
            )
            for new_item, message in cases:
                replacement = copy.deepcopy(original)
                replacement["revision"] = 1
                replacement["last_reviewed_head_sha"] = "head-0002"
                replacement["review_evidence"] = review_evidence(head_sha="head-0002")
                replacement["verification"] = verification("head-0002")
                replacement["recommendation"] = indeterminate("head-0002")
                replacement["findings"].append(new_item)
                with self.subTest(identifier=new_item["id"]), self.assertRaisesRegex(ValueError, message):
                    ledger.atomic_write(path, replacement, expected_revision=0)

    def test_base_drift_requires_append_only_canonical_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            ledger.atomic_write(path, ledger_value())
            changed = ledger_value(revision=1, base_sha="base-0002", head_sha="head-0002")
            with self.assertRaisesRegex(ValueError, "base_drift"):
                ledger.atomic_write(path, changed, expected_revision=0)
            changed["lineage_resets"] = [{
                "kind": "base_drift",
                "previous_base_sha": "base-0001",
                "current_base_sha": "base-0002",
                "previous_head_sha": "head-0001",
                "current_head_sha": "head-0002",
                "reason": "The pull request base SHA changed, so the full three-dot diff was reviewed again.",
            }]
            ledger.atomic_write(path, changed, expected_revision=0)
            self.assertEqual(json.loads(path.read_text()), changed)

    def test_force_push_evidence_is_preserved_across_later_updates(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            ledger.atomic_write(path, ledger_value())
            reset = {
                "kind": "force_push",
                "previous_base_sha": "base-0001",
                "current_base_sha": "base-0001",
                "previous_head_sha": "head-0001",
                "current_head_sha": "head-0002",
                "reason": "The saved head is not an ancestor of the current head.",
            }
            force_pushed = ledger_value(revision=1, head_sha="head-0002", lineage_resets=[reset])
            ledger.atomic_write(path, force_pushed, expected_revision=0)
            later = ledger_value(revision=2, head_sha="head-0003", lineage_resets=[reset])
            ledger.atomic_write(path, later, expected_revision=1)
            self.assertEqual(json.loads(path.read_text())["lineage_resets"], [reset])


class WorkflowFixtureTests(unittest.TestCase):
    def test_cli_first_review_persists_stable_axis_ids_and_re_review_advances_them(self) -> None:
        first = ledger_value(
            findings=[
                finding("STD-001", axis="standards"),
                finding("SPEC-001"),
            ],
            recommendation_value=indeterminate(),
        )
        replacement = ledger_value(
            revision=1,
            head_sha="head-0002",
            findings=[
                *first["findings"],
                finding("SPEC-002", first_seen_sha="head-0002"),
            ],
            recommendation_value=indeterminate("head-0002"),
        )

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            path = root_path / "5.json"
            first_input = root_path / "first.json"
            replacement_input = root_path / "replacement.json"
            first_input.write_text(json.dumps(first))
            replacement_input.write_text(json.dumps(replacement))

            first_result = run_cli("write", "--file", str(path), "--input", str(first_input))
            replacement_result = run_cli(
                "write",
                "--file",
                str(path),
                "--input",
                str(replacement_input),
                "--expected-revision",
                "0",
            )

            self.assertEqual(first_result.returncode, 0, first_result.stderr)
            self.assertEqual(replacement_result.returncode, 0, replacement_result.stderr)
            persisted = json.loads(path.read_text())

        self.assertEqual([item["id"] for item in persisted["findings"]], ["STD-001", "SPEC-001", "SPEC-002"])
        self.assertEqual(persisted["findings"][2]["first_seen_sha"], "head-0002")

    def test_later_round_closes_prior_work_suppresses_deferred_and_adds_one_blocker(self) -> None:
        deferred_history = [{
            "from": "open",
            "to": "deferred",
            "reason": "The owner accepted follow-up work.",
            "head_sha": "head-0001",
        }]
        original = ledger_value(
            findings=[
                finding("SPEC-001", blocking=True),
                finding("SPEC-002", disposition="deferred", history=deferred_history),
            ],
            verification_value=verification(status="not_run"),
            recommendation_value=recommendation(outcome="do_not_merge"),
        )
        replacement = copy.deepcopy(original)
        replacement["revision"] = 1
        replacement["last_reviewed_head_sha"] = "head-0002"
        replacement["review_evidence"] = review_evidence(head_sha="head-0002")
        replacement["verification"] = verification("head-0002")
        replacement["recommendation"] = recommendation("head-0002", outcome="do_not_merge")
        replacement["findings"][0]["disposition"] = "fixed"
        replacement["findings"][0]["history"] = [{
            "from": "open",
            "to": "fixed",
            "reason": "The acceptance condition now passes.",
            "head_sha": "head-0002",
        }]
        replacement["findings"].append(
            finding("SPEC-003", blocking=True, first_seen_sha="head-0002")
        )

        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            ledger.atomic_write(path, original)
            ledger.atomic_write(path, replacement, expected_revision=0)
            summary = ledger.summarize_ledger(json.loads(path.read_text()))

        self.assertEqual(summary["counts"], {"open": 1, "fixed": 1, "deferred": 1, "accepted": 0})
        self.assertEqual(summary["open_blocking_ids"], ["SPEC-003"])
        self.assertEqual(summary["recommendation"], "do_not_merge")

    def test_changed_deferred_work_can_reopen_and_return_to_deferred_without_losing_history(self) -> None:
        original_history = [{
            "from": "open",
            "to": "deferred",
            "reason": "The owner accepted follow-up work.",
            "head_sha": "head-0001",
        }]
        original = ledger_value(
            findings=[finding("SPEC-001", disposition="deferred", history=original_history)],
            recommendation_value=recommendation(outcome="merge_ready_with_follow_ups"),
        )
        replacement = ledger_value(
            revision=1,
            head_sha="head-0002",
            findings=[finding("SPEC-001", disposition="deferred", history=[
                *original_history,
                {
                    "from": "deferred",
                    "to": "open",
                    "reason": "Relevant validation code changed.",
                    "head_sha": "head-0002",
                },
                {
                    "from": "open",
                    "to": "deferred",
                    "reason": "The owner kept the follow-up disposition after re-review.",
                    "head_sha": "head-0002",
                },
            ])],
            recommendation_value=recommendation("head-0002", outcome="merge_ready_with_follow_ups"),
        )

        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            ledger.atomic_write(path, original)
            ledger.atomic_write(path, replacement, expected_revision=0)
            saved = json.loads(path.read_text())

        self.assertEqual(
            [(entry["from"], entry["to"]) for entry in saved["findings"][0]["history"]],
            [("open", "deferred"), ("deferred", "open"), ("open", "deferred")],
        )
        self.assertEqual(ledger.summarize_ledger(saved)["open_non_blocking_ids"], [])


class RecoveryTests(unittest.TestCase):
    def test_recover_invalid_preserves_exact_bad_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            bad = b"{not-json\r\n\x00"
            path.write_bytes(bad)
            replacement = ledger_value()
            invalid_path = ledger.recover_invalid(path, replacement)
            self.assertTrue(invalid_path.name.startswith("5.invalid-"))
            self.assertEqual(invalid_path.read_bytes(), bad)
            self.assertEqual(json.loads(path.read_text()), replacement)

    def test_recovery_failure_before_replace_keeps_canonical_and_backup(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            bad = b"malformed canonical bytes\n"
            path.write_bytes(bad)
            with mock.patch.object(ledger.os, "replace", side_effect=OSError("simulated replace failure")):
                with self.assertRaisesRegex(OSError, "simulated"):
                    ledger.recover_invalid(path, ledger_value())
            backups = sorted(path.parent.glob("5.invalid-*.json"))
            self.assertEqual(path.read_bytes(), bad)
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), bad)

    def test_recover_uses_orphan_backup_when_canonical_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            backup = path.with_name("5.invalid-20260831T010203000000Z-deadbeef.json")
            backup.write_bytes(b"orphaned invalid bytes\n")
            returned = ledger.recover_invalid(path, ledger_value())
            self.assertEqual(returned, backup)
            self.assertEqual(json.loads(path.read_text()), ledger_value())

    def test_recover_without_canonical_or_backup_is_not_a_first_write(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            with self.assertRaises(FileNotFoundError):
                ledger.recover_invalid(path, ledger_value())

    def test_recover_refuses_to_bypass_compare_and_replace_for_valid_state(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "5.json"
            original = ledger_value()
            ledger.atomic_write(path, original)
            with self.assertRaisesRegex(ValueError, "valid"):
                ledger.recover_invalid(path, ledger_value(revision=1, head_sha="head-0002"))
            self.assertEqual(json.loads(path.read_text()), original)


class SummaryTests(unittest.TestCase):
    def test_summary_groups_dispositions_and_open_blockers(self) -> None:
        fixed_history = [{"from": "open", "to": "fixed", "reason": "The route now passes.", "head_sha": "head-0001"}]
        deferred_history = [{"from": "open", "to": "deferred", "reason": "The owner accepted follow-up work.", "head_sha": "head-0001"}]
        accepted_history = [{"from": "open", "to": "accepted", "reason": "The owner accepted the documented risk.", "head_sha": "head-0001"}]
        findings = [
            finding("SPEC-001", blocking=True),
            finding("SPEC-002", disposition="fixed", history=fixed_history),
            finding("SPEC-003", disposition="deferred", history=deferred_history),
            finding("SPEC-004", disposition="accepted", history=accepted_history),
        ]
        value = ledger_value(findings=findings, recommendation_value=recommendation(outcome="do_not_merge"))
        result = ledger.summarize_ledger(value)
        self.assertEqual(result["counts"], {"open": 1, "fixed": 1, "deferred": 1, "accepted": 1})
        self.assertEqual(result["open_blocking_ids"], ["SPEC-001"])
        self.assertEqual(result["open_non_blocking_ids"], [])
        self.assertEqual(result["recommendation"], "do_not_merge")


if __name__ == "__main__":
    unittest.main()
