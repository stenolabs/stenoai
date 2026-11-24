"""OpenRouter as a first-class cloud provider.

Covers the config surface (valid provider, default model), the OpenAI client
wiring (OpenRouter base URL + attribution headers), the chat agent's adapter
choice, the key test (authenticated /key, catalogue-filtered picks) and the
error classification the onboarding key step explains to users. No network:
the key test takes an injectable ``urlopen``.
"""

import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import simple_recorder
from src import chat_agent
from src.cloud_providers import (
    OPENROUTER_BASE_URL,
    OPENROUTER_DEFAULT_MODEL,
    OPENROUTER_HEADERS,
    OPENROUTER_RECOMMENDED_MODELS,
    available_recommended,
    classify_cloud_error,
    openai_client_kwargs,
)
from src.config import Config


def _config(tmp_dir, contents=None):
    path = Path(tmp_dir) / "config.json"
    path.write_text(json.dumps(contents or {}))
    return Config(config_path=path), path


class OpenRouterConfigTests(unittest.TestCase):
    def test_openrouter_is_a_valid_cloud_provider_with_its_own_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            config, path = _config(tmp)
            self.assertTrue(config.set_cloud_provider("openrouter"))
            self.assertEqual(config.get_cloud_provider(), "openrouter")
            self.assertEqual(config.get_cloud_model(), OPENROUTER_DEFAULT_MODEL)
            self.assertEqual(json.loads(path.read_text())["cloud_provider"], "openrouter")

    def test_model_is_remembered_per_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            config, _ = _config(tmp)
            config.set_cloud_provider("openrouter")
            config.set_cloud_model("anthropic/claude-sonnet-4.5")
            config.set_cloud_provider("openai")
            self.assertEqual(config.get_cloud_model(), "gpt-4o-mini")
            config.set_cloud_provider("openrouter")
            self.assertEqual(config.get_cloud_model(), "anthropic/claude-sonnet-4.5")

    def test_config_default_matches_the_provider_module(self):
        self.assertEqual(Config.CLOUD_MODEL_DEFAULTS["openrouter"], OPENROUTER_DEFAULT_MODEL)
        self.assertIn(OPENROUTER_DEFAULT_MODEL, OPENROUTER_RECOMMENDED_MODELS)


class OpenAiClientKwargsTests(unittest.TestCase):
    def test_openrouter_uses_its_gateway_and_attribution_headers(self):
        kwargs = openai_client_kwargs("openrouter", "sk-or-v1-abc", "https://ignored.example/v1")
        self.assertEqual(kwargs["base_url"], OPENROUTER_BASE_URL)
        self.assertEqual(kwargs["default_headers"], OPENROUTER_HEADERS)
        self.assertEqual(kwargs["api_key"], "sk-or-v1-abc")
        # Attribution names the app only.
        self.assertEqual(set(OPENROUTER_HEADERS), {"HTTP-Referer", "X-Title"})

    def test_openai_and_custom_are_unchanged(self):
        self.assertEqual(openai_client_kwargs("openai", "k", "https://x/v1"), {"api_key": "k"})
        self.assertEqual(
            openai_client_kwargs("custom", "k", "https://x/v1"),
            {"api_key": "k", "base_url": "https://x/v1"},
        )
        self.assertEqual(openai_client_kwargs("custom", "k", ""), {"api_key": "k"})

    def test_summarizer_builds_an_openrouter_client(self):
        from src.summarizer import OllamaSummarizer
        with tempfile.TemporaryDirectory() as tmp:
            config, _ = _config(tmp, {"ai_provider": "cloud", "cloud_provider": "openrouter"})
            with mock.patch.dict(os.environ, {"STENOAI_CLOUD_API_KEY": "sk-or-v1-test"}), \
                    mock.patch("openai.OpenAI") as fake_openai:
                s = OllamaSummarizer(config=config)
            self.assertEqual(s.cloud_provider, "openrouter")
            self.assertEqual(s.model_name, OPENROUTER_DEFAULT_MODEL)
            fake_openai.assert_called_once_with(
                api_key="sk-or-v1-test",
                base_url=OPENROUTER_BASE_URL,
                default_headers=OPENROUTER_HEADERS,
            )


class ChatAgentTests(unittest.TestCase):
    def test_openrouter_uses_the_openai_tool_calling_adapter(self):
        s = SimpleNamespace(ai_provider="cloud", cloud_provider="openrouter")
        self.assertIs(chat_agent.provider_step(s), chat_agent._openai_step)


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _fake_urlopen(routes):
    calls = []

    def urlopen(req, timeout=None):
        calls.append(req)
        outcome = routes[req.full_url.rsplit("/", 1)[-1]]
        if isinstance(outcome, Exception):
            raise outcome
        return _Resp(json.dumps(outcome).encode("utf-8"))

    urlopen.calls = calls
    return urlopen


def _http_error(code, body):
    return urllib.error.HTTPError(
        f"{OPENROUTER_BASE_URL}/key", code, "err", {}, io.BytesIO(body.encode("utf-8")),
    )


class OpenRouterKeyTestTests(unittest.TestCase):
    def test_valid_key_offers_the_curated_models_openrouter_still_serves(self):
        urlopen = _fake_urlopen({
            "key": {"data": {"label": "x", "limit_remaining": None}},
            "models": {"data": [{"id": OPENROUTER_DEFAULT_MODEL}, {"id": "anthropic/claude-sonnet-4.5"},
                                {"id": "some/other-model"}]},
        })
        out = simple_recorder._test_openrouter_key("sk-or-v1-good", urlopen=urlopen)
        self.assertEqual(out, {"success": True,
                               "models": [OPENROUTER_DEFAULT_MODEL, "anthropic/claude-sonnet-4.5"]})
        key_req = urlopen.calls[0]
        self.assertEqual(key_req.full_url, f"{OPENROUTER_BASE_URL}/key")
        self.assertEqual(key_req.get_header("Authorization"), "Bearer sk-or-v1-good")
        self.assertEqual(key_req.get_header("X-title"), "Steno")

    def test_bad_key_is_reported_as_invalid(self):
        urlopen = _fake_urlopen({"key": _http_error(401, '{"error":{"message":"No auth credentials found"}}')})
        out = simple_recorder._test_openrouter_key("sk-or-v1-bad", urlopen=urlopen)
        self.assertFalse(out["success"])
        self.assertEqual(out["error_code"], "invalid_key")
        self.assertIn("401", out["error"])

    def test_spent_limit_is_a_warning_not_a_failure(self):
        urlopen = _fake_urlopen({
            "key": {"data": {"limit_remaining": 0}},
            "models": {"data": []},
        })
        out = simple_recorder._test_openrouter_key("sk-or-v1-spent", urlopen=urlopen)
        self.assertTrue(out["success"])
        self.assertEqual(out["warning"], "no_credit")
        self.assertEqual(out["models"], list(OPENROUTER_RECOMMENDED_MODELS))

    def test_catalogue_failure_still_succeeds_with_curated_list(self):
        urlopen = _fake_urlopen({
            "key": {"data": {}},
            "models": urllib.error.URLError("timed out"),
        })
        out = simple_recorder._test_openrouter_key("sk-or-v1-good", urlopen=urlopen)
        self.assertTrue(out["success"])
        self.assertEqual(out["models"], list(OPENROUTER_RECOMMENDED_MODELS))

    def test_network_failure_is_reported_as_network(self):
        urlopen = _fake_urlopen({"key": urllib.error.URLError("[Errno 8] nodename nor servname provided")})
        out = simple_recorder._test_openrouter_key("sk-or-v1-good", urlopen=urlopen)
        self.assertFalse(out["success"])
        self.assertEqual(out["error_code"], "network")


class ClassifyCloudErrorTests(unittest.TestCase):
    def test_codes(self):
        cases = {
            "Error code: 401 - {'error': {'code': 'invalid_api_key'}}": "invalid_key",
            "Error code: 401 - {'type': 'error', 'error': {'type': 'authentication_error'}}": "invalid_key",
            "Error code: 429 - {'error': {'code': 'insufficient_quota'}}": "no_credit",
            "OpenRouter HTTP 402: Insufficient credits": "no_credit",
            "Your credit balance is too low to access the Anthropic API": "no_credit",
            "Connection error.": "network",
            "Request timed out.": "network",
            "Something odd happened": "unknown",
            "": "unknown",
        }
        for message, code in cases.items():
            with self.subTest(message=message):
                self.assertEqual(classify_cloud_error(message), code)

    def test_available_recommended_falls_back_when_nothing_overlaps(self):
        self.assertEqual(available_recommended(["x/y"]), list(OPENROUTER_RECOMMENDED_MODELS))
        self.assertEqual(available_recommended(None), list(OPENROUTER_RECOMMENDED_MODELS))


if __name__ == "__main__":
    unittest.main()
