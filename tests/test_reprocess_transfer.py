"""Regression coverage for reprocessing imported .stenomeeting JSON notes."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.config import Config


def _imported_meeting(summary_path):
    return {
        "session_info": {
            "name": "Imported meeting",
            "summary_file": str(summary_path),
            "processed_at": "2026-09-12T10:00:00+00:00",
            "duration_seconds": 120,
            "notes_generated": False,
            "notes_stale": True,
        },
        "summary": "",
        "transcript": "Alice: Ship the release Friday.\nBob: Agreed.",
        "user_notes": "Keep the migration reversible.",
        "participants": [],
        "discussion_areas": [],
        "key_points": [],
        "action_items": [],
        "folders": [],
        "steno_transfer": {
            "sourceMeetingID": "11111111-2222-3333-4444-555555555555",
            "contentDigest": "a" * 64,
            "importedTranscriptText": "Alice: Ship the release Friday.\nBob: Agreed.",
        },
    }


def _fake_summarizer():
    fake = mock.MagicMock()
    fake.model_name = "llama3.2:3b"
    fake.summarize_transcript_streaming.return_value = iter(
        ["## Summary\n", "The release ships Friday.\n"]
    )
    return fake


def _run_reprocess(tmp, summary_path, fake):
    cfg = Config(config_path=Path(tmp) / "config.json")
    env = {"STENOAI_USER_DATA_DIR": str(Path(tmp) / "user-data")}
    with mock.patch.dict(os.environ, env), \
            mock.patch("src.config.get_config", return_value=cfg), \
            mock.patch("src.summarizer.OllamaSummarizer", return_value=fake):
        return CliRunner().invoke(simple_recorder.reprocess, [str(summary_path)])


class ReprocessTransferTests(unittest.TestCase):
    def test_full_reprocess_cannot_consume_an_imported_track(self):
        for override in (False, True):
            with self.subTest(override=override), tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / "output"
                output.mkdir()
                stem = "transfer_11111111-2222-3333-4444-555555555555"
                summary_path = output / f"{stem}_summary.json"
                original = json.dumps(_imported_meeting(summary_path)).encode()
                summary_path.write_bytes(original)
                track = output / ".meeting-transfer" / stem / "track-1.caf"
                track.parent.mkdir(parents=True)
                track.write_bytes(b"synthetic retained audio")
                cfg = Config(config_path=Path(tmp) / "config.json")
                args = [stem] + (["--audio-file", str(track)] if override else [])
                with mock.patch.dict(os.environ, {"STENOAI_USER_DATA_DIR": tmp}), \
                        mock.patch("src.config.get_config", return_value=cfg), \
                        mock.patch.object(simple_recorder.process_streaming, "callback") as pipeline:
                    result = CliRunner().invoke(simple_recorder.full_reprocess, args)
                self.assertNotEqual(result.exit_code, 0)
                self.assertIn("not supported for imported Steno packages", result.output)
                pipeline.assert_not_called()
                self.assertEqual(summary_path.read_bytes(), original)
                self.assertEqual(track.read_bytes(), b"synthetic retained audio")
                self.assertEqual(sorted(p.name for p in output.iterdir()),
                                 [".meeting-transfer", summary_path.name])

    def test_success_preserves_import_data_and_clears_generate_notes_flags(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary_path = Path(tmp) / "transfer_summary.json"
            original = _imported_meeting(summary_path)
            summary_path.write_text(json.dumps(original), encoding="utf-8")

            result = _run_reprocess(tmp, summary_path, _fake_summarizer())

            self.assertEqual(result.exit_code, 0, result.output)
            saved = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["summary"], "The release ships Friday.")
            self.assertNotIn("notes_generated", saved["session_info"])
            self.assertNotIn("notes_stale", saved["session_info"])
            self.assertEqual(saved["steno_transfer"], original["steno_transfer"])
            self.assertEqual(saved["user_notes"], original["user_notes"])
            self.assertEqual(saved["transcript"], original["transcript"])
            self.assertIn("STREAM_COMPLETE", result.output)

    def test_markdown_success_clears_both_generate_notes_flags(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary_path = Path(tmp) / "meeting_summary.md"
            summary_path.write_text(
                "---\n"
                'title: "Imported meeting"\n'
                'date: "2026-09-12T10:00:00+00:00"\n'
                "duration_seconds: 120\n"
                "notes_generated: false\n"
                "notes_stale: true\n"
                "---\n\n"
                "## Transcript\n\n"
                "Alice: Ship the release Friday.\n",
                encoding="utf-8",
            )

            result = _run_reprocess(tmp, summary_path, _fake_summarizer())

            self.assertEqual(result.exit_code, 0, result.output)
            frontmatter = summary_path.read_text(encoding="utf-8").split("---")[1]
            self.assertNotIn("notes_generated:", frontmatter)
            self.assertNotIn("notes_stale:", frontmatter)

    def test_failed_atomic_publication_preserves_original_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary_path = Path(tmp) / "transfer_summary.json"
            original = _imported_meeting(summary_path)
            original_bytes = json.dumps(original, separators=(",", ":")).encode()
            summary_path.write_bytes(original_bytes)

            with mock.patch(
                "simple_recorder._atomic_write_text",
                side_effect=OSError("simulated publication failure"),
            ):
                result = _run_reprocess(tmp, summary_path, _fake_summarizer())

            self.assertNotEqual(result.exit_code, 0)
            self.assertNotIn("STREAM_COMPLETE", result.output)
            self.assertEqual(summary_path.read_bytes(), original_bytes)


if __name__ == "__main__":
    unittest.main()
