import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src import keywords


class A1SeamTests(unittest.TestCase):
    """The A1 seam is a thin call into keywords.apply_to_transcript; we assert
    the helper does the right thing on the two derived strings the seam heals."""

    def test_plain_and_diarised_healed(self):
        entries = [{"preferred": "NexGen Suite", "aliases": ["NexGan Suite"]}]
        plain = keywords.apply_to_transcript("about NexGan Suite", entries)
        diarised = keywords.apply_to_transcript("[Others] NexGan Suite rocks", entries)
        self.assertEqual(plain, "about NexGen Suite")
        self.assertEqual(diarised, "[Others] NexGen Suite rocks")


class A2ReprocessTests(unittest.TestCase):
    """reprocess must retroactively heal the stored transcript (JSON: transcript
    + diarised_text; MD: ## Transcript) using configured Custom Keywords, and the
    MD rewrite must preserve the folders frontmatter."""

    def setUp(self):
        self._orig_dd = os.environ.get("STENOAI_USER_DATA_DIR")
        from src import config as _config
        self._orig_config = _config._config_instance
        self._tmpdir = tempfile.TemporaryDirectory()
        self._tmp = self._tmpdir.name
        os.environ["STENOAI_USER_DATA_DIR"] = self._tmp
        # Fresh config bound to the temp data dir.
        _config._config_instance = None
        from src.config import get_config
        get_config().set_custom_keywords(
            [{"preferred": "NexGen Suite", "aliases": ["NexGan Suite"]}]
        )

    def tearDown(self):
        if self._orig_dd is not None:
            os.environ["STENOAI_USER_DATA_DIR"] = self._orig_dd
        else:
            os.environ.pop("STENOAI_USER_DATA_DIR", None)
        from src import config as _config
        _config._config_instance = self._orig_config
        self._tmpdir.cleanup()

    def _run_reprocess(self, summary_path):
        # Patch the whole OllamaSummarizer class so __init__ never runs (no real
        # Ollama probe / httpx.get to 11434), keeping the test hermetic. reprocess
        # does `from src.summarizer import OllamaSummarizer` locally, so the class
        # is looked up on the src.summarizer module at call time - patch it there.
        import simple_recorder as sr
        from click.testing import CliRunner
        with patch("src.summarizer.OllamaSummarizer", autospec=True) as MockSummarizer:
            MockSummarizer.return_value.summarize_transcript_streaming.return_value = (
                iter(["## Summary\nok\n"])
            )
            # reprocess snapshots the prior note as a backup (#249) and may
            # regenerate the title; both read the summarizer instance. Give the
            # autospec mock a concrete model_name and a no-op title so those
            # paths run without touching a real model.
            MockSummarizer.return_value.model_name = "mock-model"
            MockSummarizer.return_value.generate_title.return_value = None
            runner = CliRunner()
            result = runner.invoke(sr.cli, ["reprocess", str(summary_path)])
        if result.exception is not None and not isinstance(
            result.exception, SystemExit
        ):
            raise result.exception
        return result

    def test_json_heals_both_fields(self):
        p = Path(self._tmp) / "m.json"
        p.write_text(json.dumps({
            "session_info": {"name": "M", "duration_minutes": 5},
            "transcript": "about NexGan Suite",
            "diarised_text": "[Others] NexGan Suite rocks",
            "is_diarised": True,
            "folders": ["f1"],
        }))
        self._run_reprocess(p)
        data = json.loads(p.read_text())
        self.assertEqual(data["transcript"], "about NexGen Suite")
        self.assertEqual(data["diarised_text"], "[Others] NexGen Suite rocks")

    def test_md_heals_and_preserves_folders(self):
        p = Path(self._tmp) / "m.md"
        p.write_text(
            '---\ntitle: "M"\nis_diarised: false\nfolders: ["f1"]\n---\n\n'
            '## Summary\n\nold\n\n## Transcript\n\nabout NexGan Suite\n'
        )
        self._run_reprocess(p)
        text = p.read_text()
        self.assertIn("about NexGen Suite", text)
        self.assertIn('folders: ["f1"]', text)


if __name__ == "__main__":
    unittest.main()
