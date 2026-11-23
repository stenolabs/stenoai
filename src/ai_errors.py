"""Classify AI provider failures into a small set of stable, private codes.

Provider errors can carry prompts, note text or response bodies, so nothing
here ever returns or logs an exception's message. A failure is classified by
its exception type (by class name, so no SDK has to be importable), its HTTP
status, and the provider's machine-readable error code/type field (for
example OpenAI's ``insufficient_quota``) -- never by free text.

The codes are a wire contract shared with app/chat-query.js, app/chat-agent.js
and the renderer (lib/aiError.ts). Add a code there before emitting it here.
"""

OLLAMA_UNREACHABLE = 'ollama-unreachable'
MODEL_MISSING = 'model-missing'
AUTH = 'auth'
QUOTA = 'quota'
RATE_LIMIT = 'rate-limit'
NETWORK = 'network'
TIMEOUT = 'timeout'
CONTEXT_TOO_LONG = 'context-too-long'
UNKNOWN = 'unknown'

CODES = (
    OLLAMA_UNREACHABLE, MODEL_MISSING, AUTH, QUOTA, RATE_LIMIT,
    NETWORK, TIMEOUT, CONTEXT_TOO_LONG, UNKNOWN,
)


class OllamaNotRunningError(Exception):
    """The local Ollama server could not be reached or started."""


class ModelNotAvailableError(Exception):
    """The configured local model is not downloaded and could not be pulled."""


class ContextTooLargeError(ValueError):
    """The request is larger than Steno will send to a model."""


# Machine-readable provider codes / error types (never message text).
_QUOTA_CODES = {'insufficient_quota', 'billing_error', 'billing_hard_limit_reached', 'credit_balance_too_low'}
_CONTEXT_CODES = {'context_length_exceeded', 'request_too_large', 'string_above_max_length'}
_AUTH_CODES = {'invalid_api_key', 'authentication_error', 'permission_error', 'invalid_x_api_key'}
_RATE_CODES = {'rate_limit_exceeded', 'rate_limit_error', 'overloaded_error'}
_MODEL_CODES = {'model_not_found', 'not_found_error'}

_TYPE_NAMES = {
    'OllamaNotRunningError': OLLAMA_UNREACHABLE,
    'ModelNotAvailableError': MODEL_MISSING,
    'ContextTooLargeError': CONTEXT_TOO_LONG,
    # openai / anthropic SDKs
    'AuthenticationError': AUTH,
    'PermissionDeniedError': AUTH,
    'RateLimitError': RATE_LIMIT,
    'OverloadedError': RATE_LIMIT,
    'NotFoundError': MODEL_MISSING,
    'RequestTooLargeError': CONTEXT_TOO_LONG,
    'APITimeoutError': TIMEOUT,
    'APIConnectionError': NETWORK,
    # httpx
    'ConnectTimeout': TIMEOUT,
    'ReadTimeout': TIMEOUT,
    'WriteTimeout': TIMEOUT,
    'PoolTimeout': TIMEOUT,
    'TimeoutException': TIMEOUT,
    'ConnectError': NETWORK,
    'NetworkError': NETWORK,
    'TransportError': NETWORK,
    # stdlib (socket.timeout is TimeoutError; URLError covers DNS/refused)
    'TimeoutError': TIMEOUT,
    'URLError': NETWORK,
    'ConnectionError': NETWORK,
}

_STATUS_CODES = {
    401: AUTH, 403: AUTH, 402: QUOTA, 429: RATE_LIMIT, 404: MODEL_MISSING,
    413: CONTEXT_TOO_LONG, 408: TIMEOUT, 504: TIMEOUT, 524: TIMEOUT,
    503: RATE_LIMIT, 529: RATE_LIMIT,
}


def _status(exc):
    for attr in ('status_code', 'status'):
        value = getattr(exc, attr, None)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    response = getattr(exc, 'response', None)
    value = getattr(response, 'status_code', None)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    # urllib.error.HTTPError keeps the status in ``code``.
    value = getattr(exc, 'code', None)
    if isinstance(value, int) and not isinstance(value, bool) and 100 <= value < 600:
        return value
    return None


def _provider_codes(exc):
    """The provider's machine-readable error code/type fields, lower-cased."""
    found = set()
    for attr in ('code', 'type'):
        value = getattr(exc, attr, None)
        if isinstance(value, str):
            found.add(value.lower())
    body = getattr(exc, 'body', None)
    if isinstance(body, dict):
        for node in (body, body.get('error')):
            if isinstance(node, dict):
                for key in ('code', 'type'):
                    if isinstance(node.get(key), str):
                        found.add(node[key].lower())
    return found


def _classify_one(exc):
    codes = _provider_codes(exc)
    if codes & _QUOTA_CODES:
        return QUOTA
    if codes & _CONTEXT_CODES:
        return CONTEXT_TOO_LONG
    if codes & _AUTH_CODES:
        return AUTH
    if codes & _MODEL_CODES:
        return MODEL_MISSING
    if codes & _RATE_CODES:
        return RATE_LIMIT
    status = _status(exc)
    if status is not None:
        # The server answered: classify by status alone (an HTTPError is also
        # a URLError, but it is not a network failure).
        return _STATUS_CODES.get(status)
    for cls in type(exc).__mro__:
        if cls.__name__ in _TYPE_NAMES:
            return _TYPE_NAMES[cls.__name__]
    return None


def _chain(exc, limit=8):
    seen = set()
    while exc is not None and id(exc) not in seen and len(seen) < limit:
        seen.add(id(exc))
        yield exc
        exc = exc.__cause__ or exc.__context__


def classify_ai_error(exc, provider=None):
    """A stable code for ``exc``; ``provider`` is the configured ai_provider.

    Wrapped errors (``raise RuntimeError(...)`` inside an ``except``) are
    classified by the first link of their cause/context chain that matches.
    """
    code = None
    for link in _chain(exc):
        code = _classify_one(link)
        if code:
            break
    code = code or UNKNOWN
    if provider in ('local', 'remote') and code in (NETWORK,):
        return OLLAMA_UNREACHABLE
    return code


def configured_provider():
    """The configured ai_provider, or None when config cannot be read."""
    try:
        from src.config import get_config
        return get_config().get_ai_provider()
    except Exception:
        return None
