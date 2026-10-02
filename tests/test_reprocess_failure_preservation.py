"""A failed Generate notes operation must leave the source note intact."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.config import Config


class ReprocessFailurePreservationTests(unittest.TestCase):
    def test_failure_before_or_during_stream_keeps_note_and_user_notes(self):
        for partial in (False, True):
            with self.subTest(partial=partial), tempfile.TemporaryDirectory() as tmp:
                note = Path(tmp) / "synthetic_summary.md"
                original = (
                    "---\ntitle: Synthetic planning\nlanguage: en\n"
                    "duration_seconds: 60\nnotes_generated: false\n---\n"
                    "## Summary\n\nOriginal summary must survive.\n\n"
                    "## User Notes\n\nKeep the synthetic agenda.\n\n"
                    "## Transcript\n\nThe release is scheduled for Friday.\n"
                )
                note.write_text(original)
                fake = mock.MagicMock()
                fake.model_name = "synthetic-model"

                def failing_stream(*args, **kwargs):
                    if partial:
                        yield "Partial summary that must not replace the original"
                    raise ConnectionError("No route to host")

                fake.summarize_transcript_streaming.side_effect = failing_stream
                with mock.patch.dict(os.environ, {"STENOAI_USER_DATA_DIR": tmp}), \
                        mock.patch("src.config.get_config", return_value=Config(config_path=Path(tmp) / "config.json")), \
                        mock.patch("src.summarizer.OllamaSummarizer", return_value=fake):
                    result = CliRunner().invoke(simple_recorder.reprocess, [str(note)])
                self.assertEqual(result.exit_code, 1, result.output)
                self.assertIn("STREAM_ERROR:No route to host", result.output)
                self.assertNotIn("STREAM_COMPLETE", result.output)
                self.assertEqual(note.read_text(), original)
                fake.generate_title.assert_not_called()


if __name__ == "__main__":
    unittest.main()
