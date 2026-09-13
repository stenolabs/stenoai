"""Parakeet TDT v3 ASR via ONNX Runtime.

Cross-platform sibling of ``_parakeet_mlx``. Uses ``onnx-asr`` to run
the istupakov/parakeet-tdt-0.6b-v3-onnx weights with the int8-quantised
encoder so the bundle size stays comparable to the MLX path (~670 MB
model vs ~600 MB for MLX), and pure CPU so Windows alpha testers
without an NVIDIA GPU get the same behaviour as anyone else.

Public surface matches ``_parakeet_mlx`` so the platform dispatcher in
``src.parakeet`` can swap us in transparently — the live consumer in
simple_recorder.py and the batch caller in src.transcriber.py do not
branch on engine.

A few intentional differences from the MLX path:

* Partials are supported (``SUPPORTS_PARTIALS = True``). onnx-asr's CPU
  inference is fast enough on a modern x86 CPU to keep up with the live
  consumer's 400 ms cadence; the trailing-window re-decode pattern in
  simple_recorder.py already throttles this to a fixed cost per call.
* Sentence-level segments are reconstructed from the model's
  token-level timestamps by grouping on sentence-ending punctuation
  and trailing whitespace boundaries. MLX's parakeet-mlx exposes
  ``result.sentences`` directly; onnx-asr's ``TimestampedResult`` only
  surfaces tokens + per-token start/end times, so we grouping is done
  in ``_result_to_dict``.
"""

from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from src._heartbeat import _emit_heartbeat

logger = logging.getLogger(__name__)

# istupakov's canonical ONNX export of NVIDIA's Parakeet TDT v3 0.6B model.
# Same architecture and capabilities as the MLX variant — multilingual,
# 25 European languages. The "-onnx" suffix is part of the HF repo id.
DEFAULT_MODEL_ID = "istupakov/parakeet-tdt-0.6b-v3-onnx"

# onnx-asr exposes this id under a built-in alias ("nemo-parakeet-tdt-0.6b-v3")
# so we don't have to manage the HF download separately. The alias resolves to
# the same istupakov repo above.
_ONNX_ASR_ALIAS = "nemo-parakeet-tdt-0.6b-v3"

# Use the int8-quantised encoder. The fp32 encoder is ~2.4 GB on disk; int8 is
# ~650 MB with negligible WER impact (<0.5% on Open ASR Leaderboard). Shipping
# fp32 would balloon the Windows installer by 2 GB for no real quality gain.
_QUANTIZATION = "int8"

# Live partials are viable on CPU — see module docstring.
SUPPORTS_PARTIALS = True

# Parakeet TDT v3 expects 16 kHz mono input regardless of backend.
_SAMPLE_RATE = 16000

# Batch-file chunking. onnx-asr has no built-in chunk_duration, so long files
# would feed one giant array to the ORT session and balloon memory the same way
# the MLX path SIGABRTs on metal::malloc. We window the audio manually in
# transcribe_file, recognize each window, then offset + dedupe the token
# timestamps back into one global result. Kept equal to the MLX backend's
# constants (see _parakeet_mlx) so long-meeting behaviour matches per-platform.
PARAKEET_CHUNK_DURATION_S = 60.0
PARAKEET_CHUNK_OVERLAP_S = 15.0

# When deduping the overlap region between adjacent windows, a token whose
# global start lands within this epsilon of the last committed token's end is
# treated as the same token re-emitted in the overlap, not a new one.
_DEDUPE_EPSILON_S = 0.1

# (text-only, with-timestamps) pair, keyed by model_id. Two adapter objects
# wrap the same underlying ORT session — onnx-asr's adapter is lightweight,
# the heavy weight lives in the session. Avoiding a single adapter means we
# can serve the live partial path (text-only is marginally faster) and the
# batch path (needs token timestamps for segments) without re-creating
# either on every call.
_MODEL_CACHE: dict[str, tuple[Any, Any]] = {}
_MODEL_LOCK = threading.Lock()


def _load_model(model_id: str) -> tuple[Any, Any]:
    """Lazily load (and cache) the ONNX Parakeet adapter pair for a model id.

    Returns ``(text_model, timestamped_model)``. Both wrap the same ORT
    session; only the result-shaping differs. CPU-only — we set the
    provider explicitly so onnx-asr doesn't try CUDA/DML and emit a
    confusing warning when those aren't present.

    Raises ImportError if onnx-asr isn't available — caller decides how
    to surface that.
    """
    cached = _MODEL_CACHE.get(model_id)
    if cached is not None:
        return cached
    with _MODEL_LOCK:
        cached = _MODEL_CACHE.get(model_id)
        if cached is not None:
            return cached
        # Force offline resolution when the model is already cached so this
        # load makes no HuggingFace Hub network call. MUST run before onnx-asr
        # (and thus huggingface_hub) is imported — HF_HUB_OFFLINE is read at
        # import time. Gated on is_installed inside, so a fresh download is
        # left online.
        from src.parakeet_models import disable_implicit_hf_token, maybe_enable_offline
        maybe_enable_offline(model_id)
        # Public model — never send an inherited HF token, which would 401 the
        # anonymous fetch. Must precede the onnx-asr import (hub reads the flag
        # at import time), same as maybe_enable_offline.
        disable_implicit_hf_token()
        try:
            import onnx_asr
        except ImportError as e:
            raise ImportError(
                "onnx-asr is not installed. Run `pip install onnx-asr[cpu,hub]` "
                "in the venv (dev) or rebuild the PyInstaller bundle (prod)."
            ) from e
        logger.info("Loading Parakeet (ONNX) model: %s [int8, CPU]", model_id)
        text_model = onnx_asr.load_model(
            _ONNX_ASR_ALIAS,
            quantization=_QUANTIZATION,
            providers=["CPUExecutionProvider"],
        )
        ts_model = text_model.with_timestamps()
        _MODEL_CACHE[model_id] = (text_model, ts_model)
        logger.info("Parakeet (ONNX) model loaded")
        return _MODEL_CACHE[model_id]


def model_sample_rate(model_id: str = DEFAULT_MODEL_ID) -> int:
    """Sample rate the model expects (used to configure the mic + VAD).

    Parakeet TDT v3 is hard-pinned to 16 kHz mono on every backend, so
    we return the constant rather than touching the model — avoids a
    cold-import + load just to answer this question at startup.
    """
    return _SAMPLE_RATE


def ensure_loaded(model_id: str = DEFAULT_MODEL_ID) -> None:
    """Pre-load the model on a background thread.

    Mirrors ``_parakeet_mlx.ensure_loaded``. The first transcribe call
    pays the warm-load cost (~2 s for ONNX session init + int8 encoder
    mmap; ~30 s on first ever run when the snapshot still has to
    download from HuggingFace).
    """
    _load_model(model_id)


# ---------------------------------------------------------------------------
# Batch — file
# ---------------------------------------------------------------------------

def transcribe_file(
    audio_path: Path,
    language: Optional[str] = None,
    model_id: str = DEFAULT_MODEL_ID,
) -> dict:
    """Transcribe a WAV file end-to-end.

    Returns the shape the existing pipeline expects: ``text``,
    ``segments`` (list of ``{text, start, end}``), ``duration_seconds``,
    ``detected_language``, ``detected_language_probability``.

    ``language`` is accepted for forward compatibility — Parakeet TDT v3
    is multilingual and language-agnostic at inference time. We surface
    the value the caller passed in ``detected_language`` when concrete.
    """
    if not audio_path.exists():
        logger.error("Audio file not found: %s", audio_path)
        return _empty_result()

    _, ts_model = _load_model(model_id)
    logger.info("Transcribing (batch file): %s", audio_path)

    samples = _load_wav_16k_mono(audio_path)
    if samples is None:
        # Unexpected header (not 16 kHz / 16-bit PCM, or unreadable). Let
        # onnx-asr open + resample the file itself in a single, non-chunked
        # pass — the pre-chunking behaviour. The diarisation splitter always
        # hands us 16 kHz mono PCM, so this fallback is rare and the large-file
        # memory risk it carries effectively never fires in the common path.
        result = ts_model.recognize(str(audio_path), sample_rate=_SAMPLE_RATE)
        return _result_to_dict(result, language)

    chunk_samples = int(PARAKEET_CHUNK_DURATION_S * _SAMPLE_RATE)
    if len(samples) <= chunk_samples:
        # Short-file fast path: one window, no offset/dedupe bookkeeping.
        result = ts_model.recognize(samples, sample_rate=_SAMPLE_RATE)
        return _result_to_dict(result, language)

    merged = _transcribe_windows(ts_model, samples)
    return _result_to_dict(merged, language)


# ---------------------------------------------------------------------------
# Batch — in-memory samples
# ---------------------------------------------------------------------------

def transcribe_samples(
    samples_16k,
    language: Optional[str] = None,
    model_id: str = DEFAULT_MODEL_ID,
) -> dict:
    """Transcribe an in-memory float32 buffer at 16 kHz.

    Hot path for the live VAD-gated consumer — both throttled partials
    and per-utterance finals call this on speech buffers that already
    live in memory.

    ``samples_16k`` may be a numpy float32 array (mono) or any sequence
    onnx-asr can interpret as one. The live consumer always passes
    numpy.
    """
    import numpy as np

    text_model, _ = _load_model(model_id)
    arr = np.asarray(samples_16k, dtype=np.float32).reshape(-1)
    # Sub-100 ms inputs are below ONNX's minimum feasible frame count and
    # produce empty/garbage output. Bail early — mirrors the MLX path.
    if arr.shape[0] < (_SAMPLE_RATE // 10):
        return _empty_result()
    # Use the text-only adapter for partials — timestamps aren't read by
    # the live consumer and skipping them shaves a small amount of CPU.
    result = text_model.recognize(arr, sample_rate=_SAMPLE_RATE)
    # text_model returns a TextResult (just text). Wrap to the dict shape.
    text = _extract_text(result)
    return {
        "text": text or None,
        "segments": [],
        "duration_seconds": float(arr.shape[0]) / _SAMPLE_RATE,
        "detected_language": language if (language and language != "auto") else None,
        "detected_language_probability": None,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Sentence-boundary punctuation. Same set for all Parakeet languages — the
# model emits ASCII punctuation even for Cyrillic/Greek output, so we don't
# need locale-aware sentence splitters here.
_SENTENCE_END = re.compile(r"[.!?]+")


def _extract_text(result: Any) -> str:
    """Pull a plain text string out of any onnx-asr result type.

    ``TextResult`` exposes ``.text``; ``TimestampedResult`` likewise.
    Some onnx-asr versions return a bare string directly. Be permissive
    so a library bump doesn't quietly break the live path.
    """
    if isinstance(result, str):
        return result.strip()
    text = getattr(result, "text", None)
    if isinstance(text, str):
        return text.strip()
    return ""


def _result_to_dict(result: Any, language: Optional[str]) -> dict:
    """Convert a TimestampedResult into the pipeline's expected dict shape.

    onnx-asr's TimestampedResult exposes ``text`` plus parallel
    ``tokens`` / ``timestamps`` lists. We reconstruct sentence-level
    segments by walking tokens and cutting on sentence-ending
    punctuation, so downstream callers (diarisation, summarisation)
    get the same ``{text, start, end}`` shape parakeet-mlx returns
    via ``result.sentences``.
    """
    text = _extract_text(result)
    tokens = list(getattr(result, "tokens", None) or [])
    timestamps = list(getattr(result, "timestamps", None) or [])

    segments = _group_tokens_into_sentences(tokens, timestamps)
    duration = segments[-1]["end"] if segments else None
    if duration is None and timestamps:
        # Fall back to last token's end time when we couldn't group cleanly.
        last_ts = timestamps[-1]
        duration = float(_ts_end(last_ts))

    detected_language = language if (language and language != "auto") else None
    # None when the result came from a single non-windowed pass (onnx-asr's
    # own TimestampedResult, or a file shorter than one window) -- there is
    # no windowing there, so there is nothing that could have been lost.
    total = float(getattr(result, "total_seconds", 0) or 0)
    covered = float(getattr(result, "covered_seconds", 0) or 0)
    coverage = min(1.0, covered / total) if total > 0 else None

    return {
        "text": text or None,
        "segments": segments,
        "duration_seconds": duration,
        "detected_language": detected_language,
        "detected_language_probability": None,
        "window_coverage": coverage,
    }


def _ts_start(ts: Any) -> float:
    """Normalise a single timestamp entry to a float start time.

    onnx-asr timestamps come through as ``(start, end)`` tuples in
    current releases; tolerate dict or object shapes too in case the
    API tightens later.
    """
    if isinstance(ts, (tuple, list)) and len(ts) >= 1:
        return float(ts[0] or 0.0)
    if isinstance(ts, dict):
        return float(ts.get("start", 0.0) or 0.0)
    return float(getattr(ts, "start", 0.0) or 0.0)


def _ts_end(ts: Any) -> float:
    if isinstance(ts, (tuple, list)) and len(ts) >= 2:
        return float(ts[1] or 0.0)
    if isinstance(ts, dict):
        return float(ts.get("end", ts.get("start", 0.0)) or 0.0)
    return float(getattr(ts, "end", getattr(ts, "start", 0.0)) or 0.0)


def _group_tokens_into_sentences(tokens: list, timestamps: list) -> list[dict]:
    """Walk paired (token, timestamp) entries, cut on sentence-ending
    punctuation, emit ``{text, start, end}`` dicts.

    If tokens and timestamps lengths don't agree (defensive — newer
    onnx-asr versions may insert a leading <eos> token without a
    timestamp), we fall back to a single whole-utterance segment so
    callers still get something usable.
    """
    if not tokens or not timestamps or len(tokens) != len(timestamps):
        return _fallback_segment(tokens, timestamps)

    segments: list[dict] = []
    current_tokens: list[str] = []
    current_start: Optional[float] = None
    current_end: float = 0.0

    for tok, ts in zip(tokens, timestamps):
        tok_str = tok if isinstance(tok, str) else str(tok)
        if not tok_str:
            continue
        start = _ts_start(ts)
        end = _ts_end(ts)
        if current_start is None:
            current_start = start
            # Seed current_end from the segment start so a segment whose tokens
            # all carry end==0.0 (unrecognised timestamp shape) never emits an
            # end < start span to diarisation/summarisation.
            current_end = start
        current_tokens.append(tok_str)
        current_end = end if end > current_end else current_end
        if _SENTENCE_END.search(tok_str):
            text = "".join(current_tokens).strip()
            if text:
                segments.append({"text": text, "start": current_start, "end": current_end})
            current_tokens = []
            current_start = None
            current_end = 0.0

    # Tail: tokens after the last sentence-ending punctuation become one
    # final segment so they're not silently dropped.
    if current_tokens and current_start is not None:
        text = "".join(current_tokens).strip()
        if text:
            segments.append({"text": text, "start": current_start, "end": current_end})

    return segments


def _fallback_segment(tokens: list, timestamps: list) -> list[dict]:
    """Build a single segment spanning the whole utterance when token-level
    grouping isn't possible (mismatched lengths, empty timestamps).

    Better than returning an empty segments list — the diarisation /
    summarisation pipeline still gets a usable transcript with rough
    start/end bounds.
    """
    if not tokens:
        return []
    text = "".join(tok if isinstance(tok, str) else str(tok) for tok in tokens).strip()
    if not text:
        return []
    start = _ts_start(timestamps[0]) if timestamps else 0.0
    end = _ts_end(timestamps[-1]) if timestamps else 0.0
    return [{"text": text, "start": start, "end": end}]


def _empty_result() -> dict:
    return {
        "text": None,
        "segments": [],
        "duration_seconds": None,
        "detected_language": None,
        "detected_language_probability": None,
    }


# ---------------------------------------------------------------------------
# Manual long-file windowing (onnx-asr has no built-in chunk_duration)
# ---------------------------------------------------------------------------

@dataclass
class _SimpleResult:
    """Minimal stand-in for onnx-asr's TimestampedResult.

    Exposes just the three attributes ``_result_to_dict`` /
    ``_group_tokens_into_sentences`` read — ``text``, ``tokens``,
    ``timestamps`` — so a merged multi-window transcript flows through the
    exact same shaping path as a single-window TimestampedResult.

    Coverage is the union of audio read by usable windows, not their count:
    overlapping windows and a short final window have different weights.
    Counters remain available for diagnostics. Native onnx-asr results have
    no coverage fields, so readers use getattr with a default.
    """
    text: str
    tokens: list
    timestamps: list
    windows_attempted: int = 0
    windows_recognized: int = 0
    total_seconds: float = 0.0
    covered_seconds: float = 0.0


def _load_wav_16k_mono(audio_path: Path):
    """Load a WAV as a mono float32 numpy array, or ``None`` if the header
    isn't the 16 kHz / 16-bit PCM the diarisation splitter produces.

    Returning ``None`` signals ``transcribe_file`` to fall back to onnx-asr's
    own path-based open + resample (a single, non-chunked pass) rather than
    guessing at an unexpected format. Stereo is downmixed by averaging.
    """
    import wave

    import numpy as np

    try:
        with wave.open(str(audio_path), "rb") as wf:
            n_channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            framerate = wf.getframerate()
            n_frames = wf.getnframes()
            if sampwidth != 2 or framerate != _SAMPLE_RATE:
                return None
            raw = wf.readframes(n_frames)
    except (wave.Error, EOFError, OSError) as e:
        logger.warning("Could not read WAV %s for chunking: %s", audio_path, e)
        return None

    if not raw:
        return None
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if n_channels > 1:
        # Interleaved frames → average channels down to mono.
        samples = samples.reshape(-1, n_channels).mean(axis=1)
    return samples


def _transcribe_windows(ts_model: Any, samples) -> _SimpleResult:
    """Window ``samples`` into overlapping chunks, recognise each, and merge
    the token-level results into one ``_SimpleResult`` with global timestamps.

    Each window's local timestamps are offset by the window's start time; the
    overlap region between adjacent windows is deduped by dropping any token
    whose global start lands before the last committed token's end (minus an
    epsilon). A single window whose ``recognize`` raises is logged and skipped,
    so one bad window degrades to a small gap rather than failing the whole
    meeting — but if *every* window fails (a broken model/session), we raise so
    the caller marks it a transcription failure instead of returning an empty
    result that would be mislabelled as silence.
    """
    chunk_samples = int(PARAKEET_CHUNK_DURATION_S * _SAMPLE_RATE)
    step_samples = int((PARAKEET_CHUNK_DURATION_S - PARAKEET_CHUNK_OVERLAP_S) * _SAMPLE_RATE)
    if step_samples <= 0:
        # Defensive: overlap >= chunk would make us never advance.
        step_samples = chunk_samples

    # Total windows the loop below will attempt: one per step until a window
    # reaches the end of the samples. Only used for heartbeat progress.
    total_windows = max(1, -(-(len(samples) - chunk_samples) // step_samples) + 1)

    merged_tokens: list = []
    merged_timestamps: list = []
    last_end = -1.0
    windows_attempted = 0
    windows_recognized = 0
    covered_samples = 0
    covered_upto = 0
    last_error: Optional[Exception] = None

    for start in range(0, len(samples), step_samples):
        window = samples[start:start + chunk_samples]
        if len(window) == 0:
            break
        chunk_start_s = start / _SAMPLE_RATE
        windows_attempted += 1
        try:
            result = ts_model.recognize(window, sample_rate=_SAMPLE_RATE)
        except Exception as e:
            last_error = e
            logger.warning("ONNX window at %.1fs failed, skipping: %s", chunk_start_s, e)
            if start + chunk_samples >= len(samples):
                break
            continue
        # The model returned, so the backend is alive even if this payload is
        # malformed and cannot count toward transcript coverage.
        _emit_heartbeat(windows_attempted, total_windows)
        tokens = list(getattr(result, "tokens", None) or [])
        timestamps = list(getattr(result, "timestamps", None) or [])
        if len(tokens) != len(timestamps):
            # Can't align tokens to times for this window — skip it cleanly
            # rather than emit corrupt global timestamps.
            logger.warning(
                "ONNX window at %.1fs had %d tokens / %d timestamps, skipping",
                chunk_start_s, len(tokens), len(timestamps),
            )
            if start + chunk_samples >= len(samples):
                break
            continue

        windows_recognized += 1
        # Count the union only after payload validation. The watermark avoids
        # counting overlap twice and excludes gaps left by skipped windows.
        window_end = min(start + chunk_samples, len(samples))
        if window_end > covered_upto:
            covered_samples += window_end - max(start, covered_upto)
            covered_upto = window_end
        for tok, ts in zip(tokens, timestamps):
            g_start = _ts_start(ts) + chunk_start_s
            g_end = _ts_end(ts) + chunk_start_s
            # Drop the overlap-region re-transcription: the previous window
            # already committed these seconds.
            if g_start < last_end - _DEDUPE_EPSILON_S:
                continue
            merged_tokens.append(tok)
            merged_timestamps.append((g_start, g_end))
            if g_end > last_end:
                last_end = g_end

        if start + chunk_samples >= len(samples):
            break

    # Every window's recognize() raised → this is a real transcription failure,
    # not silence. Raise so transcribe_file → transcribe_audio tags it
    # transcription_failed and preserves the audio, rather than returning an
    # empty result the pipeline would mislabel as "No speech detected".
    if windows_attempted > 0 and windows_recognized == 0:
        raise RuntimeError(
            f"all {windows_attempted} ONNX transcription windows failed"
        ) from last_error

    text = "".join(
        tok if isinstance(tok, str) else str(tok) for tok in merged_tokens
    ).strip()
    total_seconds = len(samples) / _SAMPLE_RATE
    covered_seconds = covered_samples / _SAMPLE_RATE
    if covered_seconds < total_seconds:
        logger.warning(
            "ONNX transcription read %.0fs of %.0fs (%d of %d windows usable); "
            "the transcript is missing roughly %.0fs of audio",
            covered_seconds, total_seconds, windows_recognized, windows_attempted,
            total_seconds - covered_seconds,
        )
    return _SimpleResult(
        text=text,
        tokens=merged_tokens,
        timestamps=merged_timestamps,
        windows_attempted=windows_attempted,
        windows_recognized=windows_recognized,
        total_seconds=total_seconds,
        covered_seconds=covered_seconds,
    )
