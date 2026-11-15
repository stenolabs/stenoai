# tests/test_templates_cli.py
import json
import tempfile
import unittest
from pathlib import Path

from click.testing import CliRunner
from unittest import mock

import simple_recorder
from src.config import Config


def _last_json(output):
    line = [ln for ln in output.splitlines() if ln.strip().startswith("{")][-1]
    return json.loads(line)


class TemplatesCliTests(unittest.TestCase):
    def _run(self, cmd, args, tmp):
        cfg = Config(config_path=Path(tmp) / "config.json")
        with mock.patch("src.config.get_config", return_value=cfg):
            return CliRunner().invoke(cmd, args), cfg

    def test_list_templates_includes_standard_and_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            res, _ = self._run(simple_recorder.list_templates, [], tmp)
            data = _last_json(res.output)
            ids = [t["id"] for t in data["templates"]]
            self.assertIn("standard", ids)
            self.assertEqual(data["default_template_id"], "standard")

    def test_save_template_creates_custom(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = json.dumps({"name": "Leitung", "prompt": "kurz", "language": "de"})
            res, cfg = self._run(simple_recorder.save_template, [payload], tmp)
            data = _last_json(res.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["template"]["id"], "leitung")

    def test_set_default_template_persists(self):
        with tempfile.TemporaryDirectory() as tmp:
            res, cfg = self._run(simple_recorder.set_default_template, ["shareable-summary"], tmp)
            self.assertTrue(_last_json(res.output)["success"])

    def test_set_default_unknown_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            res, _ = self._run(simple_recorder.set_default_template, ["nope"], tmp)
            self.assertNotEqual(res.exit_code, 0)

    def test_detailed_builtin_id_round_trips_through_cli(self):
        tid = "builtin_detailed"
        with tempfile.TemporaryDirectory() as tmp:
            listed, _ = self._run(simple_recorder.list_templates, [], tmp)
            self.assertEqual(listed.exit_code, 0, listed.output)
            original = next(t for t in _last_json(listed.output)["templates"] if t["id"] == tid)
            self.assertTrue(original["builtin"])
            self.assertFalse(original["locked"])
            self.assertEqual(original["format"], "markdown")
            payload = json.dumps({**original, "prompt": "Synthetic edited Detailed prompt."})
            saved, _ = self._run(simple_recorder.save_template, [payload], tmp)
            self.assertEqual(saved.exit_code, 0, saved.output)
            self.assertTrue(_last_json(saved.output)["success"])
            self.assertEqual(_last_json(saved.output)["template"]["id"], tid)
            reloaded = Config(config_path=Path(tmp) / "config.json")
            self.assertEqual(reloaded.get_template(tid)["prompt"], "Synthetic edited Detailed prompt.")
            selected, _ = self._run(simple_recorder.set_default_template, [tid], tmp)
            self.assertEqual(selected.exit_code, 0, selected.output)
            self.assertTrue(_last_json(selected.output)["success"])
            reset, _ = self._run(simple_recorder.reset_template, [tid], tmp)
            self.assertEqual(reset.exit_code, 0, reset.output)
            self.assertTrue(_last_json(reset.output)["success"])
            after, _ = self._run(simple_recorder.list_templates, [], tmp)
            data = _last_json(after.output)
            self.assertEqual(data["default_template_id"], tid)
            self.assertEqual(next(t for t in data["templates"] if t["id"] == tid), original)


if __name__ == "__main__":
    unittest.main()
