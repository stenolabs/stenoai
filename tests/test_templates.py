# tests/test_templates.py
import unittest
from src import templates as T


class BuiltinRegistryTests(unittest.TestCase):
    def test_standard_is_locked_structured(self):
        std = T.BUILTIN_TEMPLATES["standard"]
        self.assertEqual(std["id"], T.STANDARD_TEMPLATE_ID)
        self.assertTrue(std["locked"])
        self.assertEqual(std["format"], "structured")

    def test_sample_is_an_editable_markdown_custom_template(self):
        s = T.SAMPLE_TEMPLATE
        self.assertEqual(s["id"], "shareable-summary")
        self.assertEqual(s["format"], "markdown")
        self.assertTrue(s["prompt"].strip())
        self.assertNotIn("locked", s)  # custom: not locked

    def test_new_template_id_slugifies_and_dedupes(self):
        self.assertEqual(T.new_template_id("Sprint Planning", set()), "sprint-planning")
        self.assertEqual(
            T.new_template_id("Sprint Planning", {"sprint-planning"}),
            "sprint-planning-2",
        )

    def test_validate_rejects_blank_name_and_bad_language(self):
        ok, _ = T.validate_template(
            {"name": "", "prompt": "x", "language": "auto"}, {"auto", "de"}
        )
        self.assertFalse(ok)
        ok, _ = T.validate_template(
            {"name": "X", "prompt": "x", "language": "xx"}, {"auto", "de"}
        )
        self.assertFalse(ok)
        ok, _ = T.validate_template(
            {"name": "X", "prompt": "x", "language": "de"}, {"auto", "de"}
        )
        self.assertTrue(ok)

    def test_validate_is_defensive_at_the_trust_boundary(self):
        langs = {"auto", "de"}
        # Non-dict payloads must return (False, msg), never raise.
        for bad in ([], None, 42):
            ok, msg = T.validate_template(bad, langs)
            self.assertFalse(ok)
            self.assertTrue(msg)
        # name: numeric / blank / over-long
        for bad_name in (123, "", "   ", "x" * (T.MAX_NAME_LEN + 1)):
            ok, _ = T.validate_template(
                {"name": bad_name, "prompt": "p", "language": "auto"}, langs
            )
            self.assertFalse(ok)
        # prompt: missing / blank / over-long / numeric
        for bad_prompt in (None, "", "   ", 123, "x" * (T.MAX_PROMPT_LEN + 1)):
            ok, _ = T.validate_template(
                {"name": "X", "prompt": bad_prompt, "language": "auto"}, langs
            )
            self.assertFalse(ok)
        # language: array / unknown
        for bad_lang in (["de"], "xx"):
            ok, _ = T.validate_template(
                {"name": "X", "prompt": "p", "language": bad_lang}, langs
            )
            self.assertFalse(ok)
        # format: present but invalid — including non-string/unhashable payloads
        # that would raise on a naive `fmt in VALID_FORMATS` membership check.
        for bad_fmt in ("weird", ["markdown"], {"k": "v"}, 5):
            ok, msg = T.validate_template(
                {"name": "X", "prompt": "p", "language": "auto", "format": bad_fmt}, langs
            )
            self.assertFalse(ok)
            self.assertTrue(msg)
        # icon: present but not a str
        ok, _ = T.validate_template(
            {"name": "X", "prompt": "p", "language": "auto", "icon": 5}, langs
        )
        self.assertFalse(ok)
        # A fully valid dict still passes.
        ok, msg = T.validate_template(
            {"name": "X", "prompt": "p", "language": "de",
             "format": "markdown", "icon": "doc"},
            langs,
        )
        self.assertTrue(ok, msg)

    def test_sample_icon_is_a_valid_editor_key(self):
        editor_keys = {"doc", "people", "calendar", "lightbulb", "phone", "megaphone"}
        self.assertEqual(T.SAMPLE_TEMPLATE["icon"], "megaphone")
        self.assertIn(T.SAMPLE_TEMPLATE["icon"], editor_keys)

    def test_merge_applies_overrides_and_tags_builtin(self):
        merged = T.merge_templates(
            overrides={"standard": {"name": "Default note"}},
            custom=[{"id": "leitung", "name": "Leitung", "prompt": "p", "language": "de",
                     "format": "markdown"}],
        )
        std = next(m for m in merged if m["id"] == "standard")
        self.assertEqual(std["name"], "Default note")   # override applied
        self.assertTrue(std["builtin"] and std["locked"])
        custom = next(m for m in merged if m["id"] == "leitung")
        self.assertFalse(custom["builtin"])
        # built-ins come first
        self.assertEqual(merged[0]["id"], "standard")


class TemplateGalleryTests(unittest.TestCase):
    """Issue #297 — a curated set of built-in templates beyond just Standard,
    so users get useful defaults for common meeting types without having to
    write their own prompt. Unlike Standard, these are editable + resettable
    built-ins (locked=False) — same UX as OpenOats-style built-in/custom."""

    GALLERY_IDS = {"product-demo", "sales-call", "one-on-one", "standup", "follow_up_email"}

    def test_gallery_ids_are_registered_builtins(self):
        self.assertTrue(self.GALLERY_IDS.issubset(set(T.BUILTIN_TEMPLATES)))

    def test_gallery_templates_are_editable_markdown_prompts(self):
        valid_langs = {"auto"}
        for tid in self.GALLERY_IDS:
            t = T.BUILTIN_TEMPLATES[tid]
            with self.subTest(template=tid):
                self.assertEqual(t["id"], tid)
                self.assertFalse(t.get("locked"), "gallery templates must stay editable")
                self.assertEqual(t["format"], "markdown")
                self.assertEqual(t["language"], "auto")
                self.assertTrue(t["prompt"].strip())
                self.assertLessEqual(len(t["prompt"]), T.MAX_PROMPT_LEN)
                ok, err = T.validate_template(t, valid_langs)
                self.assertTrue(ok, err)

    def test_gallery_templates_are_distinct_from_each_other(self):
        prompts = [T.BUILTIN_TEMPLATES[tid]["prompt"] for tid in self.GALLERY_IDS]
        names = [T.BUILTIN_TEMPLATES[tid]["name"] for tid in self.GALLERY_IDS]
        self.assertEqual(len(prompts), len(set(prompts)))
        self.assertEqual(len(names), len(set(names)))

    def test_merge_tags_gallery_templates_as_editable_builtins(self):
        merged = T.merge_templates(overrides={}, custom=[])
        merged_by_id = {m["id"]: m for m in merged}
        for tid in self.GALLERY_IDS:
            m = merged_by_id[tid]
            with self.subTest(template=tid):
                self.assertTrue(m["builtin"])
                self.assertFalse(m["locked"])

    def test_gallery_templates_can_be_reset_like_any_editable_builtin(self):
        # Not a Config test (that lives in test_config_templates.py) — just
        # pins that these ids aren't special-cased away from the existing
        # override/reset mechanism editable built-ins already have.
        for tid in self.GALLERY_IDS:
            with self.subTest(template=tid):
                self.assertFalse(T.BUILTIN_TEMPLATES[tid].get("locked"))



class RecipeValidationTests(unittest.TestCase):
    def test_validate_recipe_accepts_valid_payload(self):
        ok, err = T.validate_recipe({"label": "Follow Up", "prompt": "Draft follow up email"})
        self.assertTrue(ok)
        self.assertEqual(err, "")

    def test_validate_recipe_rejects_non_dict(self):
        for bad in [None, "string", [1, 2], 123]:
            with self.subTest(payload=bad):
                ok, err = T.validate_recipe(bad)
                self.assertFalse(ok)
                self.assertIn("Invalid recipe payload", err)

    def test_validate_recipe_rejects_missing_or_blank_label(self):
        for bad in [{}, {"label": ""}, {"label": "   "}, {"label": 123}]:
            with self.subTest(payload=bad):
                ok, err = T.validate_recipe({**bad, "prompt": "valid prompt"})
                self.assertFalse(ok)
                self.assertIn("label is required", err.lower())

    def test_validate_recipe_rejects_over_long_label(self):
        ok, err = T.validate_recipe({"label": "x" * (T.MAX_RECIPE_LABEL_LEN + 1), "prompt": "valid"})
        self.assertFalse(ok)
        self.assertIn("too long", err.lower())

    def test_validate_recipe_rejects_missing_or_blank_prompt(self):
        for bad in [{}, {"prompt": ""}, {"prompt": "   "}, {"prompt": 123}]:
            with self.subTest(payload=bad):
                ok, err = T.validate_recipe({"label": "valid label", **bad})
                self.assertFalse(ok)
                self.assertIn("prompt is required", err.lower())

    def test_validate_recipe_rejects_over_long_prompt(self):
        ok, err = T.validate_recipe({"label": "valid", "prompt": "x" * (T.MAX_RECIPE_PROMPT_LEN + 1)})
        self.assertFalse(ok)
        self.assertIn("too long", err.lower())

if __name__ == "__main__":
    unittest.main()
