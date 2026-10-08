import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import ANY, patch

from click.testing import CliRunner

import simple_recorder
from src.config import Config


def _status_result(ready: bool, returncode: int = 0) -> subprocess.CompletedProcess:
    missing = [] if ready else ["nemotron-3-diarization/example.mlmodelc"]
    return subprocess.CompletedProcess(
        args=[],
        returncode=returncode,
        stdout=json.dumps({
            "ready": ready,
            "cache_directory": "/private/tmp/isolated/models/speaker-diarization",
            "required_models": ["nemotron-3-diarization/example.mlmodelc"],
            "missing_models": missing,
        }) + "\n",
        stderr="",
    )


class SpeakerModelCliTests(unittest.TestCase):
    def test_status_reports_missing_models_as_a_successful_read(self):
        sidecar_result = subprocess.CompletedProcess(
            args=[],
            returncode=3,
            stdout=json.dumps({
                "ready": False,
                "cache_directory": "/private/tmp/isolated/models/speaker-diarization",
                "required_models": ["sortformer/example.mlmodelc"],
                "missing_models": ["sortformer/example.mlmodelc"],
            }) + "\n",
            stderr="",
        )
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             patch("subprocess.run", return_value=sidecar_result) as run:
            result = CliRunner().invoke(simple_recorder.speaker_model_status)

        self.assertEqual(result.exit_code, 0, result.output)
        payload = json.loads(result.output)
        self.assertTrue(payload["success"])
        self.assertFalse(payload["ready"])
        run.assert_called_once_with(
            ["/fake/steno-diarize", "model-status"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
            env=ANY,
        )

    def test_prepare_failure_is_structured_and_nonzero(self):
        sidecar_result = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="download failed\n"
        )
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             patch("simple_recorder._run_sidecar_with_progress", return_value=sidecar_result):
            result = CliRunner().invoke(simple_recorder.prepare_speaker_models)

        self.assertEqual(result.exit_code, 1, result.output)
        payload = json.loads(result.output)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["error"], "Speaker diarization model setup failed")
        self.assertNotIn("download failed", result.output)

    def test_prepare_accepts_coreml_diagnostics_around_json(self):
        payload = {
            "ready": True,
            "cache_directory": "/private/tmp/isolated/models/speaker-diarization",
            "required_models": ["sortformer/example.mlmodelc"],
            "missing_models": [],
        }
        sidecar_result = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=(
                "E5RT encountered an STL exception. msg = unordered_map::at: key not found."
                + json.dumps(payload)
                + "\nMetal teardown warning\n"
            ),
            stderr="steno-diarize: preparing speaker diarization models\n",
        )
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             patch("simple_recorder._run_sidecar_with_progress", return_value=sidecar_result):
            result = CliRunner().invoke(simple_recorder.prepare_speaker_models)

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(json.loads(result.output), {"success": True, **payload})
        self.assertNotIn("E5RT", result.output)
        self.assertNotIn("Metal", result.output)

    def test_status_without_sidecar_is_structured(self):
        with patch("src.transcriber._resolve_steno_diarize", return_value=None):
            result = CliRunner().invoke(simple_recorder.speaker_model_status)

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(
            json.loads(result.output),
            {
                "success": False,
                "ready": False,
                "error": "Speaker diarization is unavailable on this system",
            },
        )


class SpeakerModelEngineTests(unittest.TestCase):
    """The sidecar's model commands target the same engine meeting
    processing runs: the saved setting, or an explicit --engine while
    Settings prepares a choice it has not saved yet."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.config_path = Path(tmp.name) / "config.json"
        self.config = Config(config_path=self.config_path)
        patcher = patch("src.config.get_config", return_value=self.config)
        patcher.start()
        self.addCleanup(patcher.stop)
        env = patch.dict(os.environ, {}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("STENOAI_DIARIZE_ENGINE", None)

    def _invoke(self, command, args, sidecar_result):
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             patch("subprocess.run", return_value=sidecar_result) as run:
            result = CliRunner().invoke(command, args)
        return result, run

    def test_status_targets_the_saved_engine(self):
        self.config._config["diarization_engine"] = "nemotron3"
        result, run = self._invoke(simple_recorder.speaker_model_status, [], _status_result(True))

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(run.call_args.kwargs["env"]["STENOAI_DIARIZE_ENGINE"], "nemotron3")

    def test_prepare_engine_option_overrides_the_saved_engine(self):
        # prepare streams progress, so it runs through the progress runner
        # rather than subprocess.run; the engine must reach it all the same.
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             patch.object(
                 simple_recorder, "_run_sidecar_with_progress", return_value=_status_result(True)
             ) as run:
            result = CliRunner().invoke(
                simple_recorder.prepare_speaker_models, ["--engine", "nemotron3"]
            )

        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(self.config.get_diarization_engine(), "sortformer")
        self.assertEqual(run.call_args.args[0], ["/fake/steno-diarize", "prepare-models"])
        self.assertEqual(run.call_args.kwargs["env"]["STENOAI_DIARIZE_ENGINE"], "nemotron3")

    @unittest.skipIf(sys.platform == "win32", "runs a /bin/sh fake sidecar")
    def test_prepare_engine_reaches_a_real_sidecar_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            sidecar = Path(tmp) / "steno-diarize"
            # The sidecar reports the engine it was started with as its cache
            # directory, so the assertion sees the child's real environment.
            sidecar.write_text(
                "#!/bin/sh\n"
                "echo 'STENO_PROGRESS {\"percent\":10,\"phase\":\"downloading\"}' >&2\n"
                "printf '{\"ready\":true,\"cache_directory\":\"%s\",'"
                " \"$STENOAI_DIARIZE_ENGINE\"\n"
                "echo '\"required_models\":[],\"missing_models\":[]}'\n"
            )
            sidecar.chmod(0o755)
            with patch("src.transcriber._resolve_steno_diarize", return_value=str(sidecar)):
                result = CliRunner().invoke(
                    simple_recorder.prepare_speaker_models, ["--engine", "nemotron3"]
                )

        self.assertEqual(result.exit_code, 0, result.output)
        lines = result.output.strip().splitlines()
        self.assertEqual(lines[0], 'SPEAKER_MODELS_PROGRESS:{"percent": 10, "phase": "downloading"}')
        self.assertEqual(json.loads(lines[-1])["cache_directory"], "nemotron3")

    def test_engine_option_rejects_unknown_engines(self):
        result, run = self._invoke(
            simple_recorder.prepare_speaker_models, ["--engine", "pyannote"], _status_result(True)
        )

        self.assertNotEqual(result.exit_code, 0)
        run.assert_not_called()

    def test_set_nemotron3_is_refused_until_its_models_are_ready(self):
        result, run = self._invoke(
            simple_recorder.set_diarization_engine_cmd, ["nemotron3"], _status_result(False, returncode=3)
        )

        payload = json.loads(result.output)
        self.assertFalse(payload["success"])
        self.assertFalse(payload["models_ready"])
        self.assertEqual(run.call_args.kwargs["env"]["STENOAI_DIARIZE_ENGINE"], "nemotron3")
        self.assertEqual(Config(config_path=self.config_path).get_diarization_engine(), "sortformer")

    def test_set_nemotron3_persists_once_its_models_are_ready(self):
        result, _run = self._invoke(
            simple_recorder.set_diarization_engine_cmd, ["nemotron3"], _status_result(True)
        )

        self.assertEqual(json.loads(result.output), {"success": True, "engine": "nemotron3"})
        self.assertEqual(Config(config_path=self.config_path).get_diarization_engine(), "nemotron3")

    def test_set_sortformer_never_needs_the_sidecar(self):
        self.config.set_diarization_engine("nemotron3")
        result, run = self._invoke(
            simple_recorder.set_diarization_engine_cmd, ["sortformer"], _status_result(False)
        )

        self.assertEqual(json.loads(result.output), {"success": True, "engine": "sortformer"})
        run.assert_not_called()
        self.assertEqual(Config(config_path=self.config_path).get_diarization_engine(), "sortformer")

    def test_set_rejects_unknown_engines(self):
        result, run = self._invoke(
            simple_recorder.set_diarization_engine_cmd, ["pyannote"], _status_result(True)
        )

        payload = json.loads(result.output)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["valid_engines"], ["sortformer", "nemotron3"])
        run.assert_not_called()

    def test_cli_engine_choices_match_the_config_registry(self):
        choice = next(
            param for param in simple_recorder.prepare_speaker_models.params
            if param.name == "engine"
        )
        self.assertEqual(tuple(choice.type.choices), Config.VALID_DIARIZATION_ENGINES)


class SpeakerModelProgressTests(unittest.TestCase):
    def test_progress_line_validation(self):
        parse = simple_recorder._parse_speaker_progress_line
        self.assertEqual(parse('STENO_PROGRESS {"percent":42,"phase":"downloading"}'),
                         {"percent": 42, "phase": "downloading"})
        for line in [
            'STENO_PROGRESS {"percent":101,"phase":"downloading"}',
            'STENO_PROGRESS {"percent":-1,"phase":"downloading"}',
            'STENO_PROGRESS {"percent":4.2,"phase":"downloading"}',
            'STENO_PROGRESS {"percent":true,"phase":"downloading"}',
            'STENO_PROGRESS {"percent":4,"phase":"/Users/me/secret"}',
            'STENO_PROGRESS {"percent":4,"phase":["downloading"]}',
            'STENO_PROGRESS {"percent":4,"phase":{"a":1}}',
            'STENO_PROGRESS not json',
            'steno-diarize error: something',
        ]:
            self.assertIsNone(parse(line), line)

    @unittest.skipIf(sys.platform == "win32", "runs a /bin/sh fake sidecar")
    def test_prepare_relays_progress_from_a_real_sidecar_process(self):
        payload = {
            "ready": True,
            "cache_directory": "/private/tmp/isolated/models/speaker-diarization",
            "required_models": ["sortformer/example.mlmodelc"],
            "missing_models": [],
        }
        with tempfile.TemporaryDirectory() as tmp:
            sidecar = Path(tmp) / "steno-diarize"
            sidecar.write_text(
                "#!/bin/sh\n"
                "echo 'STENO_PROGRESS {\"percent\":10,\"phase\":\"downloading\"}' >&2\n"
                "echo 'CoreML noise /private/path' >&2\n"
                "echo 'STENO_PROGRESS {\"percent\":75,\"phase\":\"compiling\"}' >&2\n"
                f"echo '{json.dumps(payload)}'\n"
            )
            sidecar.chmod(0o755)
            with patch("src.transcriber._resolve_steno_diarize", return_value=str(sidecar)):
                result = CliRunner().invoke(simple_recorder.prepare_speaker_models)

        self.assertEqual(result.exit_code, 0, result.output)
        lines = result.output.strip().splitlines()
        self.assertEqual(lines[:-1], [
            'SPEAKER_MODELS_PROGRESS:{"percent": 10, "phase": "downloading"}',
            'SPEAKER_MODELS_PROGRESS:{"percent": 75, "phase": "compiling"}',
        ])
        self.assertEqual(json.loads(lines[-1]), {"success": True, **payload})
        self.assertNotIn("CoreML", result.output)

    @unittest.skipIf(sys.platform == "win32", "runs a /bin/sh fake sidecar")
    def test_progress_arrives_while_the_sidecar_is_still_running(self):
        import time
        with tempfile.TemporaryDirectory() as tmp:
            sidecar = Path(tmp) / "steno-diarize"
            # Lots of stderr noise around the progress line, then a pause:
            # the event must be relayed before the process exits.
            sidecar.write_text(
                "#!/bin/sh\n"
                "i=0; while [ $i -lt 2000 ]; do echo 'CoreML noise line' >&2; i=$((i+1)); done\n"
                "echo 'STENO_PROGRESS {\"percent\":5,\"phase\":\"downloading\"}' >&2\n"
                "sleep 1\n"
                "echo '{}'\n"
            )
            sidecar.chmod(0o755)
            seen = []
            started = time.monotonic()
            result = simple_recorder._run_sidecar_with_progress(
                [str(sidecar)], 10, lambda e: seen.append((time.monotonic(), e))
            )
            finished = time.monotonic()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "{}")
        self.assertEqual([e for _, e in seen], [{"percent": 5, "phase": "downloading"}])
        self.assertLess(seen[0][0] - started, finished - started - 0.5)

    @unittest.skipIf(sys.platform == "win32", "runs a /bin/sh fake sidecar")
    def test_hung_sidecar_times_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            sidecar = Path(tmp) / "steno-diarize"
            sidecar.write_text("#!/bin/sh\nexec sleep 30\n")
            sidecar.chmod(0o755)
            with self.assertRaises(subprocess.TimeoutExpired):
                simple_recorder._run_sidecar_with_progress([str(sidecar)], 1, lambda e: None)


if __name__ == "__main__":
    unittest.main()
