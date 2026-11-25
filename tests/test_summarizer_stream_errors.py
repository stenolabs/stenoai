"""Regression tests for streaming-summary error propagation.

Before this fix the streaming generators in ``src.summarizer`` swallowed
provider failures (``logger.error(...); return``): a failed stream (e.g. Ollama
404 "model not found", a cloud API error, or an adapter error record) ended the
generator silently, so the consumers in ``simple_recorder`` saw an empty-but-
"successful" stream and wrote an empty summary + printed STREAM_COMPLETE + exit
0. These tests pin the corrected contract — a stream failure RAISES so the
consumer surfaces it via STREAM_ERROR — and add an empty-stream guard mirroring
``_map_reduce_streaming``'s empty-reduce guard. Fixes GH #301.
"""

import unittest
from unittest import mock

from src.config import Config
from src.summarizer import OllamaSummarizer


def _make_summarizer(model="llama3.2:3b"):
    # Mock the readiness check: __init__ calls _ensure_ollama_ready() for the
    # local provider, so without this construction would try to start Ollama
    # (non-hermetic). Mirrors tests/test_summarizer_template.py::_s.
    with mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready", return_value=True):
        return OllamaSummarizer(model_name=model, ai_provider="local", config=Config())


def _gen_raising(exc):
    """Return a zero-arg-usable generator function that raises ``exc`` on iteration."""

    def _factory(*args, **kwargs):
        raise exc
        yield  # pragma: no cover - makes this a generator

    return _factory


def _gen_yielding(chunks):
    def _factory(*args, **kwargs):
        for c in chunks:
            yield c

    return _factory


class _FakeResp:
    """Minimal context-manager stand-in for urllib.request.urlopen()."""

    def __init__(self, lines):
        self._lines = lines

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        return iter(self._lines)


class OllamaStreamErrorTests(unittest.TestCase):
    def test_ollama_stream_error_propagates(self):
        """Ollama 404 (model not found) must propagate, not yield nothing."""
        s = _make_summarizer()
        short = "Speaker: hello.\n" * 3
        err = RuntimeError("model 'x' not found (404)")
        with mock.patch.object(s, "_ensure_ollama_ready"):
            with mock.patch.object(s, "_stream_direct", side_effect=_gen_raising(err)):
                with self.assertRaises(RuntimeError) as ctx:
                    list(s.summarize_transcript_streaming(short))
        # The ORIGINAL exception surfaces so STREAM_ERROR shows the real message.
        self.assertIn("not found", str(ctx.exception))
        self.assertIs(ctx.exception, err)

    def test_empty_stream_raises_valueerror(self):
        """A stream that completes without raising but yields only whitespace
        must raise ValueError rather than silently save an empty summary."""
        s = _make_summarizer()
        short = "Speaker: hello.\n" * 3
        with mock.patch.object(s, "_ensure_ollama_ready"):
            with mock.patch.object(s, "_stream_direct", side_effect=_gen_yielding(["", "   ", "\n"])):
                with self.assertRaises(ValueError) as ctx:
                    list(s.summarize_transcript_streaming(short))
        self.assertIn("empty", str(ctx.exception).lower())

    def test_successful_stream_yields_chunks_unchanged(self):
        """Regression guard: a normal successful stream is passed through verbatim."""
        s = _make_summarizer()
        short = "Speaker: hello.\n" * 3
        with mock.patch.object(s, "_ensure_ollama_ready"):
            with mock.patch.object(
                s, "_stream_direct", side_effect=_gen_yielding(["## Summary\n", "ok\n"])
            ):
                out = list(s.summarize_transcript_streaming(short))
        self.assertEqual(out, ["## Summary\n", "ok\n"])


class TemplatePathStreamErrorTests(unittest.TestCase):
    def test_template_path_error_propagates(self):
        """The free-form template path must also surface provider errors."""
        s = _make_summarizer()
        err = RuntimeError("Ollama streaming failed: connection refused")
        with mock.patch.object(s, "_ensure_ollama_ready"):
            with mock.patch.object(s, "_stream_direct", side_effect=_gen_raising(err)):
                with self.assertRaises(RuntimeError) as ctx:
                    list(
                        s.summarize_transcript_streaming(
                            "Speaker: hi.", template_prompt="Write a status update."
                        )
                    )
        self.assertIs(ctx.exception, err)

    def test_template_path_empty_stream_raises(self):
        s = _make_summarizer()
        with mock.patch.object(s, "_ensure_ollama_ready"):
            with mock.patch.object(s, "_stream_direct", side_effect=_gen_yielding([""])):
                with self.assertRaises(ValueError):
                    list(
                        s.summarize_transcript_streaming(
                            "Speaker: hi.", template_prompt="Write a status update."
                        )
                    )


class CloudStreamErrorTests(unittest.TestCase):
    def test_openai_compatible_stream_error_propagates(self):
        """Cloud (openai-compatible) streaming failure must propagate."""
        s = _make_summarizer()
        s.ai_provider = "cloud"
        s.cloud_provider = "openai"
        s.client = None
        s.cloud_client = mock.Mock()
        s.cloud_client.chat.completions.create.side_effect = RuntimeError(
            "The model `x` does not exist (404)"
        )
        with mock.patch.object(s, "_ensure_ollama_ready"):
            with self.assertRaises(RuntimeError) as ctx:
                list(s.summarize_transcript_streaming("Speaker: hi."))
        self.assertIn("does not exist", str(ctx.exception))

    def test_anthropic_stream_error_propagates(self):
        s = _make_summarizer()
        s.ai_provider = "cloud"
        s.cloud_provider = "anthropic"
        s.anthropic_client = mock.Mock()
        s.anthropic_client.messages.stream.side_effect = RuntimeError("overloaded_error")
        with mock.patch.object(s, "_ensure_ollama_ready"):
            with self.assertRaises(RuntimeError) as ctx:
                list(s.summarize_transcript_streaming("Speaker: hi."))
        self.assertIn("overloaded_error", str(ctx.exception))

    def test_bedrock_error_propagates(self):
        s = _make_summarizer()
        s.ai_provider = "cloud"
        s.cloud_provider = "bedrock"
        with mock.patch.object(s, "_ensure_ollama_ready"):
            with mock.patch.object(
                s, "_bedrock_stream", _gen_raising(RuntimeError("AccessDeniedException"))
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    list(s.summarize_transcript_streaming("Speaker: hi."))
        self.assertIn("AccessDeniedException", str(ctx.exception))

    def test_bedrock_converse_fallback_error_propagates(self):
        """A failure in the non-streaming fallback still raises out of the stream."""
        from src.summarizer import BedrockStreamingUnsupported

        s = _make_summarizer()
        s.ai_provider = "cloud"
        s.cloud_provider = "bedrock"
        s.bedrock_api_key = "k"
        s.bedrock_region = "us-east-1"
        with mock.patch(
            "src.summarizer.bedrock_converse_stream_events",
            _gen_raising(BedrockStreamingUnsupported(400, "ValidationException")),
        ):
            with mock.patch.object(s, "_bedrock_chat", side_effect=RuntimeError("AccessDeniedException")):
                with self.assertRaises(RuntimeError) as ctx:
                    list(s.summarize_transcript_streaming("Speaker: hi."))
        self.assertIn("AccessDeniedException", str(ctx.exception))


class AdapterStreamErrorTests(unittest.TestCase):
    def _adapter_summarizer(self):
        s = _make_summarizer()
        s.ai_provider = "adapter"
        s.adapter_url = "https://adapter.example.com"
        s.adapter_token = "fake-token"
        return s

    def test_adapter_error_record_raises(self):
        """An NDJSON {"type":"error"} record must raise, not end silently."""
        s = self._adapter_summarizer()
        lines = [
            b'{"type": "chunk", "text": "partial"}\n',
            b'{"type": "error", "error": "model not found"}\n',
        ]
        with mock.patch("urllib.request.urlopen", return_value=_FakeResp(lines)):
            with self.assertRaises(RuntimeError) as ctx:
                list(s._adapter_stream("prompt"))
        self.assertIn("model not found", str(ctx.exception))

    def test_adapter_httperror_raises(self):
        import urllib.error

        s = self._adapter_summarizer()
        http_err = urllib.error.HTTPError(
            "https://adapter.example.com/ai/chat/stream", 500, "Server Error", {}, None
        )
        with mock.patch("urllib.request.urlopen", side_effect=http_err):
            with self.assertRaises(urllib.error.HTTPError):
                list(s._adapter_stream("prompt"))

    def test_adapter_transport_error_raises(self):
        s = self._adapter_summarizer()
        with mock.patch("urllib.request.urlopen", side_effect=OSError("connection reset")):
            with self.assertRaises(OSError):
                list(s._adapter_stream("prompt"))


if __name__ == "__main__":
    unittest.main()
