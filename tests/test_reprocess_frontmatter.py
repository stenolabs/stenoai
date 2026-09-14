# tests/test_reprocess_frontmatter.py
"""Regression tests for reprocess's .md frontmatter rebuild (#276 review).

The reprocess CLI rewrites a .md meeting's frontmatter from scratch. It must
carry forward two fields that may have existed in the original file:
  - `folders` (list of folder IDs the meeting belongs to)
  - `is_live_transcript` (bool, only present when true)
Dropping either silently removes the meeting from all its folders / loses the
live-transcript flag on every regenerate.
"""
import json
import tempfile
import unittest
from pathlib import Path

from click.testing import CliRunner
from unittest import mock

import simple_recorder
from src.config import Config

_MD_TEMPLATE = """\
---
title: My Meeting
language: en
duration_seconds: 600
{extra}---
## Summary

Existing summary

## Transcript

Alice: hi. Bob: bye.
"""


def _write_summary(tmp, extra_frontmatter=""):
    p = Path(tmp) / "meeting_summary.md"
    p.write_text(_MD_TEMPLATE.format(extra=extra_frontmatter))
    return p


def _fake_summarizer():
    fake = mock.MagicMock()
    fake.model_name = "llama3.2:3b"
    fake.summarize_transcript_streaming.return_value = iter(
        ["## Summary\n", "Regenerated summary body\n"]
    )
    return fake


def _run_reprocess(tmp, summary_path):
    cfg = Config(config_path=Path(tmp) / "config.json")
    with mock.patch("src.config.get_config", return_value=cfg), \
         mock.patch("src.summarizer.OllamaSummarizer", return_value=_fake_summarizer()):
        return CliRunner().invoke(simple_recorder.reprocess, [str(summary_path)])


class ReprocessFrontmatterTests(unittest.TestCase):
    def test_folders_preserved_across_reprocess(self):
        """reprocess must not drop the meeting's folder membership."""
        with tempfile.TemporaryDirectory() as tmp:
            summary = _write_summary(tmp, extra_frontmatter='folders: ["folder-abc"]\n')
            res = _run_reprocess(tmp, summary)
            self.assertEqual(res.exit_code, 0, res.output)

            reparsed = simple_recorder._parse_meeting_markdown(summary)
            self.assertIn("folder-abc", reparsed["folders"])

    def test_is_live_transcript_preserved_across_reprocess(self):
        """reprocess must carry forward the is_live_transcript flag when true."""
        with tempfile.TemporaryDirectory() as tmp:
            summary = _write_summary(tmp, extra_frontmatter="is_live_transcript: true\n")
            res = _run_reprocess(tmp, summary)
            self.assertEqual(res.exit_code, 0, res.output)

            reparsed = simple_recorder._parse_meeting_markdown(summary)
            self.assertTrue(reparsed["session_info"].get("is_live_transcript"))

    def test_no_folders_key_writes_empty_list(self):
        """A meeting with no folders key must reprocess cleanly to folders: []."""
        with tempfile.TemporaryDirectory() as tmp:
            summary = _write_summary(tmp)  # no folders, no is_live_transcript
            res = _run_reprocess(tmp, summary)
            self.assertEqual(res.exit_code, 0, res.output)

            # Check the raw frontmatter, not just the parsed result — the parser
            # defaults a *missing* folders key to [] too, so asserting only on
            # the parsed value wouldn't distinguish "wrote folders: []" from
            # "wrote nothing at all".
            frontmatter = summary.read_text().split('---')[1]
            self.assertIn('folders: []', frontmatter)

            reparsed = simple_recorder._parse_meeting_markdown(summary)
            self.assertEqual(reparsed["folders"], [])
            # is_live_transcript must NOT be injected when it was never set.
            self.assertNotIn("is_live_transcript", reparsed["session_info"])

    def test_language_provenance_preserved_across_reprocess(self):
        """reprocess must carry forward configured/detected language provenance.

        Without it, a re-detection on the next reprocess/chat could discard a
        valid Whisper engine detection (#283).
        """
        with tempfile.TemporaryDirectory() as tmp:
            summary = _write_summary(
                tmp,
                extra_frontmatter="configured_language: de\ndetected_language: de\n",
            )
            res = _run_reprocess(tmp, summary)
            self.assertEqual(res.exit_code, 0, res.output)

            reparsed = simple_recorder._parse_meeting_markdown(summary)
            self.assertEqual(reparsed["session_info"]["configured_language"], "de")
            self.assertEqual(reparsed["session_info"]["detected_language"], "de")

    def test_missing_provenance_reprocesses_to_null_provenance(self):
        """A legacy note without provenance stays provenance-less (null), so the
        recovery paths keep re-detecting rather than trusting a stale value."""
        with tempfile.TemporaryDirectory() as tmp:
            summary = _write_summary(tmp)  # no configured/detected keys
            res = _run_reprocess(tmp, summary)
            self.assertEqual(res.exit_code, 0, res.output)

            frontmatter = summary.read_text().split('---')[1]
            self.assertIn('configured_language: null', frontmatter)
            self.assertIn('detected_language: null', frontmatter)

            reparsed = simple_recorder._parse_meeting_markdown(summary)
            self.assertIsNone(reparsed["session_info"]["configured_language"])
            self.assertIsNone(reparsed["session_info"]["detected_language"])

    def test_writes_original_snapshot_on_regenerate(self):
        """reprocess must snapshot the regenerated note into <stem>_original.json
        so the note editor has a diff base and can warn before a future
        regenerate discards the user's own edits. Deleting the call this test
        guards (simple_recorder._write_original_snapshot in reprocess's .md
        branch) must make this test fail, not silently pass."""
        with tempfile.TemporaryDirectory() as tmp:
            summary = _write_summary(tmp)
            res = _run_reprocess(tmp, summary)
            self.assertEqual(res.exit_code, 0, res.output)

            snapshot_path = Path(tmp) / "meeting_original.json"
            self.assertTrue(
                snapshot_path.exists(),
                "reprocess must write an <stem>_original.json sidecar",
            )
            snapshot = json.loads(snapshot_path.read_text())
            self.assertEqual(snapshot["version"], 1)
            self.assertEqual(snapshot["capture"], "generation")
            self.assertEqual(snapshot["original"]["summary"], "Regenerated summary body")
            self.assertEqual(snapshot["edited_fields"], [])


if __name__ == "__main__":
    unittest.main()
