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



class RecipesCliTests(unittest.TestCase):
    def _run(self, cmd, args, tmp, input=None):
        cfg = Config(config_path=Path(tmp) / "config.json")
        with mock.patch("src.config.get_config", return_value=cfg):
            return CliRunner().invoke(cmd, args, input=input), cfg

    def test_list_recipes_empty_initially(self):
        with tempfile.TemporaryDirectory() as tmp:
            res, _ = self._run(simple_recorder.list_recipes, [], tmp)
            data = _last_json(res.output)
            self.assertEqual(data["recipes"], [])

    def test_save_recipe_reads_stdin_and_persists(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = json.dumps({"label": "Follow Up Email", "prompt": "Write email"})
            res, cfg = self._run(simple_recorder.save_recipe, [], tmp, input=payload)
            self.assertEqual(res.exit_code, 0)
            data = _last_json(res.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["recipe"]["id"], "follow-up-email")
            self.assertEqual(data["recipe"]["label"], "Follow Up Email")

            # List check
            res2, _ = self._run(simple_recorder.list_recipes, [], tmp)
            data2 = _last_json(res2.output)
            self.assertEqual(len(data2["recipes"]), 1)
            self.assertEqual(data2["recipes"][0]["id"], "follow-up-email")

    def test_save_recipe_invalid_json_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            res, _ = self._run(simple_recorder.save_recipe, [], tmp, input="not-json")
            self.assertNotEqual(res.exit_code, 0)
            data = _last_json(res.output)
            self.assertFalse(data["success"])

    def test_save_recipe_validation_error_returns_structured_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = json.dumps({"label": "", "prompt": "prompt"})
            res, _ = self._run(simple_recorder.save_recipe, [], tmp, input=payload)
            self.assertEqual(res.exit_code, 0)
            data = _last_json(res.output)
            self.assertFalse(data["success"])
            self.assertIn("label is required", data["error"].lower())

    def test_delete_recipe_persists(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = json.dumps({"label": "Test Recipe", "prompt": "p"})
            res, _ = self._run(simple_recorder.save_recipe, [], tmp, input=payload)
            recipe_id = _last_json(res.output)["recipe"]["id"]

            res_del, _ = self._run(simple_recorder.delete_recipe, [recipe_id], tmp)
            self.assertEqual(res_del.exit_code, 0)
            self.assertTrue(_last_json(res_del.output)["success"])

            res_del2, _ = self._run(simple_recorder.delete_recipe, ["non-existent"], tmp)
            self.assertNotEqual(res_del2.exit_code, 0)

if __name__ == "__main__":
    unittest.main()
