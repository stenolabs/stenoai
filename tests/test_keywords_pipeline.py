"""Pipeline-level regression tests for Custom Keywords healing in
``simple_recorder``: the silence-sentinel guard (data safety) and the
live-transcript fallback healing.
"""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from simple_recorder import MeetingPipeline, _parse_meeting_markdown
from src.transcriber import SILENCE_SENTINEL


def _reset_config():
    from src import config as _config
    _config._config_instance = None


class _ConfigTempDirMixin(unittest.TestCase):
    def setUp(self):
        self._orig_dd = os.environ.get("STENOAI_USER_DATA_DIR")
        from src import config as _config
        self._orig_config = _config._config_instance
        self._tmpdir = tempfile.TemporaryDirectory()
        self._tmp = self._tmpdir.name
        os.environ["STENOAI_USER_DATA_DIR"] = self._tmp
        _reset_config()

    def tearDown(self):
        if self._orig_dd is not None:
            os.environ["STENOAI_USER_DATA_DIR"] = self._orig_dd
        else:
            os.environ.pop("STENOAI_USER_DATA_DIR", None)
        from src import config as _config
        _config._config_instance = self._orig_config
        self._tmpdir.cleanup()


class SilenceSentinelHealingGuardTests(_ConfigTempDirMixin):
    """FIX 1 (data safety): a configured alias that would rewrite the silence
    sentinel must NOT mutate it - otherwise the downstream silence / live-rescue
    check (an exact-string compare) breaks and a fake-empty transcript gets
    summarised/saved with the audio possibly deleted."""

    def _make_audio(self):
        p = Path(self._tmp) / "meeting.wav"
        p.write_bytes(b"\x00" * 2048)
        return str(p)

    def _run_transcribe(self, transcript_result):
        pipeline = MeetingPipeline()
        # Pre-seed the transcriber so transcribe_audio never builds a real one.
        with patch.object(
            pipeline, "transcriber", create=True
        ) as fake_transcriber:
            fake_transcriber.transcribe_diarised.return_value = transcript_result
            return asyncio.run(pipeline.transcribe_audio(self._make_audio(), "Note"))

    def test_sentinel_is_not_healed(self):
        # Alias "speech" WOULD match inside "No speech detected in audio".
        from src.config import get_config
        get_config().set_custom_keywords(
            [{"preferred": "Speechly", "aliases": ["speech"]}]
        )
        out = self._run_transcribe({
            "text": SILENCE_SENTINEL,
            "diarised_text": None,
            "is_diarised": False,
            "duration_seconds": None,
            "detected_language": None,
        })
        # The sentinel survives verbatim so the caller's silence check still fires.
        self.assertEqual(out["transcript_text"], SILENCE_SENTINEL)

    def test_genuine_content_is_still_healed(self):
        from src.config import get_config
        get_config().set_custom_keywords(
            [{"preferred": "Speechly", "aliases": ["speech"]}]
        )
        out = self._run_transcribe({
            "text": "we discussed speech recognition today",
            "diarised_text": None,
            "is_diarised": False,
            "duration_seconds": 5,
            "detected_language": "en",
        })
        self.assertEqual(
            out["transcript_text"], "we discussed Speechly recognition today"
        )


class LiveTranscriptFallbackHealingTests(_ConfigTempDirMixin):
    """FIX 3: when batch transcription returns the sentinel and we fall back to
    the live transcript, that live text must be healed too (the batch-path
    healing never touched it). Driven end to end through process-streaming with
    auto-summarize OFF, so the transcript-only note is written with zero Ollama
    calls."""

    def test_live_fallback_text_is_healed(self):
        from click.testing import CliRunner
        import simple_recorder as sr
        from src.config import get_config

        cfg = get_config()
        cfg.set_custom_keywords(
            [{"preferred": "NexGen Suite", "aliases": ["NexGan Suite"]}]
        )
        cfg.set_auto_summarize_enabled(False)

        audio_file = str(Path(self._tmp) / "meeting.wav")
        Path(audio_file).write_bytes(b"\x00" * 2048)
        live_file = Path(self._tmp) / "live.txt"
        live_file.write_text("we shipped NexGan Suite this sprint", encoding="utf-8")

        async def _fake_transcribe(self_pipeline, af, name="Recording"):
            # Batch returned only silence -> triggers the live fallback.
            return {
                "transcript_text": SILENCE_SENTINEL,
                "diarised_text": None,
                "is_diarised": False,
                "duration_seconds": 3,
                "detected_language": None,
                "transcription_failed": False,
            }

        with patch.object(MeetingPipeline, "transcribe_audio", new=_fake_transcribe):
            result = CliRunner().invoke(
                sr.cli,
                ["process-streaming", "--name", "Note",
                 "--live-transcript", str(live_file), audio_file],
            )
        if result.exception is not None and not isinstance(
            result.exception, SystemExit
        ):
            raise result.exception

        summary_path = Path(self._tmp) / "output" / "meeting_summary.md"
        self.assertTrue(summary_path.exists(), result.output)
        data = _parse_meeting_markdown(summary_path)
        self.assertIn("NexGen Suite", data["transcript"])
        self.assertNotIn("NexGan Suite", data["transcript"])
        # Sanity: it really took the live-fallback branch.
        self.assertTrue(data["session_info"].get("is_live_transcript"))


if __name__ == "__main__":
    unittest.main()
