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


class ReprocessCarriesMidRunEditsTests(unittest.TestCase):
    """The note stays readable while reprocess streams a new summary. A rename,
    a space assignment or a My notes edit made during that window must be in
    the rewritten note, not the start-of-run snapshot of them."""

    _NOTE = """\
---
title: "Weekly sync"
language: en
duration_seconds: 600
folders: ["f-old"]
---
## Summary

Existing summary

## Transcript

Alice: hi. Bob: bye.

## User Notes

Draft notes from before
"""

    def _run_with_mid_stream_edit(self, tmp, edit, *extra_args):
        note = Path(tmp) / "meeting_summary.md"
        note.write_text(self._NOTE, encoding="utf-8")
        fake = mock.MagicMock()
        fake.model_name = "llama3.2:3b"
        fake.generate_title.return_value = "Generated title"

        def _stream(*_a, **_k):
            yield "## Summary\n"
            # The user edits the note while the model is still streaming.
            note.write_text(edit(note.read_text(encoding="utf-8")), encoding="utf-8")
            yield "Regenerated summary body\n"

        fake.summarize_transcript_streaming.side_effect = _stream
        cfg = Config(config_path=Path(tmp) / "config.json")
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch("src.summarizer.OllamaSummarizer", return_value=fake):
            res = CliRunner().invoke(simple_recorder.reprocess, [str(note), *extra_args])
        self.assertEqual(res.exit_code, 0, res.output + repr(res.exception))
        return simple_recorder._parse_meeting_markdown(note), note.read_text(encoding="utf-8")

    def test_folders_title_and_my_notes_edited_mid_run_are_kept(self):
        def _edit(md):
            md = md.replace('folders: ["f-old"]', 'folders: ["f-old", "f-new"]')
            md = md.replace('title: "Weekly sync"', 'title: "Renamed during regenerate"')
            return md.replace("Draft notes from before", "Edited while it streamed")

        with tempfile.TemporaryDirectory() as tmp:
            parsed, raw = self._run_with_mid_stream_edit(tmp, _edit)
            self.assertEqual(parsed["folders"], ["f-old", "f-new"])
            self.assertEqual(parsed["session_info"]["name"], "Renamed during regenerate")
            self.assertEqual(parsed["user_notes"], "Edited while it streamed")
            self.assertIn("Regenerated summary body", raw)
            self.assertNotIn("Draft notes from before", raw)

    def test_a_mid_run_rename_beats_a_generated_title(self):
        # --regenerate-title generates a name, but a rename the user made
        # while it ran is the newer intent.
        def _edit(md):
            return md.replace('title: "Weekly sync"', 'title: "My own name"')

        with tempfile.TemporaryDirectory() as tmp:
            parsed, _raw = self._run_with_mid_stream_edit(tmp, _edit, "--regenerate-title")
            self.assertEqual(parsed["session_info"]["name"], "My own name")

    def test_without_edits_a_generated_title_and_the_snapshot_notes_stand(self):
        with tempfile.TemporaryDirectory() as tmp:
            parsed, _raw = self._run_with_mid_stream_edit(tmp, lambda md: md, "--regenerate-title")
            self.assertEqual(parsed["session_info"]["name"], "Generated title")
            self.assertEqual(parsed["folders"], ["f-old"])
            self.assertEqual(parsed["user_notes"], "Draft notes from before")

    def test_my_notes_cleared_mid_run_stay_cleared(self):
        def _edit(md):
            return md.split("## User Notes")[0].rstrip() + "\n"

        with tempfile.TemporaryDirectory() as tmp:
            parsed, raw = self._run_with_mid_stream_edit(tmp, _edit)
            self.assertIsNone(parsed["user_notes"])
            self.assertNotIn("User Notes", raw)
