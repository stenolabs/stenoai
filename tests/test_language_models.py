"""Tests for language-specific Whisper models (LANGUAGE_WHISPER_MODELS).

An installed fine-tune such as ivrit.ai's Hebrew model must replace the main
whisper.cpp model only for recordings pinned to or detected as its language,
must never become selectable as the main model, and must fall back to the
main model whenever it can't be used.
"""

import json
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

import simple_recorder
from src import whisper_models
from src.config import Config
from src.transcriber import WhisperTranscriber

HEBREW_MODEL = "ivrit-large-v3-turbo"
ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


class FakeWhisperModel:
    """Stands in for pywhispercpp's Model: records which instance decoded."""

    def __init__(self, label, detected=("en", 0.9)):
        self.label = label
        self.detected = detected
        self.transcribe_calls = []

    def auto_detect_language(self, media=None):
        return self.detected, {}

    def transcribe(self, media=None, new_segment_callback=None, **params):
        self.transcribe_calls.append(params)
        return [SimpleNamespace(text=f"from {self.label}", t0=0, t1=100)]


def _make_wav(tmp_dir: str) -> Path:
    path = Path(tmp_dir) / "audio.wav"
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x00" * 16000)
    return path


def _build_transcriber(main_model) -> WhisperTranscriber:
    # Bypass __init__ (ffmpeg probing, engine selection) like the other
    # transcriber tests, and without the _language_models attribute so the
    # lazy-initialisation path is covered too.
    transcriber = WhisperTranscriber.__new__(WhisperTranscriber)
    transcriber.model = main_model
    transcriber.model_size = "large-v3-turbo"
    transcriber.backend = "whisper.cpp"
    return transcriber


class RegistryTests(unittest.TestCase):
    def test_language_models_are_not_selectable_as_the_main_model(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertNotIn(HEBREW_MODEL, config.SUPPORTED_WHISPER_MODELS)
            self.assertFalse(config.set_whisper_model(HEBREW_MODEL))

    def test_hebrew_model_url_is_pinned_to_a_commit(self):
        url = whisper_models._download_url(HEBREW_MODEL)
        self.assertTrue(url.startswith("https://huggingface.co/ivrit-ai/"))
        self.assertNotIn("/resolve/main/", url)

    def test_main_model_url_unchanged(self):
        self.assertEqual(
            whisper_models._download_url("large-v3-turbo"),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
        )

    def test_language_model_for_requires_install(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            with patch.object(whisper_models, "get_models_dir", return_value=Path(tmp_dir)):
                self.assertIsNone(whisper_models.language_model_for("he"))
                (Path(tmp_dir) / f"ggml-{HEBREW_MODEL}.bin").write_bytes(b"x")
                self.assertEqual(whisper_models.language_model_for("he"), HEBREW_MODEL)
                self.assertIsNone(whisper_models.language_model_for("en"))
                self.assertIsNone(whisper_models.language_model_for(None))

    def test_download_uses_registry_url(self):
        fake_response = MagicMock()
        fake_response.__enter__ = MagicMock(return_value=fake_response)
        fake_response.__exit__ = MagicMock(return_value=False)
        fake_response.headers = {"content-length": "3"}
        fake_response.iter_content = MagicMock(return_value=iter([b"abc"]))
        entry = {**whisper_models.LANGUAGE_WHISPER_MODELS[HEBREW_MODEL], "sha256": ABC_SHA256}
        with tempfile.TemporaryDirectory() as tmp_dir:
            with patch.object(whisper_models, "get_models_dir", return_value=Path(tmp_dir)), \
                 patch.dict(whisper_models.LANGUAGE_WHISPER_MODELS, {HEBREW_MODEL: entry}), \
                 patch("requests.get", return_value=fake_response) as mock_get:
                ok = whisper_models.download_with_progress(HEBREW_MODEL, lambda *a: None)
            self.assertTrue(ok)
            self.assertEqual(
                mock_get.call_args.args[0],
                whisper_models.LANGUAGE_WHISPER_MODELS[HEBREW_MODEL]["url"],
            )
            self.assertTrue((Path(tmp_dir) / f"ggml-{HEBREW_MODEL}.bin").exists())


    def test_download_rejects_checksum_mismatch(self):
        fake_response = MagicMock()
        fake_response.__enter__ = MagicMock(return_value=fake_response)
        fake_response.__exit__ = MagicMock(return_value=False)
        fake_response.headers = {"content-length": "8"}
        fake_response.iter_content = MagicMock(return_value=iter([b"tampered"]))
        with tempfile.TemporaryDirectory() as tmp_dir:
            with patch.object(whisper_models, "get_models_dir", return_value=Path(tmp_dir)), \
                 patch("requests.get", return_value=fake_response):
                ok = whisper_models.download_with_progress(HEBREW_MODEL, lambda *a: None)
            self.assertFalse(ok)
            # Neither the final file nor a .part file is left behind.
            self.assertEqual(list(Path(tmp_dir).iterdir()), [])


    def test_download_fails_closed_without_a_registered_hash(self):
        entry = {**whisper_models.LANGUAGE_WHISPER_MODELS[HEBREW_MODEL]}
        entry.pop("sha256")
        with tempfile.TemporaryDirectory() as tmp_dir:
            with patch.object(whisper_models, "get_models_dir", return_value=Path(tmp_dir)), \
                 patch.dict(whisper_models.LANGUAGE_WHISPER_MODELS, {HEBREW_MODEL: entry}), \
                 patch("requests.get") as mock_get:
                ok = whisper_models.download_with_progress(HEBREW_MODEL, lambda *a: None)
            self.assertFalse(ok)
            mock_get.assert_not_called()

    def test_download_replaces_a_destination_another_process_installed(self):
        # Two concurrent pulls: the other process finished first. The commit
        # must overwrite rather than raise (Path.rename does on Windows).
        fake_response = MagicMock()
        fake_response.__enter__ = MagicMock(return_value=fake_response)
        fake_response.__exit__ = MagicMock(return_value=False)
        fake_response.headers = {"content-length": "3"}
        with tempfile.TemporaryDirectory() as tmp_dir:
            dest = Path(tmp_dir) / "ggml-large-v3-turbo.bin"

            def chunks():
                yield b"abc"
                dest.write_bytes(b"abc")  # the other process lands mid-download

            fake_response.iter_content = MagicMock(return_value=chunks())
            with patch.object(whisper_models, "get_models_dir", return_value=Path(tmp_dir)), \
                 patch("requests.get", return_value=fake_response), \
                 patch.object(whisper_models.os, "replace", wraps=whisper_models.os.replace) as replace:
                ok = whisper_models.download_with_progress("large-v3-turbo", lambda *a: None)
            self.assertTrue(ok)
            replace.assert_called_once()
            self.assertEqual(dest.read_bytes(), b"abc")

    def test_verify_keeps_a_good_file_and_removes_a_damaged_one(self):
        entry = {**whisper_models.LANGUAGE_WHISPER_MODELS[HEBREW_MODEL], "sha256": ABC_SHA256}
        with tempfile.TemporaryDirectory() as tmp_dir:
            dest = Path(tmp_dir) / f"ggml-{HEBREW_MODEL}.bin"
            with patch.object(whisper_models, "get_models_dir", return_value=Path(tmp_dir)), \
                 patch.dict(whisper_models.LANGUAGE_WHISPER_MODELS, {HEBREW_MODEL: entry}):
                dest.write_bytes(b"abc")
                self.assertTrue(whisper_models.verify_language_model(HEBREW_MODEL))
                self.assertTrue(dest.exists())
                dest.write_bytes(b"ab")  # truncated
                self.assertFalse(whisper_models.verify_language_model(HEBREW_MODEL))
                self.assertFalse(dest.exists())
                self.assertIsNone(whisper_models.language_model_for("he"))

    def test_pull_repairs_a_damaged_language_model(self):
        fake_response = MagicMock()
        fake_response.__enter__ = MagicMock(return_value=fake_response)
        fake_response.__exit__ = MagicMock(return_value=False)
        fake_response.headers = {"content-length": "3"}
        fake_response.iter_content = MagicMock(return_value=iter([b"abc"]))
        entry = {**whisper_models.LANGUAGE_WHISPER_MODELS[HEBREW_MODEL], "sha256": ABC_SHA256}
        with tempfile.TemporaryDirectory() as tmp_dir:
            dest = Path(tmp_dir) / f"ggml-{HEBREW_MODEL}.bin"
            dest.write_bytes(b"damaged")
            with patch.object(whisper_models, "get_models_dir", return_value=Path(tmp_dir)), \
                 patch.dict(whisper_models.LANGUAGE_WHISPER_MODELS, {HEBREW_MODEL: entry}), \
                 patch("requests.get", return_value=fake_response) as mock_get:
                ok = whisper_models.download_with_progress(HEBREW_MODEL, lambda *a: None)
            self.assertTrue(ok)
            mock_get.assert_called_once()
            self.assertEqual(dest.read_bytes(), b"abc")


class ConfigTests(unittest.TestCase):
    def test_enabled_by_default_and_round_trips(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            self.assertTrue(config.get_language_models_enabled())
            self.assertTrue(config.set_language_models_enabled(False))
            self.assertFalse(Config(config_path=path).get_language_models_enabled())

    def test_hebrew_is_a_supported_language(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            self.assertTrue(config.set_language("he"))
            self.assertEqual(config.get_language(), "he")


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.config = Config(config_path=Path(self._tmp.name) / "config.json")
        self.hebrew = FakeWhisperModel("hebrew")
        self.loaded_paths = []

        def fake_model_ctor(path, n_threads=None):
            self.loaded_paths.append(path)
            return self.hebrew

        for p in (
            patch("src.config.get_config", return_value=self.config),
            patch.object(whisper_models, "language_model_for",
                         side_effect=lambda lang: HEBREW_MODEL if lang == "he" else None),
            patch("src.transcriber.WhisperCppModel", side_effect=fake_model_ctor),
            patch.object(whisper_models, "verify_language_model", return_value=True),
        ):
            p.start()
            self.addCleanup(p.stop)

    def _transcribe(self, transcriber, language):
        with tempfile.TemporaryDirectory() as tmp_dir:
            return transcriber._run_whisper_cpp(_make_wav(tmp_dir), language=language)

    def test_detected_hebrew_uses_language_model(self):
        main = FakeWhisperModel("main", detected=("he", 0.97))
        transcriber = _build_transcriber(main)
        result = self._transcribe(transcriber, "auto")
        self.assertEqual(result["text"], "from hebrew")
        self.assertEqual(result["detected_language"], "he")
        self.assertEqual(self.hebrew.transcribe_calls, [{"language": "he"}])
        self.assertEqual(main.transcribe_calls, [])
        self.assertTrue(self.loaded_paths[0].endswith(f"ggml-{HEBREW_MODEL}.bin"))

    def test_pinned_hebrew_uses_language_model(self):
        transcriber = _build_transcriber(FakeWhisperModel("main"))
        self.assertEqual(self._transcribe(transcriber, "he")["text"], "from hebrew")

    def test_english_stays_on_main_model(self):
        main = FakeWhisperModel("main", detected=("en", 0.99))
        transcriber = _build_transcriber(main)
        self.assertEqual(self._transcribe(transcriber, "auto")["text"], "from main")
        self.assertEqual(self.loaded_paths, [])

    def test_disabled_setting_keeps_main_model(self):
        self.config.set_language_models_enabled(False)
        transcriber = _build_transcriber(FakeWhisperModel("main", detected=("he", 0.97)))
        self.assertEqual(self._transcribe(transcriber, "auto")["text"], "from main")
        self.assertEqual(self.loaded_paths, [])

    def test_language_model_loaded_once_across_channels(self):
        transcriber = _build_transcriber(FakeWhisperModel("main", detected=("he", 0.97)))
        self._transcribe(transcriber, "auto")
        self._transcribe(transcriber, "auto")
        self.assertEqual(len(self.loaded_paths), 1)
        self.assertEqual(len(self.hebrew.transcribe_calls), 2)

    def test_load_failure_falls_back_to_main_model(self):
        with patch("src.transcriber.WhisperCppModel", side_effect=RuntimeError("bad ggml")):
            transcriber = _build_transcriber(FakeWhisperModel("main", detected=("he", 0.97)))
            result = self._transcribe(transcriber, "auto")
        self.assertEqual(result["text"], "from main")

    def test_damaged_file_is_never_loaded(self):
        with patch.object(whisper_models, "verify_language_model", return_value=False):
            transcriber = _build_transcriber(FakeWhisperModel("main", detected=("he", 0.97)))
            result = self._transcribe(transcriber, "auto")
        self.assertEqual(result["text"], "from main")
        self.assertEqual(self.loaded_paths, [])


class CliTests(unittest.TestCase):
    def _invoke(self, command, args, config):
        with patch("src.config.get_config", return_value=config):
            result = CliRunner().invoke(command, args)
        self.assertEqual(result.exit_code, 0, result.output)
        return json.loads(result.output.strip().splitlines()[-1])

    def test_list_reports_language_models_separately(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            config = Config(config_path=Path(tmp_dir) / "config.json")
            with patch.object(whisper_models, "get_models_dir", return_value=Path(tmp_dir)):
                out = self._invoke(simple_recorder.list_whisper_models_cmd, [], config)
        self.assertNotIn(HEBREW_MODEL, out["supported_models"])
        entry = out["language_models"][HEBREW_MODEL]
        self.assertEqual(entry["language"], "he")
        self.assertFalse(entry["installed"])
        # The pinned URL is backend-only; the renderer has no use for it.
        self.assertNotIn("url", entry)
        self.assertTrue(out["language_models_enabled"])

    def test_set_language_models_enabled_persists(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "config.json"
            config = Config(config_path=path)
            out = self._invoke(simple_recorder.set_language_models_enabled_cmd, ["false"], config)
            self.assertEqual(out, {"success": True, "language_models_enabled": False})
            self.assertFalse(Config(config_path=path).get_language_models_enabled())

    def _pull_with_installed_file(self, content):
        entry = {**whisper_models.LANGUAGE_WHISPER_MODELS[HEBREW_MODEL], "sha256": ABC_SHA256}
        with tempfile.TemporaryDirectory() as tmp_dir:
            (Path(tmp_dir) / f"ggml-{HEBREW_MODEL}.bin").write_bytes(content)
            config = Config(config_path=Path(tmp_dir) / "config.json")
            with patch.object(whisper_models, "get_models_dir", return_value=Path(tmp_dir)), \
                 patch.dict(whisper_models.LANGUAGE_WHISPER_MODELS, {HEBREW_MODEL: entry}), \
                 patch.object(whisper_models, "download_with_progress", return_value=True) as download:
                out = self._invoke(simple_recorder.pull_whisper_model_cmd, [HEBREW_MODEL], config)
        return out, download

    def test_pull_accepts_language_model(self):
        out, download = self._pull_with_installed_file(b"abc")
        self.assertEqual(out["success"], True)
        self.assertTrue(out["already_installed"])
        download.assert_not_called()

    def test_pull_redownloads_a_damaged_language_model(self):
        out, download = self._pull_with_installed_file(b"damaged")
        self.assertEqual(out, {"success": True, "model": HEBREW_MODEL})
        download.assert_called_once()


if __name__ == "__main__":
    unittest.main()
