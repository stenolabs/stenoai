import unittest
from types import SimpleNamespace
from unittest import mock

from src.config import Config
from src.summarizer import OllamaSummarizer, _openai_content_text


def _cloud_summarizer():
    with mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready", return_value=True):
        s = OllamaSummarizer(model_name="llama3.2:3b", ai_provider="local", config=Config())
    s.ai_provider = "cloud"
    s.cloud_provider = "openai"
    s.model_name = "mistral-large-latest"
    s.client = None
    s.cloud_client = mock.Mock()
    return s


def _chunk(content):
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=content))])


# Mistral reasoning models send content as typed chunks rather than a string.
_THINKING = {"type": "thinking", "thinking": [{"type": "text", "text": "let me think"}]}


class OpenAIContentTextTests(unittest.TestCase):
    def test_string_and_none(self):
        self.assertEqual(_openai_content_text("hi"), "hi")
        self.assertEqual(_openai_content_text(None), "")

    def test_chunk_list_keeps_text_and_drops_thinking(self):
        content = [_THINKING, {"type": "text", "text": "## Sum"}, {"type": "text", "text": "mary"}]
        self.assertEqual(_openai_content_text(content), "## Summary")

    def test_chunk_objects(self):
        content = [SimpleNamespace(type="thinking", thinking=[]), SimpleNamespace(type="text", text="ok")]
        self.assertEqual(_openai_content_text(content), "ok")


class MistralChunkStreamingTests(unittest.TestCase):
    def test_streaming_summary_accepts_list_content(self):
        # Regression: list-typed delta.content crashed with
        # "'list' object has no attribute 'strip'" during reprocess.
        s = _cloud_summarizer()
        s.cloud_client.chat.completions.create.return_value = iter([
            _chunk([_THINKING]),
            _chunk([{"type": "text", "text": "## Overview\n"}]),
            _chunk("Done.\n"),
            _chunk(None),
        ])
        out = "".join(s.summarize_transcript_streaming("Speaker: hi.", 0, "en", None))
        self.assertEqual(out, "## Overview\nDone.\n")

    def test_streaming_summary_with_only_thinking_is_empty_error(self):
        s = _cloud_summarizer()
        s.cloud_client.chat.completions.create.return_value = iter([_chunk([_THINKING])])
        with self.assertRaises(ValueError):
            "".join(s.summarize_transcript_streaming("Speaker: hi.", 0, "en", None))

    def test_streaming_chat_yields_only_text_chunks(self):
        # The interactive query path (Ask AI / chat) streams separately.
        s = _cloud_summarizer()
        s.cloud_client.chat.completions.create.return_value = iter([
            _chunk([_THINKING]),
            _chunk([{"type": "text", "text": "The answer"}]),
            _chunk(" is 42."),
            _chunk(None),
        ])
        self.assertEqual(list(s.stream_chat_prompt("prompt")), ["The answer", " is 42."])

    def test_non_streaming_chat_accepts_list_content(self):
        s = _cloud_summarizer()
        message = SimpleNamespace(content=[_THINKING, {"type": "text", "text": " Title "}])
        s.cloud_client.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=message)]
        )
        self.assertEqual(s._openai_chat("prompt"), "Title")


if __name__ == "__main__":
    unittest.main()
