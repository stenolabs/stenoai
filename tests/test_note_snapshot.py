import json
import tempfile
import unittest
from pathlib import Path

from simple_recorder import _write_original_snapshot

_NOTE_TEMPLATE = """---
title: "Weekly Sync"
---

## Summary

{summary}

## Key Points

- Budget approved

## Action Items

- Anna sends the draft

## Key Topics

### Budget

Reviewed.
"""


class WriteOriginalSnapshotTests(unittest.TestCase):
    """`_write_original_snapshot` reads the note it is given back from disk and
    parses it with `_parse_meeting_markdown` (the mirror of app/main.js's
    parseMeetingMarkdown), rather than accepting a fields dict directly - that
    way the snapshot agrees field-for-field with what the note editor itself
    reads back from the same file."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.summary_path = self.dir / "Weekly_Sync_summary.md"
        self.summary_path.write_text(
            _NOTE_TEMPLATE.format(summary="We agreed the budget."), encoding="utf-8"
        )

    def snapshot(self):
        return json.loads((self.dir / "Weekly_Sync_original.json").read_text(encoding="utf-8"))

    def test_writes_the_model_output_with_generation_provenance(self):
        _write_original_snapshot(self.summary_path)
        data = self.snapshot()
        self.assertEqual(data["version"], 1)
        self.assertEqual(data["capture"], "generation")
        self.assertEqual(data["original"]["summary"], "We agreed the budget.")
        self.assertEqual(data["original"]["key_points"], ["Budget approved"])
        self.assertEqual(data["original"]["action_items"], ["Anna sends the draft"])
        self.assertEqual(
            data["original"]["discussion_areas"],
            [{"title": "Budget", "analysis": "Reviewed."}],
        )
        self.assertEqual(data["edited_fields"], [])

    def test_regeneration_overwrites_the_previous_snapshot(self):
        _write_original_snapshot(self.summary_path)
        self.summary_path.write_text(
            _NOTE_TEMPLATE.format(summary="A regenerated summary."), encoding="utf-8"
        )
        _write_original_snapshot(self.summary_path)
        self.assertEqual(self.snapshot()["original"]["summary"], "A regenerated summary.")

    def test_regeneration_clears_the_recorded_edits(self):
        """The reset half of the regenerate guard's loop.

        `edited_fields` is the only thing the confirm dialog fires on. A
        regenerate has just discarded whatever those edits were (the user
        confirmed it, or there was no editor open to protect), so the note is
        unedited again and the NEXT regenerate must not prompt. Without this
        reset the dialog would fire on every later regenerate forever, and a
        user who is warned every time learns to click through the warning -
        which costs exactly the edits it exists to protect.
        """
        _write_original_snapshot(self.summary_path)
        # Stand in for app/note-snapshot.js's markEdited: the user edited the
        # summary, so the sidecar records it and the guard would prompt.
        sidecar = self.dir / "Weekly_Sync_original.json"
        edited = json.loads(sidecar.read_text(encoding="utf-8"))
        edited["edited_fields"] = ["summary", "action_items"]
        edited["edited_at"] = "2026-07-28T12:00:00"
        sidecar.write_text(json.dumps(edited), encoding="utf-8")

        self.summary_path.write_text(
            _NOTE_TEMPLATE.format(summary="A regenerated summary."), encoding="utf-8"
        )
        _write_original_snapshot(self.summary_path)

        after = self.snapshot()
        self.assertEqual(after["edited_fields"], [])
        self.assertIsNone(after["edited_at"])
        # And the diff base is the regenerated text, not the pre-edit one.
        self.assertEqual(after["original"]["summary"], "A regenerated summary.")
        self.assertEqual(after["capture"], "generation")

    def test_a_write_failure_never_raises_into_the_pipeline(self):
        # A missing/read-only directory must not fail the whole run: the note
        # matters, the snapshot is best-effort. This path also never gets far
        # enough to read the (nonexistent) note back, so it exercises the
        # broad except around the whole body, not just the write call.
        unwritable = Path("/nonexistent-dir-for-test") / "x_summary.md"
        _write_original_snapshot(unwritable)

    def test_a_path_not_ending_in_summary_md_is_rejected_without_writing(self):
        # Anchored guard, mirroring app/note-snapshot.js's noteSnapshotPath: an
        # unanchored str.replace()-based derivation would silently produce the
        # wrong sidecar path for a summary file that doesn't end in
        # "_summary.md" and could overwrite the note itself. reprocess gates
        # its .md branch on suffix == '.md', not on the "_summary" stem, so a
        # bare ".md" path is reachable in practice, not just theoretical.
        bare_md = self.dir / "Weekly_Sync.md"
        bare_md.write_text("not a real note", encoding="utf-8")
        _write_original_snapshot(bare_md)
        self.assertFalse((self.dir / "Weekly_Sync.json").exists())
        self.assertEqual(bare_md.read_text(encoding="utf-8"), "not a real note")


if __name__ == "__main__":
    unittest.main()
