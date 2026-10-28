import unittest
from unittest.mock import patch

from src.summarizer import OllamaSummarizer


class SummarizerReferenceBlockTests(unittest.TestCase):
    def _summarizer(self):
        # Avoid network/Ollama init; we only call the pure prompt builders.
        return OllamaSummarizer.__new__(OllamaSummarizer)

    def test_permissive_prompt_includes_block_when_configured(self):
        s = self._summarizer()
        with patch("src.config.get_config") as gc:
            gc.return_value.get_custom_keywords.return_value = [
                {"preferred": "NexGen Suite", "aliases": []}
            ]
            prompt = s._create_permissive_prompt("hello transcript", language="en")
            self.assertIn("REFERENCE TERMS", prompt)
            self.assertIn("- NexGen Suite", prompt)

    def test_permissive_prompt_unchanged_when_empty(self):
        s = self._summarizer()
        with patch("src.config.get_config") as gc:
            gc.return_value.get_custom_keywords.return_value = []
            prompt = s._create_permissive_prompt("hello transcript", language="en")
            self.assertNotIn("REFERENCE TERMS", prompt)


if __name__ == "__main__":
    unittest.main()
