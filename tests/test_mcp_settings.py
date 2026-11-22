"""Steno MCP server scope settings (config.json keys read by app/steno-mcp)."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner

import simple_recorder
from src.config import Config


class McpSettingsConfigTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.config_path = Path(self._tmp.name) / "config.json"
        self.config = Config(config_path=self.config_path)

    def tearDown(self):
        self._tmp.cleanup()

    def on_disk(self):
        return json.loads(self.config_path.read_text())

    def test_defaults_allow_all_meetings_with_transcripts(self):
        self.assertIsNone(self.config.get_mcp_folder_allowlist())
        self.assertFalse(self.config.get_mcp_exclude_transcripts())

    def test_allowlist_round_trips_to_config_json(self):
        self.assertTrue(self.config.set_mcp_folder_allowlist(["a1", "b2", "a1"]))
        self.assertEqual(self.on_disk()["mcp_folder_allowlist"], ["a1", "b2"])
        self.assertTrue(self.config.set_mcp_folder_allowlist([]))
        self.assertEqual(self.on_disk()["mcp_folder_allowlist"], [])
        self.assertTrue(self.config.set_mcp_folder_allowlist(None))
        self.assertIsNone(self.on_disk()["mcp_folder_allowlist"])

    def test_invalid_allowlists_are_rejected_without_writing(self):
        self.config.set_mcp_folder_allowlist(["keep"])
        for bad in ("a1", [""], [1], ["x" * 200], ["f"] * 501):
            with self.subTest(bad=bad):
                self.assertFalse(self.config.set_mcp_folder_allowlist(bad))
        self.assertEqual(self.on_disk()["mcp_folder_allowlist"], ["keep"])

    def test_malformed_stored_allowlist_reads_as_empty(self):
        self.config_path.write_text(json.dumps({"mcp_folder_allowlist": "a1"}))
        self.assertEqual(Config(config_path=self.config_path).get_mcp_folder_allowlist(), [])

    def test_exclude_transcripts_only_literal_true(self):
        self.config_path.write_text(json.dumps({"mcp_exclude_transcripts": "yes"}))
        self.assertFalse(Config(config_path=self.config_path).get_mcp_exclude_transcripts())
        self.assertTrue(self.config.set_mcp_exclude_transcripts(True))
        self.assertIs(self.on_disk()["mcp_exclude_transcripts"], True)


class McpSettingsCliTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.config_path = Path(self._tmp.name) / "config.json"
        self.config = Config(config_path=self.config_path)
        patcher = patch("src.config.get_config", return_value=self.config)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self._tmp.cleanup()

    def run_cli(self, *args):
        result = CliRunner().invoke(simple_recorder.cli, list(args))
        self.assertEqual(result.exit_code, 0, result.output)
        return json.loads(result.output.strip().splitlines()[-1])

    def test_get_reports_defaults(self):
        self.assertEqual(
            self.run_cli("get-mcp-settings"),
            {"mcp_folder_allowlist": None, "mcp_exclude_transcripts": False},
        )

    def test_set_folders_and_transcripts(self):
        out = self.run_cli("set-mcp-settings", "--folders", '["f1"]', "--exclude-transcripts", "true")
        self.assertEqual(
            out,
            {"success": True, "mcp_folder_allowlist": ["f1"], "mcp_exclude_transcripts": True},
        )
        out = self.run_cli("set-mcp-settings", "--folders", "all")
        self.assertIsNone(out["mcp_folder_allowlist"])
        self.assertTrue(out["mcp_exclude_transcripts"])

    def test_rejects_bad_folder_json(self):
        for bad in ("not json", '"f1"', "[1]"):
            with self.subTest(bad=bad):
                self.assertFalse(self.run_cli("set-mcp-settings", "--folders", bad)["success"])
        self.assertIsNone(self.config.get_mcp_folder_allowlist())


if __name__ == "__main__":
    unittest.main()
