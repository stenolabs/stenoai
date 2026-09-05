import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.config import Config


def _last_json(output):
    line = [ln for ln in output.splitlines() if ln.strip().startswith("{")][-1]
    return json.loads(line)


def _fake_process_streaming(output_dir, transcripts_dir, speakers_turn_manifest=None):
    """A stand-in for process_streaming.callback's real side effect: writes a
    fresh summary/transcript/speakers sidecar for the audio file's stem, with
    NONE of the pre-reprocess state (no folders, no participants section) --
    exactly what the real command does, so these tests exercise full-reprocess's
    OWN restore logic rather than re-testing process_streaming itself (already
    covered by the @pipeline e2e specs)."""
    def _run(audio_file, name, notes, live_transcript, append_to):
        stem = Path(audio_file).stem
        (output_dir / f"{stem}_summary.md").write_text(
            f"---\ntitle: \"{name}\"\ndate: \"2026-07-17T11:00:00\"\n---\n\n"
            "## Summary\n\nFresh reprocessed summary.\n",
            encoding="utf-8",
        )
        (transcripts_dir / f"{stem}_transcript.txt").write_text(
            f"Session: {stem}\n\n" + "=" * 60 + "\n\n[00:05] [Speaker 2] fresh line",
            encoding="utf-8",
        )
        if speakers_turn_manifest is not None:
            (output_dir / f"{stem}_speakers.json").write_text(
                json.dumps({"channels": {}, "transcript_lines": speakers_turn_manifest}),
                encoding="utf-8",
            )
    return _run


class FullReprocessCliTests(unittest.TestCase):
    """full-reprocess: a dev/maintenance tool to re-run the FULL pipeline
    (transcribe+diarize+summarize) for one already-processed meeting, from
    its original source audio -- see the plan doc's Phase 9. Mocks
    process_streaming.callback itself (its own correctness is covered by the
    @pipeline e2e specs) to isolate full-reprocess's own logic: audio
    resolution, backups, and restoring name/notes/folders/participants that
    process-streaming has no knowledge of."""

    def _run(self, args, tmp, cfg):
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            result = CliRunner().invoke(simple_recorder.full_reprocess, args)
        return result

    def test_no_source_audio_is_a_graceful_error_with_no_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "mtg001_summary.md").write_text(
                "---\ntitle: \"Mtg\"\n---\n\n## Summary\n\nOld.\n", encoding="utf-8",
            )
            cfg = Config(config_path=Path(tmp) / "config.json")

            result = self._run(["mtg001"], tmp, cfg)
            data = _last_json(result.output)
            self.assertFalse(data["success"])
            self.assertIn("No source audio", data["error"])
            # Nothing touched -- no backup files created.
            self.assertEqual(
                sorted(p.name for p in output_dir.iterdir()), ["mtg001_summary.md"],
            )

    def test_no_summary_found_is_a_graceful_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Config(config_path=Path(tmp) / "config.json")
            result = self._run(["nope"], tmp, cfg)
            data = _last_json(result.output)
            self.assertFalse(data["success"])
            self.assertIn("No summary found", data["error"])

    def test_backs_up_existing_files_before_overwriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            transcripts_dir = Path(tmp) / "transcripts"
            recordings_dir = Path(tmp) / "recordings"
            for d in (output_dir, transcripts_dir, recordings_dir):
                d.mkdir(parents=True, exist_ok=True)

            original_summary = "---\ntitle: \"Original\"\n---\n\n## Summary\n\nOld summary.\n"
            (output_dir / "mtg001_summary.md").write_text(original_summary, encoding="utf-8")
            original_transcript = "Session: mtg001\n\noriginal transcript text"
            (transcripts_dir / "mtg001_transcript.txt").write_text(original_transcript, encoding="utf-8")
            original_sidecar = json.dumps({"channels": {}})
            (output_dir / "mtg001_speakers.json").write_text(original_sidecar, encoding="utf-8")
            (recordings_dir / "mtg001.wav").write_bytes(b"fake-audio")

            cfg = Config(config_path=Path(tmp) / "config.json")
            fake = _fake_process_streaming(output_dir, transcripts_dir)
            with mock.patch.object(simple_recorder.process_streaming, "callback", side_effect=fake):
                result = self._run(["mtg001"], tmp, cfg)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(len(data["backed_up"]), 3)

            backups = {p.name: p for p in output_dir.iterdir() if ".bak-" in p.name}
            backups.update({p.name: p for p in transcripts_dir.iterdir() if ".bak-" in p.name})
            self.assertEqual(len(backups), 3)
            summary_backup = next(p for n, p in backups.items() if n.startswith("mtg001_summary.md"))
            self.assertEqual(summary_backup.read_text(encoding="utf-8"), original_summary)
            transcript_backup = next(p for n, p in backups.items() if n.startswith("mtg001_transcript.txt"))
            self.assertEqual(transcript_backup.read_text(encoding="utf-8"), original_transcript)
            sidecar_backup = next(p for n, p in backups.items() if n.startswith("mtg001_speakers.json"))
            self.assertEqual(sidecar_backup.read_text(encoding="utf-8"), original_sidecar)

            # And the real files now hold the fresh (mocked) reprocess output.
            self.assertIn("Fresh reprocessed", (output_dir / "mtg001_summary.md").read_text())

    def test_preserves_name_and_notes_into_the_pipeline_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            recordings_dir = Path(tmp) / "recordings"
            transcripts_dir = Path(tmp) / "transcripts"
            for d in (output_dir, recordings_dir, transcripts_dir):
                d.mkdir(parents=True, exist_ok=True)
            (output_dir / "mtg001_summary.json").write_text(json.dumps({
                "session_info": {"name": "Weekly Sync"},
                "user_notes": "Remember to follow up with Person Gamma.",
                "participants": [],
            }), encoding="utf-8")
            (recordings_dir / "mtg001.wav").write_bytes(b"fake-audio")

            cfg = Config(config_path=Path(tmp) / "config.json")
            fake = _fake_process_streaming(output_dir, transcripts_dir)
            # The notes file is cleaned up in full-reprocess's own `finally`
            # block right after this call returns, so its content has to be
            # captured DURING the call, not from call_args afterward.
            seen_notes_text = {}

            def _fake_with_notes_capture(audio_file, name, notes, live_transcript, append_to):
                if notes:
                    seen_notes_text["text"] = Path(notes).read_text(encoding="utf-8")
                    seen_notes_text["path"] = notes
                return fake(audio_file, name, notes, live_transcript, append_to)

            mock_callback = mock.Mock(side_effect=_fake_with_notes_capture)
            with mock.patch.object(simple_recorder.process_streaming, "callback", mock_callback):
                result = self._run(["mtg001"], tmp, cfg)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertTrue(data["notes_preserved"])

            audio_file, name, notes_path, live_transcript, append_to = mock_callback.call_args[0]
            self.assertEqual(Path(audio_file), recordings_dir / "mtg001.wav")
            self.assertEqual(name, "Weekly Sync")
            self.assertIsNone(live_transcript)
            self.assertIsNone(append_to)
            self.assertEqual(seen_notes_text["text"], "Remember to follow up with Person Gamma.")
            # The temp notes file is cleaned up after the call.
            self.assertFalse(Path(seen_notes_text["path"]).exists())

    def test_preserves_original_date_not_reprocess_time(self):
        # process-streaming always stamps `date` with "now" -- correct for a
        # brand-new recording, wrong for a reprocess of an old meeting, since
        # the app displays this date as when the meeting happened.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            recordings_dir = Path(tmp) / "recordings"
            transcripts_dir = Path(tmp) / "transcripts"
            for d in (output_dir, recordings_dir, transcripts_dir):
                d.mkdir(parents=True, exist_ok=True)
            (output_dir / "mtg001_summary.json").write_text(json.dumps({
                "session_info": {"name": "Old", "processed_at": "2026-06-01T09:15:00"},
                "participants": [],
            }), encoding="utf-8")
            (recordings_dir / "mtg001.wav").write_bytes(b"fake-audio")

            cfg = Config(config_path=Path(tmp) / "config.json")
            fake = _fake_process_streaming(output_dir, transcripts_dir)
            with mock.patch.object(simple_recorder.process_streaming, "callback", side_effect=fake):
                result = self._run(["mtg001"], tmp, cfg)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertTrue(data["date_preserved"])
            new_summary = (output_dir / "mtg001_summary.md").read_text(encoding="utf-8")
            self.assertIn('date: "2026-06-01T09:15:00"', new_summary)
            self.assertNotIn("2026-07-17T11:00:00", new_summary)

    def test_no_original_date_leaves_the_fresh_stamp_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            recordings_dir = Path(tmp) / "recordings"
            transcripts_dir = Path(tmp) / "transcripts"
            for d in (output_dir, recordings_dir, transcripts_dir):
                d.mkdir(parents=True, exist_ok=True)
            (output_dir / "mtg001_summary.md").write_text(
                "---\ntitle: \"Old\"\n---\n\n## Summary\n\nOld.\n", encoding="utf-8",
            )
            (recordings_dir / "mtg001.wav").write_bytes(b"fake-audio")

            cfg = Config(config_path=Path(tmp) / "config.json")
            fake = _fake_process_streaming(output_dir, transcripts_dir)
            with mock.patch.object(simple_recorder.process_streaming, "callback", side_effect=fake):
                result = self._run(["mtg001"], tmp, cfg)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertFalse(data["date_preserved"])
            new_summary = (output_dir / "mtg001_summary.md").read_text(encoding="utf-8")
            self.assertIn('date: "2026-07-17T11:00:00"', new_summary)

    def test_restores_participants_from_confirmed_person_profiles(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            recordings_dir = Path(tmp) / "recordings"
            transcripts_dir = Path(tmp) / "transcripts"
            for d in (output_dir, recordings_dir, transcripts_dir):
                d.mkdir(parents=True, exist_ok=True)
            (output_dir / "mtg001_summary.md").write_text(
                "---\ntitle: \"Old\"\n---\n\n## Summary\n\nOld.\n", encoding="utf-8",
            )
            (recordings_dir / "mtg001.wav").write_bytes(b"fake-audio")

            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Gamma")
            cfg.add_speaker_prototype(
                person["person_id"], [1.0, 0.0],
                recording_type="in_person", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=30.0, segment_count=5,
                created_from="user_confirmed",
            )

            fake = _fake_process_streaming(output_dir, transcripts_dir)
            with mock.patch.object(simple_recorder.process_streaming, "callback", side_effect=fake):
                result = self._run(["mtg001"], tmp, cfg)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["participants_restored"], ["Person Gamma"])
            self.assertIn("## Participants\n\nPerson Gamma", (output_dir / "mtg001_summary.md").read_text())

    def test_restores_folder_membership(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            recordings_dir = Path(tmp) / "recordings"
            transcripts_dir = Path(tmp) / "transcripts"
            for d in (output_dir, recordings_dir, transcripts_dir):
                d.mkdir(parents=True, exist_ok=True)
            (output_dir / "mtg001_summary.json").write_text(json.dumps({
                "session_info": {"name": "Old"},
                "folders": ["folder-abc"],
                "participants": [],
            }), encoding="utf-8")
            (recordings_dir / "mtg001.wav").write_bytes(b"fake-audio")

            cfg = Config(config_path=Path(tmp) / "config.json")
            fake = _fake_process_streaming(output_dir, transcripts_dir)
            with mock.patch.object(simple_recorder.process_streaming, "callback", side_effect=fake):
                result = self._run(["mtg001"], tmp, cfg)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["folders_restored"], ["folder-abc"])
            new_summary = (output_dir / "mtg001_summary.md").read_text(encoding="utf-8")
            self.assertRegex(new_summary, r'folders:\s*\["folder-abc"\]')

    def test_reports_turn_manifest_entry_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            recordings_dir = Path(tmp) / "recordings"
            transcripts_dir = Path(tmp) / "transcripts"
            for d in (output_dir, recordings_dir, transcripts_dir):
                d.mkdir(parents=True, exist_ok=True)
            (output_dir / "mtg001_summary.md").write_text(
                "---\ntitle: \"Old\"\n---\n\n## Summary\n\nOld.\n", encoding="utf-8",
            )
            (recordings_dir / "mtg001.wav").write_bytes(b"fake-audio")

            cfg = Config(config_path=Path(tmp) / "config.json")
            manifest = [
                {"start": 1.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_00"},
                {"start": 4.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_00"},
            ]
            fake = _fake_process_streaming(output_dir, transcripts_dir, speakers_turn_manifest=manifest)
            with mock.patch.object(simple_recorder.process_streaming, "callback", side_effect=fake):
                result = self._run(["mtg001"], tmp, cfg)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["turn_manifest_entries"], 2)

    def test_audio_file_override_is_honored_over_stem_lookup(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            recordings_dir = Path(tmp) / "recordings"
            transcripts_dir = Path(tmp) / "transcripts"
            for d in (output_dir, recordings_dir, transcripts_dir):
                d.mkdir(parents=True, exist_ok=True)
            (output_dir / "mtg001_summary.md").write_text(
                "---\ntitle: \"Old\"\n---\n\n## Summary\n\nOld.\n", encoding="utf-8",
            )
            # No recordings/mtg001.* on disk at all -- only the override copy.
            override_dir = Path(tmp) / "elsewhere"
            override_dir.mkdir(parents=True, exist_ok=True)
            override_audio = override_dir / "mtg001-copy.wav"
            override_audio.write_bytes(b"fake-audio")

            cfg = Config(config_path=Path(tmp) / "config.json")
            fake = _fake_process_streaming(output_dir, transcripts_dir)
            mock_callback = mock.Mock(side_effect=fake)
            with mock.patch.object(simple_recorder.process_streaming, "callback", mock_callback):
                result = self._run(
                    ["mtg001", "--audio-file", str(override_audio)], tmp, cfg,
                )
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["audio_file_used"], str(override_audio))
            audio_file_arg = mock_callback.call_args[0][0]
            self.assertEqual(audio_file_arg, str(override_audio))

    def test_missing_audio_file_override_is_a_graceful_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "mtg001_summary.md").write_text(
                "---\ntitle: \"Old\"\n---\n\n## Summary\n\nOld.\n", encoding="utf-8",
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            result = self._run(
                ["mtg001", "--audio-file", str(Path(tmp) / "nope.wav")], tmp, cfg,
            )
            data = _last_json(result.output)
            self.assertFalse(data["success"])
            self.assertIn("--audio-file not found", data["error"])


if __name__ == "__main__":
    unittest.main()
