"""Re-transcribe of a continued note (continue-recording).

A continued note spans several recordings, but its filename stem matches only
the first. Re-transcribe used to find just that one and replace the whole
transcript with it, silently dropping every continued segment. The append path
now records each segment's recording stem in `continued_recordings`, and
re-transcribe runs every segment and rejoins them.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder

_MD = """\
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

first part
"""


def _fake_transcribe(texts):
    async def fake(self, audio_file, session_name="Recording"):
        return {
            "transcript_text": texts[Path(audio_file).stem],
            "is_diarised": False,
            "configured_language": "en",
            "detected_language": "en",
            "output_language": "en",
        }
    return fake


class AppendRecordsRecordingTests(unittest.TestCase):
    def test_md_append_lists_each_continued_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            note = Path(tmp) / "first_summary.md"
            note.write_text(_MD)
            simple_recorder._append_segment_to_note(note, "second part", 60, recording_stem="second")
            simple_recorder._append_segment_to_note(note, "third part", 60, recording_stem="third")

            meeting = simple_recorder._parse_meeting_markdown(note)
            self.assertEqual(meeting["continued_recordings"], ["second", "third"])
            self.assertIn("second part", meeting["transcript"])
            self.assertTrue(meeting["session_info"]["notes_stale"])

    def test_json_append_lists_continued_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            note = Path(tmp) / "first_summary.json"
            note.write_text(json.dumps({"transcript": "first part", "session_info": {}}))
            simple_recorder._append_segment_to_note(note, "second part", 60, recording_stem="second")
            self.assertEqual(json.loads(note.read_text())["continued_recordings"], ["second"])


class RetranscribeContinuedNoteTests(unittest.TestCase):
    def _setup(self, tmp, recordings, suffix=".md"):
        rec_dir = Path(tmp) / "recordings"
        rec_dir.mkdir()
        for name in recordings:
            (rec_dir / name).write_bytes(b"audio")
        note = Path(tmp) / f"first_summary{suffix}"
        if suffix == ".md":
            note.write_text(_MD)
        else:
            note.write_text(json.dumps({
                "session_info": {"name": "Sync", "duration_seconds": 600},
                "transcript": "first part",
            }))
        return note

    def _invoke(self, note, texts):
        summarizer = mock.Mock(model_name="test-model")
        summarizer.summarize_transcript_streaming.return_value = iter(["## Summary\n\nNew summary\n"])
        with mock.patch.object(simple_recorder.MeetingPipeline, "transcribe_audio", _fake_transcribe(texts)), \
             mock.patch("src.summarizer.OllamaSummarizer", return_value=summarizer), \
             mock.patch.object(simple_recorder, "_persist_speaker_sidecar"):
            return CliRunner().invoke(simple_recorder.reprocess, [str(note), "--retranscribe"])

    def test_every_segment_is_retranscribed_and_rejoined(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {"STENOAI_USER_DATA_DIR": tmp}):
            note = self._setup(tmp, ["first.webm", "second.webm"])
            simple_recorder._append_segment_to_note(note, "old second", 60, recording_stem="second")
            separator = next(
                ln for ln in note.read_text().splitlines() if ln.startswith("--- Resumed")
            )

            res = self._invoke(note, {"first": "new first", "second": "new second"})

            self.assertEqual(res.exit_code, 0, res.output)
            meeting = simple_recorder._parse_meeting_markdown(note)
            self.assertEqual(
                meeting["transcript"], f"new first\n\n{separator}\n\nnew second"
            )
            # A later re-transcribe must still find the continued segment.
            self.assertEqual(meeting["continued_recordings"], ["second"])

    def test_json_note_is_retranscribed_and_keeps_its_list(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {"STENOAI_USER_DATA_DIR": tmp}):
            note = self._setup(tmp, ["first.webm", "second.webm"], suffix=".json")
            simple_recorder._append_segment_to_note(note, "old second", 60, recording_stem="second")
            separator = json.loads(note.read_text())["transcript"].split("\n\n")[1]

            res = self._invoke(note, {"first": "new first", "second": "new second"})

            self.assertEqual(res.exit_code, 0, res.output)
            data = json.loads(note.read_text())
            self.assertEqual(data["transcript"], f"new first\n\n{separator}\n\nnew second")
            self.assertEqual(data["continued_recordings"], ["second"])

    def test_a_part_that_now_comes_back_silent_keeps_its_place(self):
        # Dropping it would delete a part of the meeting the note already had.
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {"STENOAI_USER_DATA_DIR": tmp}):
            note = self._setup(tmp, ["first.webm", "second.webm"])
            simple_recorder._append_segment_to_note(note, "old second", 60, recording_stem="second")
            separator = next(
                ln for ln in note.read_text().splitlines() if ln.startswith("--- Resumed")
            )

            res = self._invoke(note, {"first": "new first", "second": ""})

            self.assertEqual(res.exit_code, 0, res.output)
            self.assertEqual(
                simple_recorder._parse_meeting_markdown(note)["transcript"],
                f"new first\n\n{separator}\n\n{simple_recorder._SILENCE_SENTINEL}",
            )

    def test_note_continued_before_the_list_existed_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {"STENOAI_USER_DATA_DIR": tmp}):
            note = self._setup(tmp, ["first.webm", "second.webm"])
            simple_recorder._append_segment_to_note(note, "old second", 60)
            before = note.read_text()

            res = self._invoke(note, {"first": "new first", "second": "new second"})

            self.assertNotEqual(res.exit_code, 0, res.output)
            self.assertIn("STREAM_ERROR:RETRANSCRIBE_UNLINKED_SEGMENTS", res.output)
            self.assertEqual(note.read_text(), before)

    def test_missing_continued_recording_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {"STENOAI_USER_DATA_DIR": tmp}):
            note = self._setup(tmp, ["first.webm"])
            simple_recorder._append_segment_to_note(note, "old second", 60, recording_stem="second")
            before = note.read_text()

            res = self._invoke(note, {"first": "new first"})

            self.assertNotEqual(res.exit_code, 0, res.output)
            self.assertIn("STREAM_ERROR:RETRANSCRIBE_NO_AUDIO", res.output)
            self.assertEqual(note.read_text(), before)


if __name__ == "__main__":
    unittest.main()
