import logging
import os
import ssl
import sys
import types
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from src import parakeet_models


def _fake_hub_modules(offline: bool = False, reset_sessions=None) -> dict[str, object]:
    hub = types.ModuleType("huggingface_hub")
    constants = types.ModuleType("huggingface_hub.constants")
    constants.HF_HUB_OFFLINE = offline
    utils = types.ModuleType("huggingface_hub.utils")
    http = types.ModuleType("huggingface_hub.utils._http")
    http.reset_sessions = reset_sessions or (lambda: None)
    hub.constants = constants
    hub.utils = utils
    utils._http = http
    return {
        "huggingface_hub": hub,
        "huggingface_hub.constants": constants,
        "huggingface_hub.utils": utils,
        "huggingface_hub.utils._http": http,
    }


class IsInstalledTests(unittest.TestCase):
    def setUp(self):
        self._cache = TemporaryDirectory()
        self._saved_hf_hub_cache = os.environ.get("HF_HUB_CACHE")
        os.environ["HF_HUB_CACHE"] = self._cache.name

    def tearDown(self):
        if self._saved_hf_hub_cache is None:
            os.environ.pop("HF_HUB_CACHE", None)
        else:
            os.environ["HF_HUB_CACHE"] = self._saved_hf_hub_cache
        self._cache.cleanup()

    def _snapshot(self, model_id: str) -> Path:
        snapshot = (
            parakeet_models._hf_cache_dir_for(model_id)
            / "snapshots"
            / "test-revision"
        )
        snapshot.mkdir(parents=True)
        return snapshot

    @staticmethod
    def _write(snapshot: Path, *names: str) -> None:
        for name in names:
            (snapshot / name).write_bytes(b"present")

    def test_mlx_snapshot_requires_nonempty_weights(self):
        model_id = "mlx-community/parakeet-tdt-0.6b-v3"
        snapshot = self._snapshot(model_id)
        self._write(snapshot, "config.json")

        self.assertFalse(parakeet_models.is_installed(model_id))
        (snapshot / "model.safetensors").write_bytes(b"")
        self.assertFalse(parakeet_models.is_installed(model_id))
        self._write(snapshot, "model.safetensors")
        self.assertTrue(parakeet_models.is_installed(model_id))

    def test_onnx_snapshot_requires_every_runtime_file(self):
        model_id = "istupakov/parakeet-tdt-0.6b-v3-onnx"
        snapshot = self._snapshot(model_id)
        self._write(
            snapshot,
            "config.json",
            "encoder-model.int8.onnx",
            "decoder_joint-model.int8.onnx",
        )

        self.assertFalse(parakeet_models.is_installed(model_id))
        self._write(snapshot, "vocab.txt")
        self.assertTrue(parakeet_models.is_installed(model_id))

    def test_unknown_model_never_forces_offline_mode(self):
        model_id = "example/future-model"
        snapshot = self._snapshot(model_id)
        self._write(snapshot, "config.json", "weights.bin")

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HF_HUB_OFFLINE", None)
            os.environ.pop("TRANSFORMERS_OFFLINE", None)
            self.assertFalse(parakeet_models.is_installed(model_id))
            self.assertFalse(parakeet_models.maybe_enable_offline(model_id))
            self.assertNotIn("HF_HUB_OFFLINE", os.environ)
            self.assertNotIn("TRANSFORMERS_OFFLINE", os.environ)

    def test_unreadable_snapshots_directory_is_not_installed(self):
        model_id = "mlx-community/parakeet-tdt-0.6b-v3"
        self._snapshot(model_id)

        with patch.object(Path, "iterdir", side_effect=PermissionError):
            self.assertFalse(parakeet_models.is_installed(model_id))


class MaybeEnableOfflineTests(unittest.TestCase):
    def setUp(self):
        # Snapshot the two env vars we touch so each test runs from a known
        # clean slate and never leaks state into the rest of the suite.
        self._saved = {
            k: os.environ.get(k)
            for k in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")
        }
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_enables_offline_when_installed(self):
        with patch("src.parakeet_models.is_installed", return_value=True):
            enabled = parakeet_models.maybe_enable_offline("some/model")
        self.assertTrue(enabled)
        self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "1")
        self.assertEqual(os.environ.get("TRANSFORMERS_OFFLINE"), "1")

    def test_noop_when_not_installed(self):
        with patch("src.parakeet_models.is_installed", return_value=False):
            enabled = parakeet_models.maybe_enable_offline("some/model")
        self.assertFalse(enabled)
        self.assertIsNone(os.environ.get("HF_HUB_OFFLINE"))
        self.assertIsNone(os.environ.get("TRANSFORMERS_OFFLINE"))

    def test_does_not_override_explicit_operator_value(self):
        os.environ["HF_HUB_OFFLINE"] = "0"
        os.environ["TRANSFORMERS_OFFLINE"] = "0"
        with patch("src.parakeet_models.is_installed", return_value=True):
            parakeet_models.maybe_enable_offline("some/model")
        # setdefault must leave explicit debug overrides (e.g. =0) intact for
        # both flags.
        self.assertEqual(os.environ.get("HF_HUB_OFFLINE"), "0")
        self.assertEqual(os.environ.get("TRANSFORMERS_OFFLINE"), "0")


class DisableImplicitHfTokenTests(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get("HF_HUB_DISABLE_IMPLICIT_TOKEN")
        os.environ.pop("HF_HUB_DISABLE_IMPLICIT_TOKEN", None)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("HF_HUB_DISABLE_IMPLICIT_TOKEN", None)
        else:
            os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = self._saved

    def test_sets_flag_when_unset(self):
        # A stray/expired HF token in the environment would 401 the anonymous
        # public download; the flag forces token-free requests.
        parakeet_models.disable_implicit_hf_token()
        self.assertEqual(os.environ.get("HF_HUB_DISABLE_IMPLICIT_TOKEN"), "1")

    def test_does_not_override_explicit_operator_value(self):
        os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "0"
        parakeet_models.disable_implicit_hf_token()
        # setdefault must leave an explicit operator override (e.g. =0 to reach
        # a private mirror) intact.
        self.assertEqual(os.environ.get("HF_HUB_DISABLE_IMPLICIT_TOKEN"), "0")


class DownloadErrorSurfacingTests(unittest.TestCase):
    def test_masking_filenotfound_is_reported_as_http_failure(self):
        model_id = parakeet_models.DEFAULT_MODEL_ID
        # parakeet-mlx/onnx-asr raise this shape when the HF fetch fails and
        # they fall back to a local path; it must not be parroted verbatim.
        masking = FileNotFoundError(
            2, "No such file or directory", f"{model_id}/config.json"
        )
        with patch("src.parakeet_models.is_installed", return_value=True), patch("src.parakeet.ensure_loaded", side_effect=masking), \
                patch.dict(sys.modules, _fake_hub_modules()), \
                self.assertLogs("src.parakeet_models", level="ERROR") as cm:
            ok = parakeet_models.download(model_id)
        self.assertFalse(ok)
        joined = "\n".join(cm.output)
        self.assertIn("HF_TOKEN", joined)
        self.assertIn("401", joined)

    def test_ssl_certificate_error_gets_certificate_guidance(self):
        error = ssl.SSLCertVerificationError(
            "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: "
            "unable to get local issuer certificate (_ssl.c:1006)"
        )
        with patch("src.parakeet_models.is_installed", return_value=False), patch("src.parakeet_models._download_snapshot", side_effect=error), \
                self.assertLogs("src.parakeet_models", level="ERROR") as cm:
            ok = parakeet_models.download(parakeet_models.DEFAULT_MODEL_ID)
        self.assertFalse(ok)
        joined = "\n".join(cm.output)
        self.assertIn("TLS certificate verification failed", joined)
        self.assertIn("SSL_CERT_FILE", joined)
        self.assertIn("REQUESTS_CA_BUNDLE", joined)
        self.assertNotIn("HF_TOKEN", joined)

    def test_wrapped_ssl_certificate_error_gets_certificate_guidance(self):
        try:
            raise ssl.SSLCertVerificationError("CERTIFICATE_VERIFY_FAILED")
        except ssl.SSLCertVerificationError as cause:
            error = RuntimeError("wrapped hub error")
            error.__cause__ = cause
        self.assertTrue(parakeet_models._is_ssl_certificate_error(error))

    def test_huggingface_ssl_warning_survives_generic_final_error(self):
        def fail_after_warning(model_id, emit):
            logging.getLogger("huggingface_hub.utils._http").warning(
                "'[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: "
                "unable to get local issuer certificate (_ssl.c:1006)' thrown while requesting HEAD"
            )
            raise RuntimeError(
                "An error happened while trying to locate the file on the Hub "
                "and we cannot find the requested files in the local cache."
            )

        with patch("src.parakeet_models.is_installed", return_value=False), patch("src.parakeet_models._download_snapshot", side_effect=fail_after_warning), \
                self.assertLogs("src.parakeet_models", level="ERROR") as cm:
            ok = parakeet_models.download(parakeet_models.DEFAULT_MODEL_ID)

        self.assertFalse(ok)
        self.assertEqual(
            parakeet_models.get_last_download_error(),
            "TLS certificate verification failed while contacting Hugging Face",
        )
        joined = "\n".join(cm.output)
        self.assertIn("TLS certificate verification failed", joined)

    def test_unrelated_error_uses_plain_message(self):
        with patch("src.parakeet_models.is_installed", return_value=True), patch("src.parakeet.ensure_loaded", side_effect=RuntimeError("boom")), \
                patch.dict(sys.modules, _fake_hub_modules()), \
                self.assertLogs("src.parakeet_models", level="ERROR") as cm:
            ok = parakeet_models.download(parakeet_models.DEFAULT_MODEL_ID)
        self.assertFalse(ok)
        joined = "\n".join(cm.output)
        self.assertIn("download/load failed", joined)
        self.assertNotIn("HF_TOKEN", joined)


class DownloadProgressTests(unittest.TestCase):
    def test_stages_and_failure(self):
        for failure in (False, True):
            events = []
            def fetch(model, emit):
                self.assertEqual(events[-1]["stage"], "preparing")
                emit({"stage": "downloading"})
                if failure:
                    raise OSError("offline")
            def load(model):
                from huggingface_hub import constants
                self.assertTrue(constants.HF_HUB_OFFLINE)
                self.assertEqual(events[-1]["stage"], "loading")
            with patch("src.parakeet_models.is_installed", return_value=False), patch("src.parakeet_models._download_snapshot", side_effect=fetch), \
                    patch("src.parakeet.ensure_loaded", side_effect=load) as loaded, \
                    patch.dict(sys.modules, _fake_hub_modules()):
                self.assertEqual(parakeet_models.download(progress_callback=events.append), not failure)
            expected = ["preparing", "downloading"] + ([] if failure else ["loading", "complete"])
            self.assertEqual([e["stage"] for e in events], expected)
            self.assertEqual(loaded.call_count, 0 if failure else 1)

    @patch.dict(os.environ)
    def test_snapshot_progress_and_older_hub_fallback(self):
        for modern in (True, False):
            events, calls = [], []
            def old(repo, filename, revision=None, token=None):
                calls.append((filename, revision, token))
                return "/synthetic/snapshots/abc123/" + filename
            def new(repo, filename, revision=None, token=None, tqdm_class=None):
                with tqdm_class(total=100, initial=40, unit="B", mininterval=0, disable=None, name="download") as bar:
                    bar.update(60)
                return old(repo, filename, revision, token)
            hub = types.ModuleType("huggingface_hub")
            hub.hf_hub_download = new if modern else old
            with patch.dict(sys.modules, {"huggingface_hub": hub}):
                parakeet_models._download_snapshot(parakeet_models.DEFAULT_MODEL_ID, events.append)
            self.assertIsNone(calls[0][1])
            self.assertTrue(all(c[1] == "abc123" for c in calls[1:]))
            self.assertTrue(all(c[2] is False for c in calls))
            self.assertEqual(any(e.get("file_bytes") == 100 for e in events), modern)
            self.assertEqual(events[-1]["completed_files"], len(calls))

    @patch.dict(os.environ)
    def test_snapshot_configures_tls_before_hub_download(self):
        expected_ca = "/synthetic/cacert.pem"
        seen_ca_files = []

        def fake_configure():
            os.environ["SSL_CERT_FILE"] = expected_ca
            os.environ["REQUESTS_CA_BUNDLE"] = expected_ca

        def download(repo, filename, revision=None, token=None):
            seen_ca_files.append(os.environ.get("SSL_CERT_FILE"))
            return "/synthetic/snapshots/abc123/" + filename

        hub = types.ModuleType("huggingface_hub")
        hub.hf_hub_download = download
        with patch("src.tls_bootstrap.configure", side_effect=fake_configure), patch.dict(sys.modules, {"huggingface_hub": hub}):
            parakeet_models._download_snapshot(parakeet_models.DEFAULT_MODEL_ID, lambda event: None)

        self.assertTrue(seen_ca_files)
        self.assertTrue(all(value == expected_ca for value in seen_ca_files))
        self.assertEqual(os.environ["REQUESTS_CA_BUNDLE"], expected_ca)


class OfflineLoadTests(unittest.TestCase):
    def test_offline_sessions_restored_after_load_error(self):
        states = []
        modules = _fake_hub_modules(
            offline=False,
            reset_sessions=lambda: states.append(modules["huggingface_hub.constants"].HF_HUB_OFFLINE),
        )
        constants = modules["huggingface_hub.constants"]
        with patch("src.parakeet_models.is_installed", return_value=True), patch.dict(sys.modules, modules), \
                patch("src.parakeet.ensure_loaded", side_effect=RuntimeError("synthetic load error")):
            self.assertFalse(parakeet_models.download())
            self.assertFalse(constants.HF_HUB_OFFLINE)
        self.assertEqual(states, [True, False])


if __name__ == "__main__":
    unittest.main()
