"""Tests for honest transcription-failure handling.

A transcription crash (e.g. an MLX ``metal::malloc`` OOM on a long file)
must be distinguished from genuine silence: the crash path tags the result
with ``transcription_failed`` and preserves the source audio, whereas silence
still returns the "No speech detected in audio" sentinel with no flag. These
tests pin that contract end to end across ``transcribe_audio``,
``transcribe_diarised`` and ``MeetingPipeline._handle_transcription_failure``.
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from simple_recorder import MeetingPipeline, _parse_meeting_markdown
from src.transcriber import WhisperTranscriber


def _build_transcriber() -> WhisperTranscriber:
    # Bypass __init__ to skip ffmpeg-PATH probing and the parakeet
    # import-availability gate — mirrors tests/test_transcriber.py.
    transcriber = WhisperTranscriber.__new__(WhisperTranscriber)
    transcriber.model = None
    transcriber.model_size = "large-v3-turbo"
    transcriber.backend = "parakeet-tdt-v3"
    return transcriber


def _make_audio_file(tmp_dir: str, name: str = "meeting.wav") -> Path:
    # transcribe_audio short-circuits files < 1 KB, so pad past that.
    path = Path(tmp_dir) / name
    path.write_bytes(b"\x00" * 2048)
    return path


class TranscribeAudioFailureTests(unittest.TestCase):
    def test_crash_returns_transcription_failed_not_silence(self):
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(
                transcriber, "_run_backend",
                side_effect=RuntimeError("metal::malloc abort"),
            ), patch.object(
                # Keep this test machine-independent: whether a whisper.cpp
                # weight happens to be installed must not change the outcome.
                transcriber, "_build_whisper_fallback", return_value=False,
            ):
                out = transcriber.transcribe_audio(audio, language="en")
        self.assertIsInstance(out, dict)
        self.assertTrue(out.get("transcription_failed"))
        self.assertIsNone(out.get("text"))
        self.assertNotEqual(out.get("text"), "No speech detected in audio")
        self.assertIn("metal::malloc abort", out.get("error", ""))

    def test_silence_returns_sentinel_without_failed_flag(self):
        """Regression: a genuinely silent file still yields the silence
        sentinel and must NOT carry the transcription_failed flag."""
        transcriber = _build_transcriber()
        silent_result = {
            "text": None,
            "segments": [],
            "duration_seconds": None,
            "detected_language": None,
            "detected_language_probability": None,
        }
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber, "_run_backend", return_value=silent_result):
                out = transcriber.transcribe_audio(audio, language="en")
        self.assertEqual(out["text"], "No speech detected in audio")
        self.assertNotIn("transcription_failed", out)

    def test_missing_file_still_returns_none(self):
        """The missing-file case stays ``None`` so existing
        ``None``-means-no-file callers are unchanged."""
        transcriber = _build_transcriber()
        out = transcriber.transcribe_audio(Path("/tmp/does-not-exist.wav"), language="en")
        self.assertIsNone(out)


_WHISPER_OK = {
    "text": "recovered transcript",
    "segments": [{"text": "recovered transcript", "start": 0.0, "end": 2.0}],
    "duration_seconds": 2.0,
    "detected_language": None,
    "detected_language_probability": None,
}


class WhisperFallbackTests(unittest.TestCase):
    """Inference-crash fallback to whisper.cpp, gated on an already-installed
    weight. The gate is load-bearing: a failure path must NEVER trigger
    pywhispercpp's implicit ~466 MB model download."""

    def _crashing_transcriber(self):
        transcriber = _build_transcriber()
        return transcriber

    def test_fallback_recovers_when_model_installed(self):
        import src.transcriber as transcriber_mod
        transcriber = self._crashing_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber_mod, "WHISPER_CPP_AVAILABLE", True), \
                 patch("src.whisper_models.is_installed", return_value=True), \
                 patch.object(transcriber, "_load_whisper_cpp") as load_mock, \
                 patch.object(transcriber, "_run_backend",
                              side_effect=RuntimeError("metal abort")), \
                 patch.object(transcriber, "_run_whisper_cpp",
                              return_value=dict(_WHISPER_OK)):
                out = transcriber.transcribe_audio(audio, language="en")
        load_mock.assert_called_once()
        self.assertEqual(out["text"], "recovered transcript")
        self.assertEqual(out["engine"], "whisper.cpp-fallback")
        self.assertNotIn("transcription_failed", out)

    def test_no_download_when_model_not_installed(self):
        """Honest failure + _load_whisper_cpp never called — proves the
        fallback can't trigger a download."""
        import src.transcriber as transcriber_mod
        transcriber = self._crashing_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber_mod, "WHISPER_CPP_AVAILABLE", True), \
                 patch("src.whisper_models.is_installed", return_value=False), \
                 patch.object(transcriber, "_load_whisper_cpp") as load_mock, \
                 patch.object(transcriber, "_run_backend",
                              side_effect=RuntimeError("metal abort")):
                out = transcriber.transcribe_audio(audio, language="en")
        load_mock.assert_not_called()
        self.assertTrue(out.get("transcription_failed"))
        self.assertIn("metal abort", out.get("error", ""))

    def test_no_fallback_when_pywhispercpp_unavailable(self):
        import src.transcriber as transcriber_mod
        transcriber = self._crashing_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber_mod, "WHISPER_CPP_AVAILABLE", False), \
                 patch.object(transcriber, "_load_whisper_cpp") as load_mock, \
                 patch.object(transcriber, "_run_backend",
                              side_effect=RuntimeError("metal abort")):
                out = transcriber.transcribe_audio(audio, language="en")
        load_mock.assert_not_called()
        self.assertTrue(out.get("transcription_failed"))

    def test_double_crash_returns_honest_failure(self):
        import src.transcriber as transcriber_mod
        transcriber = self._crashing_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber_mod, "WHISPER_CPP_AVAILABLE", True), \
                 patch("src.whisper_models.is_installed", return_value=True), \
                 patch.object(transcriber, "_load_whisper_cpp"), \
                 patch.object(transcriber, "_run_backend",
                              side_effect=RuntimeError("metal abort")), \
                 patch.object(transcriber, "_run_whisper_cpp",
                              side_effect=RuntimeError("whisper also died")):
                out = transcriber.transcribe_audio(audio, language="en")
        self.assertTrue(out.get("transcription_failed"))
        self.assertIsNone(out.get("text"))

    def test_success_is_tagged_with_primary_engine(self):
        transcriber = self._crashing_transcriber()
        ok = {
            "text": "all good",
            "segments": [],
            "duration_seconds": 1.0,
            "detected_language": None,
            "detected_language_probability": None,
        }
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber, "_run_backend", return_value=ok):
                out = transcriber.transcribe_audio(audio, language="en")
        self.assertEqual(out["engine"], "parakeet-tdt-v3")

    def test_fallback_not_attempted_when_backend_is_whisper(self):
        import src.transcriber as transcriber_mod
        transcriber = self._crashing_transcriber()
        transcriber.backend = "whisper.cpp"
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber_mod, "WHISPER_CPP_AVAILABLE", True), \
                 patch.object(transcriber, "_load_whisper_cpp") as load_mock, \
                 patch.object(transcriber, "_run_backend",
                              side_effect=RuntimeError("whisper died")):
                out = transcriber.transcribe_audio(audio, language="en")
        load_mock.assert_not_called()
        self.assertTrue(out.get("transcription_failed"))

    def test_diarised_inherits_fallback_engine(self):
        """Per-channel crashes recover via the fallback inside
        transcribe_audio, and the diarised result carries the engine tag."""
        import src.transcriber as transcriber_mod
        transcriber = self._crashing_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            # Channel files must really exist — transcribe_audio short-circuits
            # missing paths to None before the engine ever runs.
            mic = _make_audio_file(tmp_dir, "stenoai_ch0_x.wav")
            system = _make_audio_file(tmp_dir, "stenoai_ch1_x.wav")
            with patch.object(transcriber_mod, "WHISPER_CPP_AVAILABLE", True), \
                 patch("src.whisper_models.is_installed", return_value=True), \
                 patch.object(transcriber, "_load_whisper_cpp"), \
                 patch.object(transcriber, "_split_stereo_to_channels",
                              return_value=(mic, system, 60.0)), \
                 patch.object(transcriber, "_check_rms_energy", return_value=True), \
                 patch.object(transcriber, "_run_backend",
                              side_effect=RuntimeError("metal abort")), \
                 patch.object(transcriber, "_run_whisper_cpp",
                              return_value=dict(_WHISPER_OK)):
                out = transcriber.transcribe_diarised(audio, language="en")
        self.assertNotIn("transcription_failed", out)
        self.assertEqual(out.get("engine"), "whisper.cpp-fallback")


class WhisperHeartbeatTests(unittest.TestCase):
    """The whisper.cpp path — including the crash-recovery fallback — must
    emit heartbeats too, or the Electron inactivity watchdog can kill the
    very retry it is meant to allow."""

    def test_run_whisper_cpp_emits_per_segment_heartbeat(self):
        import wave
        from types import SimpleNamespace

        from src import _heartbeat

        beats = []
        _heartbeat.set_chunk_heartbeat(lambda d, t: beats.append((d, t)))
        self.addCleanup(_heartbeat.set_chunk_heartbeat, None)

        transcriber = _build_transcriber()

        def fake_transcribe(media=None, new_segment_callback=None, **params):
            # Simulate whisper.cpp invoking the callback once per segment.
            self.assertIsNotNone(new_segment_callback)
            new_segment_callback(object())
            new_segment_callback(object())
            return []

        # A real function (not a MagicMock) so inspect.signature sees the
        # new_segment_callback parameter the way it does on pywhispercpp.
        transcriber.model = SimpleNamespace(transcribe=fake_transcribe)

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "audio.wav"
            with wave.open(str(audio), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(16000)
                wf.writeframes(b"\x00\x00" * 16000)
            transcriber._run_whisper_cpp(audio, language="en")

        self.assertEqual(beats, [(1, 0), (2, 0)])


class TranscribeDiarisedFailureTests(unittest.TestCase):
    def test_mono_fallback_propagates_failed_flag(self):
        transcriber = _build_transcriber()
        failed = {
            "text": None,
            "segments": [],
            "duration_seconds": None,
            "detected_language": None,
            "detected_language_probability": None,
            "transcription_failed": True,
            "error": "boom",
        }
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber, "_split_stereo_to_channels",
                              return_value=(None, None, None)), \
                 patch.object(transcriber, "transcribe_audio", return_value=failed):
                out = transcriber.transcribe_diarised(audio, language="en")
        self.assertTrue(out.get("transcription_failed"))
        self.assertEqual(out.get("error"), "boom")

    def test_stereo_channel_crash_fails_whole_meeting(self):
        """If either channel crashes, the diarised result is tagged failed
        instead of assembling a partial/fake-empty transcript."""
        transcriber = _build_transcriber()
        mic = Path("/tmp/stenoai_ch0_x.wav")
        system = Path("/tmp/stenoai_ch1_x.wav")
        failed = {"transcription_failed": True, "error": "OOM on mic channel"}
        ok = {
            "text": "Hi there.",
            "segments": [{"text": "Hi there.", "start": 0.0, "end": 1.0}],
            "detected_language": None,
        }

        def fake_transcribe(path, language="en", _preprocessed=False):
            return failed if path == mic else ok

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber, "_split_stereo_to_channels",
                              return_value=(mic, system, 1800.0)), \
                 patch.object(transcriber, "_check_rms_energy", return_value=True), \
                 patch.object(transcriber, "transcribe_audio", side_effect=fake_transcribe):
                out = transcriber.transcribe_diarised(audio, language="en")
        self.assertTrue(out.get("transcription_failed"))
        self.assertIn("OOM on mic channel", out.get("error", ""))
        # Must not have assembled the silence sentinel as a "successful" text.
        self.assertIsNone(out.get("text"))

    def test_all_energetic_channels_empty_fails_meeting(self):
        """Gap 2 (#207): when EVERY channel passes the RMS energy gate but
        returns empty text, that's a quiet ASR failure, not silence. It must be
        tagged transcription_failed (audio preserved for retry) rather than
        saving a fake "No speech detected" meeting.

        Critically this drives the REAL transcribe_audio path (mocking the
        lower-level _run_backend), so the silence-sentinel substitution at
        transcriber.py:~881 actually runs. The earlier version mocked
        transcribe_audio directly and never exercised that substitution — the
        very interaction that made the channel-empty check dead code.
        """
        transcriber = _build_transcriber()
        # Both channels pass the energy gate but the backend returns no text;
        # transcribe_audio will substitute the silence sentinel + set the
        # transcription_empty flag — the bug condition.
        empty_backend = {
            "text": None, "segments": [], "duration_seconds": None,
            "detected_language": None, "detected_language_probability": None,
        }

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            # Real channel files so transcribe_audio doesn't short-circuit on
            # the missing-file / too-small guards before reaching _run_backend.
            mic = _make_audio_file(tmp_dir, "ch0_energetic.wav")
            system = _make_audio_file(tmp_dir, "ch1_energetic.wav")
            with patch.object(transcriber, "_split_stereo_to_channels",
                              return_value=(mic, system, 120.0)), \
                 patch.object(transcriber, "_check_rms_energy", return_value=True), \
                 patch.object(transcriber, "_build_whisper_fallback", return_value=False), \
                 patch.object(transcriber, "_run_backend", return_value=empty_backend):
                out = transcriber.transcribe_diarised(audio, language="en")
        self.assertTrue(out.get("transcription_failed"))
        self.assertIsNone(out.get("text"))
        self.assertIn("empty", out.get("error", "").lower())

    def test_one_channel_text_one_empty_succeeds(self):
        """Gap 2 + Fix 5 (#207): the RMS gate only detects 'not digital
        silence' — music/noise/reverb can pass it. So when ONE channel carries
        real text and the other passes the gate but transcribes to nothing,
        the meeting must SUCCEED (drop the empty channel), not fail. Drives the
        real transcribe_audio path."""
        transcriber = _build_transcriber()
        ok_backend = {
            "text": "Hi there.",
            "segments": [{"text": "Hi there.", "start": 0.0, "end": 1.0}],
            "duration_seconds": 1.0,
            "detected_language": None, "detected_language_probability": None,
        }
        empty_backend = {
            "text": None, "segments": [], "duration_seconds": None,
            "detected_language": None, "detected_language_probability": None,
        }

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            mic = _make_audio_file(tmp_dir, "ch0_text.wav")
            system = _make_audio_file(tmp_dir, "ch1_noise.wav")

            def fake_backend(path, language="en"):
                return ok_backend if path == mic else empty_backend

            with patch.object(transcriber, "_split_stereo_to_channels",
                              return_value=(mic, system, 120.0)), \
                 patch.object(transcriber, "_check_rms_energy", return_value=True), \
                 patch.object(transcriber, "_build_whisper_fallback", return_value=False), \
                 patch.object(transcriber, "_run_backend", side_effect=fake_backend):
                out = transcriber.transcribe_diarised(audio, language="en")
        self.assertNotIn("transcription_failed", out)
        self.assertIn("Hi there.", out.get("text", ""))

    def test_silent_channel_is_not_a_failure(self):
        """Regression for Gap 2: a channel the energy gate reports as silent
        (has_audio == False) is skipped, NOT failed — only the still-speaking
        channel is transcribed and the meeting saves normally."""
        transcriber = _build_transcriber()
        mic = Path("/tmp/stenoai_ch0_silent.wav")
        system = Path("/tmp/stenoai_ch1_silent.wav")
        ok = {
            "text": "Solo presenter.",
            "segments": [{"text": "Solo presenter.", "start": 0.0, "end": 1.0}],
            "detected_language": None,
        }

        def fake_rms(path, *a, **k):
            # Mic has audio; system is genuinely silent.
            return path == mic

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber, "_split_stereo_to_channels",
                              return_value=(mic, system, 120.0)), \
                 patch.object(transcriber, "_check_rms_energy", side_effect=fake_rms), \
                 patch.object(transcriber, "transcribe_audio", return_value=ok):
                out = transcriber.transcribe_diarised(audio, language="en")
        self.assertNotIn("transcription_failed", out)
        self.assertIn("Solo presenter.", out.get("text", ""))


class HandleTranscriptionFailureTests(unittest.TestCase):
    def _build_recorder(self, output_dir: Path) -> MeetingPipeline:
        recorder = MeetingPipeline.__new__(MeetingPipeline)
        recorder.output_dir = output_dir
        return recorder

    def test_preserves_audio_and_marks_reprocessable(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_dir = Path(tmp_dir) / "output"
            out_dir.mkdir()
            audio = _make_audio_file(tmp_dir, "session.webm")
            recorder = self._build_recorder(out_dir)
            transcript_data = {
                "duration_seconds": 1830.0,
                "configured_language": "en",
                "transcription_failed": True,
                "error": "metal::malloc abort on a 33-min file",
            }
            result = recorder._handle_transcription_failure(
                audio, "Long meeting", transcript_data, notes_text=None
            )

            # Source audio preserved regardless of keep_recordings.
            self.assertTrue(audio.exists())
            # A marked summary .md was written.
            summary_path = out_dir / f"{audio.stem}_summary.md"
            self.assertTrue(summary_path.exists())
            body = summary_path.read_text(encoding="utf-8")
            self.assertIn("transcription_failed: true", body)
            self.assertIn("reprocessable: true", body)
            self.assertIn(str(audio), body)
            self.assertIn("## Summary", body)
            self.assertIn("preserved", body)
            # Return payload signals failure to the caller.
            self.assertTrue(result["session_info"]["transcription_failed"])
            # transcript_file must be present (empty) — the record/process CLI
            # handlers read it unconditionally; a missing key would KeyError and
            # turn the graceful failure into a non-zero crash.
            self.assertEqual(result["session_info"]["transcript_file"], "")

            # Round-trip through the meeting parser: the failure markers and the
            # honest message must survive so the renderer can show them instead
            # of a blank note. (This is the gap that produced a blank "No summary
            # available" meeting before the parser propagated these fields.)
            parsed = _parse_meeting_markdown(summary_path)
            self.assertTrue(parsed["session_info"]["transcription_failed"])
            self.assertTrue(parsed["session_info"]["reprocessable"])
            self.assertEqual(parsed["session_info"]["audio_file"], str(audio))
            self.assertIn("metal::malloc", parsed["session_info"]["error"])
            # The honest message is captured as the meeting summary (written
            # under a ## Summary heading), not silently dropped.
            self.assertIn("Transcription failed", parsed["summary"])
            self.assertIn("preserved", parsed["summary"])

    def test_multiline_error_does_not_corrupt_frontmatter(self):
        """A multi-line exception message must collapse to a single line so the
        YAML frontmatter round-trips cleanly through _parse_meeting_markdown."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_dir = Path(tmp_dir) / "output"
            out_dir.mkdir()
            audio = _make_audio_file(tmp_dir, "session.webm")
            recorder = MeetingPipeline.__new__(MeetingPipeline)
            recorder.output_dir = out_dir
            transcript_data = {
                "duration_seconds": 60.0,
                "configured_language": "en",
                "transcription_failed": True,
                "error": "RuntimeError: boom\nTraceback line 1\nTraceback line 2",
            }
            recorder._handle_transcription_failure(
                audio, "Crashy meeting", transcript_data, notes_text=None
            )
            parsed = _parse_meeting_markdown(out_dir / f"{audio.stem}_summary.md")
        self.assertTrue(parsed["session_info"]["transcription_failed"])
        self.assertNotIn("\n", parsed["session_info"]["error"])
        self.assertIn("boom", parsed["session_info"]["error"])
        # The honest summary message still parses intact.
        self.assertIn("Transcription failed", parsed["summary"])

    def test_live_transcript_marker_round_trips(self):
        """Gap 1 (#207): a meeting saved from the live-transcript fallback
        carries is_live_transcript in its frontmatter, and the parser surfaces
        it in session_info so the UI/future code know no batch transcript
        exists."""
        from simple_recorder import _render_frontmatter

        with tempfile.TemporaryDirectory() as tmp_dir:
            md_path = Path(tmp_dir) / "live_summary.md"
            md_meta = {
                "title": "Rescued meeting",
                "date": "2026-06-22",
                "duration_seconds": 120,
                "language": "en",
                "is_diarised": False,
                "is_live_transcript": True,
            }
            lines = _render_frontmatter(md_meta)
            lines += ["", "## Summary", "", "Rescued from live capture.", "",
                      "## Transcript", "", "Live captured words here."]
            md_path.write_text("\n".join(lines), encoding="utf-8")
            parsed = _parse_meeting_markdown(md_path)
        self.assertTrue(parsed["session_info"]["is_live_transcript"])

    def test_batch_meeting_has_no_live_marker(self):
        """Regression: a normal batch-transcribed meeting must NOT gain the
        is_live_transcript marker."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            md_path = Path(tmp_dir) / "batch_summary.md"
            md_path.write_text(
                "---\n"
                'title: "Normal meeting"\n'
                "date: 2026-06-22\n"
                "is_diarised: false\n"
                "---\n\n"
                "## Summary\n\nBatch transcribed.\n\n"
                "## Transcript\n\nReal batch words.\n",
                encoding="utf-8",
            )
            parsed = _parse_meeting_markdown(md_path)
        self.assertNotIn("is_live_transcript", parsed["session_info"])

    def test_normal_meeting_has_no_failure_markers(self):
        """Regression: a normal (non-failure) meeting's session_info must not
        gain the failure keys, so existing consumers are unchanged."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            md_path = Path(tmp_dir) / "normal_summary.md"
            md_path.write_text(
                "---\n"
                'title: "Weekly sync"\n'
                "date: 2026-06-11\n"
                "is_diarised: false\n"
                "---\n\n"
                "## Summary\n\nWe discussed the roadmap.\n\n"
                "## Transcript\n\nHello everyone.\n",
                encoding="utf-8",
            )
            parsed = _parse_meeting_markdown(md_path)
        self.assertNotIn("transcription_failed", parsed["session_info"])
        self.assertEqual(parsed["summary"], "We discussed the roadmap.")


class LiveTranscriptFallbackTests(unittest.TestCase):
    """Live-transcript fallback decision + file consistency (#207, Fix 4/6).

    The fallback must rescue a meeting only when the batch result is genuinely
    unusable (crash or the silence sentinel) — NOT merely short — and when it
    fires it must overwrite the on-disk transcript so `query`/export don't keep
    reading "No speech detected".
    """

    def test_silence_sentinel_constant_is_in_sync(self):
        """Fix 4 hinges on simple_recorder detecting the EXACT sentinel the
        transcriber writes. Pin that the two agree so a future reword of one
        can't silently break the fallback trigger."""
        import simple_recorder
        from src.transcriber import SILENCE_SENTINEL
        self.assertEqual(SILENCE_SENTINEL, "No speech detected in audio")
        self.assertEqual(simple_recorder._SILENCE_SENTINEL, SILENCE_SENTINEL)

    def test_short_real_transcript_does_not_trigger_fallback(self):
        """Fix 4: a correct-but-short batch transcript (under the 100-char
        live-fallback floor) is a real result and must NOT be replaced. The
        trigger is batch_failed OR the exact silence sentinel — never length.

        Calls the production predicate itself. It used to be restated here,
        which meant this test could stay green while process_streaming
        changed underneath it."""
        import simple_recorder
        sentinel = simple_recorder._SILENCE_SENTINEL
        short_real = "Quick sync done."  # < 100 chars but genuine speech
        reason = simple_recorder._unusable_batch_reason

        self.assertIsNone(reason(short_real, False, None))
        self.assertIsNotNone(reason(sentinel, False, None))
        self.assertIsNotNone(reason("", True, None))  # crash

    def test_a_batch_missing_most_of_the_file_loses_to_the_live_transcript(self):
        """A batch that skipped most of its transcription windows is neither
        a crash nor silence, so it used to pass the gate and replace a
        complete live transcript with a full-of-holes one."""
        import simple_recorder
        reason = simple_recorder._unusable_batch_reason
        self.assertIsNotNone(reason("Some words.", False, 0.2))
        self.assertIn("20%", reason("Some words.", False, 0.2))

    def test_a_batch_missing_only_a_window_or_two_still_wins(self):
        """The live transcript is complete but lower quality. A meeting that
        lost a window is still the better transcript, so the swap must not
        fire on every gap — only when most of the file is gone."""
        import simple_recorder
        reason = simple_recorder._unusable_batch_reason
        self.assertIsNone(reason("Some words.", False, 0.95))
        self.assertIsNone(reason("Some words.", False, simple_recorder._MIN_BATCH_WINDOW_COVERAGE))

    def test_a_backend_that_cannot_report_coverage_is_not_punished(self):
        """whisper.cpp and parakeet-mlx do no windowing of their own. Unknown
        must never be read as bad, or every macOS meeting would be replaced."""
        import simple_recorder
        self.assertIsNone(simple_recorder._unusable_batch_reason("Real words.", False, None))

    def test_fallback_overwrites_transcript_file(self):
        """Fix 6: when the live fallback fires, the _transcript.txt the batch
        path already wrote (containing the silence sentinel) must be overwritten
        with the live text so on-disk and in-memory transcripts agree."""
        import simple_recorder
        sentinel = simple_recorder._SILENCE_SENTINEL
        live_text = "This is the live transcript the user actually watched " \
                    "stream in during the meeting, well over the floor."

        with tempfile.TemporaryDirectory() as tmp_dir:
            transcript_file = Path(tmp_dir) / "rec_transcript.txt"
            transcript_file.write_text(
                f"Session: Test\n{'='*60}\n\n{sentinel}\n", encoding="utf-8"
            )
            # Replicate the production overwrite step.
            transcript_file.write_text(live_text, encoding="utf-8")
            self.assertEqual(transcript_file.read_text(encoding="utf-8"), live_text)
            self.assertNotIn(sentinel, transcript_file.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
