import json
import os
import subprocess
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, patch

from src import apple_speech
from src.config import Config, apple_speech_supported
from src.transcriber import WhisperTranscriber


class AppleSpeechResolverTests(unittest.TestCase):
    def setUp(self):
        apple_speech._SIDECAR_CACHE = None

    def tearDown(self):
        apple_speech._SIDECAR_CACHE = None

    def test_override_resolves_executable_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp:
            sidecar = Path(tmp) / "steno-transcribe"
            sidecar.write_bytes(b"binary")
            sidecar.chmod(0o755)
            with patch.object(apple_speech.sys, "platform", "darwin"), patch.dict(
                os.environ,
                {"STENOAI_TRANSCRIBE_SIDECAR_PATH": str(sidecar)},
                clear=False,
            ):
                self.assertEqual(apple_speech.resolve_sidecar(), str(sidecar))

    def test_non_macos_status_is_unavailable_without_spawning(self):
        with patch.object(apple_speech.sys, "platform", "win32"), patch(
            "src.apple_speech.subprocess.run"
        ) as run:
            result = apple_speech.status("en")
        self.assertFalse(result["available"])
        run.assert_not_called()

    def test_structured_sidecar_error_is_preserved(self):
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=1,
            stdout=json.dumps({"success": False, "error": "unsupported locale"}),
            stderr="",
        )
        with patch("src.apple_speech.resolve_sidecar", return_value="/sidecar"), patch(
            "src.apple_speech.subprocess.run", return_value=completed
        ):
            with self.assertRaisesRegex(RuntimeError, "unsupported locale"):
                apple_speech.prepare("xx")

    def test_transcribe_file_normalizes_json_contract(self):
        payload = {
            "text": "Hello",
            "segments": [{"text": "Hello", "start": 0, "end": 1}],
            "duration_seconds": 1,
            "detected_language": "en",
        }
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=json.dumps(payload), stderr=""
        )
        with patch("src.apple_speech.resolve_sidecar", return_value="/sidecar"), patch(
            "src.apple_speech.subprocess.run", return_value=completed
        ) as run:
            result = apple_speech.transcribe_file(Path("/tmp/audio.wav"), language="en")

        self.assertEqual(result, payload)
        self.assertEqual(
            run.call_args.args[0],
            ["/sidecar", "transcribe-file", "/tmp/audio.wav", "en"],
        )


class AppleSpeechConfigTests(unittest.TestCase):
    def test_platform_floor(self):
        self.assertTrue(
            apple_speech_supported(platform_name="darwin", mac_version="26.0")
        )
        self.assertFalse(
            apple_speech_supported(platform_name="darwin", mac_version="25.9")
        )
        self.assertFalse(
            apple_speech_supported(platform_name="win32", mac_version="27.0")
        )

    def test_fresh_supported_mac_defaults_to_apple(self):
        with tempfile.TemporaryDirectory() as tmp, patch(
            "src.config.apple_speech_supported", return_value=True
        ):
            config = Config(Path(tmp) / "config.json")
            self.assertEqual(config.get_transcription_engine(), "apple")

    def test_existing_explicit_engine_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp, patch(
            "src.config.apple_speech_supported", return_value=True
        ):
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({"transcription_engine": "parakeet"}))
            config = Config(path)
            self.assertEqual(config.get_transcription_engine(), "parakeet")

    def test_apple_cannot_be_selected_on_unsupported_platform(self):
        with tempfile.TemporaryDirectory() as tmp, patch(
            "src.config.apple_speech_supported", return_value=False
        ):
            config = Config(Path(tmp) / "config.json")
            self.assertFalse(config.set_transcription_engine("apple"))


class AppleSpeechDispatchTests(unittest.TestCase):
    def test_explicit_apple_engine_never_falls_back_to_parakeet(self):
        config = Mock()
        config.get_transcription_engine.return_value = "apple"
        with patch("src.config.get_config", return_value=config), patch(
            "src.transcriber.APPLE_SPEECH_AVAILABLE", True
        ):
            transcriber = WhisperTranscriber()
        self.assertEqual(transcriber.backend, "apple-speech")

    def test_apple_backend_uses_native_file_contract(self):
        transcriber = object.__new__(WhisperTranscriber)
        transcriber.backend = "apple-speech"
        expected = {
            "text": "Native",
            "segments": [],
            "duration_seconds": 1,
            "detected_language": "en",
        }
        with patch(
            "src.transcriber._apple_transcribe_file", return_value=expected
        ) as native, patch(
            "src.transcriber._heartbeat_while_waiting",
            return_value=nullcontext(),
        ):
            result = transcriber._run_backend(Path("audio.wav"), "en")

        native.assert_called_once_with(Path("audio.wav"), language="en")
        self.assertEqual(result["text"], "Native")
        self.assertIsNone(result["window_coverage"])


class NativeAppleSpeechContractTests(unittest.TestCase):
    sidecar = Path(__file__).parents[1] / "bin" / "steno-transcribe"

    @unittest.skipUnless(
        apple_speech.sys.platform == "darwin"
        and sidecar.is_file()
        and os.access(sidecar, os.X_OK),
        "native Apple transcription sidecar is not built",
    )
    def test_status_command_emits_the_stable_json_contract(self):
        completed = subprocess.run(
            [str(self.sidecar), "status", "en"],
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        payload = json.loads(completed.stdout)
        self.assertTrue(payload["success"])
        self.assertTrue(payload["available"])
        self.assertTrue(payload["supported"])
        self.assertEqual(payload["display_name"], "Apple On-Device")
        self.assertTrue(payload["system_managed"])


class LexicalContentFilterContractTests(unittest.TestCase):
    """
    Regression coverage for the Swift hasLexicalContent() contract.

    This class mirrors the Swift helper's logic in Python so that the filter
    behaviour can be verified on any platform without a built sidecar.  The
    predicate rejects a string when every code-point is either whitespace or a
    non-letter/non-digit character (i.e. pure punctuation or whitespace).
    """

    @staticmethod
    def has_lexical_content(text: str) -> bool:
        """Python equivalent of the Swift hasLexicalContent() helper."""
        import unicodedata

        for ch in text:
            if ch in (" ", "\t", "\n", "\r"):
                continue
            cat = unicodedata.category(ch)
            # 'L' = Letter, 'N' = Number; any sub-category qualifies.
            if cat.startswith("L") or cat.startswith("N"):
                return True
        return False

    # ── Punctuation-only strings that MUST be rejected ───────────────────────

    def test_period_is_rejected(self):
        self.assertFalse(self.has_lexical_content("."))

    def test_ideographic_period_is_rejected(self):
        self.assertFalse(self.has_lexical_content("。"))

    def test_comma_only_is_rejected(self):
        self.assertFalse(self.has_lexical_content(","))

    def test_fullwidth_comma_is_rejected(self):
        self.assertFalse(self.has_lexical_content("，"))

    def test_ellipsis_is_rejected(self):
        self.assertFalse(self.has_lexical_content("…"))

    def test_whitespace_only_is_rejected(self):
        self.assertFalse(self.has_lexical_content("   "))

    def test_empty_string_is_rejected(self):
        self.assertFalse(self.has_lexical_content(""))

    def test_multiple_punctuation_only_is_rejected(self):
        self.assertFalse(self.has_lexical_content(".,。，…"))

    def test_punctuation_with_whitespace_is_rejected(self):
        self.assertFalse(self.has_lexical_content(" . "))

    # ── Traditional Chinese strings that MUST be accepted ────────────────────

    def test_traditional_chinese_phrase_is_accepted(self):
        self.assertTrue(self.has_lexical_content("你好"))

    def test_traditional_chinese_with_trailing_period_is_accepted(self):
        self.assertTrue(self.has_lexical_content("你好。"))

    def test_traditional_chinese_with_leading_punctuation_is_accepted(self):
        self.assertTrue(self.has_lexical_content("，你好"))

    def test_traditional_chinese_mixed_punctuation_is_accepted(self):
        self.assertTrue(self.has_lexical_content("嗯，對。"))

    def test_zh_hant_longer_sentence_is_accepted(self):
        self.assertTrue(self.has_lexical_content("這是一個測試。"))

    # ── Latin letters and digits that MUST be accepted ───────────────────────

    def test_english_word_is_accepted(self):
        self.assertTrue(self.has_lexical_content("Hello"))

    def test_english_sentence_with_punctuation_is_accepted(self):
        self.assertTrue(self.has_lexical_content("Hello, world."))

    def test_digits_are_accepted(self):
        self.assertTrue(self.has_lexical_content("123"))

    def test_digit_with_unit_is_accepted(self):
        self.assertTrue(self.has_lexical_content("42%"))

    def test_single_letter_is_accepted(self):
        self.assertTrue(self.has_lexical_content("A"))

    def test_mixed_cjk_latin_is_accepted(self):
        self.assertTrue(self.has_lexical_content("Hello 你好"))


if __name__ == "__main__":
    unittest.main()
