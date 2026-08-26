import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from src import parakeet_models


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
        with patch("src.parakeet.ensure_loaded", side_effect=masking), \
                self.assertLogs("src.parakeet_models", level="ERROR") as cm:
            ok = parakeet_models.download(model_id)
        self.assertFalse(ok)
        joined = "\n".join(cm.output)
        self.assertIn("HF_TOKEN", joined)
        self.assertIn("401", joined)

    def test_unrelated_error_uses_plain_message(self):
        with patch("src.parakeet.ensure_loaded", side_effect=RuntimeError("boom")), \
                self.assertLogs("src.parakeet_models", level="ERROR") as cm:
            ok = parakeet_models.download(parakeet_models.DEFAULT_MODEL_ID)
        self.assertFalse(ok)
        joined = "\n".join(cm.output)
        self.assertIn("download/load failed", joined)
        self.assertNotIn("HF_TOKEN", joined)


if __name__ == "__main__":
    unittest.main()
