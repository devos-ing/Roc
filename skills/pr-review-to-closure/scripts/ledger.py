"""Durable JSON ledger primitives for pull-request review findings."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import sys
from typing import Iterator
import uuid


DISPOSITIONS = {"open", "fixed", "deferred", "accepted"}
AXES = {"standards", "spec"}
SEVERITIES = {"P0", "P1", "P2", "P3"}
VERIFICATION_STATUSES = {"passed", "failed", "environment_error", "not_run"}
MERGE_OUTCOMES = {"do_not_merge", "merge_ready_with_follow_ups", "merge_ready"}
LINEAGE_KINDS = {"force_push", "base_drift"}

_TOP_LEVEL_FIELDS = {
    "version",
    "revision",
    "review_state",
    "pull_request",
    "base_sha",
    "last_reviewed_head_sha",
    "lineage_resets",
    "findings",
    "review_evidence",
    "verification",
    "recommendation",
}
_PR_FIELDS = {"host", "owner", "repo", "number"}
_FINDING_FIELDS = {
    "id",
    "axis",
    "severity",
    "blocking",
    "summary",
    "location",
    "evidence",
    "first_seen_sha",
    "acceptance",
    "disposition",
    "history",
}
_HISTORY_FIELDS = {"from", "to", "reason", "head_sha"}
_LINEAGE_FIELDS = {
    "kind",
    "previous_base_sha",
    "current_base_sha",
    "previous_head_sha",
    "current_head_sha",
    "reason",
}
_VERIFICATION_FIELDS = {"command", "head_sha", "status", "output"}
_REVIEW_EVIDENCE_FIELDS = {"sources"}
_REVIEW_EVIDENCE_SOURCE_FIELDS = {"status", "detail"}
_REQUIRED_REVIEW_EVIDENCE_SOURCES = {
    "pr_metadata",
    "pr_description",
    "reviews",
    "inline_comments",
    "issue_comments",
    "repository_standards",
}
_MERGE_RECOMMENDATION_FIELDS = {"kind", "outcome", "head_sha", "reasons"}
_INDETERMINATE_FIELDS = {"kind", "status", "head_sha", "reasons"}
_ALLOWED_TRANSITIONS = {
    "open": {"fixed", "deferred", "accepted"},
    "fixed": {"open"},
    "deferred": {"open"},
    "accepted": {"open"},
}
_COMPONENT_PATTERN = re.compile(r"[A-Za-z0-9._-]+\Z")
_FINDING_ID_PATTERN = re.compile(r"(STD|SPEC)-([0-9]{3,})\Z")


def _require_object(value: object, field: str) -> dict[str, object]:
    """Returns a JSON object or raises a field-specific validation error."""
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    return value


def _require_exact_fields(value: dict[str, object], fields: set[str], field: str) -> None:
    """Requires an object to contain exactly its canonical field set."""
    missing = fields - value.keys()
    extra = value.keys() - fields
    if missing or extra:
        details = []
        if missing:
            details.append(f"missing {', '.join(sorted(missing))}")
        if extra:
            details.append(f"unexpected {', '.join(sorted(extra))}")
        raise ValueError(f"{field} fields are invalid: {'; '.join(details)}")


def _require_string(value: object, field: str) -> str:
    """Returns a non-empty string or raises a field-specific validation error."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _require_nonnegative_integer(value: object, field: str) -> int:
    """Returns a non-negative integer while rejecting booleans."""
    if type(value) is not int or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def _require_positive_integer(value: object, field: str) -> int:
    """Returns a positive integer while rejecting booleans."""
    if type(value) is not int or value <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return value


def _require_component(value: object, field: str) -> str:
    """Returns a safe host or repository path component."""
    component = _require_string(value, field)
    if component in {".", ".."} or _COMPONENT_PATTERN.fullmatch(component) is None:
        raise ValueError(f"{field} contains unsupported path characters")
    return component


def ledger_path(
    state_root: Path,
    host: str,
    owner: str,
    repo: str,
    pr_number: int,
) -> Path:
    """Returns a resolved ledger path contained by the requested state root."""
    safe_host = _require_component(host, "host")
    safe_owner = _require_component(owner, "owner")
    safe_repo = _require_component(repo, "repo")
    safe_pr = _require_positive_integer(pr_number, "pr_number")
    resolved_root = state_root.expanduser().resolve(strict=False)
    candidate = (resolved_root / safe_host / safe_owner / safe_repo / f"{safe_pr}.json").resolve(strict=False)
    try:
        candidate.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError("ledger path escapes the state root") from error
    return candidate


def new_ledger(
    *,
    host: str,
    owner: str,
    repo: str,
    pr_number: int,
    base_sha: str,
    head_sha: str,
) -> dict[str, object]:
    """Builds an incomplete revision-zero ledger pinned to one pull request."""
    return {
        "version": 1,
        "revision": 0,
        "review_state": "incomplete",
        "pull_request": {
            "host": _require_component(host, "pull_request.host"),
            "owner": _require_component(owner, "pull_request.owner"),
            "repo": _require_component(repo, "pull_request.repo"),
            "number": _require_positive_integer(pr_number, "pull_request.number"),
        },
        "base_sha": _require_string(base_sha, "base_sha"),
        "last_reviewed_head_sha": _require_string(head_sha, "last_reviewed_head_sha"),
        "lineage_resets": [],
        "findings": [],
        "review_evidence": None,
        "verification": None,
        "recommendation": None,
    }


def _validate_history(history_value: object, disposition: str, finding_id: str) -> list[dict[str, object]]:
    """Validates one finding's ordered disposition transition history."""
    if not isinstance(history_value, list):
        raise ValueError(f"finding {finding_id} history must be an array")
    state = "open"
    history: list[dict[str, object]] = []
    for index, raw_entry in enumerate(history_value):
        entry = _require_object(raw_entry, f"finding {finding_id} history[{index}]")
        _require_exact_fields(entry, _HISTORY_FIELDS, f"finding {finding_id} history[{index}]")
        source = entry["from"]
        target = entry["to"]
        if not isinstance(source, str) or source not in DISPOSITIONS:
            raise ValueError(f"finding {finding_id} history[{index}].from is invalid")
        if not isinstance(target, str) or target not in DISPOSITIONS:
            raise ValueError(f"finding {finding_id} history[{index}].to is invalid")
        if source != state:
            raise ValueError(f"finding {finding_id} history[{index}] does not continue the prior disposition")
        if target not in _ALLOWED_TRANSITIONS[source]:
            raise ValueError(f"finding {finding_id} history[{index}] transition is not allowed")
        _require_string(entry["reason"], f"finding {finding_id} history[{index}].reason")
        _require_string(entry["head_sha"], f"finding {finding_id} history[{index}].head_sha")
        state = target
        history.append(entry)
    if state != disposition:
        raise ValueError(f"finding {finding_id} history ends at {state}, not {disposition}")
    return history


def _validate_finding(raw_finding: object, index: int) -> dict[str, object]:
    """Validates one canonical finding and returns it as an object."""
    item = _require_object(raw_finding, f"findings[{index}]")
    _require_exact_fields(item, _FINDING_FIELDS, f"findings[{index}]")
    finding_id = _require_string(item["id"], f"findings[{index}].id")
    match = _FINDING_ID_PATTERN.fullmatch(finding_id)
    if match is None or int(match.group(2)) <= 0:
        raise ValueError(f"finding id {finding_id!r} is invalid")
    axis = item["axis"]
    if not isinstance(axis, str) or axis not in AXES:
        raise ValueError(f"finding {finding_id} axis is invalid")
    expected_prefix = "STD" if axis == "standards" else "SPEC"
    if match.group(1) != expected_prefix:
        raise ValueError(f"finding id {finding_id!r} does not match axis {axis}")
    severity = item["severity"]
    if not isinstance(severity, str) or severity not in SEVERITIES:
        raise ValueError(f"finding {finding_id} severity is invalid")
    if type(item["blocking"]) is not bool:
        raise ValueError(f"finding {finding_id} blocking must be boolean")
    for field in ("summary", "location", "evidence", "first_seen_sha", "acceptance"):
        _require_string(item[field], f"finding {finding_id}.{field}")
    disposition = item["disposition"]
    if not isinstance(disposition, str) or disposition not in DISPOSITIONS:
        raise ValueError(f"finding {finding_id} disposition is invalid")
    _validate_history(item["history"], disposition, finding_id)
    return item


def _validate_lineage_reset(raw_reset: object, index: int) -> dict[str, object]:
    """Validates one canonical force-push or base-drift lineage record."""
    reset = _require_object(raw_reset, f"lineage_resets[{index}]")
    _require_exact_fields(reset, _LINEAGE_FIELDS, f"lineage_resets[{index}]")
    kind = reset["kind"]
    if not isinstance(kind, str) or kind not in LINEAGE_KINDS:
        raise ValueError(f"lineage_resets[{index}].kind is invalid")
    for field in (
        "previous_base_sha",
        "current_base_sha",
        "previous_head_sha",
        "current_head_sha",
        "reason",
    ):
        _require_string(reset[field], f"lineage_resets[{index}].{field}")
    if kind == "base_drift" and reset["previous_base_sha"] == reset["current_base_sha"]:
        raise ValueError(f"lineage_resets[{index}] base_drift must change the base SHA")
    if kind == "force_push" and reset["previous_head_sha"] == reset["current_head_sha"]:
        raise ValueError(f"lineage_resets[{index}] force_push must change the head SHA")
    return reset


def _validate_verification(value: object, head_sha: str) -> dict[str, object]:
    """Validates canonical verification evidence for the reviewed head."""
    metadata = _require_object(value, "verification")
    _require_exact_fields(metadata, _VERIFICATION_FIELDS, "verification")
    _require_string(metadata["command"], "verification.command")
    verification_head = _require_string(metadata["head_sha"], "verification.head_sha")
    if verification_head != head_sha:
        raise ValueError("verification.head_sha must match last_reviewed_head_sha")
    status = metadata["status"]
    if not isinstance(status, str) or status not in VERIFICATION_STATUSES:
        raise ValueError("verification.status is invalid")
    _require_string(metadata["output"], "verification.output")
    return metadata


def _validate_review_evidence(value: object) -> dict[str, object]:
    """Validates the required PR and repository evidence source results."""
    evidence = _require_object(value, "review_evidence")
    _require_exact_fields(evidence, _REVIEW_EVIDENCE_FIELDS, "review_evidence")
    sources = _require_object(evidence["sources"], "review_evidence.sources")
    _require_exact_fields(sources, _REQUIRED_REVIEW_EVIDENCE_SOURCES, "review_evidence.sources")
    for name, raw_source in sources.items():
        source = _require_object(raw_source, f"review_evidence.sources.{name}")
        _require_exact_fields(source, _REVIEW_EVIDENCE_SOURCE_FIELDS, f"review_evidence.sources.{name}")
        if source["status"] not in {"read", "missing"}:
            raise ValueError(f"review_evidence.sources.{name}.status is invalid")
        _require_string(source["detail"], f"review_evidence.sources.{name}.detail")
    return evidence


def _missing_review_evidence(evidence: dict[str, object]) -> list[str]:
    """Returns required evidence source names that were not read successfully."""
    return [
        str(name)
        for name, source in evidence["sources"].items()
        if source["status"] == "missing"
    ]


def _validate_reasons(value: object) -> list[str]:
    """Validates a non-empty recommendation reason list."""
    if not isinstance(value, list) or not value:
        raise ValueError("recommendation.reasons must be a non-empty array")
    reasons = []
    for index, reason in enumerate(value):
        reasons.append(_require_string(reason, f"recommendation.reasons[{index}]"))
    return reasons


def _validate_recommendation(
    value: object,
    head_sha: str,
    findings: list[dict[str, object]],
    review_evidence: dict[str, object],
    verification: dict[str, object],
) -> dict[str, object]:
    """Validates a recommendation and its merge-readiness predicates."""
    metadata = _require_object(value, "recommendation")
    kind = metadata.get("kind")
    if kind == "merge_decision":
        _require_exact_fields(metadata, _MERGE_RECOMMENDATION_FIELDS, "recommendation")
        outcome = metadata["outcome"]
        if not isinstance(outcome, str) or outcome not in MERGE_OUTCOMES:
            raise ValueError("recommendation.outcome is invalid")
        status = None
    elif kind == "indeterminate":
        _require_exact_fields(metadata, _INDETERMINATE_FIELDS, "recommendation")
        status = metadata["status"]
        if status != "merge_readiness_not_established":
            raise ValueError("recommendation.status is invalid")
        outcome = None
    else:
        raise ValueError("recommendation.kind is invalid")
    recommendation_head = _require_string(metadata["head_sha"], "recommendation.head_sha")
    if recommendation_head != head_sha:
        raise ValueError("recommendation.head_sha must match last_reviewed_head_sha")
    _validate_reasons(metadata["reasons"])

    open_blockers = [item for item in findings if item["disposition"] == "open" and item["blocking"]]
    open_non_blockers = [item for item in findings if item["disposition"] == "open" and not item["blocking"]]
    follow_ups = [item for item in findings if item["disposition"] in {"deferred", "accepted"}]
    if open_blockers:
        if outcome != "do_not_merge":
            raise ValueError("an open blocking finding requires do_not_merge")
    elif outcome == "do_not_merge":
        raise ValueError("do_not_merge requires an open blocking finding")
    elif open_non_blockers:
        if status != "merge_readiness_not_established":
            raise ValueError("an unresolved open finding prevents a merge-ready recommendation")
    elif _missing_review_evidence(review_evidence):
        if status != "merge_readiness_not_established":
            raise ValueError("missing review evidence prevents a merge-ready recommendation")
    elif verification["status"] != "passed":
        if status != "merge_readiness_not_established":
            raise ValueError("a positive recommendation requires passed verification")
    elif follow_ups:
        if outcome != "merge_ready_with_follow_ups":
            raise ValueError("deferred or accepted follow-up work requires merge_ready_with_follow_ups")
    elif outcome != "merge_ready":
        raise ValueError("merge_ready_with_follow_ups requires deferred or accepted follow-up work")
    return metadata


def validate_ledger(value: dict[str, object], *, require_complete: bool = False) -> None:
    """Validates the full ledger contract and optional completed-review requirement."""
    ledger = _require_object(value, "ledger")
    _require_exact_fields(ledger, _TOP_LEVEL_FIELDS, "ledger")
    if type(ledger["version"]) is not int or ledger["version"] != 1:
        raise ValueError("version must be the integer 1")
    revision = _require_nonnegative_integer(ledger["revision"], "revision")
    review_state = ledger["review_state"]
    if not isinstance(review_state, str) or review_state not in {"incomplete", "complete"}:
        raise ValueError("review_state must be incomplete or complete")
    pr = _require_object(ledger["pull_request"], "pull_request")
    _require_exact_fields(pr, _PR_FIELDS, "pull_request")
    for field in ("host", "owner", "repo"):
        _require_component(pr[field], f"pull_request.{field}")
    _require_positive_integer(pr["number"], "pull_request.number")
    _require_string(ledger["base_sha"], "base_sha")
    head_sha = _require_string(ledger["last_reviewed_head_sha"], "last_reviewed_head_sha")
    lineage_value = ledger["lineage_resets"]
    findings_value = ledger["findings"]
    if not isinstance(lineage_value, list):
        raise ValueError("lineage_resets must be an array")
    if not isinstance(findings_value, list):
        raise ValueError("findings must be an array")
    lineage = [_validate_lineage_reset(item, index) for index, item in enumerate(lineage_value)]
    findings = [_validate_finding(item, index) for index, item in enumerate(findings_value)]
    identifiers = [str(item["id"]) for item in findings]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("duplicate finding id")

    if review_state == "incomplete":
        if (
            revision != 0
            or lineage
            or findings
            or ledger["review_evidence"] is not None
            or ledger["verification"] is not None
            or ledger["recommendation"] is not None
        ):
            raise ValueError("an incomplete ledger must remain an empty revision-zero bootstrap")
        if require_complete:
            raise ValueError("a complete review ledger is required")
        return

    review_evidence = _validate_review_evidence(ledger["review_evidence"])
    verification = _validate_verification(ledger["verification"], head_sha)
    _validate_recommendation(ledger["recommendation"], head_sha, findings, review_evidence, verification)


def _finding_number(item: dict[str, object]) -> int:
    """Returns the numeric suffix of a validated finding ID."""
    match = _FINDING_ID_PATTERN.fullmatch(str(item["id"]))
    assert match is not None
    return int(match.group(2))


def _validate_replacement(
    previous: dict[str, object],
    replacement: dict[str, object],
    expected_revision: int,
) -> None:
    """Validates compare-and-replace and append-only cross-version invariants."""
    validate_ledger(previous)
    validate_ledger(replacement, require_complete=True)
    actual_revision = int(previous["revision"])
    if expected_revision != actual_revision:
        raise ValueError(f"stale expected revision {expected_revision}; current revision is {actual_revision}")
    if replacement["revision"] != actual_revision + 1:
        raise ValueError("replacement revision must increment the current revision by one")
    if replacement["pull_request"] != previous["pull_request"]:
        raise ValueError("replacement pull_request identity must match the canonical ledger")
    if previous["review_state"] == "complete" and replacement["review_state"] != "complete":
        raise ValueError("a complete ledger cannot return to incomplete")

    old_findings = {str(item["id"]): item for item in previous["findings"]}
    new_findings = {str(item["id"]): item for item in replacement["findings"]}
    missing_ids = old_findings.keys() - new_findings.keys()
    if missing_ids:
        raise ValueError(f"finding IDs cannot disappear: {', '.join(sorted(missing_ids))}")
    new_head = str(replacement["last_reviewed_head_sha"])
    for finding_id, old_item in old_findings.items():
        new_item = new_findings[finding_id]
        if new_item["axis"] != old_item["axis"]:
            raise ValueError(f"finding {finding_id} axis is immutable")
        if new_item["first_seen_sha"] != old_item["first_seen_sha"]:
            raise ValueError(f"finding {finding_id} first_seen_sha is immutable")
        old_history = old_item["history"]
        new_history = new_item["history"]
        if new_history[: len(old_history)] != old_history:
            raise ValueError(f"finding {finding_id} history is append-only")
        appended = new_history[len(old_history) :]
        if not appended:
            if new_item["disposition"] != old_item["disposition"]:
                raise ValueError(f"finding {finding_id} disposition changes require appended history")
        else:
            if appended[0]["from"] != old_item["disposition"]:
                raise ValueError(f"finding {finding_id} appended history must start at its prior disposition")
            if appended[-1]["to"] != new_item["disposition"]:
                raise ValueError(f"finding {finding_id} appended history must end at its new disposition")
            if any(entry["head_sha"] != new_head for entry in appended):
                raise ValueError(f"finding {finding_id} appended history must cite the current head SHA")

    for axis in sorted(AXES):
        prior_axis_items = [item for item in old_findings.values() if item["axis"] == axis]
        prior_maximum = max((_finding_number(item) for item in prior_axis_items), default=0)
        added_axis_items = [
            item for finding_id, item in new_findings.items()
            if finding_id not in old_findings and item["axis"] == axis
        ]
        for item in added_axis_items:
            if item["first_seen_sha"] != new_head:
                raise ValueError(f"new finding {item['id']} must use the current head as first_seen_sha")
            if _finding_number(item) <= prior_maximum:
                raise ValueError(f"new finding {item['id']} must use an ID above the prior {axis} maximum")
            if any(entry["head_sha"] != new_head for entry in item["history"]):
                raise ValueError(f"new finding {item['id']} history must cite the current head SHA")

    old_resets = previous["lineage_resets"]
    new_resets = replacement["lineage_resets"]
    if new_resets[: len(old_resets)] != old_resets:
        raise ValueError("lineage_resets is append-only")
    appended_resets = new_resets[len(old_resets) :]
    for reset in appended_resets:
        if (
            reset["previous_base_sha"] != previous["base_sha"]
            or reset["previous_head_sha"] != previous["last_reviewed_head_sha"]
            or reset["current_base_sha"] != replacement["base_sha"]
            or reset["current_head_sha"] != replacement["last_reviewed_head_sha"]
        ):
            raise ValueError("new lineage reset evidence must match the prior and current base/head SHAs")
    if replacement["base_sha"] != previous["base_sha"] and not any(
        reset["kind"] == "base_drift" for reset in appended_resets
    ):
        raise ValueError("a changed base SHA requires appended base_drift evidence")


@contextmanager
def _ledger_lock(path: Path) -> Iterator[None]:
    """Holds an exclusive sidecar lock for one canonical ledger update."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f".{path.name}.lock")
    with lock_path.open("a+b") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _fsync_directory(directory: Path) -> None:
    """Flushes directory metadata after a durable file operation."""
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _json_bytes(value: dict[str, object]) -> bytes:
    """Serializes a ledger to stable UTF-8 JSON bytes."""
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _replace_bytes(path: Path, content: bytes) -> None:
    """Durably replaces a file from a same-directory temporary file."""
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path: Path) -> dict[str, object]:
    """Reads a JSON object from disk for a ledger operation."""
    value = json.loads(path.read_text(encoding="utf-8"))
    return _require_object(value, "JSON input")


def _invalid_backups(path: Path) -> list[Path]:
    """Returns sorted invalid-ledger backups associated with a canonical path."""
    return sorted(path.parent.glob(f"{path.stem}.invalid-*{path.suffix}"))


def atomic_write(
    path: Path,
    value: dict[str, object],
    *,
    expected_revision: int | None = None,
) -> dict[str, object]:
    """Creates or compare-and-replaces a complete ledger with an atomic write."""
    validate_ledger(value, require_complete=True)
    if expected_revision is not None:
        _require_nonnegative_integer(expected_revision, "expected revision")
    with _ledger_lock(path):
        if path.exists():
            if expected_revision is None:
                raise ValueError("an expected revision is required to replace an existing ledger")
            previous = _read_json(path)
            _validate_replacement(previous, value, expected_revision)
        else:
            if expected_revision is not None:
                raise ValueError("stale expected revision: the canonical ledger does not exist")
            if _invalid_backups(path):
                raise ValueError("orphaned invalid backups require recovery instead of a pristine write")
            if value["revision"] != 0:
                raise ValueError("a first complete ledger must use revision 0")
        _replace_bytes(path, _json_bytes(value))
    return value


def initialize_ledger(
    path: Path,
    host: str,
    owner: str,
    repo: str,
    pr_number: int,
    base_sha: str,
    head_sha: str,
) -> dict[str, object]:
    """Creates an incomplete revision-zero bootstrap without overwriting prior state."""
    value = new_ledger(
        host=host,
        owner=owner,
        repo=repo,
        pr_number=pr_number,
        base_sha=base_sha,
        head_sha=head_sha,
    )
    validate_ledger(value)
    with _ledger_lock(path):
        if path.exists():
            raise FileExistsError(path)
        if _invalid_backups(path):
            raise ValueError("orphaned invalid backups require recovery instead of initialization")
        _replace_bytes(path, _json_bytes(value))
    return value


def _write_invalid_backup(path: Path, content: bytes) -> Path:
    """Durably copies exact invalid bytes to a unique timestamped backup."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    for _ in range(10):
        backup = path.with_name(f"{path.stem}.invalid-{stamp}-{uuid.uuid4().hex[:8]}{path.suffix}")
        try:
            with backup.open("xb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            _fsync_directory(path.parent)
            return backup
        except FileExistsError:
            continue
    raise FileExistsError("could not allocate a unique invalid-ledger backup")


def _validate_recovery_source(content: bytes, replacement: dict[str, object]) -> None:
    """Preserves trustworthy identity and revision facts from parseable invalid state."""
    try:
        source = json.loads(content.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        return
    if not isinstance(source, dict):
        return
    identity = source.get("pull_request")
    if isinstance(identity, dict) and set(identity) == _PR_FIELDS and identity != replacement["pull_request"]:
        raise ValueError("recovery replacement pull_request identity does not match the invalid ledger")
    revision = source.get("revision")
    if type(revision) is int and revision >= 0 and replacement["revision"] != revision + 1:
        raise ValueError("recovery replacement revision must increment the parseable invalid revision")


def recover_invalid(path: Path, replacement: dict[str, object]) -> Path:
    """Copies invalid bytes durably, then atomically installs a complete replacement."""
    validate_ledger(replacement, require_complete=True)
    with _ledger_lock(path):
        if path.exists():
            invalid_bytes = path.read_bytes()
            try:
                current = _read_json(path)
                validate_ledger(current)
            except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
                pass
            else:
                raise ValueError("canonical ledger is valid; use compare-and-replace write")
            _validate_recovery_source(invalid_bytes, replacement)
            backup = _write_invalid_backup(path, invalid_bytes)
        else:
            backups = _invalid_backups(path)
            if not backups:
                raise FileNotFoundError(path)
            backup = backups[-1]
            _validate_recovery_source(backup.read_bytes(), replacement)
        _replace_bytes(path, _json_bytes(replacement))
    return backup


def summarize_ledger(value: dict[str, object]) -> dict[str, object]:
    """Returns disposition counts, open IDs, and the canonical completed recommendation."""
    validate_ledger(value, require_complete=True)
    counts = {disposition: 0 for disposition in ("open", "fixed", "deferred", "accepted")}
    blockers: list[str] = []
    non_blockers: list[str] = []
    for item in value["findings"]:
        disposition = str(item["disposition"])
        counts[disposition] += 1
        if disposition == "open":
            target = blockers if item["blocking"] else non_blockers
            target.append(str(item["id"]))
    recommendation = value["recommendation"]
    decision = recommendation.get("outcome", recommendation.get("status"))
    return {
        "counts": counts,
        "open_blocking_ids": blockers,
        "open_non_blocking_ids": non_blockers,
        "missing_review_evidence": _missing_review_evidence(value["review_evidence"]),
        "recommendation": decision,
    }


def _build_parser() -> argparse.ArgumentParser:
    """Builds the ledger command-line parser."""
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)

    path_parser = subcommands.add_parser("path")
    path_parser.add_argument("--state-root", type=Path, required=True)
    path_parser.add_argument("--host", required=True)
    path_parser.add_argument("--owner", required=True)
    path_parser.add_argument("--repo", required=True)
    path_parser.add_argument("--pr", type=int, required=True)

    init_parser = subcommands.add_parser("init")
    init_parser.add_argument("--file", type=Path, required=True)
    init_parser.add_argument("--host", required=True)
    init_parser.add_argument("--owner", required=True)
    init_parser.add_argument("--repo", required=True)
    init_parser.add_argument("--pr", type=int, required=True)
    init_parser.add_argument("--base-sha", required=True)
    init_parser.add_argument("--head-sha", required=True)

    validate_parser = subcommands.add_parser("validate")
    validate_parser.add_argument("--file", type=Path, required=True)
    validate_parser.add_argument("--require-complete", action="store_true")

    summary_parser = subcommands.add_parser("summary")
    summary_parser.add_argument("--file", type=Path, required=True)

    write_parser = subcommands.add_parser("write")
    write_parser.add_argument("--file", type=Path, required=True)
    write_parser.add_argument("--input", type=Path, required=True)
    write_parser.add_argument("--expected-revision", type=int)

    recover_parser = subcommands.add_parser("recover")
    recover_parser.add_argument("--file", type=Path, required=True)
    recover_parser.add_argument("--input", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Runs the ledger command-line interface and reports controlled errors."""
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
        if args.command == "path":
            print(ledger_path(args.state_root, args.host, args.owner, args.repo, args.pr))
            return 0
        if args.command == "init":
            result: object = initialize_ledger(
                args.file,
                args.host,
                args.owner,
                args.repo,
                args.pr,
                args.base_sha,
                args.head_sha,
            )
        elif args.command == "validate":
            value = _read_json(args.file)
            validate_ledger(value, require_complete=args.require_complete)
            result = {
                "valid": True,
                "review_state": value["review_state"],
                "revision": value["revision"],
            }
        elif args.command == "write":
            result = atomic_write(
                args.file,
                _read_json(args.input),
                expected_revision=args.expected_revision,
            )
        elif args.command == "recover":
            replacement = _read_json(args.input)
            backup = recover_invalid(args.file, replacement)
            result = {
                "backup": str(backup),
                "review_state": replacement["review_state"],
                "revision": replacement["revision"],
            }
        else:
            result = summarize_ledger(_read_json(args.file))
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
