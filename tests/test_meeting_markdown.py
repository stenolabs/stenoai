"""List/detail parser contract, shared with app/meeting-markdown.test.js."""
import json
import tempfile
import unittest
from pathlib import Path

from simple_recorder import _parse_meeting_markdown


class MeetingMarkdownContractTests(unittest.TestCase):
    def test_shared_fixtures(self):
        fixtures = json.loads(
            (Path(__file__).parent / "fixtures" / "meeting-markdown.json").read_text(
                encoding="utf-8"
            )
        )
        with tempfile.TemporaryDirectory() as tmp:
            note = Path(tmp) / "fixture.md"
            for case in fixtures["cases"]:
                for label, eol in (("LF", "\n"), ("CRLF", "\r\n")):
                    with self.subTest(case=case["name"], line_endings=label):
                        note.write_bytes(case["content"].replace("\n", eol).encode("utf-8"))
                        expected = {
                            **fixtures["defaults"],
                            **case["expected"],
                            "session_info": {
                                **fixtures["defaults"]["session_info"],
                                **case["expected"].get("session_info", {}),
                                "summary_file": str(note),
                            },
                        }
                        self.assertEqual(_parse_meeting_markdown(note), expected)


if __name__ == "__main__":
    unittest.main()
