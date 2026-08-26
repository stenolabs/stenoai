import json
import subprocess
import unittest
from unittest.mock import patch

from click.testing import CliRunner

import simple_recorder


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
        )

    def test_prepare_failure_is_structured_and_nonzero(self):
        sidecar_result = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="download failed\n"
        )
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             patch("subprocess.run", return_value=sidecar_result):
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
             patch("subprocess.run", return_value=sidecar_result):
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


if __name__ == "__main__":
    unittest.main()
