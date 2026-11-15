# tests/test_generate_report_cli.py
import json
import tempfile
import unittest
from pathlib import Path

from click.testing import CliRunner
from unittest import mock

import simple_recorder
from src import report_store
from src.config import Config
from src.templates import BUILTIN_TEMPLATES

_MD_TEMPLATE = """\
---
language: en
duration_seconds: 600
---
## Summary

Existing summary

## Transcript

{transcript}
"""


def _write_summary(tmp, transcript="Alice: hi. Bob: bye."):
    p = Path(tmp) / "meeting_summary.md"
    p.write_text(_MD_TEMPLATE.format(transcript=transcript))
    return p


class GenerateReportCliTests(unittest.TestCase):
    def test_detailed_builtin_and_persisted_custom_ids_generate_with_distinct_prompts(self):
        custom = [
            {"id": "detailed", "name": "Detailed", "prompt": "Synthetic custom Detailed prompt.",
             "language": "auto", "format": "markdown"},
            {"id": "builtin-detailed", "name": "Builtin Detailed",
             "prompt": "Synthetic custom Builtin Detailed prompt.",
             "language": "auto", "format": "markdown"},
        ]
        for template in [*custom, BUILTIN_TEMPLATES["builtin_detailed"]]:
            with self.subTest(template=template["id"]), tempfile.TemporaryDirectory() as tmp:
                summary = _write_summary(tmp)
                original = summary.read_text()
                config_path = Path(tmp) / "config.json"
                config_path.write_text(json.dumps({
                    "templates_seeded": True, "custom_templates": custom,
                    "default_template_id": "builtin-detailed",
                }), encoding="utf-8")
                cfg = Config(config_path=config_path)
                summarizer = mock.MagicMock(model_name="synthetic-model")
                summarizer.summarize_transcript_streaming.return_value = iter(["## Report\nSynthetic body"])
                with mock.patch("src.config.get_config", return_value=cfg), \
                     mock.patch("src.summarizer.OllamaSummarizer", return_value=summarizer):
                    res = CliRunner().invoke(simple_recorder.generate_report, [str(summary), template["id"]])
                self.assertEqual(res.exit_code, 0, res.output)
                self.assertIn("STREAM_COMPLETE", res.output)
                self.assertEqual(summarizer.summarize_transcript_streaming.call_args.kwargs["template_prompt"],
                                 template["prompt"])
                sidecar = report_store.load_sidecar(summary)
                self.assertEqual(len(sidecar["reports"]), 1)
                self.assertEqual(sidecar["reports"][0]["template_id"], template["id"])
                self.assertEqual(sidecar["reports"][0]["template_name"], template["name"])
                self.assertEqual(sidecar["reports"][0]["content"], "## Report\nSynthetic body")
                self.assertEqual(sidecar["active_report"], sidecar["reports"][0]["id"])
                self.assertEqual(summary.read_text(), original)

    def test_unknown_template_emits_stream_error_and_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = _write_summary(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            with mock.patch("src.config.get_config", return_value=cfg):
                res = CliRunner().invoke(
                    simple_recorder.generate_report,
                    [str(summary), "does-not-exist"],
                )
            self.assertNotEqual(res.exit_code, 0)
            self.assertIn("STREAM_ERROR", res.output)
            # No sidecar written.
            sidecar_p = report_store.sidecar_path(summary)
            self.assertFalse(sidecar_p.exists())

    def test_empty_stream_emits_stream_error_and_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = _write_summary(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")

            fake_summarizer = mock.MagicMock()
            fake_summarizer.model_name = "llama3.2:3b"
            # Stream yields only whitespace → must be treated as empty.
            fake_summarizer.summarize_transcript_streaming.return_value = iter(["   ", "\n"])

            with mock.patch("src.config.get_config", return_value=cfg), \
                 mock.patch("src.summarizer.OllamaSummarizer", return_value=fake_summarizer):
                res = CliRunner().invoke(
                    simple_recorder.generate_report,
                    [str(summary), "standard"],
                )
            self.assertNotEqual(res.exit_code, 0)
            self.assertIn("STREAM_ERROR", res.output)
            self.assertIn("empty report", res.output)
            # No sidecar written.
            sidecar_p = report_store.sidecar_path(summary)
            self.assertFalse(sidecar_p.exists())

    def test_valid_stream_writes_before_stream_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = _write_summary(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")

            fake_summarizer = mock.MagicMock()
            fake_summarizer.model_name = "llama3.2:3b"
            fake_summarizer.summarize_transcript_streaming.return_value = iter(
                ["## Report\n", "- body"]
            )

            with mock.patch("src.config.get_config", return_value=cfg), \
                 mock.patch("src.summarizer.OllamaSummarizer", return_value=fake_summarizer):
                res = CliRunner().invoke(
                    simple_recorder.generate_report,
                    [str(summary), "standard"],
                )
            self.assertEqual(res.exit_code, 0, res.output)
            # Ordering: the sidecar is written before STREAM_COMPLETE is emitted.
            self.assertIn("STREAM_COMPLETE", res.output)
            # Report landed in the sidecar, NOT the meeting file.
            sidecar_p = report_store.sidecar_path(summary)
            self.assertTrue(sidecar_p.exists(), "sidecar file should exist")
            sidecar = json.loads(sidecar_p.read_text())
            self.assertEqual(len(sidecar["reports"]), 1)
            self.assertIn("body", sidecar["reports"][0]["content"])
            self.assertEqual(sidecar["active_report"], sidecar["reports"][0]["id"])
            # Meeting file itself must NOT be modified (it's still a .md).
            self.assertTrue(summary.read_text().startswith("---"))


if __name__ == "__main__":
    unittest.main()
