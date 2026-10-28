import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner

from simple_recorder import cli
from src import config as _config


class KeywordsCliTests(unittest.TestCase):
    def setUp(self):
        self._orig_dd = os.environ.get("STENOAI_USER_DATA_DIR")
        self._orig_config = _config._config_instance
        self._tmpdir = tempfile.TemporaryDirectory()
        self._tmp = self._tmpdir.name
        os.environ["STENOAI_USER_DATA_DIR"] = self._tmp
        _config._config_instance = None

    def tearDown(self):
        _config._config_instance = self._orig_config
        if self._orig_dd is None:
            os.environ.pop("STENOAI_USER_DATA_DIR", None)
        else:
            os.environ["STENOAI_USER_DATA_DIR"] = self._orig_dd
        self._tmpdir.cleanup()

    def test_set_then_get_roundtrip(self):
        runner = CliRunner()
        r1 = runner.invoke(cli, ["set-custom-keywords", "NexGen Suite: NexGan Suite"])
        self.assertEqual(r1.exit_code, 0, r1.output)
        self.assertIn('"success": true', r1.output)
        r2 = runner.invoke(cli, ["get-custom-keywords"])
        self.assertEqual(r2.exit_code, 0, r2.output)
        self.assertIn("NexGen Suite: NexGan Suite", r2.output)


class KeywordsCliIsolationTests(unittest.TestCase):
    def test_cached_config_from_another_dir_is_not_written(self):
        with tempfile.TemporaryDirectory() as old_dir:
            old_config = _config.Config(config_path=Path(old_dir) / "config.json")
            old_bytes = (Path(old_dir) / "config.json").read_bytes()
            with patch.dict(os.environ, {"STENOAI_USER_DATA_DIR": old_dir}), patch.object(
                _config, "_config_instance", old_config
            ):
                case = KeywordsCliTests("test_set_then_get_roundtrip")
                case.setUp()
                try:
                    test_dir = Path(case._tmp)
                    result = CliRunner().invoke(
                        cli, ["set-custom-keywords", "NexGen Suite: NexGan Suite"]
                    )
                    self.assertEqual(result.exit_code, 0, result.output)
                    self.assertIn('"success": true', result.output)
                    self.assertEqual((Path(old_dir) / "config.json").read_bytes(), old_bytes)
                    self.assertIn("NexGen Suite", (test_dir / "config.json").read_text())
                finally:
                    case.tearDown()
                self.assertEqual(os.environ["STENOAI_USER_DATA_DIR"], old_dir)
                self.assertIs(_config._config_instance, old_config)
                self.assertFalse(test_dir.exists())
