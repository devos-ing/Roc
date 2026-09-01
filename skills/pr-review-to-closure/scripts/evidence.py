"""Collect a read-only GitHub pull-request evidence snapshot."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys


_REPOSITORY_PATTERN = re.compile(r"([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)\Z")
_PR_VIEW_FIELDS = "number,url,baseRefOid,headRefOid,title,body,reviews,comments"


def _repository(value: str) -> tuple[str, str]:
    """Parses an owner/repository identity without accepting path syntax."""
    match = _REPOSITORY_PATTERN.fullmatch(value)
    if match is None or match.group(1) in {".", ".."} or match.group(2) in {".", ".."}:
        raise argparse.ArgumentTypeError("repository must be OWNER/REPO with safe path components")
    return match.group(1), match.group(2)


def _positive_integer(value: str) -> int:
    """Parses a positive integer command-line value."""
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("PR number must be positive")
    return number


def _run_json(command: list[str]) -> object:
    """Runs one read-only gh command and returns its JSON value."""
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"gh evidence command failed with exit code {result.returncode}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("gh evidence command returned invalid JSON") from error


def _required_string(value: object, field: str) -> str:
    """Returns a non-empty string or raises a field-specific snapshot error."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"pull request field {field} must be a non-empty string")
    return value


def collect_snapshot(gh: str, repository: tuple[str, str], pr_number: int) -> dict[str, object]:
    """Collects PR metadata, discussion, and inline comments through read-only gh commands."""
    owner, repo = repository
    identity = f"{owner}/{repo}"
    metadata_value = _run_json([
        gh,
        "pr",
        "view",
        str(pr_number),
        "--repo",
        identity,
        "--json",
        _PR_VIEW_FIELDS,
    ])
    if not isinstance(metadata_value, dict):
        raise ValueError("gh pr view must return a JSON object")
    if metadata_value.get("number") != pr_number:
        raise ValueError("gh pr view returned a different PR number")
    reviews = metadata_value.get("reviews")
    issue_comments = metadata_value.get("comments")
    if not isinstance(reviews, list) or not isinstance(issue_comments, list):
        raise ValueError("gh pr view reviews and comments must be arrays")
    inline_pages = _run_json([
        gh,
        "api",
        "--paginate",
        "--slurp",
        f"repos/{owner}/{repo}/pulls/{pr_number}/comments",
    ])
    if not isinstance(inline_pages, list) or any(not isinstance(page, list) for page in inline_pages):
        raise ValueError("gh inline review comments must be an array of pages")
    inline_comments = [comment for page in inline_pages for comment in page]
    body = metadata_value.get("body")
    if body is not None and not isinstance(body, str):
        raise ValueError("pull request field body must be a string or null")
    base_sha = _required_string(metadata_value.get("baseRefOid"), "baseRefOid")
    head_sha = _required_string(metadata_value.get("headRefOid"), "headRefOid")
    description_read = isinstance(body, str) and bool(body.strip())
    return {
        "pull_request": {
            "owner": owner,
            "repo": repo,
            "number": pr_number,
            "url": _required_string(metadata_value.get("url"), "url"),
            "base_sha": base_sha,
            "head_sha": head_sha,
            "title": _required_string(metadata_value.get("title"), "title"),
            "description": "" if body is None else body,
        },
        "reviews": reviews,
        "issue_comments": issue_comments,
        "inline_comments": inline_comments,
        "review_evidence": {
            "head_sha": head_sha,
            "sources": {
                "pr_metadata": {"status": "read", "detail": "Read with gh pr view."},
                "pr_description": {
                    "status": "read" if description_read else "missing",
                    "detail": (
                        "Read a non-empty description with gh pr view."
                        if description_read
                        else "The pull request has no non-empty description."
                    ),
                },
                "reviews": {"status": "read", "detail": "Read with gh pr view."},
                "inline_comments": {"status": "read", "detail": "Read with the GitHub pull-request review-comment API."},
                "issue_comments": {"status": "read", "detail": "Read with gh pr view."},
                "repository_standards": {
                    "status": "missing",
                    "detail": "The PR snapshot does not inspect local repository standards.",
                },
            }
        },
    }


def _build_parser() -> argparse.ArgumentParser:
    """Builds the read-only evidence command-line parser."""
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    snapshot = subcommands.add_parser("snapshot")
    snapshot.add_argument("--gh", default="gh")
    snapshot.add_argument("--repository", type=_repository, required=True)
    snapshot.add_argument("--pr", type=_positive_integer, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Runs the evidence CLI and emits either one snapshot or a controlled error."""
    try:
        args = _build_parser().parse_args(argv)
        if args.command == "snapshot":
            print(json.dumps(collect_snapshot(args.gh, args.repository, args.pr), indent=2, sort_keys=True))
            return 0
        raise ValueError("unknown command")
    except (OSError, RuntimeError, ValueError) as error:
        print(f"evidence snapshot failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
