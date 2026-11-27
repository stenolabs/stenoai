# tests/test_default_template_report.py
import json, tempfile, unittest
from pathlib import Path
from unittest import mock
from src.config import Config
from src.templates import BUILTIN_TEMPLATES
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
    def test_upgrade_keeps_custom_and_builtin_default_report_prompts_distinct(self):
        custom = [
            {"id": "detailed", "name": "Detailed", "prompt": "Synthetic custom Detailed prompt.",
             "language": "auto", "format": "markdown"},
            {"id": "builtin-detailed", "name": "Builtin Detailed",
             "prompt": "Synthetic custom Builtin Detailed prompt.",
             "language": "auto", "format": "markdown"},
        ]
        for template in [*custom, BUILTIN_TEMPLATES["builtin_detailed"]]:
            with self.subTest(default=template["id"]), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "config.json"
                path.write_text(json.dumps({
                    "templates_seeded": True, "custom_templates": custom,
                    "default_template_id": template["id"],
                }), encoding="utf-8")
                c = Config(config_path=path)
                mp = Path(tmp) / "m_summary.md"
                original = "---\n---\n\n## Summary\nSynthetic original summary\n"
                mp.write_text(original, encoding="utf-8")
                summarizer = mock.Mock(model_name="synthetic-model")
                summarizer.summarize_transcript_streaming.return_value = iter(["## Custom report\nSynthetic body"])
                report = simple_recorder.generate_default_template_report(
                    mp, "Alice: Synthetic transcript.", None, "en", 1, c, summarizer)
                self.assertIsNotNone(report)
                self.assertEqual(summarizer.summarize_transcript_streaming.call_args.kwargs["template_prompt"],
                                 template["prompt"])
                self.assertEqual(report["template_id"], template["id"])
                self.assertEqual(report["template_name"], template["name"])
                sidecar = report_store.load_sidecar(mp)
                self.assertEqual(sidecar["reports"], [report])
                self.assertEqual(sidecar["active_report"], report["id"])
                self.assertEqual(mp.read_text(encoding="utf-8"), original)
                persisted = json.loads(path.read_text())
                self.assertEqual(persisted["custom_templates"], custom)
                self.assertEqual(persisted["default_template_id"], template["id"])

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


if __name__ == "__main__":
    unittest.main()
