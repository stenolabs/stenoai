"""`has_audio` on list-meetings: does this note's original recording still
exist on disk?

keep_recordings defaults OFF, so for most notes it does not -- and
everything that depends on the audio (re-transcribe, the speaker panel's
listening samples, any future re-diarization) is quietly unavailable
without it, with nothing in the list saying so until you open the note and
find the action missing.

Derived from ONE directory listing rather than a per-meeting existence
check: this command is on the app's cold-start path and its docstring
calls it "optimized for fast loading", so the cost must not scale with
library size.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.config import Config


def _run(tmp, cfg=None):
    cfg = cfg or Config(config_path=Path(tmp) / "config.json")
    with mock.patch("src.config.get_config", return_value=cfg), \
         mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
        result = CliRunner().invoke(simple_recorder.list_meetings, [])
    return json.loads(
        [ln for ln in result.output.splitlines() if ln.strip().startswith("[")][-1]
    )


def _write_note(tmp, stem, title):
    output_dir = Path(tmp) / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / f"{stem}_summary.md").write_text(
        f'---\ntitle: "{title}"\ndate: "2026-08-02T10:00:00"\n'
        f'duration_seconds: 600\nlanguage: "en"\nis_diarised: false\n---\n\n'
        "## Summary\n\nbody\n",
        encoding="utf-8",
    )


def _write_recording(tmp, name):
    recordings = Path(tmp) / "recordings"
    recordings.mkdir(parents=True, exist_ok=True)
    (recordings / name).write_bytes(b"stub")


class ListMeetingsHasAudioTests(unittest.TestCase):
    def test_flags_only_the_notes_whose_recording_survives(self):
        with tempfile.TemporaryDirectory() as tmp:
            _write_note(tmp, "kept", "Kept")
            _write_note(tmp, "gone", "Gone")
            _write_recording(tmp, "kept.webm")

            by_title = {m["session_info"]["name"]: m for m in _run(tmp)}
            self.assertTrue(by_title["Kept"]["has_audio"])
            self.assertFalse(by_title["Gone"]["has_audio"])

    def test_any_recording_format_counts(self):
        # The capture pipeline saves whatever the source produced -- .webm
        # for system audio, .wav for native captures, .m4a/.mp3 for
        # imports. Matching on the stem alone is what makes this correct
        # for all of them; an extension whitelist would silently mark
        # imported meetings as audio-less.
        for extension in ("webm", "wav", "m4a", "mp3"):
            with tempfile.TemporaryDirectory() as tmp:
                _write_note(tmp, "note", "Note")
                _write_recording(tmp, f"note.{extension}")
                self.assertTrue(
                    _run(tmp)[0]["has_audio"], f".{extension} was not recognised",
                )

    def test_a_recordings_dir_that_does_not_exist_is_not_an_error(self):
        # Fresh install: nothing has audio, and the list must still render.
        with tempfile.TemporaryDirectory() as tmp:
            _write_note(tmp, "note", "Note")
            self.assertFalse(Path(tmp, "recordings").exists())
            meetings = _run(tmp)
            self.assertEqual(len(meetings), 1)
            self.assertFalse(meetings[0]["has_audio"])

    def test_a_similarly_named_recording_does_not_count_for_another_note(self):
        # Prefix matching would wrongly flag "note" from "note-2.wav".
        with tempfile.TemporaryDirectory() as tmp:
            _write_note(tmp, "note", "Note")
            _write_recording(tmp, "note-2.wav")
            self.assertFalse(_run(tmp)[0]["has_audio"])

    def test_a_directory_named_like_a_recording_does_not_count(self):
        # os.listdir returns directories too, so a folder called
        # "note.wav" would otherwise report audio that does not exist.
        with tempfile.TemporaryDirectory() as tmp:
            _write_note(tmp, "note", "Note")
            (Path(tmp) / "recordings" / "note.wav").mkdir(parents=True)
            self.assertFalse(_run(tmp)[0]["has_audio"])

    def test_a_note_whose_own_name_contains_the_summary_marker(self):
        # `str.replace` strips EVERY occurrence, so
        # "client_summary.v1_summary.md" used to yield the stem
        # "client.v1" -- harmless while the stem only fed the dedup set,
        # wrong the moment it is matched against real filenames.
        with tempfile.TemporaryDirectory() as tmp:
            _write_note(tmp, "client_summary.v1", "Client")
            _write_recording(tmp, "client_summary.v1.wav")
            meetings = _run(tmp)
            self.assertEqual(len(meetings), 1)
            self.assertTrue(
                meetings[0]["has_audio"],
                "the stem must keep everything but a TRAILING _summary",
            )

    def test_the_recordings_dir_is_listed_once_not_once_per_meeting(self):
        # The guard on the "optimized for fast loading" promise: a
        # per-meeting existence check would make cold start scale with
        # library size. Counting the directory listings is what actually
        # holds the implementation to a single one.
        with tempfile.TemporaryDirectory() as tmp:
            for i in range(12):
                _write_note(tmp, f"note{i}", f"Note {i}")
            _write_recording(tmp, "note3.wav")

            real_scandir = os.scandir
            calls = []

            def counting_scandir(path):
                calls.append(str(path))
                return real_scandir(path)

            with mock.patch("os.scandir", side_effect=counting_scandir):
                meetings = _run(tmp)

            recordings_dir = str(Path(tmp) / "recordings")
            self.assertEqual(
                [c for c in calls if c == recordings_dir], [recordings_dir],
                "the recordings dir must be listed exactly once for the whole list",
            )
            self.assertEqual(sum(1 for m in meetings if m["has_audio"]), 1)


if __name__ == '__main__':
    unittest.main()
