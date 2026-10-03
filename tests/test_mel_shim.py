import importlib
import importlib.util
import sys
import types
import unittest

import numpy as np

from src import _mel


def _librosa_modules() -> dict:
    return {k: v for k, v in sys.modules.items() if k == "librosa" or k.startswith("librosa.")}


def _real_librosa():
    """Import the real librosa even if the shim already occupies sys.modules,
    restoring the complete librosa.* subtree afterwards."""
    saved = _librosa_modules()
    for k in saved:
        del sys.modules[k]
    try:
        if importlib.util.find_spec("librosa") is None:
            return None
        mod = importlib.import_module("librosa")
        if getattr(mod, "__stenoai_shim__", False):
            return None
        return mod
    finally:
        for k in _librosa_modules():
            del sys.modules[k]
        sys.modules.update(saved)


class MelShimTests(unittest.TestCase):
    def test_shape_and_dtype(self):
        bank = _mel.mel(sr=16000, n_fft=512, n_mels=128, fmin=0, fmax=8000, norm="slaney")
        self.assertEqual(bank.shape, (128, 257))
        self.assertEqual(bank.dtype, np.float32)
        self.assertTrue(np.all(bank >= 0))

    def test_unsupported_config_fails_loudly(self):
        with self.assertRaises(NotImplementedError):
            _mel.mel(sr=16000, n_fft=512, htk=True)
        with self.assertRaises(NotImplementedError):
            _mel.mel(sr=16000, n_fft=512, norm=None)

    def test_matches_librosa(self):
        librosa = _real_librosa()
        if librosa is None:
            self.skipTest("librosa not installed; nothing to compare against")
        # Parakeet TDT v3's preprocessor config, plus a second shape so the
        # match isn't specific to one set of parameters.
        for sr, n_fft, n_mels in [(16000, 512, 128), (22050, 1024, 80)]:
            kw = dict(sr=sr, n_fft=n_fft, n_mels=n_mels, fmin=0, fmax=sr / 2, norm="slaney")
            np.testing.assert_allclose(
                _mel.mel(**kw), librosa.filters.mel(**kw), rtol=1e-5, atol=1e-7
            )

    def test_install_shim_registers_filters_mel(self):
        saved = _librosa_modules()
        for k in saved:
            del sys.modules[k]
        try:
            _mel.install_librosa_shim()
            self.assertIs(sys.modules["librosa"].filters.mel, _mel.mel)
            self.assertIs(sys.modules["librosa.filters"].mel, _mel.mel)
        finally:
            for k in _librosa_modules():
                del sys.modules[k]
            sys.modules.update(saved)

    def test_install_shim_leaves_a_loaded_librosa_alone(self):
        saved = _librosa_modules()
        sentinel = types.ModuleType("librosa")
        sys.modules["librosa"] = sentinel
        try:
            _mel.install_librosa_shim()
            self.assertIs(sys.modules["librosa"], sentinel)
            self.assertFalse(hasattr(sentinel, "filters"))
        finally:
            for k in _librosa_modules():
                del sys.modules[k]
            sys.modules.update(saved)

if __name__ == "__main__":
    unittest.main()
