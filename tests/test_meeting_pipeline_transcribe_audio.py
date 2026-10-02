import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from simple_recorder import MeetingPipeline


class TranscribeAudioFieldForwardingTests(unittest.TestCase):
    """MeetingPipeline.transcribe_audio -- the wrapper process-streaming
    actually calls, in simple_recorder.py -- builds its OWN return dict
    from WhisperTranscriber.transcribe_diarised's result rather than passing
    it straight through. That means a new field added to
    transcribe_diarised's contract does NOT reach process-streaming (and the
    {stem}_speakers.json sidecar it writes) unless this wrapper is updated
    too. turn_manifest (Phase 8's exact per-line speaker provenance) was
    added to transcribe_diarised and unit-tested there, but this wrapper was
    never updated -- so every meeting recorded through the real live pipeline
    got an empty sidecar (no "transcript_lines" key at all) despite every
    existing unit test passing, since none of them exercised this specific
    wrapper's dict-building. Found via a real full-reprocess run against a
    real meeting, whose transcript kept showing generic "[Others]" labels
    with confirm-speaker silently falling back to the old fuzzy matching."""

    def _build_recorder(self, tmp_dir):
        recorder = MeetingPipeline.__new__(MeetingPipeline)
        recorder.transcripts_dir = Path(tmp_dir) / "transcripts"
        recorder.transcripts_dir.mkdir(parents=True, exist_ok=True)
        recorder.transcriber = mock.Mock()
        return recorder

    def test_turn_manifest_and_speaker_clusters_are_forwarded(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "meeting.wav"
            audio.write_bytes(b"\x00" * 2048)
            recorder = self._build_recorder(tmp_dir)
            manifest = [
                {"start": 1.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_00"},
                {"start": 5.0, "channel": "system", "diarization_speaker_id": "SPEAKER_00"},
            ]
            clusters = {"mic": {"recording_type": "in_person", "clusters": {}}}
            recorder.transcriber.transcribe_diarised.return_value = {
                "text": "hello",
                "is_diarised": True,
                "diarised_text": "[00:01] [You] hello",
                "duration_seconds": 10.0,
                "detected_language": "en",
                "speaker_clusters": clusters,
                "turn_manifest": manifest,
            }
            with mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}):
                result = asyncio.run(recorder.transcribe_audio(str(audio), "Test Meeting"))
            self.assertEqual(result["turn_manifest"], manifest)
            self.assertEqual(result["speaker_clusters"], clusters)

    def test_turn_manifest_defaults_to_empty_list_when_absent(self):
        # A non-diarised (or diarisation-failed) result has no turn_manifest
        # key at all -- must default to [], not KeyError/None, since callers
        # (process_streaming) pass this straight to write_speakers_sidecar.
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "meeting.wav"
            audio.write_bytes(b"\x00" * 2048)
            recorder = self._build_recorder(tmp_dir)
            recorder.transcriber.transcribe_diarised.return_value = {
                "text": "hello",
                "is_diarised": False,
                "diarised_text": None,
                "duration_seconds": 10.0,
                "detected_language": "en",
            }
            with mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}):
                result = asyncio.run(recorder.transcribe_audio(str(audio), "Test Meeting"))
            self.assertEqual(result["turn_manifest"], [])
            self.assertEqual(result["speaker_clusters"], {})


class PartialCoverageStreamingTests(unittest.TestCase):
    def test_partial_onnx_result_rescues_live_text_and_preserves_audio(self):
        from click.testing import CliRunner
        from types import SimpleNamespace
        import numpy as np
        import simple_recorder
        from src import _parakeet_onnx as onnx

        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audio = root / "meeting.wav"
            audio.write_bytes(b"synthetic audio fixture")
            live = root / "live.txt"
            live_text = "We reviewed the budget and agreed to deploy tomorrow."
            live.write_text(live_text, encoding="utf-8")
            model = mock.Mock()
            model.recognize.side_effect = [
                RuntimeError("synthetic first-window failure"),
                SimpleNamespace(tokens=["Tomorrow."], timestamps=[(0.0, 0.5)]),
            ]
            batch = onnx._result_to_dict(onnx._transcribe_windows(
                model, np.zeros(61 * onnx._SAMPLE_RATE, dtype=np.float32),
            ), language="en")
            batch["duration_seconds"] = 61
            recorder = MeetingPipeline.__new__(MeetingPipeline)
            recorder.output_dir = root
            recorder.transcripts_dir = root / "transcripts"
            recorder.transcripts_dir.mkdir()
            recorder.transcriber = mock.Mock()
            recorder.transcriber.transcribe_diarised.return_value = batch
            config = mock.Mock()
            config.get_language.return_value = "en"
            config.get_auto_summarize_enabled.return_value = False
            config.get_keep_recordings.return_value = False
            with (
                mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp_dir}),
                mock.patch("simple_recorder.MeetingPipeline", return_value=recorder),
                mock.patch("src.config.get_config", return_value=config),
                mock.patch(
                    "simple_recorder._unusable_batch_reason",
                    wraps=simple_recorder._unusable_batch_reason,
                ) as reason,
            ):
                result = CliRunner().invoke(simple_recorder.process_streaming, [
                    str(audio), "--name", "Synthetic coverage", "--live-transcript", str(live),
                ])
            self.assertEqual(result.exit_code, 0, result.output + repr(result.exception))
            reason.assert_called_once_with("Tomorrow.", False, 16 / 61)
            summary = (root / "meeting_summary.md").read_text(encoding="utf-8")
            transcript = (recorder.transcripts_dir / "meeting_transcript.txt").read_text(encoding="utf-8")
            self.assertIn("is_live_transcript: true", summary)
            self.assertIn(live_text, summary)
            self.assertIn(live_text, transcript)
            self.assertNotIn("Tomorrow.", transcript)
            self.assertEqual(audio.read_bytes(), b"synthetic audio fixture")


if __name__ == "__main__":
    unittest.main()
