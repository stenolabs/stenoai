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


if __name__ == "__main__":
    unittest.main()
