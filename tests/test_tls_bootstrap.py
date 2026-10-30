"""TLS bootstrap uses certifi by default and keeps explicit CA policy intact."""

import importlib
import os
import ssl
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import certifi


REPO_ROOT = Path(__file__).resolve().parent.parent
CA_KEYS = ("SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE")


class TlsBootstrapTests(unittest.TestCase):
    def _require_clients(self, *names):
        try:
            return tuple(importlib.import_module(name) for name in names)
        except ImportError as error:
            self.skipTest(f"Client dependency unavailable: {error.name}")

    def setUp(self):
        self._saved_env = {key: os.environ.get(key) for key in CA_KEYS}

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _reimport(self):
        sys.modules.pop("src.tls_bootstrap", None)
        return importlib.import_module("src.tls_bootstrap")

    def test_default_uses_full_certifi_bundle_on_all_platforms(self):
        os.environ.pop("SSL_CERT_FILE", None)
        os.environ.pop("SSL_CERT_DIR", None)
        os.environ.pop("REQUESTS_CA_BUNDLE", None)
        with mock.patch("subprocess.run", side_effect=AssertionError("no Keychain export")):
            module = self._reimport()
            module.configure()
        ca_file = os.environ["SSL_CERT_FILE"]
        self.assertEqual(ca_file, certifi.where())
        self.assertEqual(os.environ["REQUESTS_CA_BUNDLE"], ca_file)
        self.assertEqual(Path(ca_file).read_bytes(), Path(certifi.where()).read_bytes())

    def test_explicit_ssl_ca_is_used_by_both_clients(self):
        with tempfile.TemporaryDirectory() as tmp:
            custom = str(Path(tmp) / "operator.pem")
            Path(custom).write_text("synthetic CA fixture")
            os.environ["SSL_CERT_FILE"] = custom
            os.environ.pop("REQUESTS_CA_BUNDLE", None)
            with mock.patch("subprocess.run", side_effect=AssertionError("no Keychain export")):
                module = self._reimport()
                module.configure()
            self.assertEqual(os.environ["SSL_CERT_FILE"], custom)
            self.assertEqual(os.environ["REQUESTS_CA_BUNDLE"], custom)

    def test_explicit_requests_ca_is_used_by_both_clients(self):
        with tempfile.TemporaryDirectory() as tmp:
            custom = str(Path(tmp) / "operator.pem")
            Path(custom).write_text("synthetic CA fixture")
            os.environ.pop("SSL_CERT_FILE", None)
            os.environ["REQUESTS_CA_BUNDLE"] = custom
            self._reimport()
            self.assertEqual(os.environ["SSL_CERT_FILE"], custom)
            self.assertEqual(os.environ["REQUESTS_CA_BUNDLE"], custom)

    def test_explicit_requests_ca_directory_selects_ssl_cert_dir(self):
        httpx, requests = self._require_clients("httpx", "requests")

        with tempfile.TemporaryDirectory() as tmp:
            os.environ.pop("SSL_CERT_FILE", None)
            os.environ.pop("SSL_CERT_DIR", None)
            os.environ["REQUESTS_CA_BUNDLE"] = tmp
            self._reimport()
            self.assertIsNone(os.environ.get("SSL_CERT_FILE"))
            self.assertEqual(os.environ["SSL_CERT_DIR"], tmp)
            with mock.patch("ssl.create_default_context", wraps=ssl.create_default_context) as create:
                httpx.create_ssl_context()
            create.assert_called_once_with(capath=tmp)
            self.assertEqual(requests.Session().merge_environment_settings(
                "https://huggingface.co", {}, None, None, None,
            )["verify"], tmp)

    def test_explicit_ssl_cert_dir_is_not_overridden_by_certifi(self):
        httpx, requests = self._require_clients("httpx", "requests")

        with tempfile.TemporaryDirectory() as tmp:
            os.environ.pop("SSL_CERT_FILE", None)
            os.environ["SSL_CERT_DIR"] = tmp
            os.environ.pop("REQUESTS_CA_BUNDLE", None)
            self._reimport()
            self.assertIsNone(os.environ.get("SSL_CERT_FILE"))
            self.assertEqual(os.environ["SSL_CERT_DIR"], tmp)
            self.assertEqual(os.environ["REQUESTS_CA_BUNDLE"], tmp)
            with mock.patch("ssl.create_default_context", wraps=ssl.create_default_context) as create:
                httpx.create_ssl_context()
            create.assert_called_once_with(capath=tmp)
            self.assertEqual(requests.Session().merge_environment_settings(
                "https://huggingface.co", {}, None, None, None,
            )["verify"], tmp)

    def test_missing_explicit_requests_ca_fails_closed_for_httpx(self):
        (httpx,) = self._require_clients("httpx")

        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "missing-ca.pem")
            os.environ.pop("SSL_CERT_FILE", None)
            os.environ.pop("SSL_CERT_DIR", None)
            os.environ["REQUESTS_CA_BUNDLE"] = missing
            self._reimport()
            self.assertEqual(os.environ["SSL_CERT_FILE"], missing)
            self.assertEqual(os.environ["REQUESTS_CA_BUNDLE"], missing)
            with self.assertRaises((OSError, FileNotFoundError)):
                httpx.create_ssl_context()

    def test_missing_explicit_ssl_dir_is_not_replaced_with_certifi(self):
        (httpx,) = self._require_clients("httpx")

        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "missing-ca-dir")
            os.environ.pop("SSL_CERT_FILE", None)
            os.environ["SSL_CERT_DIR"] = missing
            os.environ.pop("REQUESTS_CA_BUNDLE", None)
            self._reimport()
            self.assertIsNone(os.environ.get("SSL_CERT_FILE"))
            self.assertEqual(os.environ["SSL_CERT_DIR"], missing)
            self.assertEqual(os.environ["REQUESTS_CA_BUNDLE"], missing)
            with mock.patch("ssl.create_default_context", wraps=ssl.create_default_context) as create:
                httpx.create_ssl_context()
            create.assert_called_once_with(capath=missing)

    def test_distinct_explicit_file_and_directory_remain_distinct(self):
        with tempfile.TemporaryDirectory() as tmp:
            ssl_file = Path(tmp) / "ssl.pem"
            ssl_file.write_text("synthetic SSL fixture")
            requests_dir = Path(tmp) / "requests-ca"
            requests_dir.mkdir()
            os.environ["SSL_CERT_FILE"] = str(ssl_file)
            os.environ.pop("SSL_CERT_DIR", None)
            os.environ["REQUESTS_CA_BUNDLE"] = str(requests_dir)
            self._reimport()
            self.assertEqual(os.environ["SSL_CERT_FILE"], str(ssl_file))
            self.assertIsNone(os.environ.get("SSL_CERT_DIR"))
            self.assertEqual(os.environ["REQUESTS_CA_BUNDLE"], str(requests_dir))

    def test_distinct_explicit_ca_files_remain_distinct(self):
        with tempfile.TemporaryDirectory() as tmp:
            ssl_ca = str(Path(tmp) / "ssl.pem")
            requests_ca = str(Path(tmp) / "requests.pem")
            Path(ssl_ca).write_text("synthetic SSL fixture")
            Path(requests_ca).write_text("synthetic requests fixture")
            os.environ["SSL_CERT_FILE"] = ssl_ca
            os.environ["REQUESTS_CA_BUNDLE"] = requests_ca
            self._reimport()
            self.assertEqual(os.environ["SSL_CERT_FILE"], ssl_ca)
            self.assertEqual(os.environ["REQUESTS_CA_BUNDLE"], requests_ca)

    def test_broken_explicit_ca_is_not_silently_replaced(self):
        broken = "/nonexistent/explicit-operator-ca.pem"
        os.environ["SSL_CERT_FILE"] = broken
        os.environ.pop("REQUESTS_CA_BUNDLE", None)
        self._reimport()
        self.assertEqual(os.environ["SSL_CERT_FILE"], broken)
        self.assertEqual(os.environ["REQUESTS_CA_BUNDLE"], broken)

    def test_httpx_and_requests_use_explicit_ca_without_network(self):
        # HF Hub 1.x uses HTTPX; older Hub uses Requests. Check each client's
        # local CA selection without contacting Hugging Face.
        httpx, requests = self._require_clients("httpx", "requests")
        with tempfile.TemporaryDirectory() as tmp:
            custom = Path(tmp) / "operator.pem"
            custom.write_bytes(Path(certifi.where()).read_bytes())
            os.environ["SSL_CERT_FILE"] = str(custom)
            os.environ.pop("REQUESTS_CA_BUNDLE", None)
            self._reimport()
            self.assertGreater(len(httpx.create_ssl_context().get_ca_certs()), 100)
            self.assertEqual(
                requests.Session().merge_environment_settings(
                    "https://huggingface.co", {}, None, None, None,
                )["verify"],
                str(custom),
            )
            custom.unlink()
            with self.assertRaises((OSError, FileNotFoundError)):
                httpx.create_ssl_context()

    def test_default_ssl_context_loads_certifi_after_bootstrap(self):
        # A missing OpenSSL directory loads no roots. Clear that synthetic
        # explicit override before bootstrap so certifi supplies the roots.
        env = {**os.environ, "SSL_CERT_FILE": "/nonexistent/cert.pem",
               "SSL_CERT_DIR": "/nonexistent", "PYTHONPATH": str(REPO_ROOT)}
        env.pop("REQUESTS_CA_BUNDLE", None)
        script = (
            "import os, ssl;"
            "before = len(ssl.create_default_context().get_ca_certs());"
            "os.environ.pop('SSL_CERT_FILE');"
            "os.environ.pop('SSL_CERT_DIR');"
            "import src.tls_bootstrap;"
            "after = len(ssl.create_default_context().get_ca_certs());"
            "print(before, after)"
        )
        before, after = map(int, subprocess.check_output(
            [sys.executable, "-c", script], env=env, cwd=str(REPO_ROOT), text=True,
        ).split())
        self.assertEqual(before, 0)
        self.assertGreater(after, 100)


if __name__ == "__main__":
    unittest.main()
