# tests/test_config_templates.py
import json
import tempfile
import unittest
from pathlib import Path

from src.config import Config
from src.templates import STANDARD_TEMPLATE_ID


def _cfg(tmp):
    return Config(config_path=Path(tmp) / "config.json")


class TemplateSeedTests(unittest.TestCase):
    def test_sample_is_seeded_once_on_fresh_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            ids = [t["id"] for t in c.get_templates()]
            self.assertIn(STANDARD_TEMPLATE_ID, ids)
            self.assertIn("shareable-summary", ids)

    def test_deleting_the_sample_does_not_reseed_on_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            c = Config(config_path=path)
            self.assertTrue(c.delete_template("shareable-summary"))
            reloaded = Config(config_path=path)
            ids = [t["id"] for t in reloaded.get_templates()]
            self.assertNotIn("shareable-summary", ids)


class TemplateCrudTests(unittest.TestCase):
    def test_default_is_standard_then_settable(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            self.assertEqual(c.get_default_template_id(), STANDARD_TEMPLATE_ID)
            self.assertTrue(c.set_default_template("shareable-summary"))
            self.assertEqual(c.get_default_template_id(), "shareable-summary")

    def test_set_default_rejects_unknown_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            self.assertFalse(c.set_default_template("does-not-exist"))

    def test_save_new_custom_assigns_id_and_persists(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            c = Config(config_path=path)
            ok, err, saved = c.save_template(
                {"name": "Leitung", "prompt": "kurz", "language": "de", "icon": "doc"}
            )
            self.assertTrue(ok, err)
            self.assertEqual(saved["id"], "leitung")
            reloaded = [t for t in Config(config_path=path).get_templates() if t["id"] == "leitung"]
            self.assertEqual(reloaded[0]["prompt"], "kurz")
            self.assertFalse(reloaded[0]["builtin"])

    def test_editing_a_custom_template_updates_in_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            _, _, saved = c.save_template({"name": "X", "prompt": "a", "language": "auto"})
            ok, _, _ = c.save_template({**saved, "prompt": "b"})
            self.assertTrue(ok)
            again = [t for t in c.get_templates() if t["id"] == saved["id"]]
            self.assertEqual(again[0]["prompt"], "b")

    def test_locked_standard_prompt_cannot_be_overridden(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            ok, err, _ = c.save_template(
                {"id": "standard", "name": "Renamed", "prompt": "hacked", "language": "auto"}
            )
            self.assertFalse(ok)
            self.assertIn("locked", err.lower())

    def test_delete_only_removes_custom(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            self.assertFalse(c.delete_template("standard"))  # built-in: not deletable

    def test_save_validates_blank_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            ok, err, _ = c.save_template({"name": " ", "prompt": "x", "language": "auto"})
            self.assertFalse(ok)

    def test_save_does_not_crash_on_non_dict_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            ok, err, saved = c.save_template([])
            self.assertFalse(ok)
            self.assertTrue(err)
            self.assertEqual(saved, {})

    def test_save_rejects_over_long_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            ok, _, _ = c.save_template(
                {"name": "X", "prompt": "x" * 8001, "language": "auto"}
            )
            self.assertFalse(ok)

    def test_reset_template_noop_and_unknown_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            # standard is locked → no override exists → reset is a no-op success
            self.assertTrue(c.reset_template(STANDARD_TEMPLATE_ID))
            # an id with no override returns True too
            self.assertTrue(c.reset_template("does-not-exist"))


class AlreadySeededMalformedConfigTests(unittest.TestCase):
    """A malformed-but-parseable config that is ALREADY seeded must still be
    repaired on load — the normalization can't be gated behind the one-time
    `templates_seeded` flag, or template reads/writes crash on the junk."""

    def _write(self, tmp, config: dict) -> Path:
        path = Path(tmp) / "config.json"
        path.write_text(json.dumps(config))
        return path

    def test_non_list_custom_templates_does_not_crash_reads_or_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Already seeded, but custom_templates got clobbered to a non-list.
            path = self._write(
                tmp, {"templates_seeded": True, "custom_templates": "oops"}
            )
            c = Config(config_path=path)
            # Reads merge cleanly (built-ins only; the junk is dropped).
            ids = [t["id"] for t in c.get_templates()]
            self.assertIn(STANDARD_TEMPLATE_ID, ids)
            # Writes still succeed against the repaired list.
            ok, _, saved = c.save_template(
                {"name": "Brief", "prompt": "p", "language": "auto"}
            )
            self.assertTrue(ok)
            self.assertTrue(c.delete_template(saved["id"]))

    def test_list_with_non_dict_entries_is_filtered_on_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(
                tmp,
                {
                    "templates_seeded": True,
                    "custom_templates": [
                        "junk",
                        None,
                        {"id": "keep", "name": "Keep", "prompt": "p", "language": "auto"},
                    ],
                },
            )
            c = Config(config_path=path)
            ids = [t["id"] for t in c.get_templates()]
            self.assertIn(STANDARD_TEMPLATE_ID, ids)
            self.assertIn("keep", ids)
            # The non-dict entries are gone, so CRUD that iterates the list is safe.
            self.assertTrue(c.delete_template("keep"))

    def test_non_dict_template_overrides_does_not_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(
                tmp, {"templates_seeded": True, "template_overrides": "nope"}
            )
            c = Config(config_path=path)
            ids = [t["id"] for t in c.get_templates()]
            self.assertIn(STANDARD_TEMPLATE_ID, ids)

    def test_malformed_per_template_override_value_is_dropped(self):
        # template_overrides is a dict, but a per-template value is junk —
        # merge_templates would still crash on `{**base, **value}` without this.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(
                tmp,
                {
                    "templates_seeded": True,
                    "template_overrides": {STANDARD_TEMPLATE_ID: "oops"},
                },
            )
            c = Config(config_path=path)
            ids = [t["id"] for t in c.get_templates()]
            self.assertIn(STANDARD_TEMPLATE_ID, ids)



class ConfigRecipeTests(unittest.TestCase):
    def test_get_chat_recipes_empty_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            self.assertEqual(c.get_chat_recipes(), [])

    def test_save_chat_recipe_assigns_id_and_persists(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            ok, err, saved = c.save_chat_recipe({"label": "Action Items", "prompt": "List all action items"})
            self.assertTrue(ok)
            self.assertEqual(err, "")
            self.assertEqual(saved["id"], "action-items")
            self.assertEqual(saved["label"], "Action Items")
            self.assertEqual(saved["prompt"], "List all action items")

            # Reload from disk
            c2 = _cfg(tmp)
            recipes = c2.get_chat_recipes()
            self.assertEqual(len(recipes), 1)
            self.assertEqual(recipes[0]["id"], "action-items")
            self.assertEqual(recipes[0]["label"], "Action Items")

    def test_save_chat_recipe_dedupes_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            ok1, _, r1 = c.save_chat_recipe({"label": "Summary", "prompt": "p1"})
            ok2, _, r2 = c.save_chat_recipe({"label": "Summary", "prompt": "p2"})
            self.assertTrue(ok1)
            self.assertTrue(ok2)
            self.assertEqual(r1["id"], "summary")
            self.assertEqual(r2["id"], "summary-2")

    def test_save_chat_recipe_updates_existing_in_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            _, _, r1 = c.save_chat_recipe({"label": "Brief", "prompt": "p1"})
            ok, err, r2 = c.save_chat_recipe({"id": r1["id"], "label": "Brief Renamed", "prompt": "p2"})
            self.assertTrue(ok)
            self.assertEqual(r2["id"], r1["id"])
            self.assertEqual(r2["label"], "Brief Renamed")
            self.assertEqual(r2["prompt"], "p2")
            self.assertEqual(len(c.get_chat_recipes()), 1)

    def test_delete_chat_recipe(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            _, _, r1 = c.save_chat_recipe({"label": "R1", "prompt": "p1"})
            _, _, r2 = c.save_chat_recipe({"label": "R2", "prompt": "p2"})
            self.assertEqual(len(c.get_chat_recipes()), 2)

            self.assertTrue(c.delete_chat_recipe(r1["id"]))
            self.assertFalse(c.delete_chat_recipe("non-existent-id"))

            # Reload and check
            c2 = _cfg(tmp)
            recipes = c2.get_chat_recipes()
            self.assertEqual(len(recipes), 1)
            self.assertEqual(recipes[0]["id"], r2["id"])

    def test_save_chat_recipe_validates_payload(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = _cfg(tmp)
            ok, err, _ = c.save_chat_recipe(None)
            self.assertFalse(ok)
            self.assertIn("Invalid recipe payload", err)

            ok, err, _ = c.save_chat_recipe({"label": "", "prompt": "valid"})
            self.assertFalse(ok)
            self.assertIn("label is required", err.lower())

            ok, err, _ = c.save_chat_recipe({"label": "valid", "prompt": ""})
            self.assertFalse(ok)
            self.assertIn("prompt is required", err.lower())

    def test_normalize_recipes_handles_corrupt_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({"chat_recipes": ["corrupt", {"id": "ok", "label": "L", "prompt": "P"}]}))
            c = Config(config_path=path)
            recipes = c.get_chat_recipes()
            self.assertEqual(len(recipes), 1)
            self.assertEqual(recipes[0]["id"], "ok")

if __name__ == "__main__":
    unittest.main()
