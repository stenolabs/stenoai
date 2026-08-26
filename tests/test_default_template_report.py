# tests/test_default_template_report.py
import json, tempfile, unittest
from pathlib import Path
from unittest import mock
from src.config import Config
import simple_recorder
from src import report_store


class _FakeSummarizer:
    model_name = "llama3.2:3b"
    def __init__(self, chunks):
        self._chunks = chunks
    def summarize_transcript_streaming(self, transcript, duration_minutes=0, language="en",
                                       notes=None, progress_callback=None, template_prompt=None):
        # assert the template prompt is threaded through
        assert template_prompt, "expected a template prompt"
        for c in self._chunks:
            yield c


def _cfg(tmp, default_id):
    c = Config(config_path=Path(tmp) / "config.json")
    # seed a custom template + set it default
    ok, _, saved = c.save_template({"name": "Leitung", "prompt": "Kurz für den Chef.",
                                    "language": "auto"})
    assert ok
    if default_id == "custom":
        c.set_default_template(saved["id"])
        return c, saved["id"]
    return c, "standard"


class DefaultTemplateReportTests(unittest.TestCase):
    def test_noop_when_default_is_standard(self):
        with tempfile.TemporaryDirectory() as tmp:
            c, _ = _cfg(tmp, "standard")
            mp = Path(tmp) / "m_summary.md"
            mp.write_text("---\n---\n\n## Summary\nx\n", encoding="utf-8")
            out = simple_recorder.generate_default_template_report(
                mp, "T: hi", None, "en", 1, c, _FakeSummarizer(["ignored"]))
            self.assertIsNone(out)
            self.assertFalse((Path(tmp) / "m_reports.json").exists())

    def test_generates_and_writes_sidecar_for_custom_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            c, tid = _cfg(tmp, "custom")
            mp = Path(tmp) / "m_summary.md"
            mp.write_text("---\n---\n\n## Summary\nx\n", encoding="utf-8")
            out = simple_recorder.generate_default_template_report(
                mp, "T: hi", None, "en", 1, c, _FakeSummarizer(["## Report\n- ok"]))
            self.assertIsNotNone(out)
            sc = report_store.load_sidecar(mp)
            self.assertEqual(len(sc["reports"]), 1)
            self.assertEqual(sc["reports"][0]["template_id"], tid)
            self.assertIn("## Report", sc["reports"][0]["content"])
            self.assertEqual(sc["active_report"], sc["reports"][0]["id"])

    def test_empty_generation_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            c, _ = _cfg(tmp, "custom")
            mp = Path(tmp) / "m_summary.md"
            mp.write_text("---\n---\n\n## Summary\nx\n", encoding="utf-8")
            out = simple_recorder.generate_default_template_report(
                mp, "T: hi", None, "en", 1, c, _FakeSummarizer(["  ", "\n"]))
            self.assertIsNone(out)
            self.assertFalse((Path(tmp) / "m_reports.json").exists())

    def test_unknown_default_is_safe_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            c, _ = _cfg(tmp, "standard")
            c._config["default_template_id"] = "ghost"  # points at nothing
            mp = Path(tmp) / "m_summary.md"
            mp.write_text("---\n---\n\n## Summary\nx\n", encoding="utf-8")
            out = simple_recorder.generate_default_template_report(
                mp, "T: hi", None, "en", 1, c, _FakeSummarizer(["x"]))
            self.assertIsNone(out)

    def test_swallows_exceptions_writes_nothing(self):
        class _BoomSummarizer:
            model_name = "llama3.2:3b"
            def summarize_transcript_streaming(self, transcript, duration_minutes=0,
                                               language="en", notes=None,
                                               progress_callback=None, template_prompt=None):
                yield "## partial"
                raise RuntimeError("model exploded mid-stream")

        with tempfile.TemporaryDirectory() as tmp:
            c, _ = _cfg(tmp, "custom")
            mp = Path(tmp) / "m_summary.md"
            mp.write_text("---\n---\n\n## Summary\nx\n", encoding="utf-8")
            # Must not propagate: a new recording must never fail because of
            # the extra report.
            out = simple_recorder.generate_default_template_report(
                mp, "T: hi", None, "en", 1, c, _BoomSummarizer())
            self.assertIsNone(out)
            self.assertFalse((Path(tmp) / "m_reports.json").exists())

    def test_resolution_order_explicit_choice_overrides_folder_and_global(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = Config(config_path=Path(tmp) / "config.json")
            ok1, _, tmpl1 = c.save_template({"name": "Global Tmpl", "prompt": "Global prompt", "language": "auto"})
            ok2, _, tmpl2 = c.save_template({"name": "Folder Tmpl", "prompt": "Folder prompt", "language": "auto"})
            ok3, _, tmpl3 = c.save_template({"name": "Explicit Tmpl", "prompt": "Explicit prompt", "language": "auto"})
            self.assertTrue(ok1 and ok2 and ok3)
            c.set_default_template(tmpl1["id"])

            # Setup FoldersManager with a folder having template_id = tmpl2["id"]
            from src.folders import FoldersManager
            fm = FoldersManager(Path(tmp))
            folder = fm.create_folder("Team", template_id=tmpl2["id"])

            mp = Path(tmp) / "m_summary.md"
            mp.write_text(f"---\nfolders: ['{folder['id']}']\n---\n\n## Summary\nx\n", encoding="utf-8")

            with mock.patch("src.folders.get_folders_manager", return_value=fm):
                # Pass explicit template_id tmpl3["id"]
                out = simple_recorder.generate_default_template_report(
                    mp, "T: hi", None, "en", 1, c, _FakeSummarizer(["## Explicit Report"]),
                    template_id=tmpl3["id"], folder_ids=[folder["id"]],
                )
                self.assertIsNotNone(out)
                self.assertEqual(out["template_id"], tmpl3["id"])

    def test_resolution_order_folder_template_overrides_global_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = Config(config_path=Path(tmp) / "config.json")
            ok1, _, tmpl1 = c.save_template({"name": "Global Tmpl", "prompt": "Global prompt", "language": "auto"})
            ok2, _, tmpl2 = c.save_template({"name": "Folder Tmpl", "prompt": "Folder prompt", "language": "auto"})
            self.assertTrue(ok1 and ok2)
            c.set_default_template(tmpl1["id"])

            from src.folders import FoldersManager
            fm = FoldersManager(Path(tmp))
            folder = fm.create_folder("Team", template_id=tmpl2["id"])

            mp = Path(tmp) / "m_summary.md"
            mp.write_text(f"---\nfolders: ['{folder['id']}']\n---\n\n## Summary\nx\n", encoding="utf-8")

            with mock.patch("src.folders.get_folders_manager", return_value=fm):
                # No explicit template passed -> should resolve to folder template tmpl2["id"]
                out = simple_recorder.generate_default_template_report(
                    mp, "T: hi", None, "en", 1, c, _FakeSummarizer(["## Folder Report"]),
                    template_id=None, folder_ids=[folder["id"]],
                )
                self.assertIsNotNone(out)
                self.assertEqual(out["template_id"], tmpl2["id"])

if __name__ == "__main__":
    unittest.main()
