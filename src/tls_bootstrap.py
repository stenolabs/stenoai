"""Point packaged Python HTTPS clients at a CA bundle.

PyInstaller's `_ssl` may retain a build-machine OpenSSL directory that does not
exist on a customer's computer. Certifi provides a portable public CA bundle.
An operator can supply a managed-network CA file with SSL_CERT_FILE, or a CA
directory with SSL_CERT_DIR. REQUESTS_CA_BUNDLE accepts either. Explicit
values always win. We do not export macOS
Keychain certificates into OpenSSL because `security find-certificate` does not
apply Keychain's trust settings, including explicit distrust decisions.
"""

from __future__ import annotations

import os


def configure() -> None:
    """Configure stdlib SSL and requests without overriding an operator's CA.

    Mirror a single explicit CA path to the other client using the correct
    file/directory variable. Distinct explicit values are preserved. Missing
    explicit paths remain in place so TLS fails instead of using certifi.
    """
    ssl_ca = os.environ.get("SSL_CERT_FILE")
    ssl_dir = os.environ.get("SSL_CERT_DIR")
    requests_ca = os.environ.get("REQUESTS_CA_BUNDLE")
    if ssl_ca or ssl_dir or requests_ca:
        if not requests_ca:
            os.environ["REQUESTS_CA_BUNDLE"] = ssl_ca or ssl_dir
        elif not ssl_ca and not ssl_dir:
            # Requests accepts both kinds of path. HTTPX requires the matching
            # SSL variable; unknown/broken paths use FILE so HTTPX fails
            # explicitly instead of quietly selecting its certifi default.
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
