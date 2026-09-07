from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("evidence.py")


class EvidenceSnapshotTests(unittest.TestCase):
    def run_snapshot(self, body: str | None) -> tuple[subprocess.CompletedProcess[str], dict[str, object], list[list[str]]]:
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            record_path = root_path / "gh-record.jsonl"
            stub_path = root_path / "gh"
            body_literal = repr(body)
            stub_path.write_text(
                f"""#!{sys.executable}
import json
import os
import sys

arguments = sys.argv[1:]
with open(os.environ["GH_RECORD"], "a", encoding="utf-8") as record:
    record.write(json.dumps(arguments) + "\\n")
if arguments[:2] == ["pr", "view"]:
    print(json.dumps({{
        "number": 17,
        "url": "https://github.com/devos-ing/Roc/pull/17",
        "baseRefOid": "base-0001",
        "headRefOid": "head-0001",
        "title": "Package skill",
        "body": {body_literal},
        "reviews": [{{"state": "COMMENTED"}}],
        "comments": [{{"body": "Issue comment"}}]
    }}))
elif arguments[:3] == ["api", "--paginate", "--slurp"]:
    print(json.dumps([[{{"body": "Inline comment"}}]]))
else:
    raise SystemExit(9)
""",
                encoding="utf-8",
            )
            stub_path.chmod(stub_path.stat().st_mode | stat.S_IXUSR)
            environment = {**os.environ, "GH_RECORD": str(record_path)}

            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(MODULE_PATH),
                    "snapshot",
                    "--gh",
                    str(stub_path),
                    "--repository",
                    "devos-ing/Roc",
                    "--pr",
                    "17",
                ],
                capture_output=True,
                text=True,
                check=False,
                env=environment,
            )
            snapshot = json.loads(result.stdout) if result.returncode == 0 else {}
            commands = [json.loads(line) for line in record_path.read_text(encoding="utf-8").splitlines()]
            return result, snapshot, commands

    def test_snapshot_uses_only_recorded_read_commands(self) -> None:
        result, snapshot, commands = self.run_snapshot("Description")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(snapshot["pull_request"]["head_sha"], "head-0001")
        self.assertEqual(snapshot["review_evidence"]["head_sha"], "head-0001")
        self.assertEqual(snapshot["inline_comments"], [{"body": "Inline comment"}])
        self.assertEqual(commands, [
            [
                "pr", "view", "17", "--repo", "devos-ing/Roc", "--json",
                "number,url,baseRefOid,headRefOid,title,body,reviews,comments",
            ],
            ["api", "--paginate", "--slurp", "repos/devos-ing/Roc/pulls/17/comments"],
        ])
        prohibited = {"comment", "review", "edit", "merge", "close", "push"}
        self.assertFalse(any(prohibited.intersection(command) for command in commands))

    def test_absent_or_blank_description_is_missing_evidence(self) -> None:
        for body in (None, "   "):
            with self.subTest(body=body):
                result, snapshot, _commands = self.run_snapshot(body)

                self.assertEqual(result.returncode, 0, result.stderr)
                description = snapshot["review_evidence"]["sources"]["pr_description"]
                self.assertEqual(description["status"], "missing")
                self.assertIn("no non-empty description", description["detail"])


if __name__ == "__main__":
    unittest.main()
