"""AI failure classification: stable codes from types/statuses, never from text."""
import io
import json
import socket
import unittest
import urllib.error
from unittest.mock import Mock, patch

from src.ai_errors import (
    ContextTooLargeError, ModelNotAvailableError, OllamaNotRunningError, classify_ai_error,
)

PRIVATE = 'PRIVATE MEETING TEXT: the merger closes Friday'

try:
    import httpx
except ImportError:  # pragma: no cover - httpx ships with openai/anthropic/ollama
    httpx = None


def _response(status):
    request = httpx.Request('POST', 'https://api.example.test/v1/chat')
    return httpx.Response(status, request=request, json={'error': {'message': PRIVATE}})


@unittest.skipIf(httpx is None, 'httpx not installed')
class OpenAiErrorTests(unittest.TestCase):
    def setUp(self):
        try:
            import openai
        except ImportError:
            self.skipTest('openai not installed')
        self.openai = openai

    def test_status_errors(self):
        o = self.openai
        cases = [
            (o.AuthenticationError(PRIVATE, response=_response(401), body=None), 'auth'),
            (o.PermissionDeniedError(PRIVATE, response=_response(403), body=None), 'auth'),
            (o.RateLimitError(PRIVATE, response=_response(429), body=None), 'rate-limit'),
            (o.NotFoundError(PRIVATE, response=_response(404), body=None), 'model-missing'),
        ]
        for exc, code in cases:
            self.assertEqual(classify_ai_error(exc, 'cloud'), code, type(exc).__name__)

    def test_quota_is_told_apart_from_rate_limit_by_error_code(self):
        exc = self.openai.RateLimitError(
            PRIVATE, response=_response(429),
            body={'message': PRIVATE, 'type': 'insufficient_quota', 'code': 'insufficient_quota'})
        self.assertEqual(classify_ai_error(exc, 'cloud'), 'quota')

    def test_402_is_quota(self):
        exc = self.openai.APIStatusError(PRIVATE, response=_response(402), body=None)
        self.assertEqual(classify_ai_error(exc, 'cloud'), 'quota')

    def test_context_length_code(self):
        exc = self.openai.BadRequestError(
            PRIVATE, response=_response(400), body={'code': 'context_length_exceeded', 'message': PRIVATE})
        self.assertEqual(classify_ai_error(exc, 'cloud'), 'context-too-long')

    def test_connection_and_timeout(self):
        request = httpx.Request('POST', 'https://api.example.test')
        self.assertEqual(classify_ai_error(self.openai.APIConnectionError(request=request), 'cloud'), 'network')
        self.assertEqual(classify_ai_error(self.openai.APITimeoutError(request=request), 'cloud'), 'timeout')

    def test_plain_400_is_unknown(self):
        exc = self.openai.BadRequestError(PRIVATE, response=_response(400), body=None)
        self.assertEqual(classify_ai_error(exc, 'cloud'), 'unknown')


@unittest.skipIf(httpx is None, 'httpx not installed')
class AnthropicErrorTests(unittest.TestCase):
    def setUp(self):
        try:
            import anthropic
        except ImportError:
            self.skipTest('anthropic not installed')
        self.anthropic = anthropic

    def test_status_errors_and_types(self):
        a = self.anthropic
        self.assertEqual(classify_ai_error(a.AuthenticationError(PRIVATE, response=_response(401), body=None)), 'auth')
        self.assertEqual(classify_ai_error(a.RateLimitError(PRIVATE, response=_response(429), body=None)), 'rate-limit')
        body = {'type': 'error', 'error': {'type': 'billing_error', 'message': PRIVATE}}
        self.assertEqual(classify_ai_error(a.APIStatusError(PRIVATE, response=_response(400), body=body)), 'quota')
        self.assertEqual(classify_ai_error(a.APIStatusError(PRIVATE, response=_response(413), body=None)), 'context-too-long')
        self.assertEqual(classify_ai_error(a.APIStatusError(PRIVATE, response=_response(529), body=None)), 'rate-limit')


class OllamaErrorTests(unittest.TestCase):
    def test_response_error_404_is_model_missing(self):
        try:
            import ollama
        except ImportError:
            self.skipTest('ollama not installed')
        exc = ollama.ResponseError(f'model "x" not found. {PRIVATE}', 404)
        self.assertEqual(classify_ai_error(exc, 'local'), 'model-missing')

    def test_connection_refused_is_ollama_unreachable_for_local_and_remote(self):
        # ollama-python turns httpx.ConnectError into the builtin ConnectionError.
        for provider in ('local', 'remote'):
            self.assertEqual(classify_ai_error(ConnectionError(PRIVATE), provider), 'ollama-unreachable')
        self.assertEqual(classify_ai_error(ConnectionError(PRIVATE), 'cloud'), 'network')

    def test_steno_own_ollama_errors(self):
        self.assertEqual(classify_ai_error(OllamaNotRunningError('x'), 'local'), 'ollama-unreachable')
        self.assertEqual(classify_ai_error(ModelNotAvailableError('x'), 'local'), 'model-missing')
        self.assertEqual(classify_ai_error(ContextTooLargeError('x')), 'context-too-long')


@unittest.skipIf(httpx is None, 'httpx not installed')
class HttpxErrorTests(unittest.TestCase):
    def test_transport_and_status(self):
        request = httpx.Request('GET', 'http://127.0.0.1:11434')
        self.assertEqual(classify_ai_error(httpx.ConnectError(PRIVATE, request=request), 'cloud'), 'network')
        self.assertEqual(classify_ai_error(httpx.ReadTimeout(PRIVATE, request=request), 'cloud'), 'timeout')
        status = httpx.HTTPStatusError(PRIVATE, request=request, response=_response(401))
        self.assertEqual(classify_ai_error(status, 'cloud'), 'auth')


class UrllibErrorTests(unittest.TestCase):
    def _http(self, code):
        return urllib.error.HTTPError('https://bedrock.example.test', code, PRIVATE, {}, io.BytesIO(PRIVATE.encode()))

    def test_http_errors_by_status(self):
        for code, expected in ((401, 'auth'), (403, 'auth'), (402, 'quota'), (429, 'rate-limit'),
                               (404, 'model-missing'), (413, 'context-too-long'), (504, 'timeout'), (500, 'unknown')):
            self.assertEqual(classify_ai_error(self._http(code), 'cloud'), expected, code)

    def test_wrapped_runtime_error_is_classified_by_its_context(self):
        # The Bedrock / adapter paths re-raise RuntimeError inside `except HTTPError`.
        try:
            try:
                raise self._http(403)
            except urllib.error.HTTPError:
                raise RuntimeError(f'Bedrock rejected the API key. {PRIVATE}')
        except RuntimeError as exc:
            self.assertEqual(classify_ai_error(exc, 'cloud'), 'auth')

    def test_url_error_and_socket_timeout(self):
        self.assertEqual(classify_ai_error(urllib.error.URLError(PRIVATE), 'adapter'), 'network')
        self.assertEqual(classify_ai_error(socket.timeout(PRIVATE), 'adapter'), 'timeout')

    def test_unclassified(self):
        self.assertEqual(classify_ai_error(RuntimeError(PRIVATE)), 'unknown')
        self.assertEqual(classify_ai_error(ValueError(PRIVATE), 'local'), 'unknown')


class ChatProtocolTests(unittest.TestCase):
    """The machine lines carry the code and never the provider's message."""

    def _run(self, runner, exc, patches):
        raw = io.BytesIO(json.dumps({'scope': 'general', 'question': 'Explain DNS'}).encode())
        output = io.StringIO()
        config = Mock()
        config.get_ai_provider.return_value = 'cloud'
        config.get_model.return_value = 'm'
        config.get_language.return_value = 'auto'
        model = Mock()
        model.stream_chat_prompt.side_effect = exc
        with patch('sys.stdin', Mock(buffer=raw)), patch('sys.stdout', output), \
                patch('src.config.get_config', return_value=config), \
                patch('src.summarizer.OllamaSummarizer', return_value=model), self.assertRaises(SystemExit):
            runner(model)
        return output.getvalue()

    def test_chat_stream_error_line_carries_the_code(self):
        from src.chat_query import run_chat_query
        out = self._run(lambda _m: run_chat_query(Mock(), Mock()), urllib.error.URLError(PRIVATE), [])
        self.assertIn('CHAT_STREAM_ERROR:network\n', out)
        self.assertNotIn('PRIVATE', out)

    def test_chat_agent_error_line_carries_the_code_or_failed(self):
        from src import chat_agent
        for exc, line in ((OllamaNotRunningError(PRIVATE), 'CHAT_AGENT_ERROR:ollama-unreachable'),
                          (RuntimeError(PRIVATE), 'CHAT_AGENT_ERROR:failed')):
            with patch.object(chat_agent, 'run_step', side_effect=exc):
                out = self._run(lambda m: chat_agent.run_chat_agent_step(Mock(), Mock(), make_summarizer=lambda: m), exc, [])
            self.assertIn(line + '\n', out)
            self.assertNotIn('PRIVATE', out)



class BedrockEventStreamErrorTests(unittest.TestCase):
    """Bedrock's machine-readable exception types classify without any body text."""

    def test_exception_types_by_name(self):
        from src.aws_eventstream import EventStreamError
        for name, expected in (('throttlingException', 'rate-limit'), ('serviceUnavailableException', 'rate-limit'),
                               ('modelTimeoutException', 'timeout'), ('accessDeniedException', 'auth'),
                               ('resourceNotFoundException', 'model-missing'), ('modelStreamErrorException', 'unknown')):
            exc = EventStreamError(name)
            self.assertEqual(classify_ai_error(exc, 'cloud'), expected, name)
            self.assertNotIn(PRIVATE, str(exc))


if __name__ == '__main__':
    unittest.main()
