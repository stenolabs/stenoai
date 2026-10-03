"""Point Python HTTPS clients at a self-contained CA bundle.

PyInstaller compiles `_ssl` with the build host's `OPENSSLDIR` baked in
(usually a Homebrew path on a dev Mac). On a customer's clean Mac that path may
not exist, so HTTPS calls can fail with
`[SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate`.

Certifi fixes the missing-OpenSSL-directory case. Managed networks can add one
more wrinkle: a corporate VPN, proxy, or HTTPS inspection product may install a
private root certificate into macOS Keychain. Certifi intentionally does not
contain those local roots, so packaged Python must use a bundle that includes
both certifi's public roots and the user's trusted macOS roots.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path

_CERT_BEGIN = b"-----BEGIN CERTIFICATE-----"
_MACOS_KEYCHAINS = (
    "/System/Library/Keychains/SystemRootCertificates.keychain",
    "/Library/Keychains/System.keychain",
)


def _macos_keychain_pem() -> bytes:
    """Return PEM certificates trusted by macOS Keychain, when readable.

    The `security` tool exports public certificates only. It does not expose
    private keys or secrets. Fail closed to certifi when the tool is missing,
    unavailable, or returns no PEM blocks.
    """
    if sys.platform != "darwin":
        return b""
    existing = [path for path in _MACOS_KEYCHAINS if os.path.exists(path)]
    if not existing:
        return b""
    try:
        result = subprocess.run(
            ["/usr/bin/security", "find-certificate", "-a", "-p", *existing],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return b""
    if result.returncode != 0 or _CERT_BEGIN not in result.stdout:
        return b""
    return result.stdout


def _combined_ca_bundle(certifi_path: str, extra_pem: bytes) -> str:
    """Write a stable temp bundle containing certifi plus extra PEM roots."""
    if not extra_pem:
        return certifi_path
    certifi_file = Path(certifi_path)
    try:
        certifi_bytes = certifi_file.read_bytes()
    except OSError:
        return certifi_path
    content = certifi_bytes.rstrip() + bytes([10]) + extra_pem.strip() + bytes([10])
    digest = hashlib.sha256(content).hexdigest()[:16]
    bundle = Path(tempfile.gettempdir()) / f"stenoai-ca-bundle-{digest}.pem"
    try:
        if bundle.is_file() and bundle.read_bytes() == content:
            return str(bundle)
        tmp = bundle.with_suffix(".tmp")
        tmp.write_bytes(content)
        os.replace(tmp, bundle)
    except OSError:
        return certifi_path
    return str(bundle)


def configure() -> None:
    try:
        import certifi
    except ImportError:
        return
    ca_file = certifi.where()
    if not os.path.isfile(ca_file):
        return
    ca_bundle = _combined_ca_bundle(ca_file, _macos_keychain_pem())
    os.environ["SSL_CERT_FILE"] = ca_bundle
    os.environ["REQUESTS_CA_BUNDLE"] = ca_bundle


configure()
