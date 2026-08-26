"""Tests for the audio pre-processing pass (highpass + loudnorm).

The contract: pre-processing improves the input when it can and silently
steps aside when it can't — a missing ffmpeg, a failed run, or a timeout
must never fail the meeting. Temp files are always cleaned up, and the
diarised path's split channels (already 16 kHz mono + high-passed) skip
the mono pass instead of being processed twice.
"""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import src.transcriber as transcriber_mod
from src.transcriber import WhisperTranscriber, _audio_filter_chain


def _build_transcriber() -> WhisperTranscriber:
    # Bypass __init__ to skip ffmpeg-PATH probing and the parakeet
    # import-availability gate — mirrors tests/test_transcriber_failure.py.
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


_OK_RESULT = {
    "text": "hello world",
    "segments": [{"text": "hello world", "start": 0.0, "end": 1.0}],
    "duration_seconds": 1.0,
    "detected_language": None,
    "detected_language_probability": None,
}


class FilterChainTests(unittest.TestCase):
    def test_chain_contains_highpass_and_loudnorm(self):
        chain = _audio_filter_chain()
        self.assertIn(f"highpass=f={transcriber_mod.AUDIO_HIGHPASS_HZ}", chain)
        self.assertIn(f"loudnorm={transcriber_mod.AUDIO_LOUDNORM}", chain)


class PreprocessAudioTests(unittest.TestCase):
    def test_falls_back_when_ffmpeg_missing(self):
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber_mod, "_resolve_ffmpeg", return_value=None):
                out_path, is_temp = transcriber._preprocess_audio(audio)
        self.assertEqual(out_path, audio)
        self.assertFalse(is_temp)

    def test_falls_back_on_ffmpeg_nonzero_exit(self):
        transcriber = _build_transcriber()
        failed = SimpleNamespace(returncode=1, stderr=b"boom")
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber_mod, "_resolve_ffmpeg", return_value="/fake/ffmpeg"), \
                 patch.object(transcriber_mod.subprocess, "run", return_value=failed):
                out_path, is_temp = transcriber._preprocess_audio(audio)
        self.assertEqual(out_path, audio)
        self.assertFalse(is_temp)

    def test_falls_back_on_exception(self):
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber_mod, "_resolve_ffmpeg", return_value="/fake/ffmpeg"), \
                 patch.object(
                     transcriber_mod.subprocess, "run",
                     side_effect=transcriber_mod.subprocess.TimeoutExpired("ffmpeg", 600),
                 ):
                out_path, is_temp = transcriber._preprocess_audio(audio)
        self.assertEqual(out_path, audio)
        self.assertFalse(is_temp)

    def test_success_returns_temp_and_filter_chain_used(self):
        transcriber = _build_transcriber()
        captured_cmd = {}

        def fake_run(cmd, **kwargs):
            captured_cmd["cmd"] = cmd
            Path(cmd[-1]).write_bytes(b"\x00" * 64)  # ffmpeg wrote output
            return SimpleNamespace(returncode=0, stderr=b"")

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber_mod, "_resolve_ffmpeg", return_value="/fake/ffmpeg"), \
                 patch.object(transcriber_mod.subprocess, "run", side_effect=fake_run):
                out_path, is_temp = transcriber._preprocess_audio(audio)
        try:
            self.assertTrue(is_temp)
            self.assertNotEqual(out_path, audio)
            af_idx = captured_cmd["cmd"].index("-af")
            self.assertEqual(captured_cmd["cmd"][af_idx + 1], _audio_filter_chain())
        finally:
            if out_path.exists():
                out_path.unlink()


class ConvertTo16khzSkipTests(unittest.TestCase):
    def test_already_16k_mono_pcm_is_not_reconverted(self):
        """The whisper.cpp fallback receives _preprocess_audio's 16 kHz mono
        temp — a second ffmpeg decode+encode of an identical format must be
        skipped."""
        import wave

        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = Path(tmp_dir) / "prep.wav"
            with wave.open(str(audio), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(16000)
                wf.writeframes(b"\x00\x00" * 32000)  # 2 s
            with patch.object(transcriber_mod.subprocess, "run") as run_mock:
                out_path, duration = transcriber._convert_to_16khz(audio)
            run_mock.assert_not_called()
            self.assertEqual(out_path, audio)
            self.assertAlmostEqual(duration, 2.0)


class TranscribeAudioPreprocessIntegrationTests(unittest.TestCase):
    def test_temp_cleaned_after_successful_transcription(self):
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            temp = Path(tmp_dir) / "stenoai_prep_meeting.wav"
            temp.write_bytes(b"\x00" * 2048)
            with patch.object(transcriber, "_preprocess_audio", return_value=(temp, True)), \
                 patch.object(transcriber, "_run_backend", return_value=dict(_OK_RESULT)) as run_mock:
                out = transcriber.transcribe_audio(audio, language="en")
            # Backend received the preprocessed temp, and it's gone afterwards.
            self.assertEqual(run_mock.call_args[0][0], temp)
            self.assertFalse(temp.exists())
        self.assertEqual(out["text"], "hello world")

    def test_temp_cleaned_when_backend_crashes(self):
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            temp = Path(tmp_dir) / "stenoai_prep_meeting.wav"
            temp.write_bytes(b"\x00" * 2048)
            with patch.object(transcriber, "_preprocess_audio", return_value=(temp, True)), \
                 patch.object(transcriber, "_run_backend", side_effect=RuntimeError("boom")), \
                 patch.object(transcriber, "_build_whisper_fallback", return_value=False):
                out = transcriber.transcribe_audio(audio, language="en")
            self.assertTrue(out.get("transcription_failed"))
            self.assertFalse(temp.exists())

    def test_preprocessed_flag_skips_mono_pass(self):
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber, "_preprocess_audio") as prep_mock, \
                 patch.object(transcriber, "_run_backend", return_value=dict(_OK_RESULT)):
                transcriber.transcribe_audio(audio, language="en", _preprocessed=True)
            prep_mock.assert_not_called()

    def test_diarised_channels_skip_mono_pass(self):
        transcriber = _build_transcriber()
        with tempfile.TemporaryDirectory() as tmp_dir:
            mic = _make_audio_file(tmp_dir, "stenoai_ch0_meeting.wav")
            system = _make_audio_file(tmp_dir, "stenoai_ch1_meeting.wav")
            with patch.object(
                     transcriber, "_split_stereo_to_channels",
                     return_value=(mic, system, 10.0),
                 ), \
                 patch.object(transcriber, "_check_rms_energy", return_value=True), \
                 patch.object(
                     transcriber, "transcribe_audio",
                     wraps=transcriber.transcribe_audio,
                 ) as ta_mock, \
                 patch.object(transcriber, "_preprocess_audio") as prep_mock, \
                 patch.object(transcriber, "_run_backend", return_value=dict(_OK_RESULT)):
                transcriber.transcribe_diarised(Path(tmp_dir) / "meeting.wav", language="en")
            # Both per-channel calls passed _preprocessed=True and the mono
            # pre-processing pass never ran.
            self.assertEqual(ta_mock.call_count, 2)
            for call in ta_mock.call_args_list:
                self.assertTrue(call.kwargs.get("_preprocessed"))
            prep_mock.assert_not_called()

    def test_split_filter_includes_highpass_no_loudnorm(self):
        """The diarised split applies highpass only — per-channel loudnorm
        would distort the relative-RMS speaker-bleed heuristic."""
        transcriber = _build_transcriber()
        captured_cmds = []

        def fake_run(cmd, **kwargs):
            captured_cmds.append(cmd)
            if "-t" in cmd:  # channel-count probe
                return SimpleNamespace(returncode=0, stderr="Audio: pcm_s16le, stereo\nDuration: 00:00:10.00", stdout="")
            Path(cmd[-1]).write_bytes(b"\x00" * 64)
            return SimpleNamespace(returncode=0, stderr=b"")

        with tempfile.TemporaryDirectory() as tmp_dir:
            audio = _make_audio_file(tmp_dir)
            with patch.object(transcriber_mod, "_resolve_ffmpeg", return_value="/fake/ffmpeg"), \
                 patch.object(transcriber_mod.subprocess, "run", side_effect=fake_run):
                transcriber._split_stereo_to_channels(audio)

        split_cmds = [c for c in captured_cmds if "-af" in c]
        self.assertEqual(len(split_cmds), 2)
        for cmd in split_cmds:
            af = cmd[cmd.index("-af") + 1]
            self.assertIn(f"highpass=f={transcriber_mod.AUDIO_HIGHPASS_HZ}", af)
            self.assertNotIn("loudnorm", af)
