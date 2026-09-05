"""Unit tests for map-reduce summarization helpers in OllamaSummarizer."""

import unittest
from unittest import mock

from src.config import Config
from src.summarizer import OllamaSummarizer, MAP_PROMPT_OVERHEAD_TOKENS, MAP_OUTPUT_MAX_TOKENS, CHARS_PER_TOKEN, _CHUNK_SAFETY_CHARS_PER_TOKEN


def _make_summarizer(model_name="llama3.2:3b"):
    # __init__ calls _ensure_ollama_ready() for the local provider -- without
    # mocking it, construction hits the REAL local Ollama server and, if the
    # model isn't installed, triggers a REAL multi-GB `ollama pull` (this was
    # a live bug: every test in this file did exactly that on any machine
    # with Ollama actually running, e.g. via ollama.list()/.pull() in
    # src.summarizer._ensure_model_available). Mirrors the correct pattern
    # already used in test_summarizer_template.py's _s() helper.
    cfg = Config()
    # Patch out the Ollama readiness/start check during construction — these are
    # unit tests for pure helpers (chunk budget, split, prompt build) and must
    # not depend on a live Ollama server. Matches the pattern the sibling
    # summarizer test modules already use, and keeps the suite hermetic in CI.
    with mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready"):
        return OllamaSummarizer(model_name=model_name, ai_provider="local", config=cfg)


class ChunkBudgetTests(unittest.TestCase):
    def test_budget_uses_fixed_caps_not_ratio(self):
        s = _make_summarizer("llama3.2:3b")  # num_ctx = 8192
        # content_tokens = 8192 - 300 - 600 = 7292; budget = 7292 * 2 = 14584
        self.assertEqual(s._chunk_budget_chars(), 7292 * _CHUNK_SAFETY_CHARS_PER_TOKEN)

    def test_budget_scales_with_model_context(self):
        s_small = _make_summarizer("llama3.2:3b")   # 8192
        s_large = _make_summarizer("gemma4:e2b-it-qat")  # 32768
        self.assertLess(s_small._chunk_budget_chars(), s_large._chunk_budget_chars())


class SplitIntoChunksTests(unittest.TestCase):
    def test_short_transcript_returns_single_chunk(self):
        s = _make_summarizer()
        budget = s._chunk_budget_chars()
        transcript = "Speaker A: hello world.\n" * 10
        # Definitely shorter than budget
        self.assertLess(len(transcript), budget)
        chunks = s._split_into_chunks(transcript)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0], transcript)

    def test_each_chunk_fits_within_budget(self):
        s = _make_summarizer()
        budget = s._chunk_budget_chars()
        overlap_chars = int(budget * 0.05)
        content_budget = budget - overlap_chars
        # Build transcript 3x content_budget → guaranteed 3+ chunks
        line = "Speaker A: some words here.\n"
        n = (content_budget * 3) // len(line) + 1
        transcript = line * n
        chunks = s._split_into_chunks(transcript)
        self.assertGreater(len(chunks), 1)
        for i, chunk in enumerate(chunks):
            self.assertLessEqual(
                len(chunk), budget,
                msg=f"chunk {i} of {len(chunks)} has {len(chunk)} chars > budget {budget}",
            )

    def test_overlap_prefix_from_previous_chunk(self):
        s = _make_summarizer()
        budget = s._chunk_budget_chars()
        overlap_chars = int(budget * 0.05)
        content_budget = budget - overlap_chars
        # Make a transcript large enough for exactly 2 raw chunks
        line = "x" * 80 + "\n"
        n = (content_budget // len(line)) + 5
        transcript = line * n
        chunks = s._split_into_chunks(transcript)
        self.assertGreaterEqual(len(chunks), 2, "need at least 2 chunks to test overlap")
        # chunk[1] must start with the tail of chunk[0]
        tail = chunks[0][-overlap_chars:]
        self.assertTrue(
            chunks[1].startswith(tail),
            msg=f"chunk[1] does not start with last {overlap_chars} chars of chunk[0]",
        )

    def test_no_data_lost_across_chunks(self):
        s = _make_summarizer()
        budget = s._chunk_budget_chars()
        overlap_chars = int(budget * 0.05)
        content_budget = budget - overlap_chars
        # Each line has a unique number so we can check coverage
        line = "Speaker A: line {i}.\n"
        n = (content_budget * 2) // len(line.format(i=9999)) + 1
        lines = [line.format(i=i) for i in range(n)]
        transcript = "".join(lines)
        chunks = s._split_into_chunks(transcript)
        combined = " ".join(chunks)
        for i, ln in enumerate(lines):
            self.assertIn(ln.strip(), combined, msg=f"line {i} not found in any chunk")


class MapCallTests(unittest.TestCase):
    def test_map_prompt_contains_chunk_position(self):
        s = _make_summarizer()
        prompt = s._create_map_prompt("hello world", 2, 5)
        self.assertIn("part 2 of 5", prompt)
        self.assertIn("hello world", prompt)

    def test_map_prompt_contains_extraction_structure(self):
        s = _make_summarizer()
        prompt = s._create_map_prompt("some text", 1, 3)
        self.assertIn("KEY POINTS", prompt)
        self.assertIn("ACTION ITEMS", prompt)
        self.assertIn("TRANSCRIPT SEGMENT:", prompt)

    def test_summarize_chunk_raises_on_empty_llm_response(self):
        s = _make_summarizer()
        with mock.patch.object(s, '_ensure_ollama_ready'):
            with mock.patch.object(s.client, 'chat', return_value={"message": {"content": ""}}):
                with self.assertRaises(ValueError) as ctx:
                    s._summarize_chunk("some content", 1, 3)
        self.assertIn("empty", str(ctx.exception).lower())

    def test_summarize_chunk_returns_stripped_content(self):
        s = _make_summarizer()
        fake_response = {"message": {"content": "  KEY POINTS\n- item\n"}}
        with mock.patch.object(s, '_ensure_ollama_ready'):
            with mock.patch.object(s.client, 'chat', return_value=fake_response):
                result = s._summarize_chunk("some content", 1, 3)
        self.assertEqual(result, "KEY POINTS\n- item")

    def test_summarize_chunk_passes_num_predict_option(self):
        s = _make_summarizer()
        fake_response = {"message": {"content": "some result"}}
        with mock.patch.object(s, '_ensure_ollama_ready'):
            with mock.patch.object(s.client, 'chat', return_value=fake_response) as mock_chat:
                s._summarize_chunk("content", 1, 1)
        call_kwargs = mock_chat.call_args
        options = call_kwargs[1].get('options') or (call_kwargs[0][2] if len(call_kwargs[0]) > 2 else {})
        # Extract options from however it was called
        all_kwargs = mock_chat.call_args.kwargs if mock_chat.call_args.kwargs else {}
        if not all_kwargs:
            all_kwargs = dict(zip(['model', 'messages', 'stream', 'options'], mock_chat.call_args.args))
        self.assertEqual(all_kwargs.get('options', {}).get('num_predict'), 600)

    def test_summarize_chunk_uses_non_streaming(self):
        s = _make_summarizer()
        fake_response = {"message": {"content": "result"}}
        with mock.patch.object(s, '_ensure_ollama_ready'):
            with mock.patch.object(s.client, 'chat', return_value=fake_response) as mock_chat:
                s._summarize_chunk("content", 1, 1)
        call_kwargs = mock_chat.call_args.kwargs if mock_chat.call_args.kwargs else {}
        if not call_kwargs:
            call_kwargs = dict(zip(['model', 'messages', 'stream', 'options'], mock_chat.call_args.args))
        self.assertIs(call_kwargs.get('stream'), False)


class ThinkingDisabledTests(unittest.TestCase):
    """Regression for STREAM_ERROR "empty result after retry" on thinking-capable
    models. gemma4:e2b-it-qat / gemma4:12b-it-qat emit chain-of-thought into
    message.thinking; the map step caps output at MAP_OUTPUT_MAX_TOKENS, so
    reasoning tokens exhaust the budget and message.content comes back empty.
    Summarization calls must pass think=False so the whole budget is answer text.
    """

    @staticmethod
    def _chat_kwargs(mock_chat):
        kw = dict(mock_chat.call_args.kwargs)
        if not kw:
            kw = dict(zip(['model', 'messages', 'stream', 'options'], mock_chat.call_args.args))
        return kw

    def _long_transcript(self, s):
        budget = s._chunk_budget_chars()
        overlap = int(budget * 0.05)
        content_budget = budget - overlap
        line = "b" * 80 + "\n"
        n = (content_budget // len(line)) + 5
        return line * n

    def test_map_chunk_call_disables_thinking(self):
        s = _make_summarizer()
        fake_response = {"message": {"content": "result"}}
        with mock.patch.object(s, '_ensure_ollama_ready'):
            with mock.patch.object(s.client, 'chat', return_value=fake_response) as mock_chat:
                s._summarize_chunk("content", 1, 1)
        self.assertIs(self._chat_kwargs(mock_chat).get('think'), False)

    def test_reduce_call_disables_thinking(self):
        s = _make_summarizer()
        transcript = self._long_transcript(s)
        with mock.patch.object(s, '_summarize_chunk', return_value="extracted"):
            with mock.patch.object(s, '_ensure_ollama_ready'):
                def fake_chat(**kwargs):
                    return iter([{"message": {"content": "## Summary\nok\n"}}])
                with mock.patch.object(s.client, 'chat', side_effect=fake_chat) as mock_chat:
                    list(s._map_reduce_streaming(transcript))
        self.assertIs(mock_chat.call_args.kwargs.get('think'), False)

    def test_direct_streaming_summary_disables_thinking(self):
        s = _make_summarizer()
        short = "Speaker: hello.\n" * 5

        def fake_chat(**kwargs):
            return iter([{"message": {"content": "## Summary\nok\n"}}])

        with mock.patch.object(s, '_ensure_ollama_ready'):
            with mock.patch.object(s.client, 'chat', side_effect=fake_chat) as mock_chat:
                list(s.summarize_transcript_streaming(short))
        self.assertIs(mock_chat.call_args.kwargs.get('think'), False)

    def test_json_summary_path_disables_thinking(self):
        s = _make_summarizer()
        valid = ('{"overview":"o","key_points":[],"next_steps":[],'
                 '"discussion_areas":[],"participants":[]}')
        with mock.patch.object(s, '_ensure_ollama_ready'):
            with mock.patch.object(s.client, 'chat',
                                   return_value={"message": {"content": valid}}) as mock_chat:
                s.summarize_transcript("some transcript text", 10)
        self.assertIs(self._chat_kwargs(mock_chat).get('think'), False)

    def test_generate_title_disables_thinking(self):
        s = _make_summarizer()
        fake_client = mock.MagicMock()
        fake_client.chat.return_value = {"message": {"content": "Project Kickoff"}}
        with mock.patch('ollama.Client', return_value=fake_client):
            s.generate_title("a summary", "a transcript")
        self.assertIs(fake_client.chat.call_args.kwargs.get('think'), False)


class ThinkFallbackTests(unittest.TestCase):
    """The ollama>=0.5.0 pin governs only the bundled client; in remote mode the
    request hits the user's own server, which may reject `think`. _chat_no_think
    / _chat_stream_no_think must retry once without `think`, and re-raise the
    ORIGINAL error if the retry also fails (so a genuine fault isn't masked)."""

    def test_chat_no_think_retries_without_think_on_error(self):
        s = _make_summarizer()
        seen = []

        def chat(**kwargs):
            seen.append(kwargs)
            if 'think' in kwargs:
                raise Exception("unknown parameter: think")
            return {"message": {"content": "ok"}}

        client = mock.MagicMock()
        client.chat.side_effect = chat
        result = s._chat_no_think(client, model="m", messages=[])
        self.assertEqual(result["message"]["content"], "ok")
        self.assertEqual(len(seen), 2)
        self.assertIs(seen[0].get('think'), False)   # first attempt requested think=False
        self.assertNotIn('think', seen[1])           # retry dropped it

    def test_chat_no_think_reraises_original_when_retry_also_fails(self):
        s = _make_summarizer()

        def chat(**kwargs):
            raise RuntimeError("original" if 'think' in kwargs else "retry")

        client = mock.MagicMock()
        client.chat.side_effect = chat
        with self.assertRaises(RuntimeError) as ctx:
            s._chat_no_think(client, model="m", messages=[])
        self.assertEqual(str(ctx.exception), "original")

    def test_chat_no_think_passes_through_on_success(self):
        s = _make_summarizer()
        client = mock.MagicMock()
        client.chat.return_value = {"message": {"content": "ok"}}
        result = s._chat_no_think(client, model="m", messages=[])
        self.assertEqual(result["message"]["content"], "ok")
        self.assertEqual(client.chat.call_count, 1)
        self.assertIs(client.chat.call_args.kwargs.get('think'), False)

    def test_chat_stream_no_think_restarts_stream_without_think(self):
        s = _make_summarizer()

        def chat(**kwargs):
            if 'think' in kwargs:
                def boom():
                    raise Exception("think rejected")
                    yield  # pragma: no cover - makes this a generator
                return boom()
            return iter([{"message": {"content": "a"}}, {"message": {"content": "b"}}])

        client = mock.MagicMock()
        client.chat.side_effect = chat
        out = list(s._chat_stream_no_think(client, model="m", messages=[]))
        self.assertEqual([c["message"]["content"] for c in out], ["a", "b"])

    def test_chat_stream_no_think_reraises_original_when_retry_stream_also_fails(self):
        s = _make_summarizer()

        def chat(**kwargs):
            msg = "original" if 'think' in kwargs else "retry"

            def boom():
                raise RuntimeError(msg)
                yield  # pragma: no cover - makes this a generator

            return boom()

        client = mock.MagicMock()
        client.chat.side_effect = chat
        with self.assertRaises(RuntimeError) as ctx:
            list(s._chat_stream_no_think(client, model="m", messages=[]))
        self.assertEqual(str(ctx.exception), "original")


class ReducePromptTests(unittest.TestCase):
    def test_reduce_prompt_contains_chunk_headers(self):
        s = _make_summarizer()
        results = ["KEY POINTS\n- item A", "KEY POINTS\n- item B"]
        prompt = s._create_reduce_prompt(results)
        self.assertIn("CHUNK 1 OF 2", prompt)
        self.assertIn("CHUNK 2 OF 2", prompt)
        self.assertIn("item A", prompt)
        self.assertIn("item B", prompt)

    def test_reduce_prompt_instructs_markdown_output(self):
        s = _make_summarizer()
        prompt = s._create_reduce_prompt(["result"])
        self.assertIn("## Summary", prompt)
        self.assertIn("## Key Topics", prompt)
        self.assertIn("## Key Points", prompt)
        self.assertIn("## Action Items", prompt)

    def test_reduce_prompt_includes_notes_when_provided(self):
        s = _make_summarizer()
        prompt = s._create_reduce_prompt(["result"], notes="bring coffee")
        self.assertIn("bring coffee", prompt)
        self.assertIn("USER NOTES", prompt)

    def test_reduce_prompt_no_notes_section_when_empty(self):
        s = _make_summarizer()
        prompt = s._create_reduce_prompt(["result"], notes=None)
        self.assertNotIn("USER NOTES", prompt)

    def test_reduce_prompt_does_not_say_summarise_this_transcript(self):
        # Regression guard: the reduce step must NOT reuse _create_markdown_prompt's
        # opening "Summarise this meeting transcript" because the input is already
        # extracted bullet lists, not raw speech.
        s = _make_summarizer()
        prompt = s._create_reduce_prompt(["result"])
        self.assertNotIn("Summarise this meeting transcript", prompt)
        self.assertNotIn("TRANSCRIPT:\n", prompt)


class NeedsChunkingTests(unittest.TestCase):
    def test_returns_false_for_cloud_provider(self):
        cfg = Config()
        with mock.patch.object(cfg, 'get_cloud_api_key', return_value="sk-fake"):
            with mock.patch.object(cfg, 'get_cloud_provider', return_value="bedrock"):
                with mock.patch.object(cfg, 'get_bedrock_region', return_value="us-east-1"):
                    with mock.patch.object(cfg, 'get_bedrock_inference_profile', return_value=""):
                        s = OllamaSummarizer(model_name="gpt-4o", ai_provider="cloud", config=cfg)
        # Cloud provider: even with a giant transcript, chunking is not needed
        self.assertFalse(s._needs_chunking("x" * 1_000_000))

    def test_returns_false_for_adapter_provider(self):
        cfg = Config()
        with mock.patch.object(cfg, 'get_adapter_url', return_value="https://adapter.example.com"):
            with mock.patch.object(cfg, 'get_adapter_token', return_value="fake-token"):
                s = OllamaSummarizer(model_name="adapter-model", ai_provider="adapter", config=cfg)
        self.assertFalse(s._needs_chunking("x" * 1_000_000))

    def test_returns_false_for_short_transcript(self):
        s = _make_summarizer("llama3.2:3b")  # num_ctx = 8192
        # 8192 * 0.8 * 2 = 13107 chars threshold; 1000 chars is well below
        self.assertFalse(s._needs_chunking("x" * 1000))

    def test_returns_true_for_long_transcript(self):
        s = _make_summarizer("llama3.2:3b")  # threshold ~13107 chars
        long_transcript = "x" * 30000
        self.assertTrue(s._needs_chunking(long_transcript))


class MapReduceStreamingTests(unittest.TestCase):
    def test_progress_callback_called_for_each_chunk_then_reducing(self):
        s = _make_summarizer()
        budget = s._chunk_budget_chars()
        overlap = int(budget * 0.05)
        content_budget = budget - overlap
        # Force 2 raw chunks
        line = "a" * 80 + "\n"
        n = (content_budget // len(line)) + 5
        transcript = line * n

        progress_calls = []
        with mock.patch.object(s, '_summarize_chunk', return_value="KEY POINTS\n- x"):
            with mock.patch.object(s, '_ensure_ollama_ready'):
                # Patch the Ollama streaming (reduce step)
                def fake_chat(**kwargs):
                    return iter([
                        {"message": {"content": "## Summary\nok\n"}},
                        {"message": {"content": ""}},
                    ])
                with mock.patch.object(s.client, 'chat', side_effect=fake_chat):
                    chunks = list(s._map_reduce_streaming(
                        transcript,
                        progress_callback=lambda step, total: progress_calls.append((step, total)),
                    ))

        # Should have called progress once per map chunk, then once for reducing
        n_chunks = len(s._split_into_chunks(transcript))
        map_calls = [(i + 1, n_chunks) for i in range(n_chunks)]
        reduce_signal = (n_chunks + 1, n_chunks)  # step > total = "reducing"
        self.assertEqual(progress_calls[:-1], map_calls)
        self.assertEqual(progress_calls[-1], reduce_signal)

    def test_map_reduce_streaming_yields_reduce_content(self):
        s = _make_summarizer()
        budget = s._chunk_budget_chars()
        overlap = int(budget * 0.05)
        content_budget = budget - overlap
        line = "b" * 80 + "\n"
        n = (content_budget // len(line)) + 5
        transcript = line * n

        with mock.patch.object(s, '_summarize_chunk', return_value="extracted"):
            with mock.patch.object(s, '_ensure_ollama_ready'):
                def fake_chat(**kwargs):
                    return iter([
                        {"message": {"content": "## Summary\ntest result\n"}},
                        {"message": {"content": ""}},
                    ])
                with mock.patch.object(s.client, 'chat', side_effect=fake_chat):
                    result = "".join(s._map_reduce_streaming(transcript))
        self.assertIn("## Summary", result)
        self.assertIn("test result", result)


class SummarizeTranscriptStreamingForkTests(unittest.TestCase):
    def test_short_transcript_uses_direct_path(self):
        """Short transcripts must NOT trigger map-reduce (1 chat call, not N+1)."""
        s = _make_summarizer()
        short = "Speaker: hello.\n" * 5

        def fake_chat(**kwargs):
            return iter([{"message": {"content": "## Summary\nok\n"}}])

        with mock.patch.object(s, '_ensure_ollama_ready'):
            with mock.patch.object(s.client, 'chat', side_effect=fake_chat) as mock_chat:
                list(s.summarize_transcript_streaming(short))
        # Direct path: exactly 1 chat call
        self.assertEqual(mock_chat.call_count, 1)

    def test_long_transcript_routes_to_map_reduce(self):
        """A transcript over threshold must call _map_reduce_streaming, not direct."""
        s = _make_summarizer("llama3.2:3b")
        long_transcript = "Speaker: words.\n" * 3000  # definitely over 26k chars

        with mock.patch.object(s, '_map_reduce_streaming', return_value=iter(["ok"])) as mock_mr:
            with mock.patch.object(s, '_ensure_ollama_ready'):
                list(s.summarize_transcript_streaming(long_transcript))
        mock_mr.assert_called_once()

    def test_no_valueerror_for_long_transcript(self):
        """The PR #246 ValueError must be gone — long transcripts must not raise."""
        s = _make_summarizer("llama3.2:3b")
        long_transcript = "x" * 40000  # over threshold

        with mock.patch.object(s, '_map_reduce_streaming', return_value=iter(["## Summary\nok"])):
            with mock.patch.object(s, '_ensure_ollama_ready'):
                try:
                    list(s.summarize_transcript_streaming(long_transcript))
                except ValueError as e:
                    self.fail(f"summarize_transcript_streaming raised ValueError for long transcript: {e}")


if __name__ == "__main__":
    unittest.main()
