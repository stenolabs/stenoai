"""Tests for the provider-neutral live AskBar query backend."""

import base64
import json
import logging
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from click.testing import CliRunner

_TEST_USER_DATA = tempfile.TemporaryDirectory()
os.environ.setdefault("STENOAI_USER_DATA_DIR", _TEST_USER_DATA.name)

# Backend imports must happen after the user-data override above.
import simple_recorder  # noqa: E402
from simple_recorder import query_live_streaming  # noqa: E402
from src.summarizer import OllamaSummarizer  # noqa: E402


class _Config:
    def get_language(self):
        return "auto"

    def get_ai_provider(self):
        return "cloud"

    def get_model(self):
        return "gpt-4"


class LiveQueryCliTests(unittest.TestCase):
    def _run(
        self,
        *,
        raw_input=None,
        transcript="The team decided to ship on Friday.",
        question="What did we decide?",
        history=None,
        args=None,
        chunks=("They will ", "ship on Friday."),
        stream_error=None,
        config=None,
    ):
        if raw_input is None:
            payload = {"transcript": transcript, "question": question}
            if history is not None:
                payload["history"] = history
            raw_input = json.dumps(payload)

        summarizer = mock.MagicMock()
        if stream_error is None:
            summarizer.query_transcript_streaming_strict.return_value = iter(chunks)
        else:
            summarizer.query_transcript_streaming_strict.side_effect = stream_error

        with (
            mock.patch.object(
                simple_recorder,
                "OllamaSummarizer",
                return_value=summarizer,
            ) as summarizer_class,
            mock.patch("src.config.get_config", return_value=config or _Config()),
            mock.patch.object(
                simple_recorder,
                "resolve_output_language",
                return_value="en",
            ),
        ):
            result = CliRunner().invoke(
                query_live_streaming,
                args or [],
                input=raw_input,
            )

        return result, summarizer_class, summarizer

    def test_is_registered_on_the_cli(self):
        self.assertIn("query-live-streaming", simple_recorder.cli.commands)

    def test_provider_and_model_override_options_are_not_accepted(self):
        for args in (
            ["-q", "What did we decide?"],
            ["--host", "http://127.0.0.1:11443"],
            ["--model", "some-model"],
        ):
            with self.subTest(args=args):
                result, summarizer_class, _ = self._run(args=args)
                self.assertNotEqual(result.exit_code, 0)
                self.assertIn("No such option", result.output)
                summarizer_class.assert_not_called()

    def test_uses_configured_summarizer_and_strict_stream_with_zero_overrides(self):
        transcript = "  The team voted to release on Friday.  "
        question = "  When is the release?  "
        chunks = ("Friday ", "afternoon.")

        result, summarizer_class, summarizer = self._run(
            transcript=transcript,
            question=question,
            chunks=chunks,
        )

        self.assertEqual(result.exit_code, 0, result.output)
        summarizer_class.assert_called_once_with()
        summarizer.query_transcript_streaming_strict.assert_called_once_with(
            transcript.strip(),
            question.strip(),
            language="en",
            history=None,
        )

        lines = result.output.splitlines()
        encoded_chunks = [
            line.removeprefix("CHAT_CHUNK:")
            for line in lines
            if line.startswith("CHAT_CHUNK:")
        ]
        self.assertEqual(
            [base64.b64decode(value).decode("utf-8") for value in encoded_chunks],
            list(chunks),
        )
        self.assertEqual(lines[-1], "CHAT_STREAM_COMPLETE")

    def test_invalid_payloads_fail_before_constructing_a_summarizer(self):
        cases = (
            ("", "Empty live transcript"),
            ("  \n", "Empty live transcript"),
            ("{not-json}", "Invalid live query payload"),
            (json.dumps(["not", "an", "object"]), "Invalid live query payload"),
            (
                json.dumps({"transcript": "  ", "question": "valid"}),
                "Empty live transcript",
            ),
            (
                json.dumps({"transcript": "valid", "question": "  "}),
                "Empty live query question",
            ),
        )
        for raw_input, expected in cases:
            with self.subTest(expected=expected):
                result, summarizer_class, _ = self._run(raw_input=raw_input)
                self.assertNotEqual(result.exit_code, 0)
                self.assertIn(f"CHAT_STREAM_ERROR:{expected}", result.output)
                self.assertNotIn("CHAT_STREAM_COMPLETE", result.output)
                summarizer_class.assert_not_called()

    def test_question_character_limit_is_still_a_hard_failure(self):
        result, summarizer_class, _ = self._run(
            raw_input=json.dumps(
                {"transcript": "A", "question": "Q" * 2_001}
            )
        )
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn(
            "CHAT_STREAM_ERROR:Live query question exceeds maximum length",
            result.output,
        )
        summarizer_class.assert_not_called()

    def test_over_budget_transcript_is_trimmed_oldest_first(self):
        lines = [f"OLD-{i:04d} " + ("x" * 40) for i in range(20)]
        lines.append("NEWEST-LINE the decision was Friday")
        transcript = "\n".join(lines)
        budget = 180
        with mock.patch.object(
            simple_recorder, "_live_query_transcript_budget", return_value=budget
        ):
            result, summarizer_class, summarizer = self._run(
                transcript=transcript, question="What?"
            )
        self.assertEqual(result.exit_code, 0, result.output)
        summarizer_class.assert_called_once_with()
        called = summarizer.query_transcript_streaming_strict.call_args
        trimmed = called.args[0]
        self.assertTrue(
            trimmed.startswith("[earlier transcript omitted]\n"),
            trimmed[:80],
        )
        self.assertIn("NEWEST-LINE the decision was Friday", trimmed)
        self.assertNotIn("OLD-0000", trimmed)
        self.assertLessEqual(len(trimmed), budget)
        self.assertNotIn("CHAT_STREAM_ERROR", result.output)

    def test_stdin_limit_is_measured_in_utf8_bytes(self):
        raw_input = json.dumps(
            {
                "transcript": "valid",
                "question": "Q",
                "padding": "界" * 350_000,
            },
            ensure_ascii=False,
        )
        self.assertGreater(
            len(raw_input.encode("utf-8")),
            simple_recorder.MAX_LIVE_QUERY_STDIN_BYTES,
        )

        result, summarizer_class, _ = self._run(raw_input=raw_input)

        self.assertNotEqual(result.exit_code, 0)
        self.assertIn(
            "CHAT_STREAM_ERROR:Live query payload exceeds maximum length",
            result.output,
        )
        summarizer_class.assert_not_called()

    def test_provider_failure_emits_only_fixed_error_and_restores_logging(self):
        transcript = "SECRET_TRANSCRIPT the budget was cut"
        question = "SECRET_QUESTION by how much?"
        provider_error = RuntimeError(
            "SECRET_PROVIDER_ERROR containing prompt and endpoint details"
        )
        records = []

        class _Capture(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        handler = _Capture()
        root = logging.getLogger()
        root.addHandler(handler)
        previous_disable = logging.root.manager.disable
        try:
            result, summarizer_class, summarizer = self._run(
                transcript=transcript,
                question=question,
                stream_error=provider_error,
            )
        finally:
            root.removeHandler(handler)

        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(
            result.output.strip(),
            "CHAT_STREAM_ERROR:Live query failed",
        )
        self.assertNotIn("CHAT_STREAM_COMPLETE", result.output)
        self.assertNotIn("SECRET_", result.output)
        self.assertEqual(records, [])
        self.assertEqual(logging.root.manager.disable, previous_disable)
        summarizer_class.assert_called_once_with()
        summarizer.query_transcript_streaming_strict.assert_called_once()

    def test_answer_exceeding_one_mib_fails_without_completion(self):
        chunks = ("X" * (512 * 1024), "Y" * (512 * 1024 + 1))

        result, _, _ = self._run(chunks=chunks)

        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("CHAT_CHUNK:", result.output)
        self.assertIn("CHAT_STREAM_ERROR:Live query failed", result.output)
        self.assertNotIn("CHAT_STREAM_COMPLETE", result.output)

    def test_non_text_provider_chunk_fails_closed(self):
        result, _, _ = self._run(chunks=("valid", b"not text"))

        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("CHAT_STREAM_ERROR:Live query failed", result.output)
        self.assertNotIn("CHAT_STREAM_COMPLETE", result.output)

    def test_history_is_forwarded_to_the_strict_stream(self):
        history = [
            {"role": "user", "content": "What was the deadline?"},
            {"role": "assistant", "content": "Friday."},
        ]
        result, _, summarizer = self._run(history=history)
        self.assertEqual(result.exit_code, 0, result.output)
        summarizer.query_transcript_streaming_strict.assert_called_once_with(
            "The team decided to ship on Friday.",
            "What did we decide?",
            language="en",
            history=history,
        )

    def test_empty_history_list_is_forwarded_as_empty(self):
        result, _, summarizer = self._run(history=[])
        self.assertEqual(result.exit_code, 0, result.output)
        summarizer.query_transcript_streaming_strict.assert_called_once_with(
            "The team decided to ship on Friday.",
            "What did we decide?",
            language="en",
            history=[],
        )

    def test_history_keeps_newest_six_entries(self):
        history = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"turn-{i}"}
            for i in range(7)
        ]
        result, _, summarizer = self._run(history=history)
        self.assertEqual(result.exit_code, 0, result.output)
        forwarded = summarizer.query_transcript_streaming_strict.call_args.kwargs[
            "history"
        ]
        self.assertEqual([e["content"] for e in forwarded], [f"turn-{i}" for i in range(1, 7)])

    def test_history_drops_oldest_to_fit_total_char_cap(self):
        history = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": "x" * 3000}
            for i in range(6)
        ]
        result, _, summarizer = self._run(history=history)
        self.assertEqual(result.exit_code, 0, result.output)
        forwarded = summarizer.query_transcript_streaming_strict.call_args.kwargs[
            "history"
        ]
        self.assertEqual(len(forwarded), 4)
        self.assertLessEqual(sum(len(e["content"]) for e in forwarded), 12000)
        self.assertEqual(forwarded[0]["content"], "x" * 3000)

    def test_history_entry_over_4000_chars_is_rejected(self):
        history = [{"role": "user", "content": "y" * 4001}]
        result, summarizer_class, _ = self._run(history=history)
        self.assertNotEqual(result.exit_code, 0)
        self.assertEqual(
            result.output.strip(),
            "CHAT_STREAM_ERROR:Invalid live query payload",
        )
        self.assertNotIn("yyyy", result.output)
        summarizer_class.assert_not_called()

    def test_malformed_history_is_rejected_with_fixed_error(self):
        cases = (
            {"transcript": "valid", "question": "Q", "history": "not-a-list"},
            {"transcript": "valid", "question": "Q", "history": [{"role": "system", "content": "x"}]},
            {"transcript": "valid", "question": "Q", "history": [{"role": "user", "content": 12}]},
            {"transcript": "valid", "question": "Q", "history": ["bare-string"]},
        )
        for payload in cases:
            with self.subTest(history=payload["history"]):
                result, summarizer_class, _ = self._run(
                    raw_input=json.dumps(payload)
                )
                self.assertNotEqual(result.exit_code, 0)
                self.assertEqual(
                    result.output.strip(),
                    "CHAT_STREAM_ERROR:Invalid live query payload",
                )
                self.assertNotIn("CHAT_STREAM_COMPLETE", result.output)
                summarizer_class.assert_not_called()

    def test_apple_system_budget_is_smaller_than_local_gguf(self):
        apple = simple_recorder._live_query_transcript_budget("local", "apple:system")
        gguf = simple_recorder._live_query_transcript_budget(
            "local", "gemma4:e2b-it-qat"
        )
        cloud = simple_recorder._live_query_transcript_budget("cloud", "gpt-4")
        self.assertGreater(apple, 0)
        self.assertGreater(gguf, 0)
        self.assertLess(apple, gguf)
        self.assertEqual(cloud, 400_000)


class QueryPromptHistoryTests(unittest.TestCase):
    def _prompt(self, **kwargs):
        summarizer = object.__new__(OllamaSummarizer)
        summarizer.ollama_process = None
        return summarizer._build_query_prompt(
            "TRANSCRIPT_BODY",
            "What did we decide?",
            **kwargs,
        )

    def test_absent_or_empty_history_is_byte_identical(self):
        baseline = self._prompt()
        self.assertEqual(baseline, self._prompt(history=None))
        self.assertEqual(baseline, self._prompt(history=[]))
        self.assertNotIn("PREVIOUS QUESTIONS", baseline)
        self.assertIn("QUESTION: What did we decide?", baseline)
        self.assertIn("TRANSCRIPT_BODY", baseline)

    def test_query_prompt_contains_transcript_header_and_no_parroting_refusal(self):
        prompt = self._prompt()
        self.assertIn("TRANSCRIPT:\nTRANSCRIPT_BODY", prompt)
        self.assertIn(
            "If the transcript below contains no speech, reply that there is no meeting content yet.",
            prompt,
        )
        self.assertNotIn("Only say you don't know", prompt)
        self.assertNotIn("topic truly wasn't discussed", prompt)

    def test_history_renders_in_order_between_question_and_transcript(self):
        prompt = self._prompt(
            history=[
                {"role": "user", "content": "first question"},
                {"role": "assistant", "content": "first answer"},
                {"role": "user", "content": "follow up"},
                {"role": "assistant", "content": "follow answer"},
            ]
        )
        question_at = prompt.index("QUESTION: What did we decide?")
        history_at = prompt.index(
            "PREVIOUS QUESTIONS AND ANSWERS IN THIS CONVERSATION:"
        )
        transcript_at = prompt.index("TRANSCRIPT_BODY")
        self.assertLess(question_at, history_at)
        self.assertLess(history_at, transcript_at)
        self.assertLess(
            prompt.index("Q: first question"), prompt.index("A: first answer")
        )
        self.assertLess(
            prompt.index("A: first answer"), prompt.index("Q: follow up")
        )
        self.assertLess(
            prompt.index("Q: follow up"), prompt.index("A: follow answer")
        )



class StrictQueryStreamingTests(unittest.TestCase):
    def test_strict_stream_propagates_provider_errors(self):
        summarizer = object.__new__(OllamaSummarizer)
        summarizer.ollama_process = None
        summarizer.ai_provider = "adapter"
        summarizer._build_query_prompt = mock.MagicMock(return_value="prompt")
        summarizer._adapter_stream = mock.MagicMock(
            side_effect=RuntimeError("provider unavailable")
        )

        with self.assertRaisesRegex(RuntimeError, "provider unavailable"):
            list(
                summarizer.query_transcript_streaming_strict(
                    "transcript",
                    "question",
                )
            )
        summarizer._adapter_stream.assert_called_once_with(
            "prompt",
            timeout_seconds=300,
        )

    def test_strict_stream_forwards_history_into_the_prompt(self):
        summarizer = object.__new__(OllamaSummarizer)
        summarizer.ollama_process = None
        summarizer.ai_provider = "adapter"
        summarizer._build_query_prompt = mock.MagicMock(return_value="prompt")
        summarizer._adapter_stream = mock.MagicMock(return_value=iter(["ok"]))
        history = [{"role": "user", "content": "earlier"}]

        list(
            summarizer.query_transcript_streaming_strict(
                "transcript",
                "question",
                history=history,
            )
        )

        summarizer._build_query_prompt.assert_called_once_with(
            "transcript", "question", "en", history=history
        )


    def test_strict_stream_uses_configured_local_or_remote_ollama(self):
        for provider in ("local", "remote"):
            with self.subTest(provider=provider):
                summarizer = object.__new__(OllamaSummarizer)
                summarizer.ollama_process = None
                summarizer.ai_provider = provider
                summarizer.model_name = "configured-model"
                summarizer.remote_url = "https://configured.example"
                summarizer._build_query_prompt = mock.MagicMock(
                    return_value="prompt"
                )
                summarizer._ensure_ollama_ready = mock.MagicMock()
                summarizer._ollama_options = mock.MagicMock(
                    return_value={"num_ctx": 8192}
                )
                fake_ollama = mock.MagicMock()
                client = mock.MagicMock()
                client.chat.return_value = iter(
                    [{"message": {"content": "configured answer"}}]
                )
                fake_ollama.Client.return_value = client

                with mock.patch("src.summarizer.ollama", fake_ollama):
                    chunks = list(
                        summarizer.query_transcript_streaming_strict(
                            "transcript",
                            "question",
                        )
                    )

                self.assertEqual(chunks, ["configured answer"])
                expected_client_args = (
                    {"host": "https://configured.example"}
                    if provider == "remote"
                    else {}
                )
                fake_ollama.Client.assert_called_once_with(**expected_client_args)
                if provider == "remote":
                    summarizer._ensure_ollama_ready.assert_not_called()
                else:
                    summarizer._ensure_ollama_ready.assert_called_once_with()
                client.chat.assert_called_once_with(
                    model="configured-model",
                    messages=[{"role": "user", "content": "prompt"}],
                    stream=True,
                    options={"num_ctx": 8192},
                )

    def test_strict_stream_uses_configured_openai_compatible_provider(self):
        summarizer = object.__new__(OllamaSummarizer)
        summarizer.ollama_process = None
        summarizer.ai_provider = "cloud"
        summarizer.cloud_provider = "openai"
        summarizer.model_name = "configured-cloud-model"
        summarizer._build_query_prompt = mock.MagicMock(return_value="prompt")
        summarizer.cloud_client = mock.MagicMock()
        summarizer.cloud_client.chat.completions.create.return_value = [
            SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        delta=SimpleNamespace(content="cloud answer")
                    )
                ]
            ),
            SimpleNamespace(choices=[]),
        ]

        chunks = list(
            summarizer.query_transcript_streaming_strict(
                "transcript",
                "question",
            )
        )

        self.assertEqual(chunks, ["cloud answer"])
        summarizer.cloud_client.chat.completions.create.assert_called_once_with(
            model="configured-cloud-model",
            messages=[{"role": "user", "content": "prompt"}],
            stream=True,
        )

    def test_legacy_stream_keeps_inline_error_contract(self):
        summarizer = object.__new__(OllamaSummarizer)
        summarizer.ollama_process = None
        summarizer.query_transcript_streaming_strict = mock.MagicMock(
            side_effect=RuntimeError("provider unavailable")
        )

        with self.assertLogs("src.summarizer", level="ERROR"):
            chunks = list(
                summarizer.query_transcript_streaming(
                    "transcript",
                    "question",
                )
            )

        self.assertEqual(chunks, ["\n[Error: provider unavailable]"])

class FinishedNoteQueryBudgetTests(unittest.TestCase):
    def setUp(self):
        self.runner = CliRunner()
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def _make_config(self, model="apple:system", provider="local"):
        cfg = mock.MagicMock()
        cfg.get_model.return_value = model
        cfg.get_ai_provider.return_value = provider
        cfg.get_language.return_value = "en"
        cfg.get_language_name.return_value = "English"
        return cfg

    def test_finished_note_query_streaming_trims_over_budget_apple_system(self):
        """Over-budget note transcript is trimmed newest-first with omission marker."""
        large_text = "\n".join(f"Line {i:04d}: discussing point number {i} in detail." for i in range(1500))
        self.assertGreater(len(large_text), 50_000)
        note_file = os.path.join(self.temp_dir.name, "large_note.txt")
        with open(note_file, "w", encoding="utf-8") as f:
            f.write(large_text)

        captured_transcripts = []

        def _mock_query_streaming(transcript, question, language="en", history=None):
            captured_transcripts.append(transcript)
            yield "Answer chunk"

        mock_summarizer = mock.MagicMock()
        mock_summarizer.query_transcript_streaming.side_effect = _mock_query_streaming

        cfg = self._make_config(model="apple:system", provider="local")
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch("simple_recorder.OllamaSummarizer", return_value=mock_summarizer):
            res = self.runner.invoke(
                simple_recorder.cli,
                ["query-streaming", note_file, "-q", "What were the decisions?"],
            )

        self.assertEqual(res.exit_code, 0)
        self.assertEqual(len(captured_transcripts), 1)
        passed_transcript = captured_transcripts[0]
        budget = simple_recorder._live_query_transcript_budget("local", "apple:system")
        self.assertLessEqual(len(passed_transcript), budget)
        self.assertTrue(passed_transcript.startswith("[earlier transcript omitted]\n"))
        self.assertIn("Line 1499", passed_transcript)
        self.assertNotIn("Line 0001:", passed_transcript)

    def test_finished_note_query_streaming_leaves_small_note_untouched(self):
        """Small note transcript within budget is passed untouched byte-for-byte."""
        small_text = "Alice: We decided to deploy AFM.\nBob: Sounds good."
        note_file = os.path.join(self.temp_dir.name, "small_note.txt")
        with open(note_file, "w", encoding="utf-8") as f:
            f.write(small_text)

        captured_transcripts = []

        def _mock_query_streaming(transcript, question, language="en", history=None):
            captured_transcripts.append(transcript)
            yield "Answer chunk"

        mock_summarizer = mock.MagicMock()
        mock_summarizer.query_transcript_streaming.side_effect = _mock_query_streaming

        cfg = self._make_config(model="apple:system", provider="local")
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch("simple_recorder.OllamaSummarizer", return_value=mock_summarizer):
            res = self.runner.invoke(
                simple_recorder.cli,
                ["query-streaming", note_file, "-q", "What did Alice say?"],
            )

        self.assertEqual(res.exit_code, 0)
        self.assertEqual(len(captured_transcripts), 1)
        passed_transcript = captured_transcripts[0]
        self.assertEqual(passed_transcript, small_text)
        self.assertNotIn("[earlier transcript omitted]", passed_transcript)

    def test_finished_note_query_non_streaming_trims_over_budget(self):
        """Non-streaming query command also trims over-budget transcript."""
        large_text = "\n".join(f"Line {i:04d}: discussing topic {i}" for i in range(1200))
        note_file = os.path.join(self.temp_dir.name, "large_note_sync.txt")
        with open(note_file, "w", encoding="utf-8") as f:
            f.write(large_text)

        captured_transcripts = []

        def _mock_query(transcript, question, language="en", history=None):
            captured_transcripts.append(transcript)
            return "Sync answer"

        mock_summarizer = mock.MagicMock()
        mock_summarizer.query_transcript.side_effect = _mock_query

        cfg = self._make_config(model="apple:system", provider="local")
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch("simple_recorder.OllamaSummarizer", return_value=mock_summarizer):
            res = self.runner.invoke(
                simple_recorder.cli,
                ["query", note_file, "-q", "Summary of topics?"],
            )

        self.assertEqual(res.exit_code, 0)
        self.assertEqual(len(captured_transcripts), 1)
        passed_transcript = captured_transcripts[0]
        budget = simple_recorder._live_query_transcript_budget("local", "apple:system")
        self.assertLessEqual(len(passed_transcript), budget)
        self.assertTrue(passed_transcript.startswith("[earlier transcript omitted]\n"))


if __name__ == "__main__":
    unittest.main()
