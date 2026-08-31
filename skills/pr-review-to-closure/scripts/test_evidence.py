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
    def test_snapshot_uses_only_recorded_read_commands(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            record_path = root_path / "gh-record.jsonl"
            stub_path = root_path / "gh"
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
        "body": "Description",
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

            self.assertEqual(result.returncode, 0, result.stderr)
            snapshot = json.loads(result.stdout)
            self.assertEqual(snapshot["pull_request"]["head_sha"], "head-0001")
            self.assertEqual(snapshot["inline_comments"], [{"body": "Inline comment"}])
            commands = [json.loads(line) for line in record_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(commands, [
                [
                    "pr", "view", "17", "--repo", "devos-ing/Roc", "--json",
                    "number,url,baseRefOid,headRefOid,title,body,reviews,comments",
                ],
                ["api", "--paginate", "--slurp", "repos/devos-ing/Roc/pulls/17/comments"],
            ])
            prohibited = {"comment", "review", "edit", "merge", "close", "push"}
            self.assertFalse(any(prohibited.intersection(command) for command in commands))


if __name__ == "__main__":
    unittest.main()
