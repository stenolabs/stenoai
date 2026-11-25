"""Bedrock ``converse-stream`` tests with a mocked ``urllib.request.urlopen``.

Validated against hand-framed event streams, not a live AWS account: the
event payload shapes follow the ConverseStream API reference
(messageStart / contentBlockStart / contentBlockDelta / contentBlockStop /
messageStop / metadata).
"""

import io
import json
import types
import unittest
import urllib.error
from unittest import mock

from src import chat_agent
from src.ai_errors import classify_ai_error
from src.aws_eventstream import EventStreamError, encode_message
from src.config import Config
from src.summarizer import (
    BEDROCK_STREAM_FALLBACK_STATUSES,
    BedrockStreamingUnsupported,
    OllamaSummarizer,
    bedrock_converse_stream_events,
)

PRIVATE = "the transcript said something confidential"


def _event(event_type, obj):
    return encode_message(
        {":event-type": event_type, ":content-type": "application/json", ":message-type": "event"},
        json.dumps(obj).encode(),
    )


def _exception(exception_type, obj):
    return encode_message(
        {":exception-type": exception_type, ":content-type": "application/json", ":message-type": "exception"},
        json.dumps(obj).encode(),
    )


def _text_stream(pieces):
    frames = [_event("messageStart", {"role": "assistant"})]
    frames += [_event("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": p}}) for p in pieces]
    frames += [
        _event("contentBlockStop", {"contentBlockIndex": 0}),
        _event("messageStop", {"stopReason": "end_turn"}),
        _event("metadata", {"usage": {"inputTokens": 1, "outputTokens": 2}, "metrics": {"latencyMs": 3}}),
    ]
    return b"".join(frames)


class FakeResponse(io.BytesIO):
    """An http.client-like response: context manager + read1 in small slices."""

    def __init__(self, data, slice_size=5):
        super().__init__(data)
        self.slice_size = slice_size
        self.headers = {}

    def read1(self, size=-1):
        return super().read(min(size if size > 0 else self.slice_size, self.slice_size))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def _http_error(url, code, error_type=None, body=PRIVATE):
    headers = {"x-amzn-ErrorType": f"{error_type}:http://internal.amazon.com/coral/"} if error_type else {}
    return urllib.error.HTTPError(url, code, "nope", headers, io.BytesIO(body.encode()))


def _converse_json(text="whole answer", tool_use=None):
    content = [{"text": text}] if text else []
    if tool_use:
        content.append({"toolUse": tool_use})
    return json.dumps({"output": {"message": {"role": "assistant", "content": content}}}).encode()


def _make_summarizer():
    with mock.patch.object(OllamaSummarizer, "_ensure_ollama_ready", return_value=True):
        s = OllamaSummarizer(model_name="anthropic.claude-haiku-4-5-20251001-v1:0", ai_provider="local", config=Config())
    s.ai_provider = "cloud"
    s.cloud_provider = "bedrock"
    s.bedrock_api_key = "bedrock-key"
    s.bedrock_region = "us-east-1"
    s.bedrock_inference_profile = ""
    return s


class ConverseStreamTransportTests(unittest.TestCase):
    def test_posts_to_converse_stream_with_bearer_auth_and_yields_events(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["headers"] = {k.lower(): v for k, v in req.header_items()}
            captured["body"] = json.loads(req.data.decode())
            captured["timeout"] = timeout
            return FakeResponse(_text_stream(["Hel", "lo"]))

        body = {"messages": [{"role": "user", "content": [{"text": "hi"}]}]}
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            events = list(bedrock_converse_stream_events("eu-west-2", "arn:aws:bedrock:eu-west-2:1:application-inference-profile/abc", "k", body, 42))
        self.assertEqual(
            captured["url"],
            "https://bedrock-runtime.eu-west-2.amazonaws.com/model/"
            "arn%3Aaws%3Abedrock%3Aeu-west-2%3A1%3Aapplication-inference-profile%2Fabc/converse-stream",
        )
        self.assertEqual(captured["headers"]["authorization"], "Bearer k")
        self.assertEqual(captured["headers"]["accept"], "application/vnd.amazon.eventstream")
        self.assertEqual(captured["body"], body)
        self.assertEqual(captured["timeout"], 42)
        self.assertEqual([k for k, _ in events],
                         ["messageStart", "contentBlockDelta", "contentBlockDelta", "contentBlockStop", "messageStop", "metadata"])
        self.assertEqual(events[1][1]["delta"]["text"], "Hel")

    def test_fallback_statuses_raise_unsupported_before_any_event(self):
        for code in sorted(BEDROCK_STREAM_FALLBACK_STATUSES):
            with mock.patch("urllib.request.urlopen", side_effect=_http_error("u", code, "ValidationException")):
                with self.assertRaises(BedrockStreamingUnsupported) as ctx:
                    next(bedrock_converse_stream_events("us-east-1", "m", "k", {}, 10))
            self.assertEqual(ctx.exception.status, code)
            self.assertEqual(ctx.exception.error_type, "ValidationException")
            self.assertNotIn(PRIVATE, str(ctx.exception))

    def test_other_http_errors_raise_classifiable_runtime_error_without_body(self):
        for code, expected in ((401, "auth"), (429, "rate-limit"), (500, "unknown"), (503, "rate-limit")):
            with mock.patch("urllib.request.urlopen", side_effect=_http_error("u", code)):
                with self.assertRaises(RuntimeError) as ctx:
                    next(bedrock_converse_stream_events("us-east-1", "m", "k", {}, 10))
            self.assertNotIsInstance(ctx.exception, BedrockStreamingUnsupported)
            self.assertNotIn(PRIVATE, str(ctx.exception))
            self.assertEqual(classify_ai_error(ctx.exception, "cloud"), expected, code)

    def test_mid_stream_exception_raises_without_body(self):
        data = _event("contentBlockDelta", {"delta": {"text": "partial"}}) + _exception("throttlingException", {"message": PRIVATE})
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(data)):
            events = bedrock_converse_stream_events("us-east-1", "m", "k", {}, 10)
            self.assertEqual(next(events)[1]["delta"]["text"], "partial")
            with self.assertRaises(EventStreamError) as ctx:
                next(events)
        self.assertNotIn(PRIVATE, str(ctx.exception))
        self.assertEqual(classify_ai_error(ctx.exception, "cloud"), "rate-limit")


class SummarizerBedrockStreamTests(unittest.TestCase):
    def test_stream_chat_prompt_yields_text_pieces(self):
        s = _make_summarizer()
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(_text_stream(["One ", "two ", "three"]))) as uo:
            pieces = list(s.stream_chat_prompt("question"))
        self.assertEqual(pieces, ["One ", "two ", "three"])
        req = uo.call_args.args[0]
        self.assertTrue(req.full_url.endswith("/anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream"))
        self.assertEqual(uo.call_args.kwargs["timeout"], 300)
        self.assertEqual(json.loads(req.data.decode())["messages"][0]["content"][0]["text"], "question")

    def test_stream_completion_summary_path_streams_with_long_timeout(self):
        s = _make_summarizer()
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(_text_stream(["## Summary\n", "- ok"]))) as uo:
            pieces = list(s._stream_completion("summarise"))
        self.assertEqual(pieces, ["## Summary\n", "- ok"])
        self.assertEqual(uo.call_args.kwargs["timeout"], 7200)

    def test_inference_profile_wins_in_stream_url(self):
        s = _make_summarizer()
        s.bedrock_inference_profile = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(_text_stream(["x"]))) as uo:
            list(s.stream_chat_prompt("q"))
        self.assertIn("/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream", uo.call_args.args[0].full_url)

    def test_falls_back_to_converse_when_streaming_is_unsupported(self):
        s = _make_summarizer()
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            if req.full_url.endswith("/converse-stream"):
                raise _http_error(req.full_url, 400, "ValidationException")
            return FakeResponse(_converse_json("whole answer"))

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            pieces = list(s.stream_chat_prompt("q"))
        self.assertEqual(pieces, ["whole answer"])
        self.assertEqual([u.rsplit("/", 1)[1] for u in urls], ["converse-stream", "converse"])

    def test_fallback_surfaces_converse_error_when_both_fail(self):
        s = _make_summarizer()

        def fake_urlopen(req, timeout=None):
            raise _http_error(req.full_url, 403, "AccessDeniedException")

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            with self.assertRaises(RuntimeError) as ctx:
                list(s.stream_chat_prompt("q"))
        self.assertIn("rejected the API key", str(ctx.exception))
        self.assertEqual(classify_ai_error(ctx.exception, "cloud"), "auth")

    def test_bad_key_does_not_fall_back(self):
        s = _make_summarizer()
        with mock.patch("urllib.request.urlopen", side_effect=_http_error("u", 401)) as uo:
            with self.assertRaises(RuntimeError) as ctx:
                list(s.stream_chat_prompt("q"))
        self.assertEqual(uo.call_count, 1)
        self.assertNotIn(PRIVATE, str(ctx.exception))

    def test_empty_stream_raises(self):
        s = _make_summarizer()
        data = _event("messageStart", {"role": "assistant"}) + _event("messageStop", {"stopReason": "end_turn"})
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(data)):
            with self.assertRaises(RuntimeError) as ctx:
                list(s.stream_chat_prompt("q"))
        self.assertIn("empty", str(ctx.exception))

    def test_missing_key_is_reported_before_any_request(self):
        s = _make_summarizer()
        s.bedrock_api_key = None
        with mock.patch("urllib.request.urlopen") as uo:
            with self.assertRaises(RuntimeError):
                list(s.stream_chat_prompt("q"))
        uo.assert_not_called()


def _fn(**kw):
    return types.SimpleNamespace(**kw)


PARTS = {"instructions": "Be helpful.", "scope": "notes", "context": "CTX", "history": "", "question": "Make an issue"}
TOOLS = [{"name": "linear__create_issue", "description": "Create", "parameters": {"type": "object"}}]


def _agent_summarizer():
    return _fn(ai_provider="cloud", cloud_provider="bedrock", model_name="m",
               bedrock_region="us-east-1", bedrock_api_key="k", bedrock_inference_profile="")


class ChatAgentBedrockStepTests(unittest.TestCase):
    def test_streams_text_and_assembles_tool_use_from_input_deltas(self):
        data = b"".join([
            _event("messageStart", {"role": "assistant"}),
            _event("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": "On "}}),
            _event("contentBlockDelta", {"contentBlockIndex": 0, "delta": {"text": "it."}}),
            _event("contentBlockStop", {"contentBlockIndex": 0}),
            _event("contentBlockStart", {"contentBlockIndex": 1,
                                         "start": {"toolUse": {"toolUseId": "t1", "name": "linear__create_issue"}}}),
            _event("contentBlockDelta", {"contentBlockIndex": 1, "delta": {"toolUse": {"input": '{"tit'}}}),
            _event("contentBlockDelta", {"contentBlockIndex": 1, "delta": {"toolUse": {"input": 'le": "C"}'}}}),
            _event("contentBlockStop", {"contentBlockIndex": 1}),
            _event("messageStop", {"stopReason": "tool_use"}),
            _event("metadata", {"usage": {}}),
        ])
        pieces = []
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(data)) as uo:
            out = chat_agent.run_step({"tools": TOOLS, "turns": []}, _agent_summarizer(), PARTS, pieces.append)
        self.assertEqual(pieces, ["On ", "it."])
        self.assertEqual(out["text"], "On it.")
        self.assertEqual(out["tool_calls"], [{"id": "t1", "name": "linear__create_issue", "arguments": {"title": "C"}}])
        req = uo.call_args.args[0]
        self.assertTrue(req.full_url.endswith("/m/converse-stream"))
        sent = json.loads(req.data.decode())
        self.assertEqual(sent["toolConfig"]["tools"][0]["toolSpec"]["name"], "linear__create_issue")
        self.assertEqual(sent["system"][0]["text"][:11], "Be helpful.")

    def test_tool_turns_are_sent_as_tool_result_blocks(self):
        turns = [
            {"type": "assistant", "text": "", "tool_calls": [{"id": "c1", "name": "linear__create_issue", "arguments": {"title": "A"}}]},
            {"type": "tool_result", "id": "c1", "name": "linear__create_issue", "content": "Created ABC-1"},
        ]
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(_text_stream(["Done"]))) as uo:
            out = chat_agent.run_step({"tools": TOOLS, "turns": turns}, _agent_summarizer(), PARTS)
        self.assertEqual(out, {"text": "Done", "tool_calls": []})
        sent = json.loads(uo.call_args.args[0].data.decode())
        self.assertEqual(sent["messages"][1]["content"][0]["toolUse"]["toolUseId"], "c1")
        self.assertEqual(sent["messages"][2]["content"][0]["toolResult"]["content"], [{"text": "Created ABC-1"}])

    def test_falls_back_to_converse_when_streaming_is_unsupported(self):
        urls = []

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            if req.full_url.endswith("/converse-stream"):
                raise _http_error(req.full_url, 403, "AccessDeniedException")
            return FakeResponse(_converse_json("Sure.", {"toolUseId": "t9", "name": "linear__create_issue", "input": {"title": "D"}}))

        pieces = []
        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            out = chat_agent.run_step({"tools": TOOLS, "turns": []}, _agent_summarizer(), PARTS, pieces.append)
        self.assertEqual([u.rsplit("/", 1)[1] for u in urls], ["converse-stream", "converse"])
        self.assertEqual(pieces, ["Sure."])
        self.assertEqual(out["tool_calls"], [{"id": "t9", "name": "linear__create_issue", "arguments": {"title": "D"}}])

    def test_stream_exception_propagates_classifiable(self):
        data = _event("messageStart", {"role": "assistant"}) + _exception("modelTimeoutException", {"message": PRIVATE})
        with mock.patch("urllib.request.urlopen", return_value=FakeResponse(data)):
            with self.assertRaises(EventStreamError) as ctx:
                chat_agent.run_step({"tools": [], "turns": []}, _agent_summarizer(), PARTS)
        self.assertEqual(classify_ai_error(ctx.exception, "cloud"), "timeout")
        self.assertNotIn(PRIVATE, str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
