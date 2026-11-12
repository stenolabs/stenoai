"""Point packaged Python HTTPS clients at a CA bundle.

PyInstaller's `_ssl` may retain a build-machine OpenSSL directory that does not
exist on a customer's computer. Certifi provides a portable public CA bundle.
An operator can supply a managed-network CA file with SSL_CERT_FILE, or a CA
directory with SSL_CERT_DIR. REQUESTS_CA_BUNDLE accepts either. Explicit
values always win. We do not export macOS
Keychain certificates into OpenSSL because `security find-certificate` does not
apply Keychain's trust settings, including explicit distrust decisions.

An explicit value that points at nothing is removed rather than kept: HTTPX
opens it at client construction, and `import ollama` builds a client at import
time, so a stale variable would otherwise stop every CLI command, including
ones that need no TLS. The variable's name is remembered so model downloads,
the one place managed-network users hit this, refuse with an error that names
it instead of quietly trusting certifi.
"""

from __future__ import annotations

import os

_CA_VARIABLES = ("SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE")

# Sticky for the process: configure() runs more than once, and the variables
# it removed are gone from the environment by the second call.
_missing_ca_variables: list[str] = []


def missing_ca_variables() -> tuple[str, ...]:
    """Names of explicit CA variables that pointed at a missing path."""
    return tuple(_missing_ca_variables)


def _points_at_something(name: str, value: str) -> bool:
    if name == "SSL_CERT_FILE":
        return os.path.isfile(value)
    if name == "SSL_CERT_DIR":
        return os.path.isdir(value)
    return os.path.exists(value)  # REQUESTS_CA_BUNDLE takes a file or a directory


def configure() -> None:
    """Configure stdlib SSL and requests without overriding an operator's CA.

    Mirror a single explicit CA path to the other client using the correct
    file/directory variable. Distinct explicit values are preserved. Explicit
    paths that do not exist are removed and recorded (see module docstring),
    and certifi fills in as it would with nothing set, which is also what
    HTTPX and requests fall back to on their own. Model downloads check
    missing_ca_variables() and refuse instead.
    """
    for name in _CA_VARIABLES:
        value = os.environ.get(name)
        if value and not _points_at_something(name, value):
            del os.environ[name]
            if name not in _missing_ca_variables:
                _missing_ca_variables.append(name)

    ssl_ca = os.environ.get("SSL_CERT_FILE")
    ssl_dir = os.environ.get("SSL_CERT_DIR")
    requests_ca = os.environ.get("REQUESTS_CA_BUNDLE")
    if ssl_ca or ssl_dir or requests_ca:
        if not requests_ca:
            # Requests takes a single path. With both a file and a directory
            # set, it gets the file, as HTTPX does; stdlib SSL reads both.
            os.environ["REQUESTS_CA_BUNDLE"] = ssl_ca or ssl_dir
        elif not ssl_ca and not ssl_dir:
            # Requests accepts both kinds of path. HTTPX requires the matching
            # SSL variable.
            target = "SSL_CERT_DIR" if os.path.isdir(requests_ca) else "SSL_CERT_FILE"
            os.environ[target] = requests_ca
        return

    try:
        import certifi
    except ImportError:
        return
    ca_file = certifi.where()
    if not os.path.isfile(ca_file):
        return
    os.environ["SSL_CERT_FILE"] = ca_file
    os.environ["REQUESTS_CA_BUNDLE"] = ca_file


configure()
