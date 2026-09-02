"""Batch transcription via Parakeet TDT v3 (MLX).

Replaces the previous pywhispercpp + openai-whisper backends. One engine
for live (in simple_recorder.py's VAD-gated consumer) and post-stop
(here), which means a recording's live transcript and final transcript
share the same model — no flavour mismatch between what the user saw
during recording and what summarisation sees afterwards.

Public surface kept compatible with the prior whisper-era pipeline so
the rest of the codebase doesn't churn:

* ``WhisperTranscriber`` (class name retained for callers / tests)
  - ``transcribe_audio(path, language)`` — single-channel batch
  - ``transcribe_diarised(path, language)`` — stereo channel split into
    [You] / [Others] turns
  - ``transcribe_with_timestamps(path)`` — segment-level timing

The stereo channel split, RMS-energy gating, and speaker-bleed collapse
all stay — they operate on transcript text + audio metadata, not on the
specific ASR engine.

Whisper-era hallucination filtering ("Thank you." / "Bye." on silence)
is gone: Parakeet doesn't produce those canned phrases on silent or
noisy input (verified empirically — pure silence, low noise, and
isolated clicks all return empty). Filtering by phrase against a real
ASR engine would now strictly remove real speech without preventing
anything; the model is the source of truth.
"""

import contextlib
import inspect
import json
import logging
import math
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Tuple

from src._heartbeat import _emit_heartbeat
from src.speaker_suggestions import (
    SAME_MEETING_MERGE_DISTANCE_THRESHOLD,
    SUGGESTION_MIN_AVG_TURN_SECONDS,
    build_clusters_from_diarization,
    determine_recording_type,
)

logger = logging.getLogger(__name__)


# --- Tunables ---------------------------------------------------------------
# Speaker-bleed detection: collapse to mic-only when the two-channel
# transcripts overlap above this Jaccard similarity. True bleed (no
# headphones, mic picks up speaker echo) is consistently >0.8 in practice;
# a real two-party call where the same audio doesn't reach both channels
# is typically <0.2. 0.6 leaves wide headroom on either side.
BLEED_JACCARD_THRESHOLD = 0.6

# Per-segment bleed correction. Whole-transcript Jaccard catches
# catastrophic bleed but misses the case where ASR word-level differences
# ("weight" vs "wait", "let me" vs "let") drop the aggregate similarity
# into the 0.5-0.6 gap while individual adjacent segments still obviously
# echo. For each system_segment we find the nearest mic_segment by start
# time within ±PER_SEGMENT_BLEED_WINDOW_S and drop it if Jaccard exceeds
# the per-segment threshold. Threshold is lower than the whole-transcript
# one because per-segment text is shorter — random vocabulary overlap is
# rarer in a single sentence than across a whole call.
PER_SEGMENT_BLEED_JACCARD = 0.5
PER_SEGMENT_BLEED_WINDOW_S = 3.0
# Minimum-length gate. Short utterances ("Yes", "OK", "thanks", "好的")
# trivially Jaccard-match across channels when both speakers genuinely
# say the same brief thing — the dedup would then delete a real Others
# reply rather than a bleed echo. We gate on character count instead of
# token count because Python's ``\w+`` matches a whole CJK sentence as
# one continuous token (no inter-word spaces), so a token-based gate
# would silently disable bleed correction for Chinese / Japanese /
# Thai etc. ~15 chars is "substantial sentence" in any script: ~3-4
# English words, ~5-6 CJK ideographs. The whole-transcript backstop
# still catches catastrophic bleed where every line is short.
PER_SEGMENT_BLEED_MIN_CHARS = 15

# Audio pre-processing before batch transcription. A gentle high-pass strips
# low-frequency rumble (HVAC, desk thumps, handling noise) below the voice
# band, and single-pass loudness normalization lifts quiet stretches toward a
# consistent level — cleaner input improves ASR accuracy and reduces
# hallucination on near-silent passages. Single-pass (dynamic) loudnorm is
# deliberate: the two-pass variant would double decode time for marginal gain.
AUDIO_HIGHPASS_HZ = 90
AUDIO_LOUDNORM = "I=-16:TP=-1.5:LRA=11"

# ffmpeg wall-clock cap for the pre-processing pass. Decode+filter+encode of
# 16 kHz mono runs far faster than realtime (~30 s for a 3-hour meeting);
# 10 minutes is generous headroom before we give up and use the original.
AUDIO_PREPROCESS_TIMEOUT_S = 600

# Floor for the per-channel diarised split decode (see
# _diarised_split_timeout). The split fully decodes the whole recording once
# per channel; a fixed 120 s used to silently time out on multi-hour stereo
# files and drop us back to a mono (no [You]/[Others]) transcript. Matches the
# pre-process floor; the helper scales it up with duration for long meetings.
DIARISED_SPLIT_TIMEOUT_S = 600

# Timeout for the channel-COUNT probe in _split_stereo_to_channels (`-t 0`,
# header-only -- runs BEFORE we know duration, so unlike the timeouts above
# this can't scale with it). Should be near-instant, but a live-recorded
# WebM (no seek index) measured >15s on a real ~3.5h recording -- same
# silent-mono-fallback failure this whole file already guards against
# elsewhere, just one step earlier in the pipeline.
CHANNEL_DETECT_TIMEOUT_S = 60

# RMS energy gate for "channel has speech". Intentionally low (-70 dB) so
# headphones-mode mic recordings — captured at much lower amplitude than
# speakers-mode — still pass. The model handles low-amplitude speech fine;
# this gate's only job is to skip channels with effectively zero audio.
MIN_RMS_THRESHOLD = 0.0003

# Cap how many 1-second windows we sample when scanning RMS so a 30-min
# recording doesn't pull all 30 min of int16 samples into Python lists.
RMS_MAX_WINDOWS = 60

# Acoustic per-channel speaker diarization (steno-diarize sidecar, macOS
# only). Merge gap for consecutive same-speaker diarizer segments — reduces
# diarization flicker and shrinks the gaps that cause boundary sentence
# misattribution in _assign_asr_segments_to_diar_segments. Matches the value
# validated against real meeting audio in the research playground.
STENO_DIARIZE_MERGE_GAP_S = 0.3

# Cross-channel echo can make the same voice appear in both independent
# diarization runs. Only merge mutual-nearest embedding pairs that are as
# tight as the already-validated same-meeting fragment threshold, and whose
# runner-up is clearly worse. The margin prevents two acoustically similar
# speakers from being joined merely because both fall below the distance
# cutoff.
CROSS_CHANNEL_SPEAKER_MATCH_MARGIN = 0.05

# Floor for the steno-diarize subprocess timeout. Real measured runtime
# varies a lot with recording length: single-digit-to-tens-of-seconds for
# short/typical meetings, but a real ~3.5h recording measured ~18 minutes
# for the embedding-extraction phase alone on the pre-highContextV2 config
# (segmentation + embedding combined dropped to ~23s for a real ~21-minute
# file after switching to SortformerConfig.highContextV2 for long enough
# recordings -- see main.swift's sortformerHighContextMinDuration). This
# floor leaves generous headroom under Electron's 8-minute inactivity
# watchdog while still bounding a runaway on pathological input; it's
# scaled up by duration for long recordings, same pattern as
# _diarised_split_timeout, so the real ceiling tracks recording length.
STENO_DIARIZE_TIMEOUT_FLOOR_S = 120

# If one diarizer cluster holds this share (or more) of a channel's total
# speaking time, short minority clusters are folded into the dominant
# speaker's transcript label. Sustained minority clusters still remain
# distinct after clearing both the cumulative-duration floor and the existing
# calibrated average-turn floor used by speaker suggestions. This keeps many
# tiny echo/crosstalk fragments from adding up to a false additional speaker.
CHANNEL_DOMINANCE_THRESHOLD = 0.92
CHANNEL_DOMINANCE_MIN_MINOR_SPEECH_SECONDS = 15.0
CHANNEL_DOMINANCE_MIN_AVG_TURN_SECONDS = SUGGESTION_MIN_AVG_TURN_SECONDS

# Sentinel text substituted when transcription produces no usable output
# (genuine silence or all-hallucination). Callers compare against this to
# distinguish "really nothing was said" from a real (possibly short)
# transcript — keep it in one place so the live-transcript fallback (#207)
# can detect it exactly.
SILENCE_SENTINEL = "No speech detected in audio"


# Resolve a usable ffmpeg binary. Electron-spawned subprocesses don't inherit
# the user's shell PATH (no /opt/homebrew/bin), so a bare `ffmpeg` string fails
# silently and breaks the stereo-channel split downstream. Look in PyInstaller
# bundle locations first, then PATH, then standard install paths. Cached on
# first successful resolve; lock guards the cache against concurrent first
# calls from multiple transcription threads.
_FFMPEG_PATH_CACHE: Optional[str] = None
_FFMPEG_PATH_LOCK = threading.Lock()


def _resolve_ffmpeg() -> Optional[str]:
    global _FFMPEG_PATH_CACHE
    if _FFMPEG_PATH_CACHE is not None:
        return _FFMPEG_PATH_CACHE
    with _FFMPEG_PATH_LOCK:
        if _FFMPEG_PATH_CACHE is not None:
            return _FFMPEG_PATH_CACHE
        import shutil
        exe_suffix = ".exe" if sys.platform == "win32" else ""
        binary_name = f"ffmpeg{exe_suffix}"
        candidates: list[str] = []
        if getattr(sys, 'frozen', False):
            exe_dir = Path(sys.executable).parent
            candidates.extend([
                str(exe_dir / binary_name),
                str(exe_dir / '_internal' / binary_name),
            ])
        # PATH (cross-platform; honours PATHEXT on Windows)
        on_path = shutil.which("ffmpeg")
        if on_path:
            candidates.append(on_path)
        if sys.platform != "win32":
            candidates.extend([
                '/opt/homebrew/bin/ffmpeg',
                '/usr/local/bin/ffmpeg',
                '/usr/bin/ffmpeg',
            ])
        for cand in candidates:
            try:
                r = subprocess.run([cand, '-version'], capture_output=True, timeout=5)
                if r.returncode == 0:
                    _FFMPEG_PATH_CACHE = cand
                    logger.info(f"ffmpeg resolved at: {cand}")
                    return cand
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
        logger.warning("ffmpeg not found in any candidate location")
        return None


# Resolve the bundled steno-diarize binary (macOS-only Swift/CoreML speaker
# diarization sidecar, built by scripts/build-diarize-sidecar.sh). Mirrors
# _resolve_ffmpeg()'s bundle-then-fallback lookup, but checks executability
# instead of running a cheap probe invocation — there's no equivalent to
# `ffmpeg -version` for this binary, so a bad binary still fails safely at
# actual call time via _run_steno_diarize's blanket failure handling.
_STENO_DIARIZE_PATH_CACHE: Optional[str] = None
_STENO_DIARIZE_PATH_LOCK = threading.Lock()


def _resolve_steno_diarize() -> Optional[str]:
    global _STENO_DIARIZE_PATH_CACHE
    if sys.platform != "darwin":
        return None
    if _STENO_DIARIZE_PATH_CACHE is not None:
        return _STENO_DIARIZE_PATH_CACHE
    with _STENO_DIARIZE_PATH_LOCK:
        if _STENO_DIARIZE_PATH_CACHE is not None:
            return _STENO_DIARIZE_PATH_CACHE
        candidates: list[str] = []
        # Same spirit as the STENO_DIARIZE_* env knobs on the Swift side —
        # lets a T2 e2e spec point at a fixture binary without touching the
        # real bundle resolution.
        override = os.environ.get("STENOAI_DIARIZE_SIDECAR_PATH")
        if override:
            candidates.append(override)
        if getattr(sys, 'frozen', False):
            exe_dir = Path(sys.executable).parent
            candidates.extend([
                str(exe_dir / 'steno-diarize'),
                str(exe_dir / '_internal' / 'steno-diarize'),
            ])
        else:
            # Dev: repo-root bin/, built by scripts/build-diarize-sidecar.sh
            repo_root = Path(__file__).resolve().parent.parent
            candidates.append(str(repo_root / 'bin' / 'steno-diarize'))
        for cand in candidates:
            if os.access(cand, os.X_OK):
                _STENO_DIARIZE_PATH_CACHE = cand
                logger.info(f"steno-diarize resolved at: {cand}")
                return cand
        logger.info("steno-diarize not found; per-channel speaker labeling falls back to legacy You/Others")
        return None


def _audio_filter_chain() -> str:
    """The ffmpeg ``-af`` chain applied to mono audio before transcription."""
    return f"highpass=f={AUDIO_HIGHPASS_HZ},loudnorm={AUDIO_LOUDNORM}"


def _parse_channels_from_ffmpeg_stderr(stderr: str) -> Optional[int]:
    """Parse "Audio: ..., stereo|mono|N channels" from ffmpeg's `-i` output."""
    m = re.search(r'Audio: [^\n]*?(stereo|mono|(\d+) channels)', stderr)
    if not m:
        return None
    token = m.group(1)
    if token == 'stereo':
        return 2
    if token == 'mono':
        return 1
    return int(m.group(2))


def _parse_duration_from_ffmpeg_stderr(stderr: str) -> Optional[float]:
    """Parse "Duration: HH:MM:SS.mmm" from ffmpeg's `-i` output."""
    m = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', stderr)
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def _diarised_split_timeout(duration_seconds: Optional[float]) -> int:
    """Wall-clock cap for one per-channel ffmpeg decode of the full recording.

    A single channel split decodes the entire file; ffmpeg decode runs well
    under 2x realtime even on a slow CPU-only box, so scaling the cap to
    ``duration * 2`` leaves generous headroom while still bounding a runaway.
    The previous fixed 120 s silently timed out on multi-hour stereo meetings
    and dropped the whole recording back to a mono (no [You]/[Others])
    transcript. When duration is unknown (some WebM headers) we fall back to
    the floor, which still comfortably beats the old 120 s.
    """
    if duration_seconds and duration_seconds > 0:
        return max(DIARISED_SPLIT_TIMEOUT_S, int(duration_seconds * 2))
    return DIARISED_SPLIT_TIMEOUT_S


try:
    import numpy as _np
    _NUMPY_AVAILABLE = True
except ImportError:
    _np = None
    _NUMPY_AVAILABLE = False


def _rms_of_pcm16(raw: bytes, n_samples: int) -> float:
    """RMS amplitude of an int16 little-endian PCM buffer, normalised to [0, 1]."""
    import struct
    import math

    if n_samples == 0:
        return 0.0
    if _NUMPY_AVAILABLE:
        samples = _np.frombuffer(raw, dtype=_np.int16).astype(_np.float32)
        samples /= 32768.0
        return float(_np.sqrt(_np.mean(samples * samples)))
    unpacked = struct.unpack(f'<{n_samples}h', raw)
    return math.sqrt(sum((s / 32768.0) ** 2 for s in unpacked) / len(unpacked))


def _scan_max_rms(wf, window: int, step: int, early_exit_threshold: float) -> float:
    """Return the maximum RMS amplitude found across stepped 1-second windows."""
    n_frames = wf.getnframes()
    if n_frames == 0:
        return 0.0

    if n_frames < window:
        wf.setpos(0)
        raw = wf.readframes(n_frames)
        return _rms_of_pcm16(raw, n_frames)

    max_rms = 0.0
    pos = 0
    while pos + window <= n_frames:
        wf.setpos(pos)
        raw = wf.readframes(window)
        rms = _rms_of_pcm16(raw, window)
        if rms > max_rms:
            max_rms = rms
        if max_rms >= early_exit_threshold:
            return max_rms
        pos += step
    return max_rms


def _format_timestamp(seconds: float) -> str:
    """Format a segment offset (seconds since recording start) as a transcript
    timestamp: ``MM:SS`` under an hour, ``H:MM:SS`` beyond it.

    Same MM:SS / H:MM:SS shape as the live-dock formatter (fmtTimestamp in
    LiveTranscriptBar.tsx) so the live view and the saved transcript read
    alike. (They aren't 1:1: the live dock stamps every segment, the saved
    transcript stamps each collapsed turn's first segment.) Only used for the
    diarised (labelled) transcript — the plain ``text`` field stays clean.
    """
    # A non-finite start (a backend emitting NaN/inf) must not crash the whole
    # diarised assembly — int(NaN) raises ValueError, int(inf) OverflowError.
    # Fall back to 00:00 rather than blowing up the transcription.
    if not math.isfinite(seconds):
        seconds = 0
    total = max(0, int(seconds))
    hh, rem = divmod(total, 3600)
    mm, ss = divmod(rem, 60)
    if hh:
        return f"{hh:d}:{mm:02d}:{ss:02d}"
    return f"{mm:02d}:{ss:02d}"


def _token_jaccard(a: str, b: str) -> float:
    """Jaccard similarity over normalised word tokens.

    Used to detect speaker-bleed: when mic and system channel transcripts
    contain nearly the same words (regardless of order or whitespace), it
    means both microphones heard the same audio. See BLEED_JACCARD_THRESHOLD.
    """
    tokens_a = set(re.findall(r"\w+", a.lower()))
    tokens_b = set(re.findall(r"\w+", b.lower()))
    if not tokens_a or not tokens_b:
        return 0.0
    return len(tokens_a & tokens_b) / len(tokens_a | tokens_b)


def _segment_rms(wav_path, start_sec: float, end_sec: float) -> float:
    """Mean RMS amplitude of a [start_sec, end_sec] slice in a 16-bit
    PCM WAV. Used by per-segment bleed correction to identify which
    channel carries the direct signal vs the attenuated echo.

    Returns 0.0 on any error so the caller falls back to the
    conservative "drop system" default.
    """
    import wave
    try:
        with wave.open(str(wav_path), 'rb') as wf:
            sr = wf.getframerate()
            n_frames_total = wf.getnframes()
            start_frame = max(0, int(start_sec * sr))
            end_frame = min(n_frames_total, int(end_sec * sr))
            duration_frames = end_frame - start_frame
            if duration_frames <= 0:
                return 0.0
            wf.setpos(start_frame)
            raw = wf.readframes(duration_frames)
            return _rms_of_pcm16(raw, duration_frames)
    except Exception:
        return 0.0


def _drop_per_segment_bleed(
    mic_segments: list,
    system_segments: list,
    mic_path=None,
    system_path=None,
):
    """Drop the bleed-echo side of each Jaccard-matched (mic, system) pair.

    Returns the (possibly-trimmed) mic_segments and system_segments lists.

    The naive version of this function assumed system = bleed echo of
    mic, but in the headphone-less case it's typically the opposite:
    the mic picks up the speaker echo of Others' speech, so the *mic*
    segment is the bleed and system has the clean direct signal. We
    decide per-pair by comparing RMS over the segment's time range on
    each channel — the channel with HIGHER RMS holds the direct signal,
    the lower-RMS one is the attenuated echo and gets dropped.

    When ``mic_path`` / ``system_path`` aren't supplied (test paths or
    a defensive caller), we fall back to the historical behaviour of
    dropping the system side.
    """
    if not mic_segments or not system_segments:
        return mic_segments, system_segments

    drop_mic: set = set()
    drop_sys: set = set()
    can_compare_rms = mic_path is not None and system_path is not None

    for i_sys, sys_seg in enumerate(system_segments):
        sys_text = (sys_seg.get("text") or "").strip()
        if not sys_text or len(sys_text) < PER_SEGMENT_BLEED_MIN_CHARS:
            continue
        sys_start = float(sys_seg.get("start") or 0.0)
        sys_end = float(sys_seg.get("end") or sys_start)
        best_jaccard = 0.0
        best_mic_idx = -1
        for i_mic, mic_seg in enumerate(mic_segments):
            if i_mic in drop_mic:
                continue
            mic_start = float(mic_seg.get("start") or 0.0)
            if abs(sys_start - mic_start) > PER_SEGMENT_BLEED_WINDOW_S:
                continue
            mic_text = (mic_seg.get("text") or "").strip()
            if not mic_text or len(mic_text) < PER_SEGMENT_BLEED_MIN_CHARS:
                continue
            jac = _token_jaccard(sys_text, mic_text)
            if jac > best_jaccard:
                best_jaccard = jac
                best_mic_idx = i_mic
        if best_jaccard < PER_SEGMENT_BLEED_JACCARD or best_mic_idx < 0:
            continue

        # Bleed pair confirmed. Decide which side to drop.
        if can_compare_rms:
            mic_seg = mic_segments[best_mic_idx]
            mic_start = float(mic_seg.get("start") or 0.0)
            mic_end = float(mic_seg.get("end") or mic_start)
            mic_rms = _segment_rms(mic_path, mic_start, mic_end)
            sys_rms = _segment_rms(system_path, sys_start, sys_end)
            # Tie-break / RMS unreadable → fall back to historical behaviour
            # (drop system) so we never delete real user mic content on
            # ambiguous evidence. >= covers the genuine-tie case AND the
            # both-zero case (_segment_rms returns 0.0 on any read error),
            # both of which should keep mic and drop system.
            if mic_rms >= sys_rms:
                drop_sys.add(i_sys)
                logger.debug(
                    "Per-segment bleed: dropping system %r "
                    "(Jaccard=%.2f, mic_rms=%.4f >= sys_rms=%.4f)",
                    sys_text[:60], best_jaccard, mic_rms, sys_rms,
                )
            else:
                drop_mic.add(best_mic_idx)
                logger.debug(
                    "Per-segment bleed: dropping mic %r "
                    "(Jaccard=%.2f, sys_rms=%.4f >= mic_rms=%.4f)",
                    (mic_segments[best_mic_idx].get("text") or "")[:60],
                    best_jaccard, sys_rms, mic_rms,
                )
        else:
            drop_sys.add(i_sys)

    if drop_sys or drop_mic:
        logger.info(
            "Per-segment bleed correction: dropped %d/%d system, %d/%d mic",
            len(drop_sys), len(system_segments),
            len(drop_mic), len(mic_segments),
        )

    kept_mic = [s for i, s in enumerate(mic_segments) if i not in drop_mic]
    kept_sys = [s for i, s in enumerate(system_segments) if i not in drop_sys]
    return kept_mic, kept_sys


# ---------------------------------------------------------------------------
# Per-channel acoustic speaker diarization (steno-diarize sidecar, macOS
# only). Ported from the research playground (scripts/diarize_playground.py)
# as dict-based helpers — that script's own docstring states it's a research
# tool that doesn't touch src/, and its functions use attribute access on
# AlignedSentence objects while our real ASR segments are dicts.
# ---------------------------------------------------------------------------

def _merge_close_diar_segments(segments: list[dict], max_gap: float) -> list[dict]:
    """Merge consecutive same-speaker diarizer segments separated by a gap
    smaller than max_gap. Segments must already be sorted by start time.
    Reduces diarization flicker and shrinks the gaps that cause boundary
    sentence misattribution in _assign_asr_segments_to_diar_segments."""
    if not segments:
        return []
    merged = [dict(segments[0])]
    for segment in segments[1:]:
        last = merged[-1]
        if segment["speaker"] == last["speaker"] and segment["start"] - last["end"] <= max_gap:
            # max(), not assignment: sorted-by-start does not mean the next
            # segment ends later. A same-speaker segment nested inside the
            # one before it (Sortformer emits these, and clamping can leave
            # one behind) would otherwise pull the merged end BACKWARDS and
            # delete speaking time that was really there.
            last["end"] = max(last["end"], segment["end"])
        else:
            merged.append(dict(segment))
    return merged


def _clamp_overlapping_diar_segments(segments: list[dict]) -> list[dict]:
    """Give each moment of audio to one speaker only, by pulling a segment's
    start up to where the previous speaker actually stopped. Segments must
    already be sorted by start time; the result is re-sorted by the caller.

    Sortformer really does emit overlapping segments -- observed on
    single-mic audio, see the note above LONG_SENTENCE_SPLIT_THRESHOLD_S.
    Left as-is, the overlapped span is counted twice: once for each cluster.
    That inflated total is what _cluster_channel_labels weighs against
    CHANNEL_DOMINANCE_THRESHOLD to decide whether a channel is one voice or
    gets split into "Speaker N" at all, so a run of overlap can decide the
    speaker count on double-counted time.

    A segment lying ENTIRELY inside an earlier one is left untouched:
    clamping it would leave nothing of it, and a cluster that only ever
    speaks inside someone else's turn would vanish from the channel
    completely -- deleting a speaker to fix an arithmetic error is the
    worse trade. Its span stays double-counted, which is the rarer case."""
    clamped: list[dict] = []
    running_end: Optional[float] = None
    for segment in segments:
        current = dict(segment)
        if running_end is not None and current["start"] < running_end < current["end"]:
            current["start"] = running_end
        clamped.append(current)
        running_end = current["end"] if running_end is None else max(running_end, current["end"])
    return clamped


# A single mic capturing two people is a much harder acoustic problem than a
# clean mic-vs-system-audio split — the diarizer's own turn boundaries can be
# genuinely noisy/overlapping there (observed empirically: alternating and
# even overlapping SPEAKER_0/SPEAKER_1 segments across a real back-and-forth).
# Parakeet sometimes fails to break a long run of natural speech (no strong
# terminal punctuation) into separate sentences, producing a single sentence
# that spans many real diarizer turns. Assigning that whole sentence to
# whichever one diarizer segment its midpoint happens to land in then forces
# an entire multi-turn exchange onto one speaker. A sentence at or above this
# duration gets word-level splitting instead (see _find_nearest_diar_segment)
# whenever it actually overlaps more than one distinct diarizer speaker.
LONG_SENTENCE_SPLIT_THRESHOLD_S = 5.0

# How far outside every diarizer segment an ASR timestamp may sit and still
# be attributed to the nearest speaker. Without a bound, "nearest" is
# unconditional: text at 0-1s with the channel's only diarizer segment at
# 2-3s was attributed in full to a speaker who, by the diarizer's own
# output, was not speaking anywhere near it -- and that attribution also
# reached the raw cluster id used for voiceprints, so one unplaceable line
# could feed a profile. Normal ASR-vs-diarizer boundary disagreement is
# well under a second (a clipped onset, a trailing word, breath before a
# turn); a whole second of diarizer-side silence around a sentence means
# the diarizer heard nobody there, not that it heard someone nearby.
#
# Judgment value, not a measured optimum: chosen to sit clearly above
# observed boundary slop and well above STENO_DIARIZE_MERGE_GAP_S, so only
# genuinely unplaceable text is affected. Raising it moves behaviour back
# toward the old unconditional nearest.
DIAR_LABEL_FALLBACK_TOLERANCE_S = 1.0


def _find_nearest_diar_segment(
    start: float,
    end: float,
    diar_segments: list[dict],
    max_gap: Optional[float] = None,
) -> Optional[int]:
    """Index of the diar segment containing [start, end]'s midpoint, or the
    nearest one by boundary distance if the midpoint falls in an uncovered
    gap.

    With ``max_gap`` set, a midpoint further than that from every segment is
    reported as unplaceable (None) instead of borrowing the nearest speaker.
    Returns None when diar_segments is empty."""
    midpoint = (start + end) / 2
    best_i, best_dist = None, float("inf")
    for i, segment in enumerate(diar_segments):
        if segment["start"] <= midpoint <= segment["end"]:
            return i
        dist = (
            segment["start"] - midpoint
            if midpoint < segment["start"]
            else midpoint - segment["end"]
        )
        if dist < best_dist:
            best_i, best_dist = i, dist
    if max_gap is not None and best_dist > max_gap:
        return None
    return best_i


def _assign_asr_segments_to_diar_segments(
    asr_segments: list[dict], diar_segments: list[dict]
) -> list[dict]:
    """Assign each ASR (Parakeet) sentence to the diarizer segment(s) it
    belongs to.

    Normal case (sentence fits inside one real diarizer turn): assign the
    whole sentence as one block to the nearest/containing diar segment.
    Sentence granularity (not word/token) is deliberate here — Parakeet
    already does its own sentence segmentation, so this never tears a word
    or clause in half for the common case.

    Long-sentence case: if a sentence runs at or above
    LONG_SENTENCE_SPLIT_THRESHOLD_S AND genuinely overlaps more than one
    distinct diarizer speaker, assigning it as one block would force an
    entire multi-turn exchange onto whichever speaker the midpoint happened
    to land on. Fall back to word-level assignment instead: each word goes
    to its own nearest diar segment (using its own timing, from
    segment["tokens"] — see src/_parakeet_mlx.py), and runs of consecutive
    words landing in the same diar segment are joined back together. This
    needs word timing to exist at all (`tokens`); if it doesn't (e.g. the
    whisper.cpp backend, or an older cached result), the sentence falls back
    to whole-block assignment like the normal case.

    Unplaceable case: a sentence whose midpoint sits further than
    DIAR_LABEL_FALLBACK_TOLERANCE_S outside every diarizer segment is not
    attributed to anyone. It is returned to the caller instead, which keeps
    the text in the transcript under the channel's own label rather than
    naming a speaker the diarizer never heard there. Text is never dropped.

    Mutates diar_segments in place, attaching joined text as
    segment["text"]. Returns the ASR segments that could not be placed, in
    input order (empty list in the normal case)."""
    for segment in diar_segments:
        segment["text"] = ""
    if not diar_segments:
        return list(asr_segments)

    unplaceable: list[dict] = []
    texts_by_segment: dict[int, list[str]] = {i: [] for i in range(len(diar_segments))}
    for asr_segment in asr_segments:
        text = (asr_segment.get("text") or "").strip()
        if not text:
            continue
        start = float(asr_segment.get("start") or 0.0)
        end = float(asr_segment.get("end") or start)
        tokens = asr_segment.get("tokens") or []
        duration = end - start

        multi_speaker_span = False
        if duration >= LONG_SENTENCE_SPLIT_THRESHOLD_S and tokens:
            overlapping_speakers = {
                seg["speaker"] for seg in diar_segments
                if seg["start"] < end and seg["end"] > start
            }
            multi_speaker_span = len(overlapping_speakers) > 1

        if multi_speaker_span:
            run_index: Optional[int] = None
            run_words: list[str] = []
            for token in tokens:
                token_text = token.get("text") or ""
                if not token_text.strip():
                    continue
                t_start = float(token.get("start") or 0.0)
                t_end = float(token.get("end") or t_start)
                idx = _find_nearest_diar_segment(
                    t_start, t_end, diar_segments, DIAR_LABEL_FALLBACK_TOLERANCE_S
                )
                if idx is None:
                    # This word carries no usable speaker evidence. Keep it
                    # with the turn it is already inside instead of opening
                    # one for a speaker the diarizer didn't hear here --
                    # words before the first placeable one simply stay
                    # buffered in run_words and lead that first run, so the
                    # sentence's word order survives either way.
                    run_words.append(token_text)
                    continue
                if run_index is not None and idx != run_index:
                    texts_by_segment[run_index].append("".join(run_words))
                    run_words = []
                run_index = idx
                run_words.append(token_text)
            if run_index is not None and run_words:
                texts_by_segment[run_index].append("".join(run_words))
            elif run_index is None:
                # Not one word in the sentence could be placed -- including
                # the case where the token list carries no usable text at
                # all, which used to drop the sentence silently.
                unplaceable.append(asr_segment)
        else:
            idx = _find_nearest_diar_segment(
                start, end, diar_segments, DIAR_LABEL_FALLBACK_TOLERANCE_S
            )
            if idx is not None:
                texts_by_segment[idx].append(text)
            else:
                unplaceable.append(asr_segment)

    for i, segment in enumerate(diar_segments):
        segment["text"] = " ".join(t.strip() for t in texts_by_segment[i] if t.strip()).strip()
    return unplaceable


# How often to print a HEARTBEAT: line while blocked waiting on
# steno-diarize. Comfortably under Electron's TRANSCRIBE_INACTIVITY_MS
# (8 minutes, app/main.js) -- see _heartbeat_while_waiting's docstring for
# why this can't just reuse the existing chunk-progress heartbeat registry.
STENO_DIARIZE_HEARTBEAT_INTERVAL_S = 60.0


@contextlib.contextmanager
def _heartbeat_while_waiting(label: str, interval_s: float = STENO_DIARIZE_HEARTBEAT_INTERVAL_S):
    """Print a HEARTBEAT: line every ``interval_s`` seconds on a background
    thread for the duration of the ``with`` block.

    src._heartbeat's chunk-progress registry only works for backends that
    call back into Python from INSIDE their own per-chunk loop (Parakeet,
    Whisper.cpp) -- steno-diarize is an opaque external binary invoked via a
    single blocking subprocess.run() call, with no such checkpoint to hang a
    callback off of. Without this, a diarization run on an hours-long
    channel prints nothing for its entire duration, which Electron's
    inactivity watchdog (app/main.js) can't tell apart from a hung process
    -- and kills, discarding a real, working meeting (confirmed against a
    real ~3.5h recording: steno-diarize needed longer than the 8-minute
    watchdog window and got killed mid-run, losing already-completed
    transcription work along with it).

    Never affects the wrapped call's own return value or exceptions --
    the background thread only ever writes heartbeat lines.
    """
    stop = threading.Event()

    def _beat():
        while not stop.wait(interval_s):
            try:
                sys.stdout.write(f"HEARTBEAT:{label}\n")
                sys.stdout.flush()
            except Exception:
                pass

    t = threading.Thread(target=_beat, daemon=True)
    t.start()
    try:
        yield
    finally:
        stop.set()
        t.join(timeout=1.0)


def _terminate_process_tree(proc: subprocess.Popen) -> None:
    """Terminate the isolated sidecar process group, including ffmpeg."""
    try:
        if sys.platform == "win32":
            result = subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                timeout=10,
                check=False,
            )
            if result.returncode != 0:
                raise OSError(f"taskkill exited {result.returncode}")
        else:
            os.killpg(proc.pid, signal.SIGKILL)
        return
    except (OSError, subprocess.SubprocessError):
        logger.warning("Could not terminate steno-diarize process group; killing parent")
    proc.kill()


def _run_steno_diarize(
    channel_path: Path, timeout: int,
    progress_sink: Optional[Callable[[int, int], None]] = None,
    extra_env: Optional[dict[str, str]] = None,
) -> Optional[tuple[list[dict], dict[str, list[float]]]]:
    """Run the steno-diarize sidecar on a single mono channel WAV.

    Returns ``(segments, speaker_embeddings)`` on success: merged diarizer
    segments (each ``{"start", "end", "speaker"}``), and a
    ``{"SPEAKER_0": [256 floats], ...}`` voiceprint centroid map (one entry
    per active speaker slot, extracted via FluidAudio's own WeSpeaker model
    with overlap-excluded, multi-chunk-averaged embeddings — see
    diarize-sidecar/Sources/main.swift). The embeddings map can be empty
    even on success (voiceprint extraction is best-effort inside the
    sidecar and never fails diarization itself).

    ``progress_sink(i, n)``, if given, is called in real time as the
    sidecar's embedding-extraction loop reports ``PROGRESS:embedding:i/n``
    lines on stderr -- the one phase of a long-recording diarization run
    that has an actual per-chunk checkpoint to report from (segmentation
    itself has none, and stays covered only by the caller's
    _heartbeat_while_waiting). Uses Popen with two concurrent reader
    threads rather than subprocess.run(capture_output=True) specifically
    so stderr can be watched WHILE the process is still running --
    matching what subprocess.run's own communicate() does internally to
    avoid the classic pipe-deadlock (stdout payloads have measured up to
    ~211KB in production, well past an OS pipe buffer, so neither stream
    can be read to completion only after the process exits).

    ``extra_env``, if given, is merged over the inherited environment --
    e.g. ``{"STENOAI_DIARIZE_COMPUTE_UNITS": "cpuAndGPU"}`` to opt a
    one-off/manual invocation into GPU instead of the sidecar's own
    power/thermal-efficient ANE default (see main.swift's
    resolveComputeUnits()). Callers on the normal per-meeting pipeline
    should leave this unset.

    Returns None on ANY failure — missing binary, timeout, non-zero exit,
    or unparseable output — so callers always have a safe fallback to
    legacy channel-only labeling and this can never fail a meeting.
    """
    binary = _resolve_steno_diarize()
    if not binary:
        return None
    proc: Optional[subprocess.Popen] = None
    try:
        process_group_options = (
            {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
            if sys.platform == "win32"
            else {"start_new_session": True}
        )
        proc = subprocess.Popen(
            [binary, "diarize", str(channel_path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={**os.environ, **extra_env} if extra_env else None,
            **process_group_options,
        )
        stdout_chunks: list[bytes] = []
        stderr_chunks: list[bytes] = []

        def _read_stdout():
            for chunk in iter(lambda: proc.stdout.read(65536), b""):
                stdout_chunks.append(chunk)

        def _read_stderr():
            buf = b""
            for chunk in iter(lambda: proc.stderr.read(4096), b""):
                stderr_chunks.append(chunk)
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if progress_sink and line.startswith(b"PROGRESS:embedding:"):
                        try:
                            i_str, n_str = line[len(b"PROGRESS:embedding:"):].split(b"/", 1)
                            progress_sink(int(i_str), int(n_str))
                        except (ValueError, IndexError):
                            pass

        t_out = threading.Thread(target=_read_stdout, daemon=True)
        t_err = threading.Thread(target=_read_stderr, daemon=True)
        t_out.start()
        t_err.start()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _terminate_process_tree(proc)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            t_out.join(timeout=2.0)
            t_err.join(timeout=2.0)
            logger.warning("steno-diarize timed out after %ss", timeout)
            return None
        t_out.join(timeout=5.0)
        t_err.join(timeout=5.0)

        if proc.returncode != 0:
            stderr_text = b"".join(stderr_chunks).decode(errors="replace")
            logger.warning(
                "steno-diarize exited %s: %s",
                proc.returncode, stderr_text[:300],
            )
            return None
        stdout = b"".join(stdout_chunks).decode(errors="replace")
        # Known FluidAudio/CoreML warnings ("E5RT encountered an STL
        # exception... key not found") can print directly to stdout
        # BEFORE, BETWEEN, or AFTER the real JSON payload — a real ~3.5h
        # run measured all three: leading warning text, an interstitial
        # non-payload JSON blob ahead of the real one, and (traced with a
        # direct, wrapper-free capture of steno-diarize's raw stdout) a
        # case where the normal {"segments":...,"speakers":...} object
        # (main.swift's Output struct, printed once via a single print())
        # never appears AT ALL: the E5RT error is FluidAudio's own
        # internal embedding-extraction failure escaping in a way that
        # skips Output entirely, leaving just a bare JSON ARRAY of the raw
        # segments (still real, load-bearing diarization data — see
        # main.swift's own comment that segments are the load-bearing
        # output, embeddings are best-effort). Scan every '{'/'[' in
        # stdout; prefer the LAST dict with a "segments" key (the normal,
        # complete case, with embeddings), but degrade to the LAST bare
        # array of segment-shaped dicts (no embeddings/voiceprint data for
        # this cluster) if no proper object payload was ever found —
        # better than discarding a real diarization result outright.
        raw_segments = None
        raw_embeddings: dict = {}
        found_object_payload = False
        decoder = json.JSONDecoder()
        search_from = 0
        while True:
            next_brace = stdout.find("{", search_from)
            next_bracket = stdout.find("[", search_from)
            starts = [p for p in (next_brace, next_bracket) if p >= 0]
            if not starts:
                break
            start = min(starts)
            try:
                candidate, end = decoder.raw_decode(stdout, start)
            except json.JSONDecodeError:
                search_from = start + 1
                continue
            if isinstance(candidate, dict) and "segments" in candidate:
                raw_segments = candidate["segments"]
                raw_embeddings = candidate.get("speakers") or {}
                found_object_payload = True
            elif (
                not found_object_payload
                and isinstance(candidate, list) and candidate
                and all(isinstance(s, dict) and "speakerId" in s for s in candidate)
            ):
                raw_segments = candidate
                raw_embeddings = {}
            search_from = max(end, start + 1)
        if raw_segments is None:
            logger.warning(
                "steno-diarize produced no usable JSON output "
                "(stdout length %d, last 500 chars: %r)",
                len(stdout), stdout[-500:],
            )
            return None
    except (subprocess.TimeoutExpired, OSError, ValueError, KeyError) as e:
        logger.warning("steno-diarize failed: %s", e)
        return None
    finally:
        if proc is not None:
            for stream in (proc.stdout, proc.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass

    try:
        if not isinstance(raw_segments, list) or not isinstance(raw_embeddings, dict):
            raise TypeError("segments must be a list and speakers must be an object")
        segments = []
        for raw_segment in raw_segments:
            if not isinstance(raw_segment, dict):
                raise TypeError("each segment must be an object")
            start = float(raw_segment["start"])
            end = float(raw_segment["end"])
            speaker = raw_segment["speakerId"]
            if (
                not math.isfinite(start)
                or not math.isfinite(end)
                or end < start
                or not isinstance(speaker, str)
                or not speaker
            ):
                raise ValueError("invalid segment values")
            segments.append({"start": start, "end": end, "speaker": speaker})
        segments.sort(key=lambda segment: segment["start"])

        from src.speaker_schema import validate_embedding

        embeddings = {}
        for speaker, raw_embedding in raw_embeddings.items():
            embeddings[str(speaker)] = validate_embedding(raw_embedding)

        # Merge first so a same-speaker overlap (the flicker case) collapses
        # into one turn instead of being clamped into two touching ones.
        merged = _merge_close_diar_segments(segments, STENO_DIARIZE_MERGE_GAP_S)
        clamped = sorted(_clamp_overlapping_diar_segments(merged), key=lambda s: s["start"])
        merged = _merge_close_diar_segments(clamped, STENO_DIARIZE_MERGE_GAP_S)
        return merged, embeddings
    except (KeyError, TypeError, ValueError, OverflowError) as e:
        logger.warning("steno-diarize produced an invalid payload: %s", e)
        return None


def _worst_window_coverage(*results: Optional[dict]) -> Optional[float]:
    """Lowest reported window coverage across the channels that reported one.

    Returns None when nothing reported -- a backend that does no windowing
    of its own cannot lose a window, but it also cannot vouch for the file,
    so "unknown" stays distinct from "complete"."""
    values = [
        float(r["window_coverage"])
        for r in results
        if isinstance(r, dict) and r.get("window_coverage") is not None
    ]
    return min(values) if values else None


def _cluster_channel_label_plan(
    diar_segments: list[dict], legacy_label: str,
) -> tuple[Optional[dict[str, str]], set[str]]:
    """Return transcript labels and clusters eligible for self matching.

    A channel at or beyond the dominance ratio remains legacy-labeled unless
    at least one minority cluster has enough total speech and a sufficiently
    long average turn to be a sustained second speaker. Short or fragmented
    clusters fold into the dominant label and are excluded from self-voiceprint
    matching, so diarization artifacts cannot re-anchor the channel or acquire
    their own speaker label.
    """
    totals: dict[str, float] = {}
    turn_counts: dict[str, int] = {}
    for s in diar_segments:
        sid = s["speaker"]
        totals[sid] = totals.get(sid, 0.0) + s["end"] - s["start"]
        turn_counts[sid] = turn_counts.get(sid, 0) + 1
    if len(totals) <= 1:
        return None, set()

    dominant = max(totals, key=totals.get)
    total_time = sum(totals.values())
    if total_time <= 0 or totals[dominant] / total_time < CHANNEL_DOMINANCE_THRESHOLD:
        return (
            {
                sid: (legacy_label if sid == dominant else f"__diar__{legacy_label}__{sid}")
                for sid in totals
            },
            set(totals),
        )

    sustained_minorities = {
        sid
        for sid, speech_seconds in totals.items()
        if sid != dominant
        and speech_seconds >= CHANNEL_DOMINANCE_MIN_MINOR_SPEECH_SECONDS
        and speech_seconds / turn_counts[sid] >= CHANNEL_DOMINANCE_MIN_AVG_TURN_SECONDS
    }
    if not sustained_minorities:
        return None, set()

    return (
        {
            sid: (
                legacy_label
                if sid == dominant or sid not in sustained_minorities
                else f"__diar__{legacy_label}__{sid}"
            )
            for sid in totals
        },
        {dominant, *sustained_minorities},
    )


def _cluster_channel_labels(diar_segments: list[dict], legacy_label: str) -> Optional[dict[str, str]]:
    """Return the transcript-label portion of _cluster_channel_label_plan.

    This public compatibility wrapper preserves callers that only need the
    cluster-to-label mapping; new diarization code also consumes the plan's
    self-voiceprint eligibility set.
    """
    return _cluster_channel_label_plan(diar_segments, legacy_label)[0]


# Cosine-distance threshold + confidence margin for voiceprint matching
# (distance = 1 - cosine_similarity). Ported from the matching algorithm in
# github.com/pasrom/meeting-transcriber's SpeakerMatcher.swift (verified via
# GitHub's raw content API), which pairs a real WeSpeaker-embedding pipeline
# with these exact starting values. The margin matters as much as the
# threshold: a bare similarity/distance cutoff let ambiguous near-ties
# through in real-recording testing (a distance-only check would have
# accepted several unrelated cross-recording speakers as "matches").
# Requiring the best candidate to clearly beat the runner-up rejects those.
VOICEPRINT_DISTANCE_THRESHOLD = 0.40
VOICEPRINT_CONFIDENCE_MARGIN = 0.10


def _voiceprint_distance(embedding: list, voiceprint: dict) -> float:
    """Cosine distance from `embedding` to a stored voiceprint, taking the
    minimum over its long-term centroid and recent-samples FIFO (either
    anchor can rescue a borderline match) — port of
    SpeakerMatcher.distance. Returns +inf if the voiceprint has no usable
    anchors at all.
    """
    from src.voiceprint import cosine_distance
    anchors = list(voiceprint.get("embeddings") or [])
    centroid = voiceprint.get("centroid")
    if centroid:
        anchors.append(centroid)
    distances = []
    for anchor in anchors:
        try:
            distances.append(cosine_distance(embedding, anchor))
        except (TypeError, ValueError, OverflowError):
            continue
    return min(distances, default=float("inf"))


def _apply_voiceprint_matches(
    speaker_embeddings: dict[str, list],
    cluster_labels: dict[str, str],
    legacy_label: str,
    allow_self_match: bool,
    eligible_speaker_ids: Optional[set[str]] = None,
) -> dict[str, str]:
    """Override cluster_labels with a self-voiceprint match where found.

    `speaker_embeddings` comes straight from the steno-diarize sidecar's
    JSON output (FluidAudio WeSpeaker centroids, overlap-excluded and
    averaged across the whole channel — see diarize-sidecar/Sources/main.swift)
    — no separate Python-side embedding extraction.

    allow_self_match=True (the mic channel, when genuinely multiple
    speakers were detected) re-anchors the legacy label onto whichever
    cluster's voice actually matches the enrolled self voiceprint, rather
    than trusting the dominant-by-duration guess — an in-person recording
    where a guest talks more than the device owner would otherwise
    mislabel the guest as "You".

    NAMED (non-self) cross-recording matching used to happen here too, but
    was removed: validating it against real ground truth (the AMI Meeting
    Corpus, individual headset mics) found that people sharing a room/mic
    score artificially similar to each other regardless of true identity —
    a channel/session bias no amount of threshold/margin tuning fixed (see
    the plan doc history for the full investigation). Silent, fully
    automatic named matching isn't safe; named identification is now a
    human-confirmed suggestion via `src.speaker_suggestions`, not an
    automatic relabel here.

    ANY failure (no embeddings, no self voiceprint stored) leaves
    cluster_labels unchanged — matching is a best-effort enhancement
    layered on top of the existing placeholder/"Speaker N" scheme, never
    something that can fail a meeting.
    """
    if not speaker_embeddings or not allow_self_match:
        return cluster_labels
    try:
        from src.config import get_config
        voiceprints = get_config().get_voiceprints()
    except Exception as e:
        logger.warning("Could not load stored voiceprints: %s", e)
        return cluster_labels

    self_vp = next((v for v in voiceprints if v.get("is_self")), None)
    if self_vp is None:
        return cluster_labels

    updated = dict(cluster_labels)

    best_sid, best_dist = None, VOICEPRINT_DISTANCE_THRESHOLD
    for sid, emb in speaker_embeddings.items():
        if eligible_speaker_ids is not None and sid not in eligible_speaker_ids:
            continue
        dist = _voiceprint_distance(emb, self_vp)
        if dist < best_dist:
            best_sid, best_dist = sid, dist
    you_cluster = best_sid

    if you_cluster is not None:
        old_dominant = next(
            (
                sid
                for sid, label in updated.items()
                if label == legacy_label
                and (eligible_speaker_ids is None or sid in eligible_speaker_ids)
            ),
            None,
        )
        old_dominant_placeholder = (
            f"__diar__{legacy_label}__{old_dominant}" if old_dominant is not None else None
        )
        if you_cluster == old_dominant:
            return updated
        for sid in updated:
            if sid == you_cluster:
                updated[sid] = legacy_label
            elif updated[sid] == legacy_label:
                updated[sid] = old_dominant_placeholder or f"__diar__{legacy_label}__{sid}"

    return updated


def _identity_matching_enabled() -> bool:
    """Whether cross-recording speaker identification is enabled (default
    off, user-configurable). Independent of diarization itself: disabling
    this stops self-voiceprint matching (_apply_voiceprint_matches) and
    per-meeting speaker-embedding persistence (clusters_out), but "Speaker
    N" splitting within a meeting is unaffected, since that only depends on
    diarizer segments, not embeddings. A config-read failure must fail
    closed because no reliable opt-in can be established.
    """
    try:
        from src.config import get_config
        return get_config().get_identity_matching_enabled()
    except Exception:
        return False


def _has_spoken_content(text: Optional[str]) -> bool:
    """Whether ASR text contains a letter or number, not just punctuation."""
    return any(char.isalnum() for char in (text or ""))


def _tag_channel_segments(
    asr_segments: list[dict],
    channel_path: Optional[Path],
    duration_seconds: Optional[float],
    legacy_label: str,
    allow_self_match: bool = False,
    clusters_out: Optional[dict] = None,
) -> list[tuple[float, str, str, Optional[str]]]:
    """Build (start, label, text, raw_diarization_speaker_id) tuples for
    one channel's ASR segments. raw_diarization_speaker_id is the EXACT
    diarizer cluster id that produced this segment (e.g. "SPEAKER_2"), or
    None when diarization wasn't available/used at all (the legacy
    single-speaker fallback). Carried through so callers can persist exact
    per-line speaker provenance in the saved transcript's sidecar, instead
    of a relabeling pass having to reconstruct "which cluster produced
    this line" after the fact via fuzzy timestamp matching -- the fuzzy
    approach is provably unsafe (see src.speaker_suggestions.relabel_transcript_exact
    and the plan doc's Phase 8): a channel's cluster segments routinely
    span nearly the whole recording, so timestamp-tolerance matching can
    misattribute a line to the wrong cluster, or even the wrong channel.

    Tries acoustic diarization first: if the steno-diarize sidecar succeeds
    and finds more than one real speaker cluster, turns are built from the
    diarizer's own segment boundaries (with ASR sentences reassigned into
    them via _assign_asr_segments_to_diar_segments). The cluster with the
    most total speaking time keeps the channel's legacy label
    ("You"/"Others"). Other clusters get a placeholder resolved to
    "Speaker N" later, except short minority clusters in a dominant channel,
    which fold into the dominant label. A self voiceprint can re-anchor the
    legacy label onto a different eligible cluster instead (see
    _apply_voiceprint_matches; mic channel only). NAMED
    (non-self) speaker identification does not happen automatically here —
    see src.speaker_suggestions for the human-confirmed suggestion flow.
    ANY failure — missing binary, timeout, bad JSON, a single-cluster
    result, or any voiceprint-matching failure — falls back to the
    byte-identical legacy behaviour of labeling every ASR segment with
    legacy_label.

    If diarization succeeds and ``clusters_out`` is given (a mutable dict),
    it's populated in place with this channel's raw cluster/embedding data
    (build_clusters_from_diarization's shape) so the caller can assemble a
    {stem}_speakers.json sidecar from data already computed here, without
    a second diarization pass (previously only backfill-speaker-embeddings
    -- a separate, manual CLI step re-diarizing from scratch -- ever wrote
    that sidecar; a live recording never did).
    """
    if not asr_segments:
        return []

    # ASR can emit punctuation-only tail content for digital silence
    # (observed as a standalone "." after macOS `say` speech). Treating any
    # non-empty string as speech lets that artifact acquire its own diarizer
    # cluster and creates a phantom "Speaker N" transcript line. A real
    # utterance always contains at least one Unicode letter or number. Apply
    # this once before diarization and again below because word-level speaker
    # assignment can split a valid "Thanks ." input into "Thanks" and ".".
    asr_segments = [
        segment
        for segment in asr_segments
        if _has_spoken_content(segment.get("text"))
    ]
    if not asr_segments:
        return []

    # Set below whenever diarization ran and produced real diar_segments
    # but _cluster_channel_label_plan decided NOT to split the transcript
    # (a single real speaker, or no sustained minority in a channel at or
    # beyond CHANNEL_DOMINANCE_THRESHOLD). legacy_tagged below still looks up
    # each ASR segment's OWN nearest diar segment for exact per-line
    # provenance -- unlike single_raw_sid's earlier, cruder approach
    # (claiming ONE id for the whole legacy-labeled span), this stays
    # correct even when a minor-but-real second cluster is genuinely
    # mixed in, since every segment gets its OWN real id, not a guess.
    # Left None for a real diarization failure (nothing to look up).
    diar_segments_for_provenance: Optional[list] = None

    if channel_path is not None:
        timeout = max(STENO_DIARIZE_TIMEOUT_FLOOR_S, int(duration_seconds or 0))
        logger.info(f"Diarizing {legacy_label} channel acoustically (up to {timeout}s)...")
        print(f"PROGRESS:diarize:{legacy_label}:start", flush=True)
        try:
            def _progress_sink(i: int, n: int, _label=legacy_label) -> None:
                print(f"PROGRESS:diarize:{_label}:embedding:{i}/{n}", flush=True)

            with _heartbeat_while_waiting(f"diarize:{legacy_label}"):
                diarize_result = _run_steno_diarize(channel_path, timeout, progress_sink=_progress_sink)
            if diarize_result:
                diar_segments, speaker_embeddings = diarize_result
                cluster_labels, eligible_speaker_ids = _cluster_channel_label_plan(
                    diar_segments, legacy_label,
                )
                if cluster_labels:
                    cluster_labels = _apply_voiceprint_matches(
                        speaker_embeddings,
                        cluster_labels,
                        legacy_label,
                        allow_self_match,
                        eligible_speaker_ids,
                    )
                    unplaceable = _assign_asr_segments_to_diar_segments(asr_segments, diar_segments)
                    diar_tagged = []
                    for segment in diar_segments:
                        text = (segment.get("text") or "").strip()
                        if _has_spoken_content(text):
                            diar_tagged.append((
                                segment["start"], cluster_labels[segment["speaker"]], text,
                                segment["speaker"],
                            ))
                    # Text the diarizer left unplaceable still belongs in the
                    # transcript -- under this channel's own label, with no
                    # raw cluster id, so it reads as "someone on this side"
                    # and can never feed a voiceprint. Dropping it would lose
                    # real speech; naming a speaker for it would invent one.
                    for asr_segment in unplaceable:
                        text = (asr_segment.get("text") or "").strip()
                        if _has_spoken_content(text):
                            diar_tagged.append((
                                float(asr_segment.get("start") or 0.0), legacy_label, text, None,
                            ))
                    diar_tagged.sort(key=lambda turn: turn[0])
                    if diar_tagged:
                        logger.info(
                            f"Diarizing {legacy_label} channel found "
                            f"{len(set(cluster_labels.values()))} speaker cluster(s)"
                        )
                        if clusters_out is not None:
                            clusters_out.update(
                                build_clusters_from_diarization(diar_segments, speaker_embeddings)
                            )
                        return diar_tagged
                else:
                    # _cluster_channel_label_plan returned no labels: either
                    # a genuinely single distinct diarizer id, or no
                    # sustained minority in a channel at or beyond
                    # CHANNEL_DOMINANCE_THRESHOLD -- not a diarization
                    # failure either way. The TRANSCRIPT
                    # correctly falls back to plain legacy_label (no
                    # "Speaker N" split needed for one continuous voice) --
                    # but real diar_segments exist, so legacy_tagged below
                    # can still look up each ASR segment's OWN nearest diar
                    # segment for exact per-line provenance. This is by far
                    # the most common real-world shape (confirmed against
                    # two different real recordings this session: a normal
                    # 1:1 call's channels routinely land >99% dominant) --
                    # without this, exact-match provenance would silently
                    # never apply to the majority of real meetings.
                    diar_segments_for_provenance = diar_segments
                    if clusters_out is not None and speaker_embeddings:
                        # Still the CLEANEST case for a voiceprint even when
                        # dominance-collapsed rather than genuinely single:
                        # one real person's speech is still isolable here.
                        # A normal 1:1 call's remote side is very often
                        # exactly this shape -- without this, it could NEVER
                        # contribute a named-speaker candidate, since it
                        # never reaches the multi-cluster branch above.
                        clusters_out.update(build_clusters_from_diarization(diar_segments, speaker_embeddings))
            logger.info(f"Diarizing {legacy_label} channel: falling back to legacy single-speaker labeling")
        finally:
            print(f"PROGRESS:diarize:{legacy_label}:done", flush=True)

    legacy_tagged: list[tuple[float, str, str, Optional[str]]] = []
    for s in asr_segments:
        text = (s.get("text") or "").strip()
        if not _has_spoken_content(text):
            continue
        start = float(s.get("start") or 0.0)
        raw_sid = None
        if diar_segments_for_provenance:
            # Looked up per-ASR-segment (not one id claimed for the whole
            # span) -- reuses the same containing/nearest-midpoint logic
            # _assign_asr_segments_to_diar_segments already relies on, but
            # WITHOUT calling that function itself: it mutates diar_segments
            # and can reflow/resplit text across segment boundaries (long-
            # sentence word-level splitting), which would risk changing
            # this path's visible output -- still required to be
            # byte-identical to the pre-Phase-8 legacy behaviour. This is
            # purely a read-only side lookup for exact-match provenance.
            #
            # Bounded like the labeling path, and for the same reason even
            # when the channel holds a single cluster: raw_sid claims THIS
            # cluster produced THIS line, and a line sitting far outside
            # every segment the diarizer emitted has no evidence behind
            # that claim -- it may well be someone the diarizer never
            # segmented at all. A later rename would then put a name on a
            # line that was never that person's. None is the honest answer;
            # the text still reaches the transcript under legacy_label.
            idx = _find_nearest_diar_segment(
                start,
                float(s.get("end") or start),
                diar_segments_for_provenance,
                DIAR_LABEL_FALLBACK_TOLERANCE_S,
            )
            if idx is not None:
                raw_sid = diar_segments_for_provenance[idx]["speaker"]
        legacy_tagged.append((start, legacy_label, text, raw_sid))
    return legacy_tagged


def _resolve_speaker_placeholders(
    tagged: list[tuple[float, str, str, str, Optional[str]]],
) -> list[tuple[float, str, str, str, Optional[str]]]:
    """Replace placeholder cluster labels (see _cluster_channel_labels) with
    "Speaker N", numbered by first chronological appearance across BOTH
    channels merged and time-sorted — so a reader sees new speakers
    introduced as 2, 3, 4... regardless of which channel they came from.

    Cross-channel echo copies have already been conservatively unified by
    _reconcile_cross_channel_speakers when embeddings made that possible.
    Any placeholders still distinct here are intentionally numbered as
    different people.

    `channel` and `raw_diarization_speaker_id` pass through untouched —
    only `label` is ever rewritten here.
    """
    numbering: dict[str, str] = {}
    next_n = 2
    resolved: list[tuple[float, str, str, str, Optional[str]]] = []
    for start, label, text, channel, raw_sid in tagged:
        if label.startswith("__diar__"):
            if label not in numbering:
                numbering[label] = f"Speaker {next_n}"
                next_n += 1
            label = numbering[label]
        resolved.append((start, label, text, channel, raw_sid))
    return resolved


def _reconcile_cross_channel_speakers(
    tagged: list[tuple[float, str, str, str, Optional[str]]],
    mic_clusters: dict,
    system_clusters: dict,
) -> tuple[list[tuple[float, str, str, str, Optional[str]]], dict, dict]:
    """Collapse unambiguous mic/system copies of the same acoustic speaker.

    Bleed correction removes duplicate ASR segments, but acoustic diarization
    still runs against each complete channel WAV. With speakers playing aloud,
    Sortformer can therefore discover the same leaked voice independently in
    both channels. Without this reconciliation, placeholder resolution turns
    those channel-local IDs into two visible people and speaker review exposes
    two rows for one person.

    WeSpeaker centroids from the same recording are safe enough for a narrow,
    conservative merge: require a mutual-nearest pair at or below the existing
    same-meeting fragment threshold and a clear runner-up margin on both sides.
    The channel retaining more post-bleed transcript text is canonical. Alias
    turns inherit its label and provenance, and the duplicate sidecar cluster
    is removed. Ambiguous, malformed, or unmatched clusters stay untouched.
    """
    if not tagged or not mic_clusters or not system_clusters:
        return tagged, mic_clusters, system_clusters

    from src.voiceprint import cosine_distance

    distances: dict[tuple[str, str], float] = {}
    for mic_sid, mic_cluster in mic_clusters.items():
        mic_embedding = mic_cluster.get("embedding") if isinstance(mic_cluster, dict) else None
        if not mic_embedding:
            continue
        for system_sid, system_cluster in system_clusters.items():
            system_embedding = (
                system_cluster.get("embedding") if isinstance(system_cluster, dict) else None
            )
            if not system_embedding:
                continue
            try:
                distance = cosine_distance(mic_embedding, system_embedding)
            except (TypeError, ValueError, OverflowError):
                continue
            if math.isfinite(distance):
                distances[(mic_sid, system_sid)] = distance

    if not distances:
        return tagged, mic_clusters, system_clusters

    def _confident_nearest(
        sid: str,
        *,
        from_mic: bool,
    ) -> Optional[tuple[str, float]]:
        candidates = sorted(
            (
                (distance, system_sid if from_mic else mic_sid)
                for (mic_sid, system_sid), distance in distances.items()
                if (mic_sid if from_mic else system_sid) == sid
            ),
            key=lambda candidate: candidate[0],
        )
        if not candidates:
            return None
        best_distance, best_sid = candidates[0]
        if best_distance > SAME_MEETING_MERGE_DISTANCE_THRESHOLD:
            return None
        if (
            len(candidates) > 1
            and candidates[1][0] - best_distance < CROSS_CHANNEL_SPEAKER_MATCH_MARGIN
        ):
            return None
        return best_sid, best_distance

    matches: list[tuple[str, str, float]] = []
    for mic_sid in mic_clusters:
        mic_best = _confident_nearest(mic_sid, from_mic=True)
        if mic_best is None:
            continue
        system_sid, distance = mic_best
        system_best = _confident_nearest(system_sid, from_mic=False)
        if system_best is not None and system_best[0] == mic_sid:
            matches.append((mic_sid, system_sid, distance))

    if not matches:
        return tagged, mic_clusters, system_clusters

    text_weights: dict[tuple[str, str], int] = {}
    labels: dict[tuple[str, str], str] = {}
    for _start, label, text, channel, raw_sid in tagged:
        if raw_sid is None:
            continue
        key = (channel, raw_sid)
        text_weights[key] = text_weights.get(key, 0) + len((text or "").strip())
        labels.setdefault(key, label)

    mic_out = dict(mic_clusters)
    system_out = dict(system_clusters)
    aliases: dict[tuple[str, str], tuple[str, str, str]] = {}
    for mic_sid, system_sid, distance in matches:
        mic_key = ("mic", mic_sid)
        system_key = ("system", system_sid)
        mic_weight = text_weights.get(mic_key, 0)
        system_weight = text_weights.get(system_key, 0)
        if mic_weight == 0 and system_weight == 0:
            continue

        mic_label = labels.get(mic_key)
        system_label = labels.get(system_key)
        # Merging the two dominant legacy labels would erase a normal 1:1 call
        # if unrelated centroids happen to fall below the distance threshold.
        # For all other pairs, post-bleed text remains the best evidence of
        # which channel contains the direct signal: minority echo clusters may
        # have been folded into either channel's legacy label.
        if mic_label == "You" and system_label == "Others":
            continue
        if mic_weight >= system_weight:
            canonical_key, alias_key = mic_key, system_key
        else:
            canonical_key, alias_key = system_key, mic_key

        canonical_label = labels.get(canonical_key) or labels.get(alias_key)
        if canonical_label is None:
            continue
        aliases[alias_key] = (*canonical_key, canonical_label)

        canonical_out = mic_out if canonical_key[0] == "mic" else system_out
        alias_out = mic_out if alias_key[0] == "mic" else system_out
        canonical_cluster = canonical_out.get(canonical_key[1])
        alias_cluster = alias_out.get(alias_key[1])
        if isinstance(canonical_cluster, dict) and isinstance(alias_cluster, dict):
            # Transcript provenance is rewritten to the canonical cluster, so
            # retain the alias time ranges there as well. This keeps review
            # clips placeable without double-counting overlapping echo ranges.
            segments = []
            for cluster in (canonical_cluster, alias_cluster):
                for segment in cluster.get("segments") or []:
                    try:
                        start = float(segment["start"])
                        end = float(segment["end"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    if math.isfinite(start) and math.isfinite(end) and end > start:
                        segments.append((start, end))
            if segments:
                merged_segments: list[list[float]] = []
                for start, end in sorted(segments):
                    if merged_segments and start <= merged_segments[-1][1]:
                        merged_segments[-1][1] = max(merged_segments[-1][1], end)
                    else:
                        merged_segments.append([start, end])
                canonical_cluster = dict(canonical_cluster)
                canonical_cluster["segments"] = [
                    {"start": start, "end": end} for start, end in merged_segments
                ]
                canonical_cluster["speech_duration_seconds"] = sum(
                    end - start for start, end in merged_segments
                )
                canonical_cluster["segment_count"] = sum(
                    int(cluster.get("segment_count") or 0)
                    for cluster in (canonical_cluster, alias_cluster)
                )
                canonical_out[canonical_key[1]] = canonical_cluster
        alias_out.pop(alias_key[1], None)
        logger.info(
            "Cross-channel speaker reconciliation: %s/%s -> %s/%s "
            "(distance=%.3f, retained_chars=%d/%d)",
            alias_key[0], alias_key[1], canonical_key[0], canonical_key[1],
            distance, mic_weight, system_weight,
        )

    if not aliases:
        return tagged, mic_clusters, system_clusters

    reconciled = []
    for start, label, text, channel, raw_sid in tagged:
        canonical = aliases.get((channel, raw_sid)) if raw_sid is not None else None
        if canonical is not None:
            channel, raw_sid, label = canonical
        reconciled.append((start, label, text, channel, raw_sid))
    original_labels = {
        label for _start, label, _text, _channel, _raw_sid
        in _resolve_speaker_placeholders(tagged)
    }
    resolved_labels = {
        label for _start, label, _text, _channel, _raw_sid
        in _resolve_speaker_placeholders(reconciled)
    }
    if len(original_labels) > 1 and len(resolved_labels) <= 1:
        logger.info("Cross-channel speaker reconciliation skipped: would erase speaker split")
        return tagged, mic_clusters, system_clusters
    return reconciled, mic_out, system_out


@dataclass(frozen=True)
class _DiarisedTurnAssembly:
    plain_parts: list[str]
    diarised_text: Optional[str]
    is_diarised: bool
    turn_manifest: list[dict]


def _assemble_diarised_turns(
    tagged: list[tuple[float, str, str, str, Optional[str]]],
) -> _DiarisedTurnAssembly:
    """Build the shared transcript and provenance representation.

    A saved diarised line and its manifest entry are positionally paired.
    Keeping turn collapse, visible-label detection, rendering, and manifest
    creation in one helper prevents the mono and stereo paths from drifting.
    Adjacent text is collapsed only when its visible label and full source
    provenance match; unplaceable text therefore cannot inherit a cluster.
    """
    turns: list[tuple[float, str, list[str], str, Optional[str]]] = []
    for start, speaker, text, channel, raw_sid in tagged:
        if (
            turns
            and turns[-1][1] == speaker
            and turns[-1][3] == channel
            and turns[-1][4] == raw_sid
        ):
            turns[-1][2].append(text)
        else:
            turns.append((start, speaker, [text], channel, raw_sid))

    plain_parts = [' '.join(parts) for _start, _speaker, parts, _channel, _raw_sid in turns]
    distinct_labels = {speaker for _start, speaker, _parts, _channel, _raw_sid in turns}
    is_diarised = len(distinct_labels) > 1
    if not is_diarised:
        return _DiarisedTurnAssembly(plain_parts, None, False, [])

    labelled_parts = [
        f"[{_format_timestamp(start)}] [{speaker}] {' '.join(parts)}"
        for start, speaker, parts, _channel, _raw_sid in turns
    ]
    turn_manifest = [
        {"start": start, "channel": channel, "diarization_speaker_id": raw_sid}
        for start, _speaker, _parts, channel, raw_sid in turns
    ]
    return _DiarisedTurnAssembly(
        plain_parts,
        "\n\n".join(labelled_parts),
        True,
        turn_manifest,
    )


# Apple SpeechTranscriber is exposed through a small Swift sidecar so the
# Python/Electron pipeline can use the system-managed model without PyObjC or
# shipping weights.
from src.apple_speech import (  # noqa: E402
    resolve_sidecar as _resolve_apple_speech,
    transcribe_file as _apple_transcribe_file,
)

APPLE_SPEECH_AVAILABLE = _resolve_apple_speech() is not None


# Try Parakeet first (preferred — same engine as live, arm64 Macs only).
try:
    from src.parakeet import transcribe_file as _parakeet_transcribe_file
    PARAKEET_AVAILABLE = True
except ImportError:
    _parakeet_transcribe_file = None
    PARAKEET_AVAILABLE = False

# whisper.cpp via pywhispercpp is the cross-platform fallback that keeps
# Intel-Mac DMGs working (parakeet-mlx is Apple-Silicon-only). Bundled
# unconditionally in stenoai.spec and lazily probed here at import time.
try:
    from pywhispercpp.model import Model as WhisperCppModel
    WHISPER_CPP_AVAILABLE = True
except ImportError:
    WhisperCppModel = None
    WHISPER_CPP_AVAILABLE = False

if not APPLE_SPEECH_AVAILABLE and not PARAKEET_AVAILABLE and not WHISPER_CPP_AVAILABLE:
    logger.warning(
        "No ASR backend available (Apple SpeechTranscriber sidecar, "
        "parakeet, and pywhispercpp are all missing); batch transcription "
        "will fail",
    )

# Top-level capability flag retained for callers that probed for whisper
# presence. Means "any working ASR backend at all".
WHISPER_AVAILABLE = (
    APPLE_SPEECH_AVAILABLE or PARAKEET_AVAILABLE or WHISPER_CPP_AVAILABLE
)


class WhisperTranscriber:
    """Batch transcription with the configured local ASR engine.

    Class name is retained for callers from the whisper-era surface. Apple
    SpeechTranscriber, Parakeet, and whisper.cpp all normalize into the same
    transcript/segment shape before the shared stereo split and diarization
    pipeline runs.
    """

    def __init__(self, model_size: str = "large-v3-turbo"):
        if not (
            APPLE_SPEECH_AVAILABLE
            or PARAKEET_AVAILABLE
            or WHISPER_CPP_AVAILABLE
        ):
            raise ImportError(
                "No ASR backend available. Rebuild the macOS Apple "
                "transcription sidecar or install Parakeet/whisper.cpp."
            )
        # Kept on the instance so existing callers / logs that read
        # ``model_size`` and ``backend`` don't change. Backend selection
        # respects the user-selected engine from Settings → Transcribe
        # (Config.get_transcription_engine). Without this, an arm64 user
        # who picked Whisper would still get Parakeet on the post-stop
        # pass — live and final would silently use different engines
        # and the diarised transcript wouldn't match what they previewed.
        # Fallbacks never download implicitly. An explicit Apple choice fails
        # closed if its required sidecar is absent; it must not surprise the
        # user by pulling Parakeet weights.
        self.model_size = model_size
        self.model = None

        try:
            from src.config import get_config
            requested = get_config().get_transcription_engine()
        except Exception:
            requested = "parakeet"

        if requested == "apple":
            if not APPLE_SPEECH_AVAILABLE:
                raise ImportError(
                    "Apple on-device transcription is selected, but the "
                    "steno-transcribe sidecar is unavailable."
                )
            self.backend = "apple-speech"
        elif requested == "whisper":
            if not WHISPER_CPP_AVAILABLE:
                raise ImportError(
                    "Whisper.cpp is selected, but its backend is unavailable."
                )
            self.backend = "whisper.cpp"
            self._load_whisper_cpp()
        elif PARAKEET_AVAILABLE:
            self.backend = "parakeet-tdt-v3"
        elif WHISPER_CPP_AVAILABLE:
            self.backend = "whisper.cpp"
            self._load_whisper_cpp()
        else:
            raise ImportError(
                "No usable ASR backend is available for the selected engine."
            )
        expected_backend = {
            "apple": "apple-speech",
            "parakeet": "parakeet-tdt-v3",
            "whisper": "whisper.cpp",
        }.get(requested)
        fallback = self.backend != expected_backend
        logger.info(
            "ASR engine selected: requested=%s using=%s fallback=%s",
            requested, self.backend, fallback,
        )
        self._ensure_ffmpeg_in_path()

    def _load_whisper_cpp(self) -> None:
        """Load the whisper.cpp model lazily for the Intel-Mac fallback path.

        pywhispercpp auto-downloads the ggml weight on first construction;
        ``self.model_size`` should be one of the entries in
        ``src/whisper_models.py`` (large-v3-turbo is the default).
        """
        import multiprocessing
        n_threads = max(1, multiprocessing.cpu_count() - 2)
        logger.info("Loading whisper.cpp model: %s", self.model_size)
        self.model = WhisperCppModel(self.model_size, n_threads=n_threads)
        logger.info("whisper.cpp model loaded (threads=%d)", n_threads)

    def _build_whisper_fallback(self) -> bool:
        """Try to stand up whisper.cpp as a crash-recovery fallback engine.

        Returns True only when a retry on whisper.cpp is actually possible:
        the active backend is Parakeet, pywhispercpp is importable, and the
        ggml weight for ``self.model_size`` is ALREADY on disk. The
        is_installed gate is load-bearing — constructing pywhispercpp's
        Model for a missing weight auto-downloads ~466 MB, which must never
        happen implicitly in a failure path (offline machines, metered
        connections). Any error means "no fallback", never a crash.
        """
        try:
            if self.backend != "parakeet-tdt-v3" or not WHISPER_CPP_AVAILABLE:
                return False
            if self.model is not None:
                # Already loaded by a previous fallback (e.g. the first
                # diarised channel) — reuse it.
                return True
            from src import whisper_models
            if not whisper_models.is_installed(self.model_size):
                logger.info(
                    "whisper.cpp fallback unavailable: model %r not installed",
                    self.model_size,
                )
                return False
            self._load_whisper_cpp()
            return True
        except Exception as e:
            logger.warning("whisper.cpp fallback unavailable: %s", e)
            return False

    def _ensure_ffmpeg_in_path(self) -> None:
        """Make sure ffmpeg is reachable from $PATH for the stereo split.

        We don't need ffmpeg for the basic transcribe path anymore (Parakeet
        handles arbitrary formats via librosa), but the stereo-channel split
        in ``transcribe_diarised`` still calls ffmpeg with a `pan` filter to
        separate the mic and system channels.
        """
        exe_suffix = ".exe" if sys.platform == "win32" else ""
        binary_name = f"ffmpeg{exe_suffix}"
        possible_ffmpeg_paths = []

        if getattr(sys, 'frozen', False):
            exe_dir = Path(sys.executable).parent
            root_ffmpeg = exe_dir / binary_name
            if root_ffmpeg.exists():
                possible_ffmpeg_paths.append(str(root_ffmpeg))
            if hasattr(sys, '_MEIPASS'):
                meipass_ffmpeg = Path(sys._MEIPASS) / binary_name
                if meipass_ffmpeg.exists():
                    possible_ffmpeg_paths.append(str(meipass_ffmpeg))
            internal_ffmpeg = exe_dir / '_internal' / binary_name
            if internal_ffmpeg.exists():
                possible_ffmpeg_paths.append(str(internal_ffmpeg))
        else:
            dev_ffmpeg = Path(__file__).parent.parent / 'bin' / binary_name
            if dev_ffmpeg.exists():
                possible_ffmpeg_paths.append(str(dev_ffmpeg))

        if sys.platform != "win32":
            possible_ffmpeg_paths.extend([
                '/opt/homebrew/bin/ffmpeg',
                '/usr/local/bin/ffmpeg',
                '/usr/bin/ffmpeg',
            ])

        try:
            subprocess.run(['ffmpeg', '-version'], capture_output=True, timeout=5, check=True)
            logger.info("ffmpeg found in PATH")
            return
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError):
            pass

        ffmpeg_found_path = None
        for ffmpeg_path in possible_ffmpeg_paths:
            try:
                subprocess.run([ffmpeg_path, '-version'], capture_output=True, timeout=5, check=True)
                ffmpeg_found_path = ffmpeg_path
                logger.info(f"Found ffmpeg at: {ffmpeg_path}")
                break
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError):
                continue

        if ffmpeg_found_path:
            ffmpeg_dir = os.path.dirname(ffmpeg_found_path)
            current_path = os.environ.get('PATH', '')
            if ffmpeg_dir not in current_path:
                # os.pathsep is ':' on POSIX and ';' on Windows — hardcoding ':'
                # corrupts PATH on Windows so the prepended dir never resolves.
                os.environ['PATH'] = f"{ffmpeg_dir}{os.pathsep}{current_path}"
                logger.info(f"Added {ffmpeg_dir} to PATH")
        else:
            logger.warning("ffmpeg not found - stereo diarisation will fall back to mono")

    def _preprocess_audio(self, audio_filepath: Path) -> Tuple[Path, bool]:
        """Clean mono audio before transcription: high-pass + loudnorm.

        Returns ``(path_to_transcribe, is_temp)``. On any problem — ffmpeg
        missing, non-zero exit, timeout — falls back to ``(original, False)``
        so pre-processing can never fail a meeting. The caller owns deleting
        the temp file when ``is_temp`` is True.
        """
        ffmpeg = _resolve_ffmpeg()
        if not ffmpeg:
            logger.info("ffmpeg unavailable; skipping audio pre-processing")
            return audio_filepath, False

        # mkstemp (not a name derived from the input stem) so concurrent CLI
        # invocations over same-named files can't overwrite or unlink each
        # other's pre-processed audio mid-transcription. Inside the fail-open
        # guard: an mkstemp failure (disk full, temp-dir perms) must fall
        # back to the original audio like every other pre-processing problem,
        # not fail the meeting.
        try:
            fd, temp_name = tempfile.mkstemp(
                prefix=f"stenoai_prep_{audio_filepath.stem}_", suffix=".wav"
            )
            os.close(fd)
        except OSError as e:
            logger.warning("Could not create pre-processing temp file; using original audio: %s", e)
            return audio_filepath, False
        temp_path = Path(temp_name)
        try:
            # loudnorm's two-pass loudness analysis can take real wall-clock
            # time on a long recording, with zero other output in between --
            # without this, the terminal goes silent for that whole stretch
            # right after "Saved: ...", which reads as a hang.
            logger.info(f"Pre-processing audio (highpass + loudnorm): {audio_filepath.name}...")
            result = subprocess.run(
                [ffmpeg, '-y', '-i', str(audio_filepath),
                 '-af', _audio_filter_chain(),
                 '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
                 str(temp_path)],
                capture_output=True,
                timeout=AUDIO_PREPROCESS_TIMEOUT_S,
            )
            if result.returncode == 0 and temp_path.exists() and temp_path.stat().st_size > 0:
                logger.info("Audio pre-processed (highpass + loudnorm): %s", temp_path.name)
                return temp_path, True
            logger.warning(
                "Audio pre-processing failed (rc=%s); using original audio: %s",
                result.returncode, result.stderr.decode(errors='replace')[-300:],
            )
        except Exception as e:
            logger.warning("Audio pre-processing error; using original audio: %s", e)
        # Clean up any partial output from the failed pass.
        try:
            if temp_path.exists():
                temp_path.unlink()
        except OSError:
            pass
        return audio_filepath, False

    # ------------------------------------------------------------------
    # Core: run the configured ASR backend on one WAV path.
    # ------------------------------------------------------------------

    def _run_backend(self, audio_filepath: Path, language: str) -> dict:
        """Dispatch to whichever ASR backend is active for this instance."""
        if self.backend == "apple-speech":
            return self._run_apple_speech(audio_filepath, language)
        if self.backend == "parakeet-tdt-v3":
            return self._run_parakeet(audio_filepath, language)
        return self._run_whisper_cpp(audio_filepath, language)

    def _run_apple_speech(self, audio_filepath: Path, language: str) -> dict:
        """Run Apple's system-managed SpeechTranscriber sidecar."""
        with _heartbeat_while_waiting("apple-speech"):
            result = _apple_transcribe_file(
                audio_filepath,
                language=language,
            )
        result.setdefault("window_coverage", None)
        return result

    def _run_parakeet(self, audio_filepath: Path, language: str) -> dict:
        """Call into ``src.parakeet`` and normalise the result shape.

        No phrase-level filtering here — Parakeet returns empty on silence
        and noise (verified) so the previous whisper-era "Thank you." /
        "Bye." canned-phrase blocklist would strictly drop real speech now.
        """
        # Parakeet TDT v3 is multilingual + language-agnostic at inference
        # time, so "auto" and a concrete code both work — the model just
        # decodes. We surface the requested code in ``detected_language``
        # when it's concrete so the summariser still sees a hint.
        lang_for_parakeet = None if language == "auto" else language
        result = _parakeet_transcribe_file(audio_filepath, language=lang_for_parakeet)
        if not result:
            return {
                "text": None,
                "segments": [],
                "duration_seconds": None,
                "detected_language": None,
                "detected_language_probability": None,
            }

        segments = result.get("segments") or []
        raw_text = (result.get("text") or "").strip()
        return {
            "text": raw_text or None,
            "segments": segments,
            "duration_seconds": result.get("duration_seconds"),
            "detected_language": result.get("detected_language"),
            "detected_language_probability": result.get("detected_language_probability"),
            # Fraction of transcription windows that came back usable, or None
            # where the backend does no windowing of its own. Only the onnx
            # backend can lose a window silently (parakeet-mlx has no per-chunk
            # except, so a bad window fails the whole call loudly) -- but the
            # key travels on both paths so callers never have to branch.
            "window_coverage": result.get("window_coverage"),
        }

    def _convert_to_16khz(self, audio_filepath: Path) -> tuple[Path, Optional[float]]:
        """Convert audio to 16 kHz mono WAV for whisper.cpp via ffmpeg.

        Used only on the whisper.cpp path. Parakeet's ``transcribe_file``
        accepts arbitrary formats via librosa, so the Parakeet path doesn't
        need this step.
        """
        import wave

        # Already 16 kHz mono PCM — e.g. produced by _preprocess_audio (the
        # whisper.cpp crash-fallback receives that temp) or the diarised
        # channel split. Skip the second full decode+encode.
        try:
            with wave.open(str(audio_filepath), 'rb') as wf:
                if (wf.getframerate() == 16000 and wf.getnchannels() == 1
                        and wf.getsampwidth() == 2):
                    return audio_filepath, wf.getnframes() / wf.getframerate()
        except Exception:
            pass  # not a readable WAV — fall through to ffmpeg

        ffmpeg = _resolve_ffmpeg() or 'ffmpeg'
        # mkstemp (not a name derived from the input stem) so concurrent CLI
        # invocations over same-named files can't overwrite or unlink each
        # other's converted audio mid-transcription — same guard as
        # _preprocess_audio. The caller (_run_whisper_cpp) owns deleting this
        # temp when it returns as the converted path; on any failure we return
        # the original audio, so we must clean up the mkstemp file ourselves.
        try:
            fd, temp_name = tempfile.mkstemp(
                prefix=f"stenoai_16khz_{audio_filepath.stem}_", suffix=".wav"
            )
            os.close(fd)
        except OSError as e:
            logger.error("Could not create 16 kHz temp file: %s", e)
            return audio_filepath, None
        converted_path = Path(temp_name)
        try:
            result = subprocess.run(
                [ffmpeg, '-y', '-i', str(audio_filepath),
                 '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
                 str(converted_path)],
                capture_output=True,
                timeout=60,
            )
            if result.returncode == 0 and converted_path.exists() and converted_path.stat().st_size > 0:
                duration_seconds = None
                try:
                    with wave.open(str(converted_path), 'rb') as wf:
                        duration_seconds = wf.getnframes() / wf.getframerate()
                except Exception as e:
                    logger.warning("Could not read duration from converted WAV: %s", e)
                return converted_path, duration_seconds
            logger.error("ffmpeg conversion failed: %s", result.stderr.decode())
        except Exception as e:
            logger.error("Audio conversion error: %s", e)
        # Clean up the (empty or partial) temp output before falling back.
        try:
            if converted_path.exists():
                converted_path.unlink()
        except OSError:
            pass
        return audio_filepath, None

    def _run_whisper_cpp(self, audio_filepath: Path, language: str) -> dict:
        """Call into pywhispercpp on the converted 16 kHz mono WAV.

        Same return shape as ``_run_parakeet``. ``language="auto"`` uses
        whisper.cpp's built-in language detection; a concrete code biases
        the decoder toward that language. Loop-hallucination dedup (runs
        of 5+ identical segments) preserved from the whisper-era code —
        whisper.cpp is known to emit canned phrases like ``"Thank you."``
        repeatedly on silent input.
        """
        if self.model is None:
            logger.error("whisper.cpp model not loaded")
            return {"text": None, "segments": [], "duration_seconds": None,
                    "detected_language": None, "detected_language_probability": None}

        converted_path, duration_seconds = self._convert_to_16khz(audio_filepath)
        cleanup_converted = converted_path != audio_filepath

        try:
            resolved_language = language
            detected_language = None
            detected_language_probability = None

            if language == "auto":
                try:
                    detection_result, _ = self.model.auto_detect_language(media=str(converted_path))
                    if detection_result and len(detection_result) >= 1:
                        detected_language = detection_result[0]
                        resolved_language = detected_language
                        if len(detection_result) >= 2:
                            detected_language_probability = float(detection_result[1])
                except Exception as e:
                    logger.warning("Failed to auto-detect language; using whisper default: %s", e)
                    resolved_language = None

            transcribe_kwargs = {"media": str(converted_path)}
            if resolved_language and resolved_language != "auto":
                transcribe_kwargs["language"] = resolved_language
            # Per-segment heartbeat: keeps the Electron inactivity watchdog
            # alive on this path too — including when whisper.cpp runs as
            # the crash-recovery fallback for a long meeting on a slow
            # machine, which would otherwise be minutes of stdout silence.
            # Probed by signature so an API change degrades to no heartbeat
            # rather than a TypeError mid-failure-recovery.
            try:
                if "new_segment_callback" in inspect.signature(self.model.transcribe).parameters:
                    segment_count = 0

                    def _on_segment(_segment):
                        nonlocal segment_count
                        segment_count += 1
                        _emit_heartbeat(segment_count, 0)  # total unknown

                    transcribe_kwargs["new_segment_callback"] = _on_segment
            except (TypeError, ValueError):
                pass
            segments = self.model.transcribe(**transcribe_kwargs)

            # Dedup whisper.cpp loop hallucinations: 5+ consecutive identical
            # segments. Preserved from the historical whisper code path.
            if segments:
                deduped: list = []
                i = 0
                while i < len(segments):
                    text = segments[i].text.strip()
                    run_end = i + 1
                    while run_end < len(segments) and segments[run_end].text.strip() == text:
                        run_end += 1
                    if run_end - i >= 5 and text:
                        # Log the count, not the text: dropped segments are
                        # transcript content and must not reach the debug log.
                        logger.warning("Dropped %d repeated whisper segments (%d chars each)", run_end - i, len(text))
                    else:
                        deduped.extend(segments[i:run_end])
                    i = run_end
                segments = deduped

            if not segments:
                return {"text": None, "segments": [], "duration_seconds": duration_seconds,
                        "detected_language": detected_language,
                        "detected_language_probability": detected_language_probability}

            transcript = " ".join(s.text.strip() for s in segments)
            return {
                "text": transcript.strip() or None,
                "segments": [
                    {"text": s.text.strip(), "start": s.t0 / 100.0, "end": s.t1 / 100.0}
                    for s in segments if s.text.strip()
                ],
                "duration_seconds": duration_seconds,
                "detected_language": detected_language,
                "detected_language_probability": detected_language_probability,
            }
        finally:
            if cleanup_converted and converted_path.exists():
                try:
                    converted_path.unlink()
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # Public batch API (back-compat with the whisper-era surface).
    # ------------------------------------------------------------------

    def transcribe_audio(
        self,
        audio_filepath: Path,
        language: str = "en",
        _preprocessed: bool = False,
    ) -> Optional[dict]:
        """Transcribe a single-channel (or mono-mixed) audio file.

        Returns ``None`` if the file is missing or too small to transcribe;
        otherwise a dict with ``text`` / ``segments`` / ``duration_seconds`` /
        ``detected_language`` / ``detected_language_probability``.

        ``_preprocessed`` marks input that is already cleaned (the diarised
        path's split channels are 16 kHz mono + high-passed by the split
        ffmpeg pass) so the mono pre-processing pass isn't applied twice.
        """
        if not audio_filepath.exists():
            logger.error(f"Audio file not found: {audio_filepath}")
            return None

        preprocess_temp: Optional[Path] = None
        try:
            logger.info(f"Transcribing audio file: {audio_filepath}")
            file_size = audio_filepath.stat().st_size
            logger.info(f"Audio file size: {file_size / 1024:.1f} KB")

            if file_size < 1000:  # Less than 1KB
                logger.warning("Audio file appears to be too small for transcription")
                return {
                    "text": "Audio file too small or empty",
                    "duration_seconds": None,
                    "detected_language": None,
                    "detected_language_probability": None,
                }

            transcribe_path = audio_filepath
            if not _preprocessed:
                transcribe_path, is_temp = self._preprocess_audio(audio_filepath)
                if is_temp:
                    preprocess_temp = transcribe_path

            try:
                result = self._run_backend(transcribe_path, language)
                result.setdefault("engine", self.backend)
            except Exception as primary_error:
                # A mid-inference crash (e.g. an MLX metal abort) on the
                # primary engine. Retry ONCE on whisper.cpp — but only when
                # the weight is already installed (_build_whisper_fallback
                # never triggers a download). Otherwise re-raise into the
                # honest transcription_failed path below.
                if not self._build_whisper_fallback():
                    raise
                logger.warning(
                    "Primary engine crashed (%s); retrying once on whisper.cpp",
                    primary_error,
                )
                result = self._run_whisper_cpp(transcribe_path, language)
                result["engine"] = "whisper.cpp-fallback"

            transcript = result.get("text")
            logger.info(f"Transcription completed. Length: {len(transcript) if transcript else 0} characters")

            if not transcript:
                logger.warning("Transcription returned empty text (all hallucinations or silent)")
                # Structural flag set BEFORE the sentinel substitution so callers
                # (e.g. transcribe_diarised) can distinguish a genuinely empty
                # result from one that legitimately produced the sentinel text.
                # Checking result["text"] downstream is useless once we overwrite
                # it with the truthy sentinel below (#207, Gap 2 dead-code fix).
                result["transcription_empty"] = True
                result["text"] = SILENCE_SENTINEL

            result.setdefault("detected_language", None)
            result.setdefault("detected_language_probability", None)
            return result

        except Exception as e:
            logger.error(f"Error during transcription: {e}")
            import traceback
            logger.error(f"Traceback: {traceback.format_exc()}")
            # A crash here (e.g. an MLX metal::malloc OOM on a long file) is NOT
            # silence. Return a tagged dict so callers can preserve the audio and
            # surface a real, reprocessable error instead of saving a fake-empty
            # meeting. `None` stays reserved for the missing-file case above so
            # existing "None means no file" callers are unchanged.
            return {
                "text": None,
                "segments": [],
                "duration_seconds": None,
                "detected_language": None,
                "detected_language_probability": None,
                "transcription_failed": True,
                "error": str(e),
            }
        finally:
            if preprocess_temp is not None:
                try:
                    preprocess_temp.unlink()
                except OSError:
                    pass

    def _split_stereo_to_channels(self, audio_filepath: Path) -> Tuple[Optional[Path], Optional[Path], Optional[float]]:
        """Detect stereo and split into mono mic + system channel files.

        Returns ``(mic_path, system_path, duration_seconds)`` if stereo,
        ``(None, None, None)`` if mono or detection fails.
        """
        ffmpeg = _resolve_ffmpeg()
        if not ffmpeg:
            logger.warning("ffmpeg unavailable; cannot split stereo channels")
            return None, None, None

        # Detect channel count via ffmpeg. `-t 0` makes ffmpeg parse the
        # input header (where the channel layout lives) and exit immediately
        # without decoding any audio frames — without it, a 1-hour recording
        # would actually decode in full just to read metadata. In practice
        # this ISN'T always instant: a WebM written live by MediaRecorder
        # (our sysaudio capture path) has no seek index, so on an unusually
        # large file ffmpeg's demuxer can still need real time to find the
        # first decodable packet. A real ~3.5h recording measured this at
        # >15s. Same failure shape _diarised_split_timeout's docstring
        # documents for the later full-channel-split step: a too-tight fixed
        # timeout here silently drops the whole recording to mono (no
        # [You]/[Others]) instead of failing loudly — so this budget needs
        # real headroom, not just enough for the common case.
        try:
            probe = subprocess.run(
                [ffmpeg, '-hide_banner', '-t', '0', '-i', str(audio_filepath),
                 '-f', 'null', '-'],
                capture_output=True, timeout=CHANNEL_DETECT_TIMEOUT_S, text=True
            )
            stderr = probe.stderr or ''
            channels = _parse_channels_from_ffmpeg_stderr(stderr)
            if channels is None:
                logger.warning(f"Could not parse channel count from ffmpeg output: {stderr[:300]}")
                return None, None, None

            duration = _parse_duration_from_ffmpeg_stderr(stderr)

            if channels < 2:
                logger.info("Audio is mono, skipping stereo split")
                return None, None, None

            logger.info(f"Stereo audio detected ({channels} channels), splitting")
        except Exception as e:
            logger.warning(f"Channel detection failed: {e}")
            return None, None, None

        # Split channels into temp files (16kHz mono — Parakeet's expected
        # rate, so the model doesn't have to resample internally).
        temp_dir = tempfile.gettempdir()
        mic_path = Path(temp_dir) / f"stenoai_ch0_{audio_filepath.stem}.wav"
        system_path = Path(temp_dir) / f"stenoai_ch1_{audio_filepath.stem}.wav"

        # Scale the decode timeout to the recording length — a fixed 120 s
        # silently timed out on multi-hour files and lost speaker separation.
        split_timeout = _diarised_split_timeout(duration)

        try:
            for ch_idx, out_path in [(0, mic_path), (1, system_path)]:
                # High-pass only on the diarised path — deliberately NO
                # per-channel loudnorm: normalising each channel separately
                # would erase the relative-RMS difference that
                # _drop_per_segment_bleed uses to tell the direct signal
                # from its attenuated echo on the other channel.
                result = subprocess.run(
                    [ffmpeg, '-y', '-i', str(audio_filepath),
                     '-af', f'pan=mono|c0=c{ch_idx},highpass=f={AUDIO_HIGHPASS_HZ}',
                     '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
                     str(out_path)],
                    capture_output=True, timeout=split_timeout
                )
                if result.returncode != 0:
                    logger.error(f"Channel {ch_idx} extraction failed: {result.stderr.decode()}")
                    return None, None, None

            # If ffprobe couldn't get duration from the container (e.g. WebM),
            # calculate it from the split WAV file
            if duration is None:
                try:
                    import wave
                    with wave.open(str(mic_path), 'rb') as wf:
                        duration = wf.getnframes() / wf.getframerate()
                        logger.info(f"Duration from split WAV: {duration:.1f}s")
                except Exception as e:
                    logger.warning(f"Could not get duration from WAV: {e}")

            logger.info("Stereo channels split successfully")
            return mic_path, system_path, duration
        except Exception as e:
            logger.error(f"Channel splitting error: {e}")
            return None, None, None

    def _check_rms_energy(self, audio_path: Path, threshold: float = MIN_RMS_THRESHOLD) -> bool:
        """Check if an audio file has speech-level energy in any 1-second window.

        Default threshold (MIN_RMS_THRESHOLD, -70 dB) is intentionally low so
        headphones-mode recordings, where the mic input is captured at a
        fraction of speakers-mode levels, still pass. The model handles
        low-amplitude speech fine; the gate's only job is to skip channels
        with effectively zero audio (digital silence from a stalled tap,
        etc.) so we don't waste time transcribing nothing or invite
        hallucinations on dead air.
        """
        try:
            import wave
            with wave.open(str(audio_path), 'rb') as wf:
                n_frames = wf.getnframes()
                sr = wf.getframerate()
                if n_frames == 0:
                    return False
                window = sr  # 1 second
                step = max(window, n_frames // RMS_MAX_WINDOWS)
                max_rms = _scan_max_rms(wf, window, step, threshold)

            label = "early exit" if max_rms >= threshold else "scanned"
            logger.info(
                f"RMS energy for {audio_path.name}: max={max_rms:.6f} "
                f"(threshold {threshold}, {label})"
            )
            return max_rms >= threshold
        except Exception as e:
            logger.warning(f"RMS check failed for {audio_path}: {e}")
            return True

    def transcribe_diarised(self, audio_filepath: Path, language: str = "en") -> Optional[dict]:
        """Transcribe with stereo channel diarisation.

        If the audio is stereo (left=mic, right=system), each channel is
        transcribed separately and labelled as [You] and [Others]. Mono
        audio (e.g. many imported recordings) has no channel split to lean
        on, but can still contain multiple speakers — acoustic diarization
        runs directly against the whole file instead; see
        _transcribe_diarised_mono.
        """
        mic_path, system_path, duration = self._split_stereo_to_channels(audio_filepath)

        if mic_path is None:
            return self._transcribe_diarised_mono(audio_filepath, language)

        try:
            mic_has_audio = self._check_rms_energy(mic_path)
            system_has_audio = self._check_rms_energy(system_path)

            mic_segments: list[dict] = []
            system_segments: list[dict] = []
            detected_language = None
            detected_language_probability = None
            engine = None
            # A hard crash on a channel (MLX OOM, decode abort) is preserved
            # unconditionally — that's the original Gap 1 honest-failure path.
            channel_failed = False
            channel_error: Optional[str] = None
            # Gap 2 (#207): a channel that PASSED the RMS energy gate but came
            # back empty is a quiet ASR failure. But the RMS gate only detects
            # "not digital silence" — music/noise/reverb can pass it too, so an
            # empty energetic channel must NOT fail the whole meeting on its own.
            # We only fail when NO channel produced usable text (decided below).
            mic_empty_on_energy = False
            system_empty_on_energy = False
            empty_error: Optional[str] = None
            # A channel the energy gate skipped never gets a result -- bind
            # both up front so anything reading them after the branches (the
            # window-coverage roll-up at the end) can't hit an unbound name.
            mic_result: Optional[dict] = None
            sys_result: Optional[dict] = None

            # Split channels are already 16 kHz mono + high-passed by the
            # split ffmpeg pass above — skip the mono pre-processing pass.
            if mic_has_audio:
                logger.info("Transcribing mic channel (You)...")
                mic_result = self.transcribe_audio(mic_path, language, _preprocessed=True)
                if mic_result and mic_result.get("transcription_failed"):
                    channel_failed = True
                    channel_error = channel_error or mic_result.get("error")
                elif mic_result and not mic_result.get("transcription_empty") \
                        and mic_result.get("text"):
                    mic_segments = mic_result.get("segments") or []
                    if not detected_language and mic_result.get("detected_language"):
                        detected_language = mic_result["detected_language"]
                        detected_language_probability = mic_result.get("detected_language_probability")
                    if not engine:
                        engine = mic_result.get("engine")
                else:
                    # Passed the RMS energy gate but produced no real text (the
                    # text field, if any, is the silence sentinel — see the
                    # transcription_empty flag set in transcribe_audio). Record
                    # it, but don't fail yet: the other channel may carry text.
                    mic_empty_on_energy = True
                    empty_error = empty_error or "Mic channel had audio but transcription returned empty"
                    logger.warning(
                        "Mic channel passed the energy gate but produced no text"
                    )
            else:
                logger.info("Mic channel is silent, skipping")

            if system_has_audio:
                logger.info("Transcribing system channel (Others)...")
                sys_result = self.transcribe_audio(system_path, language, _preprocessed=True)
                if sys_result and sys_result.get("transcription_failed"):
                    channel_failed = True
                    channel_error = channel_error or sys_result.get("error")
                elif sys_result and not sys_result.get("transcription_empty") \
                        and sys_result.get("text"):
                    system_segments = sys_result.get("segments") or []
                    if not detected_language and sys_result.get("detected_language"):
                        detected_language = sys_result["detected_language"]
                        detected_language_probability = sys_result.get("detected_language_probability")
                    if not engine:
                        engine = sys_result.get("engine")
                else:
                    # Empty output on an energetic channel — record, don't fail
                    # yet (see mic above).
                    system_empty_on_energy = True
                    empty_error = empty_error or "System channel had audio but transcription returned empty"
                    logger.warning(
                        "System channel passed the energy gate but produced no text"
                    )
            else:
                logger.info("System channel is silent, skipping")

            # A hard crash on either channel is not silence. Bail before
            # assembling a transcript so the caller preserves the audio and
            # surfaces a real error instead of saving a partial/fake-empty
            # meeting.
            if channel_failed:
                logger.error("Diarised transcription failed on a channel: %s", channel_error)
                return {
                    "text": None,
                    "diarised_text": None,
                    "is_diarised": False,
                    "duration_seconds": duration,
                    "detected_language": detected_language,
                    "detected_language_probability": detected_language_probability,
                    "transcription_failed": True,
                    "error": channel_error or "transcription failed",
                }

            # Gap 2 (#207): only fail when NO channel produced usable text AND at
            # least one energetic channel came back empty. If one channel carries
            # real text and the other is just empty noise, the meeting is fine —
            # the empty channel is dropped, not treated as a failure.
            has_usable_text = bool(mic_segments) or bool(system_segments)
            if not has_usable_text and (mic_empty_on_energy or system_empty_on_energy):
                logger.error(
                    "Diarised transcription: every energetic channel returned "
                    "empty text — treating as a failure (audio preserved): %s",
                    empty_error,
                )
                return {
                    "text": None,
                    "diarised_text": None,
                    "is_diarised": False,
                    "duration_seconds": duration,
                    "detected_language": detected_language,
                    "detected_language_probability": detected_language_probability,
                    "transcription_failed": True,
                    "error": empty_error or "transcription returned empty",
                }

            # Speaker-bleed correction runs in two passes:
            #
            # 1. Per-segment: drop the bleed-echo side of each Jaccard-
            #    matched (mic, system) pair. Decides which side is the
            #    echo by comparing per-segment RMS on the split channel
            #    WAVs — the channel with higher RMS holds the direct
            #    signal. Without that RMS step we'd always drop system,
            #    which is wrong in the headphone-less case where the
            #    mic is the one picking up the echo of Others' speech.
            # 2. Whole-transcript: if what's LEFT of the system channel
            #    still overlaps mic >= BLEED_JACCARD_THRESHOLD, the
            #    remaining content is also bleed — collapse to mic-only.
            #    The first pass usually handles things and this is a
            #    backstop for catastrophic bleed.
            if mic_segments and system_segments:
                mic_segments, system_segments = _drop_per_segment_bleed(
                    mic_segments, system_segments,
                    mic_path=mic_path, system_path=system_path,
                )
            if mic_segments and system_segments:
                mic_text = ' '.join(s.get('text', '') for s in mic_segments)
                sys_text = ' '.join(s.get('text', '') for s in system_segments)
                similarity = _token_jaccard(mic_text, sys_text)
                if similarity >= BLEED_JACCARD_THRESHOLD:
                    logger.info(
                        f"Channel bleed detected (Jaccard={similarity:.2f} ≥ "
                        f"{BLEED_JACCARD_THRESHOLD}); collapsing to mic-only"
                    )
                    system_segments = []

            # Chronologically interleave segments from both channels and
            # collapse runs of consecutive same-speaker segments into a
            # single labelled turn. Each channel is first run through
            # acoustic diarization (steno-diarize, macOS only) to split
            # multiple speakers sharing one side of the call; any failure
            # or a single-cluster result falls back to the legacy
            # "You"/"Others" channel-only labeling.
            identity_enabled = _identity_matching_enabled()
            mic_clusters: dict = {}
            system_clusters: dict = {}
            tagged: list[tuple[float, str, str, str, Optional[str]]] = []
            tagged.extend(
                (start, label, text, "mic", raw_sid)
                for start, label, text, raw_sid in _tag_channel_segments(
                    mic_segments, mic_path, duration, "You",
                    allow_self_match=identity_enabled,
                    clusters_out=mic_clusters if identity_enabled else None,
                )
            )
            tagged.extend(
                (start, label, text, "system", raw_sid)
                for start, label, text, raw_sid in _tag_channel_segments(
                    system_segments, system_path, duration, "Others",
                    clusters_out=system_clusters if identity_enabled else None,
                )
            )
            tagged.sort(key=lambda t: t[0])
            if identity_enabled:
                tagged, mic_clusters, system_clusters = _reconcile_cross_channel_speakers(
                    tagged, mic_clusters, system_clusters,
                )
            tagged = _resolve_speaker_placeholders(tagged)

            # Same {"mic"|"system": {"recording_type", "clusters"}} shape
            # write_speakers_sidecar expects -- lets the caller
            # (simple_recorder.process_recording_streaming) write the
            # {stem}_speakers.json sidecar straight from this recording's
            # own diarization pass, with zero extra diarization cost. Only
            # a channel that actually diarized (mic_clusters/system_clusters
            # non-empty) is included -- a channel that fell back to legacy
            # labeling has no cluster/embedding data to persist.
            speaker_clusters: dict = {}
            if identity_enabled and mic_clusters:
                speaker_clusters["mic"] = {
                    "recording_type": determine_recording_type("mic", has_audio=True),
                    "clusters": mic_clusters,
                }
            if identity_enabled and system_clusters:
                speaker_clusters["system"] = {
                    "recording_type": determine_recording_type("system", has_audio=True),
                    "clusters": system_clusters,
                }

            # Each turn carries the start offset of its FIRST segment so the
            # diarised transcript can be timestamped. Only diarised_text is
            # timestamped (it's what the UI displays + what #215 exports); the
            # plain text field stays clean. NOTE: diarised_text is also the
            # summariser input (simple_recorder: text_for_summary = diarised_text
            # or transcript_text), so the summariser strips these [MM:SS] markers
            # back out on the way in (summarizer._strip_leading_timestamps) —
            # summarisation is unaffected by this display feature.
            assembled = _assemble_diarised_turns(tagged)
            plain_text = "\n\n".join(assembled.plain_parts) if assembled.plain_parts else SILENCE_SENTINEL

            return {
                "text": plain_text,
                "diarised_text": assembled.diarised_text,
                "is_diarised": assembled.is_diarised,
                "duration_seconds": duration,
                "detected_language": detected_language,
                "detected_language_probability": detected_language_probability,
                "engine": engine or self.backend,
                # {"mic"|"system": {"recording_type", "clusters"}} for
                # src.speaker_suggestions.write_speakers_sidecar, or {} if
                # neither channel diarized. Cross-channel echo aliases were
                # removed above, so the Speakers panel and exact relabel manifest
                # share the same canonical cluster ids. See _tag_channel_segments'
                # clusters_out param. Identity matching off neither collects nor
                # compares embeddings here.
                "speaker_clusters": speaker_clusters,
                # list[{"start", "channel", "diarization_speaker_id"}], one
                # per turn -- see comment above turn_manifest's construction.
                "turn_manifest": assembled.turn_manifest,
                # Worst channel wins: a meeting is only as complete as the
                # side that lost the most. None when no channel reported a
                # figure (whisper.cpp, parakeet-mlx, or a file short enough
                # to need no windowing) -- absence means "unknown", never
                # "complete", so callers must not read it as a pass.
                "window_coverage": _worst_window_coverage(mic_result, sys_result),
            }
        finally:
            # Clean up temp channel files
            for p in (mic_path, system_path):
                if p and p.exists():
                    try:
                        p.unlink()
                    except Exception:
                        pass

    def _transcribe_diarised_mono(self, audio_filepath: Path, language: str) -> Optional[dict]:
        """Diarise a mono recording (no channel split to lean on).

        Runs standard transcription, then acoustic diarization directly
        against the whole file via the same _tag_channel_segments helper the
        stereo path uses per-channel — steno-diarize decodes any input
        format itself (via ffmpeg), so no split/preprocessing is needed
        first. The single track is treated as the "You" channel, matching
        the pre-diarization convention of attributing an unlabelled mono
        recording to the user; a second acoustic cluster becomes "Speaker 2"
        exactly as a second cluster on the mic channel would in the stereo
        path. Any diarization failure or a single-cluster result leaves
        is_diarised False, matching the historical mono behaviour exactly.
        """
        result = self.transcribe_audio(audio_filepath, language)
        if not result:
            return result
        result['is_diarised'] = False
        result['diarised_text'] = None
        if result.get("transcription_failed") or result.get("transcription_empty"):
            return result

        asr_segments = result.get("segments") or []
        duration = result.get("duration_seconds")
        identity_enabled = _identity_matching_enabled()
        mono_clusters: dict = {}
        tagged = [
            (start, label, text, "mic", raw_sid)
            for start, label, text, raw_sid in _tag_channel_segments(
                asr_segments, audio_filepath, duration, "You",
                allow_self_match=identity_enabled,
                clusters_out=mono_clusters if identity_enabled else None,
            )
        ]
        tagged.sort(key=lambda t: t[0])
        tagged = _resolve_speaker_placeholders(tagged)

        assembled = _assemble_diarised_turns(tagged)
        result['speaker_clusters'] = {}
        result['turn_manifest'] = assembled.turn_manifest
        if assembled.is_diarised:
            result['diarised_text'] = assembled.diarised_text
            result['is_diarised'] = True
            if mono_clusters:
                # Same "mic" convention _transcribe_diarised_mono's own
                # docstring documents: an unlabelled mono recording is
                # attributed to the device owner, matching the stereo
                # path's mic channel.
                result['speaker_clusters']['mic'] = {
                    "recording_type": determine_recording_type("mic", has_audio=True),
                    "clusters": mono_clusters,
                }

        return result

    def transcribe_with_timestamps(self, audio_filepath: Path) -> Optional[dict]:
        """Batch transcribe and return segment-level timing.

        Thin wrapper around ``_run_backend`` — Parakeet returns AlignedSentence
        timings directly; whisper.cpp segments expose t0/t1 in centiseconds
        which the backend's normaliser converts.
        """
        if not audio_filepath.exists():
            logger.error(f"Audio file not found: {audio_filepath}")
            return None

        try:
            logger.info(f"Transcribing audio file with timestamps: {audio_filepath}")
            result = self._run_backend(audio_filepath, language="auto")
            return {
                "text": result.get("text") or "",
                "segments": result.get("segments") or [],
            }
        except Exception as e:
            logger.error(f"Error during transcription: {e}")
            return None

    def change_model(self, model_size: str) -> bool:
        """Back-compat shim. Parakeet TDT v3 has no size variants; we just
        accept the call so the existing CLI / settings code doesn't break,
        log a notice, and return True."""
        if model_size != self.model_size:
            logger.info(
                "change_model called with %r — ignored, Parakeet TDT v3 is "
                "the only available model.", model_size,
            )
        self.model_size = model_size
        return True

    def get_backend_info(self) -> dict:
        """Backend info surface kept compatible with the whisper-era callers."""
        return {
            "backend": self.backend,
            "model_size": self.model_size,
            "parakeet_available": PARAKEET_AVAILABLE,
            # Legacy keys retained so any existing UI that probes them
            # doesn't crash on KeyError; both are now always False.
            "whisper_cpp_available": False,
            "openai_whisper_available": False,
        }
