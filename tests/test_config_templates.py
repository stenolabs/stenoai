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


class DetailedTemplateUpgradeTests(unittest.TestCase):
    def test_persisted_custom_templates_and_default_survive_gallery_upgrade(self):
        custom = [
            {"id": "detailed", "name": "Detailed", "prompt": "Synthetic custom Detailed prompt.",
             "language": "auto", "format": "markdown", "icon": "doc"},
            {"id": "builtin-detailed", "name": "Builtin Detailed",
             "prompt": "Synthetic custom Builtin Detailed prompt.",
             "language": "auto", "format": "markdown", "icon": "doc"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            # Persist the pre-upgrade state directly: creating these through the
            # new gallery's save_template would de-duplicate away the collision.
            path.write_text(json.dumps({
                "templates_seeded": True, "custom_templates": custom,
                "default_template_id": "builtin-detailed",
            }), encoding="utf-8")
            c = Config(config_path=path)
            ids = [t["id"] for t in c.get_templates()]
            self.assertEqual(len(ids), len(set(ids)))
            for template in custom:
                self.assertEqual(c.get_template(template["id"]),
                                 {**template, "builtin": False, "locked": False})
            original = next(t for t in c.get_templates() if t["builtin"] and t["name"] == "Detailed")
            tid = original["id"]
            ok, err, _ = c.save_template({**original, "prompt": "Synthetic built-in edit."})
            self.assertTrue(ok, err)
            edited = Config(config_path=path)
            self.assertEqual(edited.get_template(tid)["prompt"], "Synthetic built-in edit.")
            self.assertTrue(edited.reset_template(tid))
            reloaded = Config(config_path=path)
            self.assertEqual(reloaded.get_template(tid), original)
            self.assertEqual(reloaded.get_default_template_id(), "builtin-detailed")
            self.assertEqual(reloaded.get_template("builtin-detailed")["prompt"], custom[1]["prompt"])
            self.assertEqual(json.loads(path.read_text())["custom_templates"], custom)
            self.assertTrue(reloaded.set_default_template(tid))
            self.assertEqual(Config(config_path=path).get_default_template_id(), tid)


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


if __name__ == "__main__":
    unittest.main()
