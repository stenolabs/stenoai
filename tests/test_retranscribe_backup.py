"""`reprocess --retranscribe` keeps a safety copy of the old note and speakers
sidecar (#599), the way full-reprocess already does.

The copy is made only after every segment transcribed successfully and before
the first write, so a refused or failed run leaves no `.bak-` file behind.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder

_NOTE = """\
---
title: "Sync"
duration_seconds: 600
language: "en"
configured_language: "en"
detected_language: "en"
is_diarised: false
folders: []
---

## Summary

Old summary

## Transcript

old transcript text
"""
_SIDECAR = '{"clusters": {"0": "old"}}'


async def _ok_transcribe(self, audio_file, session_name="Recording"):
    return {
        "transcript_text": "new transcript text",
        "is_diarised": False,
        "configured_language": "en",
        "detected_language": "en",
        "output_language": "en",
    }


async def _failed_transcribe(self, audio_file, session_name="Recording"):
    return {"transcription_failed": True, "error": "boom"}


def _overwrite_sidecar(output_dir, stem, result):
    (Path(output_dir) / f"{stem}_speakers.json").write_text('{"clusters": {"0": "new"}}')


class RetranscribeBackupTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"STENOAI_USER_DATA_DIR": self._tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        root = Path(self._tmp.name)
        (root / "recordings").mkdir()
        (root / "output").mkdir()
        self.note = root / "output" / "meet_summary.md"
        self.note.write_text(_NOTE)
        self.sidecar = root / "output" / "meet_speakers.json"
        self.sidecar.write_text(_SIDECAR)

    def _add_audio(self):
        (Path(self._tmp.name) / "recordings" / "meet.webm").write_bytes(b"audio")

    def _baks(self):
        return sorted(p.name for p in Path(self._tmp.name).rglob("*.bak-*"))

    def _invoke(self, transcribe, args=("--retranscribe",), backup=None):
        summarizer = mock.Mock(model_name="test-model")
        summarizer.summarize_transcript_streaming.return_value = iter(["## Summary\n\nNew\n"])
        patches = [
            mock.patch.object(simple_recorder.MeetingPipeline, "transcribe_audio", transcribe),
            mock.patch("src.summarizer.OllamaSummarizer", return_value=summarizer),
            mock.patch.object(simple_recorder, "_persist_speaker_sidecar", _overwrite_sidecar),
        ]
        if backup is not None:
            patches.append(mock.patch.object(simple_recorder, "_backup_meeting_files", backup))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return CliRunner().invoke(simple_recorder.reprocess, [str(self.note), *args])

    def test_success_keeps_copies_of_old_note_and_sidecar(self):
        self._add_audio()
        res = self._invoke(_ok_transcribe)

        self.assertEqual(res.exit_code, 0, res.output)
        baks = self._baks()
        self.assertEqual(len(baks), 2, baks)
        note_bak = next(self.note.parent.glob("meet_summary.md.bak-*"))
        sidecar_bak = next(self.note.parent.glob("meet_speakers.json.bak-*"))
        self.assertEqual(note_bak.read_text(), _NOTE)
        self.assertEqual(sidecar_bak.read_text(), _SIDECAR)
        # The live files really were rewritten.
        self.assertIn("new transcript text", self.note.read_text())
        self.assertIn("new", self.sidecar.read_text())
        # Backups are not listed as meetings.
        self.assertEqual(list(self.note.parent.glob("*_summary.md")), [self.note])

    def test_no_audio_gate_leaves_no_backup(self):
        res = self._invoke(_ok_transcribe)

        self.assertNotEqual(res.exit_code, 0)
        self.assertIn("STREAM_ERROR:RETRANSCRIBE_NO_AUDIO", res.output)
        self.assertEqual(self._baks(), [])

    def test_failed_transcription_leaves_no_backup(self):
        self._add_audio()
        res = self._invoke(_failed_transcribe)

        self.assertNotEqual(res.exit_code, 0)
        self.assertIn("STREAM_ERROR:boom", res.output)
        self.assertEqual(self._baks(), [])
        self.assertEqual(self.note.read_text(), _NOTE)
        self.assertEqual(self.sidecar.read_text(), _SIDECAR)

    def test_failing_backup_aborts_before_any_rewrite(self):
        self._add_audio()

        def broken(paths, stamp=None):
            raise OSError("disk full")

        res = self._invoke(_ok_transcribe, backup=broken)

        self.assertEqual(res.exit_code, 1, res.output)
        self.assertIn("STREAM_ERROR:", res.output)
        self.assertIn("disk full", res.output)
        self.assertEqual(self.note.read_text(), _NOTE)
        self.assertEqual(self.sidecar.read_text(), _SIDECAR)

    def test_plain_reprocess_creates_no_backup(self):
        res = self._invoke(_ok_transcribe, args=())

        self.assertEqual(res.exit_code, 0, res.output)
        self.assertEqual(self._baks(), [])


class BackupHelperTests(unittest.TestCase):
    def test_a_failed_copy_removes_the_copies_already_made(self):
        import shutil

        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "a_summary.md"
            second = Path(tmp) / "a_speakers.json"
            first.write_text("note")
            second.write_text("{}")
            real_copy2 = shutil.copy2

            def copy_then_fail(src, dst):
                if Path(src) == second:
                    # A real copy fails after creating its target.
                    Path(dst).write_text("{")
                    raise OSError("disk full")
                return real_copy2(src, dst)

            with mock.patch("shutil.copy2", side_effect=copy_then_fail):
                with self.assertRaises(OSError):
                    simple_recorder._backup_meeting_files((first, second), "20240101000000")

            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()),
                             ["a_speakers.json", "a_summary.md"])

    def test_missing_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            present = Path(tmp) / "a_summary.md"
            present.write_text("note")
            made = simple_recorder._backup_meeting_files(
                (present, Path(tmp) / "absent.json"), "20240101000000")
            self.assertEqual([Path(m).name for m in made],
                             ["a_summary.md.bak-20240101000000"])


if __name__ == "__main__":
    unittest.main()
