# tests/test_setup_check_cli.py
"""Unit tests for the `setup-check --json` machine-readable output path.

The Electron main process (startup-setup-check) parses this JSON instead of
scraping emoji out of the human-readable report, so its schema is a contract.
"""
import json
import unittest
from unittest.mock import patch
from click.testing import CliRunner

import simple_recorder


def _only_json(output):
    """Extract the single JSON object line from CLI output.

    Logging writes INFO lines to stderr which CliRunner may interleave; the
    --json path emits exactly one object line, which starts with '{'.
    """
    lines = [line for line in output.splitlines() if line.strip().startswith("{")]
    assert len(lines) == 1, f"expected exactly one JSON line, got: {output!r}"
    return json.loads(lines[0])


class SetupCheckJsonTests(unittest.TestCase):
    _VALID_STATUS = {"pass", "fail", "warn"}

    def test_json_schema_and_all_good_derivation(self):
        """--json emits {allGood, checks:[{name, ok, status, detail}]} with allGood
        == every check ok, and the Python check present and passing."""
        res = CliRunner().invoke(simple_recorder.setup_check, ["--json"])
        self.assertEqual(res.exit_code, 0, res.output)

        data = _only_json(res.output)
        self.assertIsInstance(data["allGood"], bool)
        self.assertIsInstance(data["checks"], list)
        self.assertGreater(len(data["checks"]), 0)

        for check in data["checks"]:
            self.assertIn("name", check)
            self.assertIsInstance(check["name"], str)
            self.assertTrue(check["name"])
            self.assertIn(check["status"], self._VALID_STATUS)
            self.assertIsInstance(check["ok"], bool)
            # ok is exactly "not a failure" — warnings are still ok.
            self.assertEqual(check["ok"], check["status"] != "fail")
            self.assertIsInstance(check["detail"], str)

        # allGood is exactly "no failing check".
        self.assertEqual(data["allGood"], all(c["ok"] for c in data["checks"]))

        # The interpreter is running the backend, so Python always passes.
        python = next((c for c in data["checks"] if c["name"] == "Python"), None)
        self.assertIsNotNone(python)
        self.assertEqual(python["status"], "pass")
        self.assertTrue(python["ok"])

    def test_injected_failure_sets_all_good_false(self):
        """A failing check (❌) flips its record to status=fail/ok=false and drives
        allGood to false — the JSON verdict tracks the same emoji logic the human
        report uses."""
        with patch("src.ollama_manager.get_ollama_binary", return_value=None):
            res = CliRunner().invoke(simple_recorder.setup_check, ["--json"])
        self.assertEqual(res.exit_code, 0, res.output)

        data = _only_json(res.output)
        ollama = next((c for c in data["checks"] if c["name"] == "Ollama"), None)
        self.assertIsNotNone(ollama)
        self.assertEqual(ollama["status"], "fail")
        self.assertFalse(ollama["ok"])
        self.assertFalse(data["allGood"])

    def test_human_output_unchanged_without_flag(self):
        """No flag → the human banner is still printed and no JSON object appears."""
        res = CliRunner().invoke(simple_recorder.setup_check, [])
        self.assertEqual(res.exit_code, 0, res.output)
        self.assertIn("Steno Setup Check", res.output)
        # The human path must not emit a machine-readable JSON object line.
        self.assertFalse(
            any(line.strip().startswith("{") for line in res.output.splitlines()),
            res.output,
        )

    def test_missing_optional_speaker_models_are_a_warning(self):
        with patch("simple_recorder.sys.platform", "darwin"), patch(
            "simple_recorder._run_speaker_model_command",
            return_value={"success": True, "ready": False},
        ):
            res = CliRunner().invoke(simple_recorder.setup_check, ["--json"])

        self.assertEqual(res.exit_code, 0, res.output)
        data = _only_json(res.output)
        speaker = next(c for c in data["checks"] if c["name"] == "speaker-diarization-model")
        self.assertEqual(speaker["status"], "warn")
        self.assertTrue(speaker["ok"])

    def test_non_macos_setup_omits_the_speaker_model_check(self):
        with patch("simple_recorder.sys.platform", "linux"), patch(
            "simple_recorder._run_speaker_model_command",
        ) as run_speaker_check:
            res = CliRunner().invoke(simple_recorder.setup_check, ["--json"])

        self.assertEqual(res.exit_code, 0, res.output)
        data = _only_json(res.output)
        self.assertNotIn(
            "speaker-diarization-model",
            {check["name"] for check in data["checks"]},
        )
        run_speaker_check.assert_not_called()


if __name__ == "__main__":
    unittest.main()
