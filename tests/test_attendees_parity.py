"""Unit tests for attendee display name cleaning, frontmatter serialization,
and markdown parsing round-trips.
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import simple_recorder
from simple_recorder import (
    _clean_attendee_name,
    _render_frontmatter,
    _parse_meeting_markdown,
)
from click.testing import CliRunner
from src.config import Config


class AttendeeNameCleaningTests(unittest.TestCase):
    def test_extracts_display_name_from_angle_brackets(self):
        self.assertEqual(_clean_attendee_name("Audrey Tang <audrey@example.com>"), "Audrey Tang")
        self.assertEqual(_clean_attendee_name('"Audrey Tang" <audrey@example.com>'), "Audrey Tang")
        self.assertEqual(_clean_attendee_name("'Bob Smith' <bob@example.com>"), "Bob Smith")

    def test_drops_email_only_values(self):
        self.assertIsNone(_clean_attendee_name("audrey@example.com"))
        self.assertIsNone(_clean_attendee_name("<audrey@example.com>"))
        self.assertIsNone(_clean_attendee_name("mailto:audrey@example.com"))
        self.assertIsNone(_clean_attendee_name("  user@domain.org  "))

    def test_keeps_plain_display_names(self):
        self.assertEqual(_clean_attendee_name("Audrey Tang"), "Audrey Tang")
        self.assertEqual(_clean_attendee_name("  John Doe  "), "John Doe")
        self.assertEqual(_clean_attendee_name("唐鳳"), "唐鳳")

    def test_empty_or_none_returns_none(self):
        self.assertIsNone(_clean_attendee_name(""))
        self.assertIsNone(_clean_attendee_name("   "))
        self.assertIsNone(_clean_attendee_name(None))


class AttendeeFrontmatterRoundTripTests(unittest.TestCase):
    def test_render_frontmatter_serializes_attendees_list(self):
        meta = {
            "title": "Meeting",
            "attendees": ["Alice", "Bob", "唐鳳"],
        }
        lines = _render_frontmatter(meta)
        text = "\n".join(lines)
        self.assertIn('attendees: ["Alice", "Bob', text)

    def test_parse_meeting_markdown_extracts_attendees(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            p = Path(tmp_dir) / "meeting_summary.md"
            p.write_text(
                "---\ntitle: Team Sync\nattendees: ['Alice', 'Bob']\n---\n\n"
                "## Summary\nGood meeting.\n",
                encoding="utf-8"
            )
            data = _parse_meeting_markdown(p)
            self.assertIn("attendees", data)
            self.assertEqual(data["attendees"], ["Alice", "Bob"])

    def test_parse_meeting_markdown_omits_attendees_when_absent(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            p = Path(tmp_dir) / "meeting_summary.md"
            p.write_text(
                "---\ntitle: Team Sync\n---\n\n## Summary\nGood meeting.\n",
                encoding="utf-8"
            )
            data = _parse_meeting_markdown(p)
            self.assertNotIn("attendees", data)

    def test_reprocess_preserves_attendees(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            p = Path(tmp_dir) / "meeting_summary.md"
            p.write_text(
                "---\ntitle: Team Sync\nattendees: ['Alice', 'Bob']\nduration_seconds: 60\nlanguage: en\n---\n\n"
                "## Summary\nOld summary.\n\n## Transcript\nAlice: hello. Bob: world.\n",
                encoding="utf-8"
            )
            cfg = Config(config_path=Path(tmp_dir) / "config.json")
            fake = mock.MagicMock()
            fake.model_name = "llama3.2:3b"
            fake.summarize_transcript_streaming.return_value = iter(["## Summary\nNew summary."])

            with mock.patch("src.config.get_config", return_value=cfg), \
                 mock.patch("src.summarizer.OllamaSummarizer", return_value=fake):
                res = CliRunner().invoke(simple_recorder.reprocess, [str(p)])
                self.assertEqual(res.exit_code, 0)

            reparsed = _parse_meeting_markdown(p)
            self.assertIn("attendees", reparsed)
            self.assertEqual(reparsed["attendees"], ["Alice", "Bob"])


if __name__ == "__main__":
    unittest.main()
