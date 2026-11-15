import ast
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from click.testing import CliRunner

import simple_recorder
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
        with patch("src.apple_speech._is_supported", return_value=False), patch(
            "src.apple_speech.subprocess.run"
        ) as run:
            result = apple_speech.status("en")
        self.assertFalse(result["available"])
        run.assert_not_called()

    def test_unsupported_macos_status_is_unavailable_without_spawning(self):
        with patch("src.config.apple_speech_supported", return_value=False), patch(
            "src.apple_speech.subprocess.run"
        ) as run:
            result = apple_speech.status("en")
        self.assertFalse(result["available"])
        self.assertFalse(result["supported"])
        run.assert_not_called()

    def test_unexpected_support_check_failure_is_not_reported_as_unavailable(self):
        with patch("src.config.apple_speech_supported", side_effect=RuntimeError("broken gate")), patch(
            "src.apple_speech.subprocess.run"
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "broken gate"):
                apple_speech.status("en")
        run.assert_not_called()

    def test_macos_14_and_15_never_resolve_or_spawn_the_sidecar(self):
        for version in ("14.4", "15.7"):
            with self.subTest(version=version), patch(
                "src.config.sys.platform", "darwin"
            ), patch(
                "src.config.platform.mac_ver", return_value=(version, ("", "", ""), "arm64")
            ), patch("src.apple_speech.resolve_sidecar") as resolve, patch(
                "src.apple_speech.subprocess.run"
            ) as run:
                self.assertFalse(apple_speech.status("en")["available"])
                with self.assertRaisesRegex(RuntimeError, "unavailable on this Mac"):
                    apple_speech._run(["status", "en"], timeout=15)
                resolve.assert_not_called()
                run.assert_not_called()

    def test_missing_sidecar_status_is_unavailable_without_spawning(self):
        with patch("src.config.apple_speech_supported", return_value=True), patch(
            "src.apple_speech.resolve_sidecar", return_value=None
        ), patch("src.apple_speech.subprocess.run") as run:
            result = apple_speech.status("en")
        self.assertTrue(result["success"])
        self.assertFalse(result["available"])
        self.assertFalse(result["installed"])
        run.assert_not_called()

    def test_internal_run_cannot_bypass_host_gate(self):
        with patch("src.config.apple_speech_supported", return_value=False), patch(
            "src.apple_speech.subprocess.run"
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "unavailable on this Mac"):
                apple_speech._run(["status", "en"], timeout=15)
        run.assert_not_called()

    def test_prepare_on_unsupported_platform_raises_without_spawning(self):
        with patch("src.apple_speech._is_supported", return_value=False), patch(
            "src.apple_speech.subprocess.run"
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "unavailable on this Mac"):
                apple_speech.prepare("en")
        run.assert_not_called()

    def test_transcribe_file_on_unsupported_platform_raises_without_spawning(self):
        with patch("src.apple_speech._is_supported", return_value=False), patch(
            "src.apple_speech.subprocess.run"
        ) as run:
            with self.assertRaisesRegex(RuntimeError, "unavailable on this Mac"):
                apple_speech.transcribe_file(Path("/tmp/audio.wav"), language="en")
        run.assert_not_called()

    def test_structured_sidecar_error_is_preserved(self):
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=1,
            stdout=json.dumps({"success": False, "error": "unsupported locale"}),
            stderr="",
        )
        with patch("src.apple_speech._is_supported", return_value=True), patch(
            "src.apple_speech.resolve_sidecar", return_value="/sidecar"
        ), patch("src.apple_speech.subprocess.run", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "unsupported locale"):
                apple_speech.prepare("xx")

    def test_unstructured_sidecar_error_reports_exit_without_stderr(self):
        completed = subprocess.CompletedProcess(
            args=[], returncode=86, stdout="", stderr="private/audio/path.wav"
        )
        with patch("src.apple_speech._is_supported", return_value=True), patch(
            "src.apple_speech.resolve_sidecar", return_value="/sidecar"
        ), patch("src.apple_speech.subprocess.run", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "sidecar exit 86") as raised:
                apple_speech.prepare("en")
        self.assertNotIn("private/audio/path.wav", str(raised.exception))

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
        with patch("src.apple_speech._is_supported", return_value=True), patch(
            "src.apple_speech.resolve_sidecar", return_value="/sidecar"
        ), patch("src.apple_speech.subprocess.run", return_value=completed) as run:
            result = apple_speech.transcribe_file(Path("/tmp/audio.wav"), language="en")

        self.assertEqual(result, payload)
        self.assertEqual(
            run.call_args.args[0],
            ["/sidecar", "transcribe-file", "/tmp/audio.wav", "en"],
        )


class AppleSpeechConfigTests(unittest.TestCase):
    def test_platform_floor(self):
        for version in ("16.0", "16.3", "26.0", "27.0"):
            self.assertTrue(
                apple_speech_supported(platform_name="darwin", mac_version=version), version
            )
        for version in ("14.4", "15.7", "17.0", "25.9", "unknown"):
            self.assertFalse(
                apple_speech_supported(platform_name="darwin", mac_version=version), version
            )
        self.assertFalse(
            apple_speech_supported(platform_name="win32", mac_version="27.0")
        )

    def test_actual_platform_read_uses_the_same_compat_gate(self):
        with patch("src.config.sys.platform", "darwin"), patch(
            "src.config.platform.mac_ver", return_value=("16.0", ("", "", ""), "arm64")
        ):
            self.assertTrue(apple_speech_supported())

    def test_bundle_requires_sidecar_only_on_supported_macos_versions(self):
        # Execute only the spec's version helper and transcribe-sidecar branch;
        # the full PyInstaller spec would analyse packages and require binaries.
        spec = ast.parse((Path(__file__).parents[1] / "stenoai.spec").read_text())
        helper = next(
            node for node in spec.body
            if isinstance(node, ast.FunctionDef) and node.name == "_macos_is_26_or_newer"
        )
        gate = next(
            node for node in spec.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "_REQUIRES_TRANSCRIBE_SIDECAR"
                    for target in node.targets)
        )
        branch = next(
            node for node in spec.body
            if isinstance(node, ast.If) and isinstance(node.test, ast.Name)
            and node.test.id == "_REQUIRES_TRANSCRIBE_SIDECAR"
        )
        fragment = compile(ast.Module(body=[helper, gate, branch], type_ignores=[]),
                           "stenoai.spec", "exec")
        for platform_name, version, expected in (
            ("darwin", "14.4", False),
            ("darwin", "15.7", False),
            ("darwin", "16.0", True),
            ("darwin", "16.3", True),
            ("darwin", "17.0", False),
            ("darwin", "25.9", False),
            ("darwin", "26.0", True),
            ("darwin", "27.0", True),
            ("win32", "26.0", False),
        ):
            require_sidecar = Mock(return_value=Path("/fake/steno-transcribe"))
            namespace = {
                "sys": SimpleNamespace(platform=platform_name),
                "Path": Path,
                "ollama_bin_dir": "/fake/bin",
                "required_macos_sidecars": {},
                "require_macos_sidecar": require_sidecar,
            }
            with self.subTest(platform=platform_name, version=version), patch(
                "platform.mac_ver", return_value=(version, ("", "", ""), "arm64")
            ):
                exec(fragment, namespace)
                self.assertEqual(namespace["_REQUIRES_TRANSCRIBE_SIDECAR"], expected)
                self.assertEqual(require_sidecar.called, expected)
                self.assertEqual(
                    namespace["required_macos_sidecars"]["steno-transcribe"] is not None,
                    expected,
                )

        namespace = {"sys": SimpleNamespace(platform="darwin")}
        with patch("platform.mac_ver", return_value=("unknown", ("", "", ""), "arm64")):
            with self.assertRaisesRegex(RuntimeError, "Cannot determine macOS version"):
                exec(compile(ast.Module(body=[helper], type_ignores=[]), "stenoai.spec", "exec"), namespace)
                namespace["_macos_is_26_or_newer"]()

    def test_backend_foundation_preserves_existing_parakeet_default(self):
        with tempfile.TemporaryDirectory() as tmp, patch(
            "src.config.apple_speech_supported", return_value=True
        ):
            config = Config(Path(tmp) / "config.json")
            self.assertEqual(config.get_transcription_engine(), "parakeet")

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
            self.assertNotIn("apple", config.available_transcription_engines())

    def test_available_engine_list_includes_apple_only_on_supported_host(self):
        with patch("src.config.apple_speech_supported", return_value=True):
            self.assertIn("apple", Config.available_transcription_engines())
        with patch("src.config.apple_speech_supported", return_value=False):
            self.assertNotIn("apple", Config.available_transcription_engines())

    def test_cli_advertises_only_available_engines(self):
        with tempfile.TemporaryDirectory() as tmp, patch(
            "src.config.apple_speech_supported", return_value=False
        ):
            config = Config(Path(tmp) / "config.json")
            with patch("src.config.get_config", return_value=config):
                get_result = CliRunner().invoke(simple_recorder.get_transcription_engine_cmd)
                set_result = CliRunner().invoke(
                    simple_recorder.set_transcription_engine_cmd, ["apple"]
                )
            self.assertEqual(get_result.exit_code, 0)
            self.assertEqual(set_result.exit_code, 0)
            self.assertNotIn("apple", json.loads(get_result.output)["valid_engines"])
            self.assertNotIn("apple", json.loads(set_result.output)["valid_engines"])

    def test_explicit_apple_choice_reads_as_parakeet_on_older_mac(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({"transcription_engine": "apple"}))
            with patch("src.config.apple_speech_supported", return_value=False):
                config = Config(path)
                self.assertEqual(config.get_transcription_engine(), "parakeet")
            self.assertEqual(json.loads(path.read_text())["transcription_engine"], "apple")


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
        apple_speech_supported()
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
        self.assertIsInstance(payload["available"], bool)
        self.assertIsInstance(payload["supported"], bool)
        self.assertIsInstance(payload["installed"], bool)
        self.assertFalse(payload["installed"] and not payload["supported"])
        self.assertEqual(payload["display_name"], "Apple On-Device")
        self.assertTrue(payload["system_managed"])


if __name__ == "__main__":
    unittest.main()
