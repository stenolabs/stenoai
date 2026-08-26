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


def _only_apple_sentinel(model_id):
    """Narrow stand-in for is_apple_system_model.

    A blanket True would make the FALLBACK summarizer look like an Apple model
    too, so it would re-enter the Apple arm and recurse — which is exactly the
    production hazard the guard in query_transcript_streaming_strict prevents.
    """
    return model_id == "apple:system"


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
                s, "_bedrock_chat", side_effect=RuntimeError("AccessDeniedException")
            ):
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


class AppleInteractiveQueryFallbackTests(unittest.TestCase):
    """Apple Intelligence reports available and then refuses individual
    requests: its guardrails reject some ordinary meeting content
    deterministically (measured on macOS 27 / AFM 3 Core Advanced — a
    transcript line naming a person and an action was enough, while the same
    prompt shape with a different sentence answered fine). An interactive
    question must not die on that, so the strict query generator falls back to
    the model ``__init__`` already downgrades to when the sidecar is missing.
    Mid-answer it must NOT fall back — that would duplicate text.
    """

    def _apple_summarizer(self):
        s = _make_summarizer()
        s.model_name = "apple:system"
        return s

    def _fake_ollama_client(self, chunks):
        client = mock.Mock()
        client.chat.return_value = [{"message": {"content": c}} for c in chunks]
        return client

    def test_refusal_before_first_chunk_falls_back_when_installed(self):
        s = self._apple_summarizer()
        refusal = RuntimeError("Apple Intelligence request failed")
        with mock.patch("src.apple_lm.is_apple_system_model", side_effect=_only_apple_sentinel), \
             mock.patch("src.apple_lm.stream_complete", side_effect=_gen_raising(refusal)), \
             mock.patch("src.summarizer._is_ollama_model_installed", return_value=True), \
             mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready", return_value=True), \
             mock.patch(
                 "src.summarizer.ollama.Client",
                 return_value=self._fake_ollama_client(["Ana ", "owns it."]),
             ):
            out = list(s.query_transcript_streaming_strict("You: Ana owns the migration.", "Who owns it?"))
        self.assertEqual("".join(out), "Ana owns it.")

    def test_refusal_does_not_fall_back_or_pull_when_model_not_installed(self):
        """Rule: Apple refusal fallback must never download a missing model.

        When the downgrade model is not installed locally, the original Apple
        exception must propagate immediately without initializing Ollama or
        calling chat.
        """
        s = self._apple_summarizer()
        refusal = RuntimeError("Apple Intelligence request failed: guardrail refusal")
        fallback_client = mock.Mock()
        with mock.patch("src.apple_lm.is_apple_system_model", side_effect=_only_apple_sentinel), \
             mock.patch("src.apple_lm.stream_complete", side_effect=_gen_raising(refusal)), \
             mock.patch("src.summarizer._is_ollama_model_installed", return_value=False), \
             mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready", return_value=True), \
             mock.patch("src.summarizer.ollama.Client", return_value=fallback_client):
            with self.assertRaises(RuntimeError) as ctx:
                list(s.query_transcript_streaming_strict("You: Ana owns the migration.", "Who owns it?"))
        self.assertIs(ctx.exception, refusal)
        fallback_client.chat.assert_not_called()

    def test_fallback_uses_the_downgrade_model_not_the_apple_sentinel(self):
        s = self._apple_summarizer()
        seen = {}

        def _capture(*args, **kwargs):
            seen["model"] = kwargs.get("model")
            return [{"message": {"content": "ok"}}]

        client = mock.Mock()
        client.chat.side_effect = _capture
        with mock.patch("src.apple_lm.is_apple_system_model", side_effect=_only_apple_sentinel), \
             mock.patch("src.apple_lm.stream_complete", side_effect=_gen_raising(RuntimeError("boom"))), \
             mock.patch("src.summarizer._is_ollama_model_installed", return_value=True), \
             mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready", return_value=True), \
             mock.patch("src.summarizer.ollama.Client", return_value=client):
            list(s.query_transcript_streaming_strict("You: hi.", "What?"))
        # Not an equality check on DEFAULT_MODEL: construction canonicalises the
        # tag per host (gemma4:e2b-it-qat -> gemma4:e2b-nvfp4 on Apple Silicon,
        # via resolve_runtime_tag). What must hold is that the fallback left the
        # Apple sentinel behind and asked Ollama for the DEFAULT_MODEL family.
        self.assertNotEqual(seen["model"], "apple:system")
        self.assertTrue(
            seen["model"].startswith(Config.DEFAULT_MODEL.split("-")[0]),
            f"fallback asked for {seen['model']!r}, expected the "
            f"{Config.DEFAULT_MODEL!r} family",
        )
    def test_failure_after_a_chunk_propagates_without_duplicating(self):
        s = self._apple_summarizer()
        err = RuntimeError("Apple Intelligence stream timed out")

        def _partial_then_raise(*args, **kwargs):
            yield "Ana "
            raise err

        fallback_client = mock.Mock()
        with mock.patch("src.apple_lm.is_apple_system_model", side_effect=_only_apple_sentinel), \
             mock.patch("src.apple_lm.stream_complete", side_effect=_partial_then_raise), \
             mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready", return_value=True), \
             mock.patch("src.summarizer.ollama.Client", return_value=fallback_client):
            got = []
            with self.assertRaises(RuntimeError) as ctx:
                for chunk in s.query_transcript_streaming_strict("You: hi.", "What?"):
                    got.append(chunk)
        self.assertIs(ctx.exception, err)
        self.assertEqual(got, ["Ana "])
        fallback_client.chat.assert_not_called()

    def test_timeout_is_not_retried_on_the_fallback(self):
        """A hung sidecar must surface, not silently start a second attempt.

        main.js kills the live query at LIVE_QUERY_TIMEOUT_MS (300 s) and
        reports its own fixed TIMEOUT error, so a fallback begun after a
        full-length Apple stall gets killed before it can emit anything: the
        user would wait longer for the identical outcome.
        """
        s = self._apple_summarizer()
        stall = TimeoutError("Apple Intelligence stream timed out")
        fallback_client = mock.Mock()
        with mock.patch("src.apple_lm.is_apple_system_model", side_effect=_only_apple_sentinel), \
             mock.patch("src.apple_lm.stream_complete", side_effect=_gen_raising(stall)), \
             mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready", return_value=True), \
             mock.patch("src.summarizer.ollama.Client", return_value=fallback_client):
            with self.assertRaises(TimeoutError) as ctx:
                list(s.query_transcript_streaming_strict("You: hi.", "What?"))
        self.assertIs(ctx.exception, stall)
        fallback_client.chat.assert_not_called()

    def test_interactive_attempt_uses_the_short_deadline(self):
        """The Apple attempt must be bounded well below main's 300 s kill so a
        slow sidecar still leaves budget for the fallback."""
        from src.summarizer import APPLE_INTERACTIVE_TIMEOUT_S

        s = self._apple_summarizer()
        seen = {}

        def _record(prompt, timeout=None):
            seen["timeout"] = timeout
            yield "ok"

        with mock.patch("src.apple_lm.is_apple_system_model", side_effect=_only_apple_sentinel), \
             mock.patch("src.apple_lm.stream_complete", side_effect=_record):
            list(s.query_transcript_streaming_strict("You: hi.", "What?"))
        self.assertEqual(seen["timeout"], APPLE_INTERACTIVE_TIMEOUT_S)
        self.assertLess(APPLE_INTERACTIVE_TIMEOUT_S, 300)


if __name__ == "__main__":
    unittest.main()
