"""Mel filterbank in plain numpy, standing in for ``librosa`` in the bundle.

parakeet-mlx does ``import librosa`` at module level and calls exactly one
function from it: ``librosa.filters.mel(..., norm="slaney")``, once per model
load, to build the filterbank for its log-mel front end. Bundling librosa for
that one call drags in numba, llvmlite, scipy and scikit-learn -- ~170 MB of
the macOS app for a 128x257 matrix.

``install_librosa_shim()`` registers a minimal ``librosa`` module exposing only
``filters.mel`` so parakeet-mlx imports without the real package, and
stenoai.spec excludes librosa and its dependency chain. The implementation
mirrors librosa's Slaney-style mel scale (``htk=False``) and Slaney area
normalisation; tests/test_mel_shim.py checks it against real librosa.
"""

from __future__ import annotations

import sys
import types

import numpy as np

# Slaney mel scale: linear below 1 kHz, logarithmic above.
_F_SP = 200.0 / 3
_MIN_LOG_HZ = 1000.0
_MIN_LOG_MEL = _MIN_LOG_HZ / _F_SP
_LOGSTEP = np.log(6.4) / 27.0


def _hz_to_mel(freqs: np.ndarray) -> np.ndarray:
    freqs = np.asanyarray(freqs, dtype=np.float64)
    mels = freqs / _F_SP
    log_t = freqs >= _MIN_LOG_HZ
    mels[log_t] = _MIN_LOG_MEL + np.log(freqs[log_t] / _MIN_LOG_HZ) / _LOGSTEP
    return mels


def _mel_to_hz(mels: np.ndarray) -> np.ndarray:
    mels = np.asanyarray(mels, dtype=np.float64)
    freqs = _F_SP * mels
    log_t = mels >= _MIN_LOG_MEL
    freqs[log_t] = _MIN_LOG_HZ * np.exp(_LOGSTEP * (mels[log_t] - _MIN_LOG_MEL))
    return freqs


def mel(
    *,
    sr: float,
    n_fft: int,
    n_mels: int = 128,
    fmin: float = 0.0,
    fmax: float | None = None,
    htk: bool = False,
    norm: str | None = "slaney",
    dtype=np.float32,
) -> np.ndarray:
    """Return a ``(n_mels, 1 + n_fft // 2)`` mel filterbank, as librosa does."""
    if htk or norm != "slaney":
        # Only the configuration parakeet-mlx uses is implemented; anything
        # else should fail loudly rather than return a subtly different bank.
        raise NotImplementedError("mel shim supports htk=False, norm='slaney' only")
    if fmax is None:
        fmax = float(sr) / 2

    fftfreqs = np.fft.rfftfreq(n=n_fft, d=1.0 / sr)
    mel_f = _mel_to_hz(
        np.linspace(_hz_to_mel(np.array([fmin]))[0], _hz_to_mel(np.array([fmax]))[0], n_mels + 2)
    )
    fdiff = np.diff(mel_f)
    ramps = np.subtract.outer(mel_f, fftfreqs)

    weights = np.zeros((n_mels, 1 + n_fft // 2), dtype=dtype)
    for i in range(n_mels):
        lower = -ramps[i] / fdiff[i]
        upper = ramps[i + 2] / fdiff[i + 1]
        weights[i] = np.maximum(0, np.minimum(lower, upper))

    enorm = 2.0 / (mel_f[2 : n_mels + 2] - mel_f[:n_mels])
    weights *= enorm[:, np.newaxis]
    return weights


def install_librosa_shim() -> None:
    """Register a stub ``librosa`` exposing ``filters.mel``, unless one is loaded.

    Always installed (not only when librosa is missing) so dev and the bundle
    run the same filterbank code. A real librosa already imported by the
    process is left alone.
    """
    if "librosa" in sys.modules:
        return
    filters = types.ModuleType("librosa.filters")
    filters.mel = mel
    librosa = types.ModuleType("librosa")
    librosa.filters = filters
    librosa.__stenoai_shim__ = True
    sys.modules["librosa"] = librosa
    sys.modules["librosa.filters"] = filters
