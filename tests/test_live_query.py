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


class LiveQueryCliTests(unittest.TestCase):
    def _run(
        self,
        *,
        raw_input=None,
        transcript="The team decided to ship on Friday.",
        question="What did we decide?",
        args=None,
        chunks=("They will ", "ship on Friday."),
        stream_error=None,
    ):
        if raw_input is None:
            raw_input = json.dumps(
                {"transcript": transcript, "question": question}
            )

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
            mock.patch("src.config.get_config", return_value=_Config()),
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

    def test_transcript_and_question_character_limits(self):
        cases = (
            (
                {"transcript": "A" * 100_001, "question": "Q"},
                "Live transcript exceeds maximum length",
            ),
            (
                {"transcript": "A", "question": "Q" * 2_001},
                "Live query question exceeds maximum length",
            ),
        )
        for payload, expected in cases:
            with self.subTest(expected=expected):
                result, summarizer_class, _ = self._run(
                    raw_input=json.dumps(payload)
                )
                self.assertNotEqual(result.exit_code, 0)
                self.assertIn(f"CHAT_STREAM_ERROR:{expected}", result.output)
                summarizer_class.assert_not_called()

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


if __name__ == "__main__":
    unittest.main()
