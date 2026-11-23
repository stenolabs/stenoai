"""Provider constants and helpers shared by the summariser, chat and the
``test-cloud-api`` CLI command.

OpenRouter is an OpenAI-compatible gateway: one key reaches models from many
vendors. It is reached through the same ``openai`` client as OpenAI and custom
endpoints, pointed at ``OPENROUTER_BASE_URL`` and sending the attribution
headers OpenRouter recommends (``HTTP-Referer`` / ``X-Title``). Those headers
name the app, never the user or the meeting.
"""

from __future__ import annotations

import re

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_HEADERS = {
    "HTTP-Referer": "https://stenoai.co",
    "X-Title": "Steno",
}

# A fast, inexpensive model with a long context window, so a long meeting fits
# in one request. Changeable in Settings > AI like every other cloud model.
OPENROUTER_DEFAULT_MODEL = "google/gemini-2.5-flash"

# Curated picks shown first in Settings and offered after a successful key
# test. ``test-cloud-api`` keeps only the ones OpenRouter currently lists, so a
# retired id drops out without a code change; any other OpenRouter id can still
# be typed in by hand.
OPENROUTER_RECOMMENDED_MODELS = (
    OPENROUTER_DEFAULT_MODEL,
    "openai/gpt-4o-mini",
    "anthropic/claude-haiku-4.5",
    "openai/gpt-5-mini",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.5-pro",
    "anthropic/claude-opus-4.1",
)


def openai_client_kwargs(provider: str, api_key: str, custom_url: str = "") -> dict:
    """Keyword arguments for ``openai.OpenAI`` for an OpenAI-compatible provider
    ('openai', 'custom' or 'openrouter')."""
    kwargs = {"api_key": api_key}
    if provider == "openrouter":
        kwargs["base_url"] = OPENROUTER_BASE_URL
        kwargs["default_headers"] = dict(OPENROUTER_HEADERS)
    elif provider == "custom" and custom_url:
        kwargs["base_url"] = custom_url
    return kwargs


def available_recommended(live_ids) -> list:
    """The curated OpenRouter models that the live catalogue still lists, in
    curated order. Falls back to the whole curated list when the catalogue is
    unavailable or shares nothing with it (better a typed-in fix later than an
    empty picker now)."""
    live = set(live_ids or ())
    kept = [m for m in OPENROUTER_RECOMMENDED_MODELS if m in live]
    return kept or list(OPENROUTER_RECOMMENDED_MODELS)


_INVALID_KEY = re.compile(
    r"\b401\b|\b403\b|invalid[_ ]api[_ ]key|incorrect api key|authentication|"
    r"unauthori[sz]ed|no auth credentials|invalid x-api-key|user not found",
    re.IGNORECASE,
)
_NO_CREDIT = re.compile(
    r"\b402\b|insufficient[_ ]quota|insufficient credits|credit balance|billing|"
    r"exceeded your current quota|payment required",
    re.IGNORECASE,
)
_NETWORK = re.compile(
    r"connection error|connecterror|timed out|timeout|name or service not known|"
    r"nodename nor servname|getaddrinfo|network is unreachable|temporary failure in name resolution|"
    r"failed to establish|connection refused|urlopen error",
    re.IGNORECASE,
)


def classify_cloud_error(message: str) -> str:
    """Map a provider error message to a stable code the UI can explain:
    'no_credit', 'invalid_key', 'network' or 'unknown'. Credit is checked
    first: some providers phrase an empty balance as a 4xx auth-ish error."""
    text = message or ""
    if _NO_CREDIT.search(text):
        return "no_credit"
    if _INVALID_KEY.search(text):
        return "invalid_key"
    if _NETWORK.search(text):
        return "network"
    return "unknown"
