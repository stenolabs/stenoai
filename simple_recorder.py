#!/usr/bin/env python3
"""
Simple Audio Recorder & Transcriber for Electron App

Backend script that handles:
1. Transcribing captured audio with Whisper/Parakeet
2. Summarizing with Ollama
3. Saving everything locally

Audio capture is done in the Electron renderer (Web Audio); this backend
transcribes/summarizes the resulting file. Usage (called by Electron):
    python simple_recorder.py process-streaming recording.webm --name "Session"
    python simple_recorder.py transcribe-stream   # live partials over stdin
    python simple_recorder.py process-streaming recording.wav --name "Session"
    python simple_recorder.py status
"""

import click
import asyncio
import filelock
import logging
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

# Force UTF-8 on stdout/stderr so emoji and non-ASCII prints don't crash under
# Windows' default cp1252 codepage. Must run before any print() in this module.
# newline="\n" disables Windows' \n -> \r\n translation: the Electron host parses
# our streaming protocol line-by-line and matches exact sentinels (e.g.
# STREAM_COMPLETE); a translated trailing \r would make those exact matches fail
# and strand the UI "in analysis". (main.js also splits CRLF-tolerantly as a
# belt-and-suspenders, but fixing it at the source covers every sentinel.)
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", newline="\n")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace", newline="\n")
    except (AttributeError, OSError):
        pass

# Wire stdlib SSL up to certifi's CA bundle before anything tries to make
# an HTTPS call. PyInstaller's compiled-in cert paths don't exist on a
# customer's Mac, so without this the adapter request in summarizer.py
# fails with CERTIFICATE_VERIFY_FAILED.
from src import tls_bootstrap  # noqa: F401

# Import modules with graceful fallback for missing dependencies
try:
    from src.transcriber import WhisperTranscriber
except ImportError:
    WhisperTranscriber = None
    
try:
    from src.summarizer import OllamaSummarizer
except ImportError:
    OllamaSummarizer = None

from src.language_detect import detect_transcript_language

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def resolve_output_language(
    configured_language: str,
    detected_language: Optional[str] = None,
    transcript_text: Optional[str] = None,
) -> str:
    """Resolve the summary/title/query output language, in strict priority order.

    1. an explicit user pin (``configured_language != "auto"``) always wins;
    2. an engine-detected language — whisper.cpp reports one; Parakeet never
       does (#283);
    3. a text-based detection over the transcript body, filling Parakeet's gap
       so an auto-mode German/French/… meeting isn't summarised in English;
    4. ``"en"`` as the final fallback when nothing above is conclusive.

    Kept module-level (the ``MeetingPipeline`` method delegates here) so the
    resolution logic is unit-testable without constructing the pipeline.
    """
    if configured_language and configured_language != "auto":
        return configured_language

    if detected_language:
        return detected_language

    if transcript_text:
        detected = detect_transcript_language(transcript_text)
        if detected:
            # Privacy: log the code only, never the transcript content.
            logger.info(
                "Detected transcript language: %s (auto mode, engine gave none)",
                detected,
            )
            return detected

    return "en"


def _apply_chinese_variant(text: Optional[str]) -> Optional[str]:
    """Convert ``text`` to the user's selected Chinese script, if any.

    whisper.cpp and Parakeet (and the summariser LLM) emit Simplified for
    Chinese; a user who picked Traditional (``zh-Hant``) gets an s2t pass here.
    A thin, never-throwing hook: non-Chinese languages, a missing OpenCC, or a
    conversion error all fall through to the input unchanged so transcription
    is never broken by variant conversion.
    """
    if not text:
        return text
    try:
        from src.config import get_config
        from src.chinese import apply_variant

        variant = get_config().get_chinese_variant()
        if variant:
            return apply_variant(text, variant)
    except Exception as e:
        logger.warning(f"Chinese variant conversion skipped: {e}")
    return text


def resolve_persisted_output_language(
    session_info: dict,
    transcript_text: Optional[str],
    fallback_configured: str,
) -> str:
    """Resolve output language for a note that already has a persisted value.

    Recovery paths (reprocess / generate-report / regen-title) reopen a saved
    note whose ``session_info`` carries an ``output_language`` from when it was
    first processed. That persisted value is only trustworthy when we can prove
    its *provenance*: it was written from a real user pin
    (``configured_language != "auto"``) or from an engine detection
    (``detected_language``, i.e. Whisper). Old Parakeet auto-mode notes instead
    persisted ``"en"`` purely from the buggy fallback (#283) with no pin and no
    engine language behind it - trusting that value would re-pin every such note
    to English forever, defeating this fix.

    So: honour the persisted value only when pin- or engine-backed; otherwise
    fall through to ``resolve_output_language`` (which re-detects from the
    transcript, then lands on "en" if inconclusive). Re-detecting a
    previously text-detected note is idempotent, so this is safe to re-run.

    Only STORED provenance may authenticate the persisted value: the caller's
    current pin must NOT retroactively legitimise a stale value it never
    produced. So a legacy note {output_language: "en"} with no stored provenance
    does not become trustworthy just because config is now pinned to "fr" - the
    current "fr" pin wins instead. ``fallback_configured`` (the caller's current
    configured language) therefore feeds ONLY the untrusted-path resolve, never
    the trust check.
    """
    stored_configured = session_info.get("configured_language")
    detected = session_info.get("detected_language")
    persisted = session_info.get("output_language")
    if persisted and ((stored_configured and stored_configured != "auto") or detected):
        return persisted
    # Untrusted persisted value: resolve fresh. Prefer a real stored pin (which
    # only reaches here when no output_language was persisted), then the
    # caller's current pin, then engine/text detection.
    return resolve_output_language(
        stored_configured or fallback_configured, detected, transcript_text
    )


# Session names that should trigger AI title regeneration after summarization.
# Covers manual placeholders (Meeting / Note / Meeting-ABC123 / Note-ABC123) and
# the auto-detect-meetings shape "<AppName> — YYYY-MM-DD HH:MM" produced by
# requestAutoRecord in app/main.js. Keep in sync if the auto-detect format changes.
_AUTO_NAMED_PATTERN = re.compile(
    r'^(?:(?:Meeting|Note)(?:-[A-Z0-9]{6})?'
    r'|.+ — \d{4}-\d{2}-\d{2} \d{2}:\d{2})$'
)

# Regex to normalize markdown headers that incorrectly start on the same line as
# the closing tag of a reasoning block (e.g. `</thought>## Summary`). This ensures
# the parser correctly splits and identifies sections. Scoped to think/thought
# tags specifically (not any HTML-like tag) so unrelated inline markup in the
# model's output can't be mistaken for a reasoning block and get a spurious
# section break inserted ahead of it.
#   Mirrored in app/main.js as REASONING_TAG_HEADER_PATTERN /
#   normalizeMarkdownForParsing (the detail-page parser). The two MUST stay
#   equivalent — see #346. Any edit here has to land there too.
_REASONING_TAG_HEADER_PATTERN = re.compile(r'(</(?:think|thought|thinking|reasoning)>)\s*(#{1,6}\s)', re.IGNORECASE)

# Opts one-off/manual diarization CLI invocations (never the normal
# per-meeting pipeline) into GPU instead of the steno-diarize sidecar's own
# power/thermal-efficient ANE default -- exactly the escape hatch
# main.swift's resolveComputeUnits() documents for "bulk backfill runs
# where throughput matters more than power/thermal efficiency". Benchmarked
# on a real ~21-minute recording (post-highContextV2 config swap): ANE
# 23.0s vs GPU 18.0s wall-clock (~1.28x), with near-identical speaker
# clusters/segment totals between the two -- a real, worthwhile win for a
# manual/background bulk run. Not wired into the normal live pipeline,
# which keeps the ANE default (see Phase 6 of the plan doc for the
# power/thermal tradeoff discussion -- that's a user-facing decision, not
# made here).
_DIARIZE_BULK_ENV = {"STENOAI_DIARIZE_COMPUTE_UNITS": "cpuAndGPU"}

def _normalize_markdown_for_parsing(md_text: str) -> str:
    """Ensure headers immediately following a reasoning tag start on a new line."""
    return _REASONING_TAG_HEADER_PATTERN.sub(r'\1\n\2', md_text)

# Shared atomic writers (tempfile + os.replace + Windows PermissionError
# retry). One implementation for the summary JSON and config.json (recorder_state.json
# is no longer written — see MeetingPipeline.state_file) and one for the summary
# Markdown — re-exported here so existing imports keep working. The canonical
# copies live in src.config because this module already imports from src (the
# reverse import would be circular).
from src.config import _atomic_write_json, _atomic_write_text  # noqa: E402


def _start_summary_heartbeat(label: str = "summarize", interval_s: int = 60, max_beats: int = 30):
    """Print ``HEARTBEAT:<label>:<n>`` lines from a daemon thread.

    Covers the silent window between "Generating summary" and the model's
    first streamed token — prompt eval of a context-capped transcript on a
    CPU-only machine can exceed the Electron inactivity watchdog's window
    with zero stdout. Capped at ``max_beats`` so a genuinely hung Ollama
    can't keep the watchdog alive forever (30 beats ≈ the old fixed 30-min
    budget). Returns a ``threading.Event``; set it to stop the beats — the
    caller stops it on the first streamed chunk, after which real output is
    the liveness signal.

    Single ``sys.stdout.write`` per line (TextIOWrapper writes are locked)
    so a beat can never tear a concurrently streamed CHUNK: line.
    """
    import threading

    stop = threading.Event()

    def _beat():
        beats = 0
        while beats < max_beats and not stop.wait(interval_s):
            beats += 1
            sys.stdout.write(f"HEARTBEAT:{label}:{beats}\n")
            sys.stdout.flush()

    threading.Thread(target=_beat, daemon=True, name="summary-heartbeat").start()
    return stop


def _emit_progress(step: int, total: int) -> None:
    """Emit a PROGRESS: line to stdout for the map-reduce summarization step."""
    if step > total:
        label = "reducing"
    else:
        label = f"{step}/{total}"
    sys.stdout.write(f"PROGRESS:summarize:{label}\n")
    sys.stdout.flush()


def _find_recording_for_stem(recordings_dir, stem: str):
    """Return the source recording whose filename stem matches ``stem``, else None.

    The recording filename stem equals the note stem (``<stem>_summary.md`` →
    ``<stem>``), with an arbitrary extension (native ``.wav``, system-audio
    ``.webm``, imported ``.m4a`` / ``.mp3``). Iterating and comparing stems keeps
    the match extension-agnostic and avoids treating ``stem`` as a glob pattern.
    Used by re-transcribe (#266) to locate the audio to re-run ASR on; returns
    None when keep-recordings was off and the source is gone (the MVP audio-gate).

    Deterministic + safe when the stem is not unique: collect ALL stem-matching
    regular files and return one only when there is EXACTLY ONE. If several files
    share the stem (e.g. a retained ``.wav`` next to an imported ``.m4a``),
    decline (return None) rather than guess the wrong source — the caller already
    surfaces ``RETRANSCRIBE_NO_AUDIO``. Symlinks are rejected (``is_symlink()``)
    to match the JS ``recording-available`` handler's ``Dirent.isFile()`` posture
    and to never re-transcribe through a symlinked recording. The app enforces
    stem uniqueness, so the ambiguity guard is defensive.
    """
    from pathlib import Path
    matches = []
    try:
        for entry in Path(recordings_dir).iterdir():
            # is_file() follows symlinks; also reject symlinks so both sides agree
            # (the JS handler's Dirent.isFile() does not follow symlinks).
            if entry.is_file() and not entry.is_symlink() and Path(entry.name).stem == stem:
                matches.append(entry)
    except (FileNotFoundError, NotADirectoryError):
        return None
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        logger.warning(
            "Re-transcribe: %d recordings share stem %r in %s; declining as ambiguous",
            len(matches), stem, recordings_dir,
        )
    return None


def _render_frontmatter(meta: dict) -> list[str]:
    """Render a meeting .md YAML frontmatter block (including the enclosing
    ``---`` fences) from a flat dict, with the type-specific scalar
    formatting the streaming save paths use.

    Shared by ``process_recording_streaming``, ``process_streaming`` and the
    transcription-failure writer so the frontmatter format stays in one place.
    ``bool`` is checked before ``int`` because ``bool`` is an ``int`` subclass.
    """
    lines = ['---']
    for k, v in meta.items():
        if v is None:
            lines.append(f'{k}: null')
        elif isinstance(v, bool):
            lines.append(f'{k}: {"true" if v else "false"}')
        elif isinstance(v, int):
            lines.append(f'{k}: {v}')
        else:
            escaped = str(v).replace('\\', '\\\\').replace('"', '\\"')
            lines.append(f'{k}: "{escaped}"')
    lines.append('---')
    return lines


def _persist_speaker_sidecar(output_dir, meeting_stem: str, transcript_data: dict) -> bool:
    """Write the `{stem}_speakers.json` sidecar from diarization output a
    run has ALREADY computed. Returns True when a sidecar was written.

    Every path that finishes a meeting must call this, and the reason is
    that the cost of the work is already sunk long before any of them
    decide what to do next: diarization and embedding extraction happen
    inside transcription, so by the time a path reaches its own `return`
    the clusters are sitting in `transcript_data` fully paid for. Skipping
    the write does not save anything -- it only discards the embeddings,
    and with them the meeting's entire Speakers panel, permanently once
    the source audio is gone (keep_recordings defaults off).

    Three paths used to reach a `return` without writing it, all with the
    clusters in hand:
      - MeetingPipeline.process_recording's auto-summarize gate (#258)
      - process_streaming's auto-summarize gate (the same gate, second copy)
      - reprocess --retranscribe, which re-runs the FULL transcription
        (diarization included, at full cost) and then dropped the result
    The shared symptom was that turning OFF automatic note generation
    silently turned off speaker identification too, with no setting saying
    so, no error, and no way to recover the embeddings afterwards -- the
    diarization itself ran normally and the transcript carried its speaker
    labels, so nothing on screen suggested anything had been lost.

    Deliberately NOT called from the continue-recording (`append_to`) path.
    That path folds a segment into an EXISTING note, and this sidecar is
    keyed by the segment's own audio stem, which belongs to no note --
    writing there produces exactly the orphaned sidecar that has to be
    cleaned up by hand later. Continuations keeping the original
    recording's sidecar is the correct outcome; merging a continuation's
    clusters into it is a separate piece of work (the cluster ids of two
    independent diarization runs are unrelated).
    """
    speaker_clusters = transcript_data.get("speaker_clusters") or {}
    if not speaker_clusters:
        return False
    from src.speaker_suggestions import (
        count_review_markings, read_speakers_sidecar, write_speakers_sidecar,
    )
    # Read before overwriting, purely to report what this run discards. A
    # fresh diarization numbers its clusters from SPEAKER_0 again, so every
    # marking a human made against the old ids stops describing anything --
    # carrying them forward would attach a person's statement to whichever
    # voice inherited the id. Losing them is right; losing them silently is
    # not, and they are the one thing in this file no re-run reproduces.
    # `reprocess` streams lines rather than one JSON document, so the report
    # is a warning plus one greppable stdout line, mirroring the backfill's
    # wording.
    lost = count_review_markings(read_speakers_sidecar(output_dir, meeting_stem))
    if lost["multi_speaker"] or lost["review_state"]:
        message = (
            f"{meeting_stem}: re-diarization discards "
            f"{lost['multi_speaker']} cluster(s) marked as containing multiple speakers "
            f"and {lost['review_state']} kept generic."
        )
        logger.warning("Speaker markings lost: %s", message)
        print(f"LOST_SPEAKER_MARKINGS: {message}", flush=True)
    try:
        write_speakers_sidecar(
            output_dir, meeting_stem, speaker_clusters,
            turn_manifest=transcript_data.get("turn_manifest"),
        )
    except (OSError, ValueError):
        # Speaker review is optional. A concurrent review can hold the
        # sidecar lock, and malformed internal channel data must not turn an
        # otherwise valid transcription into a failed meeting.
        logger.warning("Could not persist the optional speaker analysis.")
        return False
    return True


class MeetingPipeline:
    """Simple audio recorder and transcriber."""
    
    def __init__(self):
        # Only initialize transcriber/summarizer when needed to save memory
        self.transcriber = None
        self.summarizer = None

        # Directories - centralised via get_data_dirs()
        from src.config import get_data_dirs
        dirs = get_data_dirs()
        self.recordings_dir = dirs["recordings"]
        self.transcripts_dir = dirs["transcripts"]
        self.output_dir = dirs["output"]
        
        # Legacy state file. Recording state now lives in the Electron main
        # process (capture is renderer-driven) -- see the status() docstring --
        # so nothing writes recorder_state.json anymore; the old
        # save_state()/load_state() pair was removed. The only remaining uses
        # are the defensive .unlink() cleanups (here via clear_state, plus the
        # transcription-failure paths) that remove a stale file left by a
        # pre-migration build. Kept CWD-relative on purpose: a legacy build
        # wrote it CWD-relative to the backend's working dir, which
        # getBackendCwd() (app/main.js) resolves to a single, deterministic
        # location, so the cleanup reliably finds and removes that same file.
        # Routing this through get_user_data_dir() would point cleanup at the
        # wrong directory. Because nothing writes it, the CWD-relative path
        # never touches the read-only packaged bundle and cannot leak across
        # the STENOAI_USER_DATA_DIR isolation boundary (real user data goes
        # through get_data_dirs(), which honors that env var).
        self.state_file = Path("recorder_state.json")

    def _resolve_output_language(
        self,
        configured_language: str,
        detected_language: Optional[str] = None,
        transcript_text: Optional[str] = None,
    ) -> str:
        """Resolve which language should be used for summary/title/query output.

        Thin delegate to the module-level ``resolve_output_language`` so the
        priority (pin > engine-detected > text-detected > "en") lives in one
        unit-testable place.
        """
        return resolve_output_language(
            configured_language, detected_language, transcript_text
        )

    def _transcript_file_path(self, audio_path: Path) -> Path:
        """Canonical on-disk path for a meeting's transcript text file.

        Single source of truth so the normal path and the live-transcript /
        crash fallback always agree on the filename (#207).
        """
        return self.transcripts_dir / f"{audio_path.stem}_transcript.txt"

    def _write_transcript_file(
        self,
        audio_path: Path,
        transcript_body: str,
        session_name: str,
        configured_language: str,
        detected_language: Optional[str] = None,
        output_language: Optional[str] = None,
    ) -> Path:
        """Format + write the transcript .txt with the standard header.

        Used by both the normal transcription path and the fallback paths so
        the file format and name stay identical (#207). Returns the path.
        """
        from src.config import get_config
        config = get_config()

        if output_language is None:
            output_language = self._resolve_output_language(
                configured_language, detected_language, transcript_text=transcript_body
            )
        detected_language_name = (
            config.get_language_name(detected_language) if detected_language else "Unknown"
        )

        transcript_path = self._transcript_file_path(audio_path)
        transcript_content = f"""Session: {session_name}
File: {audio_path.name}
Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
Language setting: {config.get_language_name(configured_language)}
Detected language: {detected_language_name}
Summary output language: {config.get_language_name(output_language)}

{'='*60}

{transcript_body}
"""
        with open(transcript_path, 'w', encoding='utf-8') as f:
            f.write(transcript_content)
        return transcript_path

    @staticmethod
    def _load_user_notes(session_name: str, output_dir) -> Optional[str]:
        """Load user notes file saved by Electron during recording."""
        safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', session_name)
        for candidate in [
            Path(output_dir) / f"{safe_name}_notes.txt",
            Path(output_dir) / f"{session_name}_notes.txt",
        ]:
            if candidate.exists():
                try:
                    text = candidate.read_text(encoding='utf-8').strip()
                    if text:
                        logger.info(f"Loaded user notes ({len(text)} chars)")
                        return text
                except (OSError, UnicodeDecodeError):
                    pass
                break
        return None

    @staticmethod
    def _parse_streamed_markdown(md_text: str) -> dict:
        """Parse streamed markdown summary into structured fields."""
        md_text = _normalize_markdown_for_parsing(md_text)

        summary_parts = []
        participants = []
        discussion_areas = []
        key_points = []
        action_items = []
        current_section = None
        current_topic_title = None
        current_topic_lines = []

        for line in md_text.split('\n'):
            stripped = line.strip()
            if stripped.startswith('## Summary'):
                current_section = 'summary'
            elif stripped.startswith('## Participants'):
                current_section = 'participants'
            elif stripped.startswith('## Key Topics'):
                current_section = 'topics'
            elif stripped.startswith('## Key Points'):
                current_section = 'keypoints'
            elif stripped.startswith('## Action Items'):
                current_section = 'actions'
            elif stripped.startswith('### ') and current_section == 'topics':
                if current_topic_title:
                    discussion_areas.append({"title": current_topic_title, "analysis": '\n'.join(current_topic_lines).strip()})
                current_topic_title = stripped[4:]
                current_topic_lines = []
            elif current_section == 'summary' and stripped:
                summary_parts.append(stripped)
            elif current_section == 'participants' and stripped:
                participants.extend([p.strip() for p in stripped.split(',') if p.strip()])
            elif current_section == 'topics' and current_topic_title:
                current_topic_lines.append(stripped)
            elif current_section == 'keypoints' and stripped.startswith('- '):
                key_points.append(stripped[2:])
            elif current_section == 'actions' and stripped.startswith('- '):
                action_items.append(stripped[2:].replace('[ ] ', '').replace('[x] ', ''))

        if current_topic_title:
            discussion_areas.append({"title": current_topic_title, "analysis": '\n'.join(current_topic_lines).strip()})

        return {
            "summary": ' '.join(summary_parts),
            "participants": participants,
            "discussion_areas": discussion_areas,
            "key_points": key_points,
            "action_items": action_items,
        }

    async def transcribe_audio(self, audio_file: str, session_name: str = "Recording") -> dict:
        """Transcribe audio file."""
        audio_path = Path(audio_file)

        if not audio_path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_file}")

        print(f"📝 Transcribing: {audio_path.name}")

        from src.config import get_config
        config = get_config()

        # Initialize transcriber only when needed
        if self.transcriber is None:
            self.transcriber = WhisperTranscriber(model_size=config.get_whisper_model())

        # Get configured language
        configured_language = config.get_language()
        # ASR only knows "zh" for Chinese; the Simplified/Traditional choice is
        # applied as a post-transcription conversion, not an ASR mode.
        asr_language = config.get_whisper_language()

        # Transcribe with diarisation support (stereo → [You]/[Others])
        transcript_result = self.transcriber.transcribe_diarised(audio_path, language=asr_language)

        # A transcription crash (e.g. an OOM on a long file) is not silence:
        # propagate the flag and skip writing a normal transcript file so the
        # caller preserves the audio and saves a marked, reprocessable meeting
        # instead of a fake-empty one.
        if isinstance(transcript_result, dict) and transcript_result.get("transcription_failed"):
            return {
                "audio_file": str(audio_path),
                "session_name": session_name,
                "duration_seconds": transcript_result.get("duration_seconds"),
                "configured_language": configured_language,
                "transcription_failed": True,
                "error": transcript_result.get("error") or "transcription failed",
            }

        # Handle different return types
        duration_seconds = None
        detected_language = None
        if isinstance(transcript_result, dict):
            transcript_text = transcript_result.get("text") or ""
            duration_seconds = transcript_result.get("duration_seconds")
            detected_language = transcript_result.get("detected_language")
        elif hasattr(transcript_result, 'text'):
            transcript_text = transcript_result.text
        elif isinstance(transcript_result, str):
            transcript_text = transcript_result
        else:
            transcript_text = str(transcript_result)

        # Extract diarisation fields
        is_diarised = False
        diarised_text = None
        speaker_clusters: dict = {}
        turn_manifest: list = []
        if isinstance(transcript_result, dict):
            is_diarised = transcript_result.get("is_diarised", False)
            diarised_text = transcript_result.get("diarised_text")
            speaker_clusters = transcript_result.get("speaker_clusters") or {}
            turn_manifest = transcript_result.get("turn_manifest") or []

        # Convert the transcript to the selected Chinese script (no-op otherwise).
        transcript_text = _apply_chinese_variant(transcript_text)
        diarised_text = _apply_chinese_variant(diarised_text)

        output_language = self._resolve_output_language(
            configured_language, detected_language, transcript_text=diarised_text or transcript_text
        )

        # Save transcript (use diarised text if available for the saved file)
        saved_transcript = diarised_text if diarised_text else transcript_text
        transcript_path = self._write_transcript_file(
            audio_path,
            saved_transcript,
            session_name,
            configured_language,
            detected_language=detected_language,
            output_language=output_language,
        )

        print(f"📄 Transcript saved: {transcript_path}")

        return {
            "audio_file": str(audio_path),
            "transcript_file": str(transcript_path),
            "transcript_text": transcript_text,
            "session_name": session_name,
            "duration_seconds": duration_seconds,
            "configured_language": configured_language,
            "detected_language": detected_language,
            "is_diarised": is_diarised,
            "diarised_text": diarised_text,
            "output_language": output_language,
            "speaker_clusters": speaker_clusters,
            "turn_manifest": turn_manifest,
            # Fraction of transcription windows that came back usable, worst
            # channel, or None where the backend does no windowing of its own.
            # None means "unknown", not "complete" -- see the live-transcript
            # fallback in process_streaming.
            "window_coverage": (
                transcript_result.get("window_coverage")
                if isinstance(transcript_result, dict) else None
            ),
        }

    def _handle_transcription_failure(
        self,
        audio_path: Path,
        session_name: str,
        transcript_data: dict,
        notes_text: Optional[str] = None,
    ) -> dict:
        """Save a marked, reprocessable meeting when transcription crashed.

        A crash (e.g. an MLX OOM on a long file) is not silence. Rather than
        summarise a fake-empty transcript and delete the recording, we:

        * **preserve** the source audio regardless of ``keep_recordings`` —
          it's the only copy and the retry material;
        * **skip** Ollama summarisation entirely;
        * write a clearly-marked ``<stem>_summary.md`` with
          ``transcription_failed`` / ``reprocessable`` / ``audio_file`` so the
          meeting surfaces honestly and can be retried later;
        * emit ``TRANSCRIPTION_FAILED:`` (for an honest error toast) alongside
          ``SAVED:`` (so the renderer still navigates to the marked meeting).
        """
        error = str(transcript_data.get("error") or "transcription failed")
        # Collapse whitespace/newlines: the error becomes a single-line YAML
        # frontmatter scalar, and a literal newline would break the round-trip
        # through _parse_meeting_markdown.
        short_error = " ".join(error.split())[:200]
        summary_path = self.output_dir / f"{audio_path.stem}_summary.md"
        processed_at = datetime.now().isoformat()
        duration_seconds = transcript_data.get("duration_seconds")
        md_meta = {
            'title': session_name,
            'date': processed_at,
            'duration_seconds': int(duration_seconds) if duration_seconds else None,
            'language': transcript_data.get("configured_language"),
            'configured_language': transcript_data.get("configured_language"),
            'detected_language': transcript_data.get("detected_language"),
            'is_diarised': False,
            'transcription_failed': True,
            'reprocessable': True,
            'audio_file': str(audio_path),
            'error': short_error,
        }
        md_lines = _render_frontmatter(md_meta)
        md_lines.append('')
        # Write the message under a `## Summary` heading so it survives
        # _parse_meeting_markdown (which only captures text under `## `
        # sections) and renders as the meeting's summary instead of a blank
        # note. Copy is honest about current capability: the audio is
        # preserved, but there is no in-app retry yet (tracked follow-up).
        md_lines.append('## Summary')
        md_lines.append('')
        md_lines.append(
            'Transcription failed, so no notes were generated for this recording. '
            'Your audio was preserved (not deleted), so nothing was lost.'
        )
        if notes_text:
            md_lines.append('')
            md_lines.append('## User Notes')
            md_lines.append('')
            md_lines.append(notes_text)
        _atomic_write_text(summary_path, '\n'.join(md_lines))

        print(f"⚠️ Transcription failed; preserved audio: {audio_path}")
        print(f"TRANSCRIPTION_FAILED:{short_error}", flush=True)
        print(f"SAVED:{summary_path}", flush=True)

        # Clear recording state (the recording itself is done; only its
        # transcription failed) so a stale state file doesn't linger.
        state_file = Path("recorder_state.json")
        if state_file.exists():
            try:
                state_file.unlink()
            except OSError:
                pass

        return {
            "session_info": {
                "name": session_name,
                "audio_file": str(audio_path),
                # No transcript was produced, but the process CLI handlers read
                # this key unconditionally — keep it present
                # and empty so a failure doesn't KeyError and turn a graceful
                # exit into a non-zero crash.
                "transcript_file": "",
                "summary_file": str(summary_path),
                "transcription_failed": True,
                "error": short_error,
            }
        }

    async def process_recording_streaming(self, audio_file: str, session_name: str = "Recording", notes_text: Optional[str] = None) -> dict:
        """Process recording with streaming summary output via CHUNK: protocol."""
        import base64
        print(f"🔄 Processing recording: {audio_file}")

        if not audio_file:
            raise Exception("No audio file specified")

        audio_path = Path(audio_file)
        if not audio_path.exists():
            raise Exception(f"Audio file not found: {audio_file}")

        # Step 1: Transcribe
        transcript_data = await self.transcribe_audio(audio_file, session_name)

        # A transcription crash is not silence — preserve the audio and save a
        # marked, reprocessable meeting instead of summarising a fake-empty one.
        if transcript_data.get("transcription_failed"):
            return self._handle_transcription_failure(audio_path, session_name, transcript_data, notes_text)

        transcript_text = transcript_data.get("transcript_text", "")
        diarised_text = transcript_data.get("diarised_text")
        text_for_summary = diarised_text or transcript_text

        duration_seconds = transcript_data.get("duration_seconds")
        duration_minutes = int(duration_seconds / 60) if duration_seconds else 0

        if duration_seconds:
            print(f"📏 Audio duration: {duration_seconds} seconds ({int(duration_seconds)}s)")

        print(f"TRANSCRIPTION_COMPLETE:{len(transcript_text)}", flush=True)

        # Auto-summarize gate (#258): mirror process_streaming's transcript-only
        # path so this method stays consistent even though it has no live caller.
        from src.config import get_config
        gate_config = get_config()
        if not gate_config.get_auto_summarize_enabled():
            output_language = self._resolve_output_language(
                gate_config.get_language(),
                transcript_data.get("detected_language"),
                transcript_text=text_for_summary,
            )
            summary_path = self.output_dir / f"{audio_path.stem}_summary.md"
            processed_at = datetime.now().isoformat()
            md_meta = {
                'title': session_name,
                'date': processed_at,
                'duration_seconds': int(duration_seconds) if duration_seconds else None,
                'language': output_language,
                'configured_language': gate_config.get_language(),
                'detected_language': transcript_data.get('detected_language'),
                'is_diarised': transcript_data.get('is_diarised', False),
                'notes_generated': False,
            }
            md_lines = _render_frontmatter(md_meta)
            md_lines.append('')
            md_lines.append('## Transcript')
            md_lines.append('')
            md_lines.append(diarised_text or transcript_text)
            if notes_text:
                md_lines.append('')
                md_lines.append('## User Notes')
                md_lines.append('')
                md_lines.append(notes_text)
            _atomic_write_text(summary_path, '\n'.join(md_lines))
            # Before the audio is deleted below: the sidecar is the only
            # place these embeddings survive, and this gate is about
            # skipping the SUMMARY, not about discarding diarization that
            # already ran.
            _persist_speaker_sidecar(self.output_dir, audio_path.stem, transcript_data)
            if not gate_config.get_keep_recordings():
                try:
                    audio_path.unlink()
                except OSError:
                    pass
            print("SUMMARY_SKIPPED", flush=True)
            print(f"SAVED:{summary_path}", flush=True)
            return {
                "session_info": {
                    "name": session_name,
                    "transcript_file": str(transcript_data.get("transcript_file", "")),
                    "summary_file": str(summary_path),
                }
            }

        # Step 2: Streaming summary
        if self.summarizer is None:
            self.summarizer = OllamaSummarizer()

        from src.config import get_config
        config = get_config()
        configured_language = config.get_language()
        output_language = self._resolve_output_language(
            configured_language,
            transcript_data.get("detected_language"),
            transcript_text=text_for_summary,
        )

        print("🧠 Generating summary...", flush=True)
        streamed_chunks = []
        try:
            for chunk in self.summarizer.summarize_transcript_streaming(
                text_for_summary, duration_minutes, output_language, notes_text,
                progress_callback=_emit_progress,
            ):
                encoded = base64.b64encode(chunk.encode('utf-8')).decode('ascii')
                sys.stdout.write(f"CHUNK:{encoded}\n")
                sys.stdout.flush()
                streamed_chunks.append(chunk)
        except Exception as e:
            # Surface as STREAM_ERROR so the renderer shows the "try a smaller
            # model" recommendation (same as reprocess) rather than a generic
            # failure, then re-raise to preserve this method's existing error
            # contract for its caller.
            logger.error(f"Summarization failed: {e}")
            err_msg = str(e).replace('\n', ' ').replace('\r', ' ')
            print(f"STREAM_ERROR:{err_msg}", flush=True)
            raise
        streamed_md = _apply_chinese_variant(''.join(streamed_chunks)) or ''

        print("STREAM_COMPLETE", flush=True)

        # Step 3: Generate title. generate_title logs its own failure detail
        # (provider/model/response length on an empty result, or a traceback)
        # and returns None rather than raising, so a failure simply leaves the
        # placeholder name standing — no extra logging needed here.
        if _AUTO_NAMED_PATTERN.match(session_name):
            generated_title = self.summarizer.generate_title(
                streamed_md, transcript_text, language=output_language
            )
            generated_title = _apply_chinese_variant(generated_title)
            if generated_title:
                session_name = generated_title
                print(f"TITLE:{session_name}", flush=True)
                print(f"Auto-generated title: {session_name}")

        # Step 4: Parse streamed markdown into structured JSON
        parsed = self._parse_streamed_markdown(streamed_md)

        # Step 5: Save as .md (primary format for new meetings)
        summary_path = self.output_dir / f"{audio_path.stem}_summary.md"
        processed_at = datetime.now().isoformat()
        md_meta = {
            'title': session_name,
            'date': processed_at,
            'duration_seconds': int(duration_seconds) if duration_seconds else None,
            'language': output_language,
            'configured_language': configured_language,
            'detected_language': transcript_data.get('detected_language'),
            'is_diarised': transcript_data.get('is_diarised', False),
        }
        md_lines = _render_frontmatter(md_meta)
        md_lines.append('')
        md_lines.append(streamed_md)
        md_lines.append('')
        md_lines.append('## Transcript')
        md_lines.append('')
        md_lines.append(diarised_text or transcript_text)
        if notes_text:
            md_lines.append('')
            md_lines.append('## User Notes')
            md_lines.append('')
            md_lines.append(notes_text)
        _atomic_write_text(summary_path, '\n'.join(md_lines))

        # Persist the raw diarization clusters/embeddings this run already
        # computed (zero extra diarization cost -- see
        # src.transcriber._tag_channel_segments' clusters_out param) so
        # src.speaker_suggestions has something to read for this meeting.
        # Previously only the separate, manual backfill-speaker-embeddings
        # CLI command ever wrote this sidecar, so a normally-recorded
        # meeting never got a Speakers review panel at all, even when
        # diarization succeeded (is_diarised: true).
        _persist_speaker_sidecar(self.output_dir, audio_path.stem, transcript_data)

        # Clean up
        from src.config import get_config
        if not get_config().get_keep_recordings():
            try:
                audio_path.unlink()
                print(f"🗑️ Cleaned up audio file: {audio_path}")
            except OSError:
                pass

        state_file = Path("recorder_state.json")
        if state_file.exists():
            try:
                state_file.unlink()
            except OSError:
                pass

        print(f"✅ Complete processing saved: {summary_path}")
        print(f"SAVED:{summary_path}", flush=True)
        return {
            "session_info": {
                "name": session_name,
                "transcript_file": str(transcript_data.get("transcript_file", "")),
                "summary_file": str(summary_path),
            }
        }


def generate_default_template_report(summary_path, transcript, notes, language,
                                     duration_minutes, config, summarizer):
    """Best-effort: if the configured default template is not 'standard', generate
    its report into the meeting's sidecar and make it active. Additive — the
    Standard note is untouched. Never raises (a new recording must not fail because
    of the extra report)."""
    try:
        from src import reports as _reports
        from src import report_store as _store
        tid = config.get_default_template_id()
        if not tid or tid == "standard":
            return None
        tmpl = config.get_template(tid)
        if not tmpl or not (tmpl.get("prompt") or "").strip():
            return None
        report_language = tmpl["language"] if tmpl.get("language") and tmpl["language"] != "auto" else language
        # This generation produces NO CHUNK:/PROGRESS: output, so the main-process
        # inactivity watchdog would otherwise fire on a slow model and FAIL the
        # recording AFTER the Standard note was already saved. Heartbeat keeps it
        # alive; a distinct label avoids polluting the parsed summary stream.
        heartbeat = _start_summary_heartbeat(label="default-report")
        try:
            chunks = []
            for chunk in summarizer.summarize_transcript_streaming(
                transcript, duration_minutes, report_language, notes,
                template_prompt=tmpl["prompt"],
            ):
                chunks.append(chunk)
        finally:
            heartbeat.set()
        content = "".join(chunks).strip()
        if not content:
            return None
        sidecar = _store.load_sidecar(summary_path)
        report = _reports.make_report(tid, tmpl["name"], summarizer.model_name, content)
        _reports.append_report(sidecar, report)
        _store.save_sidecar(summary_path, sidecar)
        return report
    except Exception as e:
        logger.warning(f"Default-template report generation skipped: {e}")
        return None


# CLI Commands for Electron
@click.group()
def cli():
    """Simple Audio Recorder & Transcriber Backend"""
    pass


# Detect a silence-only batch result exactly, kept in sync with the
# transcriber that produces the sentinel. Mirrors the graceful-import pattern
# above so a missing transcriber dependency doesn't break the CLI.
try:
    from src.transcriber import SILENCE_SENTINEL as _SILENCE_SENTINEL
except ImportError:
    _SILENCE_SENTINEL = "No speech detected in audio"

# Below this share of usable transcription windows a batch transcript stops
# being "the transcript" and the complete live transcript is the better
# rescue. Deliberately low: a meeting that lost a window or two is still far
# better than the streaming text, and swapping too eagerly is how the old
# length threshold made things worse (see the fallback in process_streaming).
# Half the file missing is not a gap, it is a different recording.
_MIN_BATCH_WINDOW_COVERAGE = 0.5


def _unusable_batch_reason(
    batch_text: str,
    batch_failed: bool,
    window_coverage: Optional[float],
) -> Optional[str]:
    """Why the batch transcript can't stand as the meeting's transcript, or
    None when it can.

    Three ways it can't: the transcription crashed, it came back as exactly
    the silence sentinel, or it lost more than half its transcription windows
    (see _MIN_BATCH_WINDOW_COVERAGE). Deliberately NOT length -- a five-minute
    stand-up is allowed to be short, and an earlier length threshold here
    replaced correct transcripts because of it.

    ``window_coverage`` is None for a backend that does no windowing of its
    own; unknown is not a reason to throw a result away.

    Lives outside process_streaming so the decision can be tested as itself
    rather than restated in a test that could drift away from it.
    """
    if batch_failed:
        return "failed"
    if batch_text.strip() == _SILENCE_SENTINEL:
        return "returned only silence"
    if window_coverage is not None and window_coverage < _MIN_BATCH_WINDOW_COVERAGE:
        return f"covered only {window_coverage:.0%} of its transcription windows"
    return None


def _append_segment_to_note(target: Path, new_text: str, duration_seconds):
    """Fold a continue-recording segment into an existing note.

    Appends `new_text` (with a resumed-at separator) to the note's Transcript
    section, marks the note `notes_stale: true` (the UI's cue to offer
    "Regenerate notes"), and extends duration_seconds. Supports both note
    formats: .md (frontmatter surgery, summary body untouched) and legacy
    .json. `reprocess` clears the stale flag when it rewrites the note.
    """
    if not target.exists():
        raise FileNotFoundError(f"append target not found: {target}")
    if not new_text or not new_text.strip():
        raise ValueError("continuation produced no transcript text")

    separator = f"--- Resumed {datetime.now().strftime('%H:%M')} ---"
    segment = f"\n\n{separator}\n\n{new_text.strip()}"
    added_seconds = int(duration_seconds) if duration_seconds else 0

    if target.suffix == '.md':
        content = target.read_text(encoding='utf-8')

        # 1. Frontmatter surgery: upsert notes_stale + extend duration.
        #    String-level on purpose — a parse→rebuild would lose the summary
        #    body's original LLM formatting.
        if content.startswith('---'):
            head, mid, rest = content.split('---', 2)
            fm_lines = [
                ln for ln in mid.strip().split('\n')
                if not ln.startswith('notes_stale:')
            ]
            for i, ln in enumerate(fm_lines):
                if ln.startswith('duration_seconds:'):
                    try:
                        prev = int(ln.partition(':')[2].strip())
                        fm_lines[i] = f'duration_seconds: {prev + added_seconds}'
                    except ValueError:
                        pass
                    break
            fm_lines.append('notes_stale: true')
            content = f"---\n{chr(10).join(fm_lines)}\n---{rest}"
        # (A .md note without frontmatter shouldn't exist; append-only below.)

        # 2. Append to the Transcript section: insert before a trailing
        #    "## User Notes" section if one follows the transcript, else at
        #    the end of the file.
        t_idx = content.find('\n## Transcript')
        notes_idx = content.find('\n## User Notes')
        if t_idx != -1 and notes_idx > t_idx:
            content = content[:notes_idx] + segment + '\n' + content[notes_idx:]
        else:
            content = content.rstrip('\n') + segment + '\n'
        _atomic_write_text(target, content)
    else:
        with open(target, 'r', encoding='utf-8') as f:
            data = json.load(f)
        data['transcript'] = (data.get('transcript') or '').rstrip('\n') + segment
        si = data.setdefault('session_info', {})
        si['notes_stale'] = True
        if added_seconds and isinstance(si.get('duration_seconds'), int):
            si['duration_seconds'] += added_seconds
        _atomic_write_json(target, data)

    logger.info(
        "Appended %d chars (+%ds) to %s and marked notes_stale",
        len(new_text), added_seconds, target,
    )


def _read_existing_user_notes(summary_path: Path):
    """Return the text of a note's '## User Notes' section, or None if the file
    or section is absent.

    Instant-stop writes a placeholder note (from the live transcript) at stop;
    the user may edit My notes on it while the batch pass runs. When
    process-streaming rewrites the note it must prefer that on-disk edit over
    the (older) --notes draft — this reads it back so the rewrite can preserve
    it. '## User Notes' is the LAST section written by every writer (main's
    placeholder and process-streaming alike), so it runs to end-of-file — do
    NOT stop at the next heading, or a user who types a '## ' line inside their
    own notes would lose everything after it.
    """
    try:
        if not summary_path.exists():
            return None
        content = summary_path.read_text(encoding='utf-8')
    except (OSError, UnicodeDecodeError):
        return None
    idx = content.find('\n## User Notes')
    if idx == -1:
        return None
    section = content[idx + len('\n## User Notes'):].lstrip('\n')
    text = section.strip()
    return text or None


@cli.command(name='process-streaming')
@click.argument('audio_file', default='')
@click.option('--name', '-n', default='Recording', help='Session name')
@click.option('--notes', default=None, help='Path to user notes file')
@click.option('--live-transcript', 'live_transcript', default=None,
              help='Path to the live transcript captured during recording, '
                   'used as a fallback if batch transcription returns empty (#207)')
@click.option('--append-to', 'append_to', default=None,
              help='Path to an existing note to append this transcription to '
                   '(continue-recording): the new transcript is appended to the '
                   "note's Transcript section, the note is marked notes_stale, "
                   'and no summary/title generation runs.')
def process_streaming(audio_file, name, notes, live_transcript, append_to):
    """Process audio with streaming summary output.

    Transcribes audio, then streams the summary as CHUNK: prefixed lines
    to stdout for Electron to relay to the renderer in real time.
    """
    import sys

    async def run():
        recorder = MeetingPipeline()

        # Read user notes
        notes_text = None
        if notes:
            try:
                notes_text = Path(notes).read_text(encoding='utf-8').strip()
                if notes_text:
                    logger.info(f"Loaded user notes ({len(notes_text)} chars)")
            except Exception as e:
                logger.warning(f"Failed to read notes file: {e}")

        # Instant-stop: if a placeholder note already exists at the target path
        # (main wrote it from the live transcript at stop), prefer ITS
        # '## User Notes' over the --notes draft — the user may edit My notes on
        # the placeholder WHILE this (minutes-long) batch pass runs. Reading only
        # here at command start would clobber any edit made during the window:
        # the final rewrite would restore this stale snapshot. So re-read right
        # before EACH write below via this helper, shrinking the race to ms.
        # Append runs a different path (never rewrites the note wholesale), so
        # this only affects the new-recording writes.
        placeholder_note = None if append_to else (
            recorder.output_dir / f"{Path(audio_file).stem}_summary.md"
        )

        def _refresh_edited_notes(current):
            if placeholder_note is None:
                return current
            try:
                edited = _read_existing_user_notes(placeholder_note)
                if edited is not None:
                    logger.info(f"Preserved edited My notes from placeholder ({len(edited)} chars)")
                    return edited
            except Exception as e:
                logger.debug(f"No placeholder notes to preserve: {e}")
            return current

        notes_text = _refresh_edited_notes(notes_text)

        # Read the live transcript fallback (#207). The renderer accumulates
        # live segments during recording; Electron writes them to this file so
        # we can rescue a meeting whose batch transcription came back empty.
        live_transcript_text = None
        if live_transcript:
            try:
                live_transcript_text = Path(live_transcript).read_text(encoding='utf-8').strip()
                if live_transcript_text:
                    logger.info(f"Loaded live transcript fallback ({len(live_transcript_text)} chars)")
            except Exception as e:
                logger.warning(f"Failed to read live transcript file: {e}")

        # Step 1: Transcribe. HEARTBEAT: lines are a liveness signal for the
        # Electron inactivity watchdog — without them a long transcription is
        # silent on stdout until TRANSCRIPTION_COMPLETE and indistinguishable
        # from a hung process. Electron routes them to the debug log.
        # A heartbeat must never break transcription — if the registry can't
        # even import, transcribe without one.
        try:
            from src.parakeet import set_chunk_heartbeat
        except Exception:
            def set_chunk_heartbeat(_cb):
                pass

        def _heartbeat_sink(done, total):
            sys.stdout.write(f"HEARTBEAT:transcribe:{done}/{total}\n")
            sys.stdout.write(f"PROGRESS:transcribe:{done}/{total}\n")
            sys.stdout.flush()

        print("HEARTBEAT:transcribe:start", flush=True)
        set_chunk_heartbeat(_heartbeat_sink)
        try:
            transcript_data = await recorder.transcribe_audio(audio_file, name)
        finally:
            set_chunk_heartbeat(None)

        # Live-transcript fallback (#207): rescue the meeting with the live
        # transcript the user watched stream in, instead of discarding it as
        # "No speech detected", but ONLY when the batch result is genuinely
        # unusable:
        #   - the batch transcription crashed (transcription_failed), or
        #   - it came back as exactly the silence sentinel.
        # A correct-but-short batch transcript (e.g. a 5-minute stand-up) must
        # NOT be replaced — the old length threshold did exactly that (Fix 4).
        # We only swap in the live text when the batch result is genuinely
        # unusable (failed or silence sentinel). Any non-whitespace live content
        # is better than a silent failure — even a brief session deserves rescue.
        # Third case, added later: a batch that neither crashed nor returned
        # silence, but lost most of its transcription windows. The onnx
        # backend skips a window whose recognize() raises on purpose, so one
        # bad window doesn't fail a meeting -- but the transcript then covers
        # less audio than the recording holds, and nothing said so. Such a
        # result is not empty, so it used to pass this gate and silently
        # replace a complete live transcript with a full-of-holes one.
        #
        # Keyed on COVERAGE, not on length: the length threshold this gate
        # used to have was removed for good reason (Fix 4) because it
        # replaced correct-but-short transcripts. Coverage says how much of
        # the audio was actually read, independent of how much was said in
        # it. None means the backend does no windowing of its own and cannot
        # report -- unknown is never treated as bad.
        batch_text = transcript_data.get("transcript_text", "") or ""
        batch_failed = bool(transcript_data.get("transcription_failed"))
        reason = _unusable_batch_reason(
            batch_text, batch_failed, transcript_data.get("window_coverage")
        )
        is_live_transcript = False
        if reason and live_transcript_text and live_transcript_text.strip():
            logger.warning(
                "Batch transcription %s; falling back to the live transcript "
                "captured during recording (%d chars)",
                reason,
                len(live_transcript_text),
            )
            is_live_transcript = True
            # Always (re)write _transcript.txt with the live text via the shared
            # formatter so the on-disk file matches the markdown/summary the user
            # sees and uses the canonical filename/header (#207, review-2
            # Finding 3). The silence path may already have written the sentinel
            # (Fix 6); the crash path (transcription_failed) wrote NO transcript
            # file at all and exposes no "transcript_file" key — the old code
            # only overwrote a pre-existing file, so the crash fallback left the
            # .txt missing entirely. Writing unconditionally fixes both.
            fallback_audio_path = Path(audio_file)
            existing_transcript_file = None
            try:
                written_path = recorder._write_transcript_file(
                    fallback_audio_path,
                    live_transcript_text,
                    name,
                    transcript_data.get("configured_language") or "auto",
                    detected_language=transcript_data.get("detected_language"),
                )
                existing_transcript_file = str(written_path)
                logger.info(
                    "Wrote transcript file with live transcript: %s",
                    existing_transcript_file,
                )
            except Exception as e:
                logger.warning(
                    "Failed to write transcript file with live text: %s", e
                )
            # Rebuild transcript_data so the rest of the pipeline (summary, save)
            # uses the live transcript. Live transcripts are not channel-diarised.
            transcript_data = {
                "transcript_text": live_transcript_text,
                "diarised_text": None,
                "is_diarised": False,
                "duration_seconds": transcript_data.get("duration_seconds"),
                "detected_language": transcript_data.get("detected_language"),
                "transcript_file": existing_transcript_file,
            }

        # A transcription crash (e.g. an MLX OOM on a long system-audio
        # recording) is not silence — preserve the audio and save a marked,
        # reprocessable meeting instead of summarising a fake-empty one.
        # (Only when there's no live transcript to fall back on.)
        if transcript_data.get("transcription_failed"):
            if append_to:
                # A failed CONTINUATION must never touch the existing note —
                # no failed-note write (that would clobber the target), no
                # stale flag. Exit non-zero so the renderer surfaces the
                # hard-failure notification; the audio is preserved on disk.
                print(
                    "Transcription failed (audio preserved): continuation "
                    f"not appended to {append_to}",
                    flush=True,
                )
                sys.exit(1)
            recorder._handle_transcription_failure(Path(audio_file), name, transcript_data, notes_text)
            return

        transcript_text = transcript_data.get("transcript_text", "")
        diarised_text = transcript_data.get("diarised_text")
        text_for_summary = diarised_text or transcript_text

        duration_seconds = transcript_data.get("duration_seconds")
        duration_minutes = int(duration_seconds / 60) if duration_seconds else 0

        print(f"TRANSCRIPTION_COMPLETE:{len(transcript_text)}", flush=True)

        # Continue-recording (append) path: fold this segment's transcript
        # into the target note, mark it stale, and stop — no summary, no
        # title, no new note. The user regenerates notes on demand (the
        # floating "Regenerate notes" CTA drives `reprocess`, which reads the
        # combined Transcript section and clears the stale flag on rewrite).
        if append_to:
            from src.config import get_config as _get_config
            segment_text = diarised_text or transcript_text
            # A silent continuation is not a crash (transcription_failed is
            # handled above) but it must not pollute the note with the
            # silence sentinel or mark it stale for nothing. Exit non-zero so
            # the renderer surfaces the failure notification; the target note
            # is untouched.
            if not segment_text.strip() or segment_text.strip() == _SILENCE_SENTINEL:
                print(
                    "No speech detected in continuation; nothing appended "
                    f"to {append_to}",
                    flush=True,
                )
                sys.exit(1)
            _append_segment_to_note(
                Path(append_to),
                segment_text,
                duration_seconds,
            )
            audio_path = Path(audio_file)
            if not is_live_transcript and not _get_config().get_keep_recordings():
                try:
                    audio_path.unlink()
                except OSError:
                    pass
            print("SUMMARY_SKIPPED", flush=True)
            print(f"SAVED:{append_to}", flush=True)
            return

        # Auto-summarize gate (#258): when the user has turned off automatic
        # note generation, stop at a transcript-only note. This runs BEFORE the
        # summarizer is constructed and before any title / template-report LLM
        # call — with the toggle off there are zero Ollama calls and Ollama need
        # not be running at all. The user generates notes on demand later
        # (reprocess), which regenerates the summary and drops notes_generated.
        from src.config import get_config
        gate_config = get_config()
        if not gate_config.get_auto_summarize_enabled():
            output_language = recorder._resolve_output_language(
                gate_config.get_language(),
                transcript_data.get("detected_language"),
                transcript_text=text_for_summary,
            )
            audio_path = Path(audio_file)
            summary_path = recorder.output_dir / f"{audio_path.stem}_summary.md"
            processed_at = datetime.now().isoformat()
            md_meta = {
                'title': name,
                'date': processed_at,
                'duration_seconds': int(duration_seconds) if duration_seconds else None,
                'language': output_language,
                'configured_language': gate_config.get_language(),
                'detected_language': transcript_data.get('detected_language'),
                'is_diarised': transcript_data.get('is_diarised', False),
                'notes_generated': False,
            }
            if is_live_transcript:
                md_meta['is_live_transcript'] = True
            md_lines = _render_frontmatter(md_meta)
            md_lines.append('')
            md_lines.append('## Transcript')
            md_lines.append('')
            md_lines.append(diarised_text or transcript_text)
            # Re-read My notes right before writing (see _refresh_edited_notes):
            # catches an edit made during this pass so the write doesn't clobber it.
            notes_text = _refresh_edited_notes(notes_text)
            if notes_text:
                md_lines.append('')
                md_lines.append('## User Notes')
                md_lines.append('')
                md_lines.append(notes_text)
            _atomic_write_text(summary_path, '\n'.join(md_lines))

            # Before the audio is deleted below: the sidecar is the only
            # place these embeddings survive, and this gate is about
            # skipping the SUMMARY, not about discarding diarization that
            # already ran.
            _persist_speaker_sidecar(recorder.output_dir, audio_path.stem, transcript_data)

            if not is_live_transcript and not gate_config.get_keep_recordings():
                try:
                    audio_path.unlink()
                except OSError:
                    pass

            print("SUMMARY_SKIPPED", flush=True)
            print(f"SAVED:{summary_path}", flush=True)
            return

        # Step 2: Stream summary
        if recorder.summarizer is None:
            recorder.summarizer = OllamaSummarizer()

        from src.config import get_config
        config = get_config()
        configured_language = config.get_language()
        output_language = recorder._resolve_output_language(
            configured_language,
            transcript_data.get("detected_language"),
            transcript_text=text_for_summary,
        )

        import base64
        streamed_chunks = []
        # Keep the watchdog alive through model load + prompt eval — the
        # silent stretch before the first streamed token. Stopped on the
        # first chunk; from then on the chunks themselves are the signal.
        summary_heartbeat = _start_summary_heartbeat()
        _stream_error = None
        try:
            for chunk in recorder.summarizer.summarize_transcript_streaming(
                text_for_summary, duration_minutes, output_language, notes_text,
                progress_callback=_emit_progress,
            ):
                summary_heartbeat.set()
                encoded = base64.b64encode(chunk.encode('utf-8')).decode('ascii')
                sys.stdout.write(f"CHUNK:{encoded}\n")
                sys.stdout.flush()
                streamed_chunks.append(chunk)
        except Exception as e:
            _stream_error = e
        finally:
            summary_heartbeat.set()

        # Surface a summarization failure (e.g. a long-meeting map-reduce that
        # overflows context) as STREAM_ERROR so the renderer shows the same
        # "try a smaller model" recommendation it shows for reprocess — instead
        # of a generic processing failure with no guidance.
        if _stream_error is not None:
            logger.error(f"Summarization failed: {_stream_error}")
            err_msg = str(_stream_error).replace('\n', ' ').replace('\r', ' ')
            print(f"STREAM_ERROR:{err_msg}", flush=True)
            sys.exit(1)

        streamed_md = _apply_chinese_variant(''.join(streamed_chunks)) or ''

        print("STREAM_COMPLETE", flush=True)

        # Step 3: Generate title
        session_name = name
        if _AUTO_NAMED_PATTERN.match(name):
            try:
                generated_title = recorder.summarizer.generate_title(
                    streamed_md, transcript_text, language=output_language
                )
                generated_title = _apply_chinese_variant(generated_title)
                if generated_title:
                    session_name = generated_title
                    print(f"TITLE:{session_name}", flush=True)
            except Exception as e:
                logger.warning(f"Title generation failed: {e}")

        # Step 4: Save as .md
        audio_path = Path(audio_file)
        summary_path = recorder.output_dir / f"{audio_path.stem}_summary.md"

        # Parse the streamed markdown for title generation
        parsed = MeetingPipeline._parse_streamed_markdown(streamed_md)

        # Save as .md only (primary format for new meetings)
        summary_path = summary_path.with_suffix('.md')
        processed_at = datetime.now().isoformat()
        md_meta = {
            'title': session_name,
            'date': processed_at,
            'duration_seconds': int(duration_seconds) if duration_seconds else None,
            'language': output_language,
            'configured_language': configured_language,
            'detected_language': transcript_data.get('detected_language'),
            'is_diarised': transcript_data.get('is_diarised', False),
        }
        # Mark live-sourced meetings (#207) so the UI and future code know this
        # transcript came from the live capture, not a batch transcription.
        if is_live_transcript:
            md_meta['is_live_transcript'] = True
        md_lines = _render_frontmatter(md_meta)
        md_lines.append('')
        md_lines.append(streamed_md)
        md_lines.append('')
        md_lines.append('## Transcript')
        md_lines.append('')
        md_lines.append(diarised_text or transcript_text)
        # Re-read My notes right before writing (see _refresh_edited_notes): the
        # summary just streamed for seconds/minutes, during which the user may
        # have edited My notes on the note — don't clobber that with the snapshot.
        notes_text = _refresh_edited_notes(notes_text)
        if notes_text:
            md_lines.append('')
            md_lines.append('## User Notes')
            md_lines.append('')
            md_lines.append(notes_text)
        _atomic_write_text(summary_path, '\n'.join(md_lines))

        # Persist the raw diarization clusters/embeddings this run already
        # computed (zero extra diarization cost -- see
        # src.transcriber._tag_channel_segments' clusters_out param) so
        # src.speaker_suggestions has something to read for this meeting.
        # Previously only the separate, manual backfill-speaker-embeddings
        # CLI command ever wrote this sidecar, so a normally-recorded
        # meeting never got a Speakers review panel at all, even when
        # diarization succeeded (is_diarised: true).
        _persist_speaker_sidecar(recorder.output_dir, audio_path.stem, transcript_data)

        # Clean up audio. When we fell back to the live transcript the batch
        # transcription was empty/failed, so KEEP the audio regardless of the
        # keep_recordings setting — it's the user's only retry material if they
        # want a proper batch transcript later (mirrors the failure path).
        from src.config import get_config
        if not is_live_transcript and not get_config().get_keep_recordings():
            try:
                audio_path.unlink()
            except OSError:
                pass

        print(f"SAVED:{summary_path}", flush=True)

        # B3: if a non-Standard default template is configured, additionally
        # generate its report into the sidecar (best-effort; the Standard note
        # is already saved above).
        generate_default_template_report(
            summary_path, text_for_summary, notes_text, output_language,
            duration_minutes, config, recorder.summarizer,
        )

    asyncio.run(run())


@cli.command(name='get-whisper-model')
def get_whisper_model_cmd():
    """Get the configured Whisper model size."""
    from src.config import get_config
    config = get_config()
    print(json.dumps({
        "whisper_model": config.get_whisper_model(),
        "supported_models": list(config.SUPPORTED_WHISPER_MODELS),
    }))


@cli.command(name='list-whisper-models')
def list_whisper_models_cmd():
    """List supported Whisper models with metadata + installed status (UI)."""
    from src.config import get_config
    from src.whisper_models import SUPPORTED_WHISPER_MODELS, is_installed
    config = get_config()
    current = config.get_whisper_model()
    supported = {
        key: {**meta, "installed": is_installed(key)}
        for key, meta in SUPPORTED_WHISPER_MODELS.items()
    }
    print(json.dumps({
        "current_model": current,
        "supported_models": supported,
        "provider": "local",
    }))


@cli.command(name='pull-whisper-model')
@click.argument('model_name')
def pull_whisper_model_cmd(model_name):
    """Download a Whisper model from HuggingFace, streaming progress lines."""
    from src.whisper_models import (
        SUPPORTED_WHISPER_MODELS,
        download_with_progress,
        is_installed,
    )
    if model_name not in SUPPORTED_WHISPER_MODELS:
        print(json.dumps({"success": False, "error": f"Unknown model: {model_name}"}))
        return
    if is_installed(model_name):
        print(json.dumps({"success": True, "model": model_name, "already_installed": True}))
        return

    def emit(pct, done, total):
        # Match the Ollama pull format ("<status> <pct>%") so the Electron
        # progress parser can reuse the same regex.
        print(f"Downloading {pct}%", flush=True)

    ok = download_with_progress(model_name, emit)
    if ok:
        print(json.dumps({"success": True, "model": model_name}))
    else:
        print(json.dumps({"success": False, "error": "Download failed"}))


@cli.command(name='set-whisper-model')
@click.argument('model_size')
def set_whisper_model_cmd(model_size: str):
    """Set the Whisper model size."""
    from src.config import get_config
    config = get_config()
    if config.set_whisper_model(model_size):
        print(json.dumps({"success": True, "whisper_model": model_size}))
    else:
        print(json.dumps({
            "success": False,
            "error": f"Unsupported model: {model_size}",
            "supported_models": list(config.SUPPORTED_WHISPER_MODELS),
        }))


@cli.command(name='get-transcription-engine')
def get_transcription_engine_cmd():
    """Get the active ASR engine ('parakeet' or 'whisper')."""
    from src.config import get_config
    config = get_config()
    print(json.dumps({
        "engine": config.get_transcription_engine(),
        "valid_engines": list(config.VALID_TRANSCRIPTION_ENGINES),
    }))


@cli.command(name='set-transcription-engine')
@click.argument('engine')
def set_transcription_engine_cmd(engine: str):
    """Set the active ASR engine. Used by Settings → Transcribe."""
    from src.config import get_config
    config = get_config()
    if config.set_transcription_engine(engine):
        print(json.dumps({"success": True, "engine": engine}))
    else:
        print(json.dumps({
            "success": False,
            "error": f"Invalid engine: {engine}",
            "valid_engines": list(config.VALID_TRANSCRIPTION_ENGINES),
        }))


@cli.command(name='list-parakeet-models')
def list_parakeet_models_cmd():
    """List Parakeet models with metadata + installed status (UI)."""
    from src.parakeet_models import SUPPORTED_PARAKEET_MODELS, is_installed, DEFAULT_MODEL_ID
    supported = {
        key: {**meta, "installed": is_installed(key)}
        for key, meta in SUPPORTED_PARAKEET_MODELS.items()
    }
    print(json.dumps({
        "current_model": DEFAULT_MODEL_ID,
        "supported_models": supported,
        "provider": "local",
    }))


@cli.command(name='parakeet-status')
def parakeet_status_cmd():
    """Cheap check the Setup wizard polls to decide whether step 2 can be skipped."""
    from src.parakeet_models import is_installed, DEFAULT_MODEL_ID
    print(json.dumps({
        "model": DEFAULT_MODEL_ID,
        "installed": is_installed(DEFAULT_MODEL_ID),
    }))


@cli.command(name='onnx-selftest')
def onnx_selftest_cmd():
    """Prove ONNX Runtime's native libraries load + run inside the bundle.

    CI's other smoke tests (``parakeet-status``) only touch a Python id
    string and never construct an InferenceSession, so a missing or broken
    onnxruntime native DLL — the well-documented PyInstaller-on-Windows
    gotcha (microsoft/onnxruntime#25193) — would still build green and only
    fail at the user's first transcription. This loads the bundled Silero
    VAD model (a few hundred KB, no network) and runs one inference, which
    forces the native session libs to load and execute. The same DLLs back
    the onnx-asr Parakeet path on Windows/Linux, so a pass here means the
    ASR session libs are present too.

    Prints ``ONNX_SELFTEST_OK`` and exits 0 on success; prints the error and
    exits 1 on any failure so CI fails the build.
    """
    try:
        import numpy as np
        from src.silero_vad import SileroVAD, VAD_CHUNK_SAMPLES
        vad = SileroVAD()
        prob = vad.predict(np.zeros((VAD_CHUNK_SAMPLES,), dtype=np.float32))
        # On non-darwin the Parakeet backend is onnx-asr. Importing it here
        # catches bundling gaps the VAD check misses — notably onnx_asr's
        # `importlib.metadata.version("onnx-asr")` at import, which needs the
        # package metadata copied into the bundle (copy_metadata in the spec).
        if sys.platform != "darwin":
            import onnx_asr  # noqa: F401

        # Long-file windowing self-check. The actual ASR weights (670 MB)
        # aren't in CI, so we can't recognise real audio here — but we CAN
        # prove the manual windowing in _parakeet_onnx.transcribe_file slices
        # a >120 s array into multiple windows and merges them, end-to-end in
        # the frozen bundle, by driving it with a stub recogniser. This catches
        # a numpy/slicing bundling gap or a windowing regression offline.
        from src import _parakeet_onnx as _onnx
        long_samples = np.zeros(130 * _onnx._SAMPLE_RATE, dtype=np.float32)

        class _CountingModel:
            def __init__(self):
                self.calls = 0

            def recognize(self, window, sample_rate=None):
                self.calls += 1
                from types import SimpleNamespace
                return SimpleNamespace(text="", tokens=[], timestamps=[])

        counter = _CountingModel()
        merged = _onnx._transcribe_windows(counter, long_samples)
        if counter.calls < 2:
            raise RuntimeError(
                f"windowing produced {counter.calls} window(s) for a 130 s array; expected >= 2"
            )
        if not isinstance(merged, _onnx._SimpleResult):
            raise RuntimeError("windowing did not return a _SimpleResult")

        print(f"ONNX_SELFTEST_OK prob={float(prob):.4f} windows={counter.calls}")
    except Exception as e:
        print(f"ONNX_SELFTEST_FAIL: {e}", file=sys.stderr)
        sys.exit(1)


@cli.command(name='warmup-parakeet')
def warmup_parakeet_cmd():
    """Pre-load Parakeet weights to warm the OS page cache.

    Fired by Electron at app launch (best-effort, non-blocking). The
    subprocess loads the model end-to-end and exits — when the actual
    recording subprocess later spawns and calls ``ensure_loaded``, the
    model files are already in the OS page cache so disk I/O is
    near-instant. Does NOT eliminate the per-subprocess MLX parse cost
    (that requires a long-running daemon), but it shaves the visible
    portion of "first record after launch is slow" by ~1 s on modern
    SSDs and more on cold caches.

    Silent on success — Electron parses only the exit code. On
    'model not installed' (fresh user before Setup runs), exits 0
    without loading; the cost of trying to load a missing model is
    higher than just skipping.
    """
    from src.parakeet_models import is_installed, DEFAULT_MODEL_ID
    if not is_installed(DEFAULT_MODEL_ID):
        return
    try:
        from src.parakeet import ensure_loaded
        ensure_loaded()
    except Exception as e:
        # Best-effort: a warmup failure must never block app startup.
        # Log to stderr so the Electron debug log captures it, but
        # exit 0 so main.js doesn't surface it as an error to the user.
        print(f"warmup-parakeet failed: {e}", file=sys.stderr)


@cli.command(name='download-parakeet-model')
@click.argument('model_id', required=False)
def download_parakeet_model_cmd(model_id):
    """Download a Parakeet snapshot from HuggingFace.

    Emits ``PARAKEET_PULL_STAGE:<stage>`` lines (parsed by main.js into a
    parakeet-pull-progress IPC event) before the final JSON result. Stages
    are coarse (``downloading`` / ``loading``) because the snapshot is
    multiple files and threading byte-level progress through
    huggingface_hub's tqdm isn't worth the wire complexity for a one-time
    ~600 MB download.
    """
    from src.parakeet_models import (
        DEFAULT_MODEL_ID,
        SUPPORTED_PARAKEET_MODELS,
        download,
        is_installed,
    )
    target = model_id or DEFAULT_MODEL_ID
    if target not in SUPPORTED_PARAKEET_MODELS:
        print(json.dumps({"success": False, "error": f"Unknown model: {target}"}))
        return
    if is_installed(target):
        print(json.dumps({"success": True, "model": target, "already_installed": True}))
        return

    def emit(stage: str):
        print(f"PARAKEET_PULL_STAGE:{stage}", flush=True)

    ok = download(target, emit)
    if ok:
        print(json.dumps({"success": True, "model": target}))
    else:
        print(json.dumps({"success": False, "error": "Download failed"}))


@cli.command(name='get-keep-recordings')
def get_keep_recordings_cmd():
    """Get whether recordings are kept after processing."""
    from src.config import get_config
    config = get_config()
    print(json.dumps({"keep_recordings": config.get_keep_recordings()}))


@cli.command(name='set-keep-recordings')
@click.argument('enabled', type=bool)
def set_keep_recordings_cmd(enabled: bool):
    """Set whether recordings are kept after processing."""
    from src.config import get_config
    config = get_config()
    if config.set_keep_recordings(enabled):
        print(json.dumps({"success": True, "keep_recordings": enabled}))
    else:
        print(json.dumps({"success": False, "error": "Failed to persist setting"}))


@cli.command(name='get-auto-install-when-idle')
def get_auto_install_when_idle_cmd():
    """Get whether updates auto-install when the app is idle."""
    from src.config import get_config
    config = get_config()
    print(json.dumps({"auto_install_when_idle": config.get_auto_install_when_idle()}))


@cli.command(name='set-auto-install-when-idle')
@click.argument('enabled', type=bool)
def set_auto_install_when_idle_cmd(enabled: bool):
    """Set whether updates auto-install when the app is idle."""
    from src.config import get_config
    config = get_config()
    if config.set_auto_install_when_idle(enabled):
        print(json.dumps({"success": True, "auto_install_when_idle": enabled}))
    else:
        print(json.dumps({"success": False, "error": "Failed to persist setting"}))


@cli.command(name='get-identity-matching-enabled')
def get_identity_matching_enabled_cmd():
    """Get whether cross-recording speaker identification is enabled."""
    from src.config import get_config
    config = get_config()
    print(json.dumps({"identity_matching_enabled": config.get_identity_matching_enabled()}))


@cli.command(name='set-identity-matching-enabled')
@click.argument('enabled', type=bool)
def set_identity_matching_enabled_cmd(enabled: bool):
    """Set whether cross-recording speaker identification is enabled."""
    from src.config import get_config
    config = get_config()
    if config.set_identity_matching_enabled(enabled):
        print(json.dumps({"success": True, "identity_matching_enabled": enabled}))
    else:
        print(json.dumps({"success": False, "error": "Failed to persist setting"}))


@cli.command(name='get-auto-summarize')
def get_auto_summarize_cmd():
    """Get whether notes are generated automatically after transcription."""
    from src.config import get_config
    config = get_config()
    print(json.dumps({"auto_summarize_enabled": config.get_auto_summarize_enabled()}))


@cli.command(name='set-auto-summarize')
@click.argument('enabled', type=bool)
def set_auto_summarize_cmd(enabled: bool):
    """Set whether notes are generated automatically after transcription."""
    from src.config import get_config
    config = get_config()
    if config.set_auto_summarize_enabled(enabled):
        print(json.dumps({"success": True, "auto_summarize_enabled": enabled}))
    else:
        print(json.dumps({"success": False, "error": "Failed to persist setting"}))


@cli.command(name='get-obsidian-sync')
def get_obsidian_sync_cmd():
    """Get whether notes are mirrored to an Obsidian vault (#413)."""
    from src.config import get_config
    config = get_config()
    print(json.dumps({"obsidian_sync_enabled": config.get_obsidian_sync_enabled()}))


@cli.command(name='set-obsidian-sync')
@click.argument('enabled', type=bool)
def set_obsidian_sync_cmd(enabled: bool):
    """Enable/disable mirroring notes to an Obsidian vault."""
    from src.config import get_config
    config = get_config()
    if config.set_obsidian_sync_enabled(enabled):
        print(json.dumps({"success": True, "obsidian_sync_enabled": enabled}))
    else:
        print(json.dumps({"success": False, "error": "Failed to persist setting"}))


@cli.command(name='get-obsidian-vault-path')
def get_obsidian_vault_path_cmd():
    """Get the configured Obsidian vault folder (empty = not configured)."""
    from src.config import get_config
    config = get_config()
    print(json.dumps({"obsidian_vault_path": config.get_obsidian_vault_path()}))


@cli.command(name='set-obsidian-vault-path')
@click.argument('vault_path', default='')
def set_obsidian_vault_path_cmd(vault_path):
    """Set the Obsidian vault folder (empty to clear)."""
    from src.config import get_config
    config = get_config()
    if config.set_obsidian_vault_path(vault_path):
        print(json.dumps({"success": True, "obsidian_vault_path": vault_path}))
    else:
        print(json.dumps({"success": False, "error": "Failed to set vault path"}))


@cli.command(name='get-silence-auto-stop')
def get_silence_auto_stop_cmd():
    """Get whether recordings auto-stop on a stretch of silence + the duration."""
    from src.config import get_config
    config = get_config()
    print(json.dumps({
        "silence_auto_stop_enabled": config.get_silence_auto_stop_enabled(),
        "silence_auto_stop_minutes": config.get_silence_auto_stop_minutes(),
        "supported_minutes": list(config.SUPPORTED_SILENCE_AUTO_STOP_MINUTES),
    }))


@cli.command(name='set-silence-auto-stop-enabled')
@click.argument('enabled', type=bool)
def set_silence_auto_stop_enabled_cmd(enabled: bool):
    from src.config import get_config
    config = get_config()
    if config.set_silence_auto_stop_enabled(enabled):
        print(json.dumps({"success": True, "silence_auto_stop_enabled": enabled}))
    else:
        print(json.dumps({"success": False, "error": "Failed to persist setting"}))


@cli.command(name='set-silence-auto-stop-minutes')
@click.argument('minutes', type=int)
def set_silence_auto_stop_minutes_cmd(minutes: int):
    from src.config import get_config
    config = get_config()
    if config.set_silence_auto_stop_minutes(minutes):
        print(json.dumps({"success": True, "silence_auto_stop_minutes": minutes}))
    else:
        print(json.dumps({
            "success": False,
            "error": f"Unsupported minutes value; expected one of {list(config.SUPPORTED_SILENCE_AUTO_STOP_MINUTES)}",
        }))


@cli.command()
def status():
    """Show recorder status.

    Recording state is tracked in the Electron main process now (capture is
    renderer-driven), not in recorder_state.json — so this reports backend
    readiness ("READY") plus recent recordings. Used by main.js as a backend
    health check (get-status).
    """
    recorder = MeetingPipeline()

    print("🎙️ Steno Recorder Status")
    print("=" * 25)
    print("STATUS: READY")

    # Show recent recordings
    recordings = list(recorder.recordings_dir.glob("*.wav"))
    if recordings:
        recent = sorted(recordings, key=lambda x: x.stat().st_mtime, reverse=True)[:3]
        print(f"\nRecent recordings ({len(recordings)} total):")
        for recording in recent:
            size_mb = recording.stat().st_size / (1024 * 1024)
            print(f"  • {recording.name} ({size_mb:.1f}MB)")


class _PendingFinalsCoordinator:
    """Holds each channel's finalised-but-unshown utterance for up to
    ``PER_SEGMENT_BLEED_WINDOW_S`` so a same-instant utterance on the OTHER
    channel has a chance to arrive before either reaches the user — the
    live equivalent of the batch pipeline's ``_drop_per_segment_bleed``
    (``src/transcriber.py``), reusing its constants and Jaccard function
    directly instead of re-deriving them.

    An entry releases early, after ``MIN_HOLD_S``, once the other
    channel's VAD is confirmed idle — there's no plausible overlap
    incoming, so holding it out for the full window would just be added
    latency with no dedup benefit. This bounds mic-only recordings (system
    channel never active) and ordinary non-overlapping turn-taking to a
    fixed ``MIN_HOLD_S`` floor rather than the old single-channel path's
    true zero delay — a deliberate, small (500 ms) latency trade for the
    bleed-detection window; only genuine cross-channel overlap pays the
    full window.
    """

    # Grace period after the other channel goes idle before giving up on a
    # possible bleed match. Bridges the gap between a SpeechEnd event and
    # that channel's _finalise() actually landing an entry here (VAD flush
    # + Parakeet decode aren't instantaneous).
    MIN_HOLD_S = 0.5

    def __init__(self):
        self._pending = []
        # (entry, emitted_at) pairs already released to the user, kept for
        # PER_SEGMENT_BLEED_WINDOW_S so a late-arriving bleed partner whose
        # counterpart already left self._pending can still be caught — see
        # _resolve_against_recent.
        self._recent_emitted = []

    def add(self, channel, text, start, end, samples):
        if not text:
            return
        self._pending.append({
            "channel": channel,
            "text": text,
            "start": start,
            "end": end,
            "samples": samples,
            "added_at": time.monotonic(),
        })

    def _is_bleed_pair(self, e, other):
        """True if `e` and `other` (opposite channels) overlap in time and
        their text is similar enough to be the same underlying speech —
        the shared Jaccard/window/min-chars gate used by both
        _resolve_bleed and _resolve_against_recent."""
        from src.transcriber import (
            _token_jaccard, PER_SEGMENT_BLEED_JACCARD,
            PER_SEGMENT_BLEED_WINDOW_S, PER_SEGMENT_BLEED_MIN_CHARS,
        )
        if abs(other["start"] - e["start"]) > PER_SEGMENT_BLEED_WINDOW_S:
            return False
        if (len(e["text"]) < PER_SEGMENT_BLEED_MIN_CHARS
                or len(other["text"]) < PER_SEGMENT_BLEED_MIN_CHARS):
            return False
        return _token_jaccard(e["text"], other["text"]) >= PER_SEGMENT_BLEED_JACCARD

    def _resolve_bleed(self, entries):
        """Return the set of entry ids (all still in `entries`, i.e. not
        yet shown) to drop as bleed echoes. Compares every entry against
        every OTHER-channel entry in ``entries`` (ready or not — a
        not-yet-ready entry still carries real text and RMS, so there's
        no reason to wait on it before using it as a comparison point).
        Same rule as batch: Jaccard >= threshold on time-overlapping text
        means bleed; the lower-RMS side is the echo and gets dropped.
        Ties always favor mic ('You'), matching src/transcriber.py's
        _drop_per_segment_bleed default (`if mic_rms >= sys_rms:
        drop_sys`) — entries are compared from the mic side's
        perspective regardless of loop/insertion order, so a tie can't
        non-deterministically drop mic depending on which channel
        happened to finalise first."""
        drop_ids = set()
        for e in entries:
            for other in entries:
                if other is e or other["channel"] == e["channel"]:
                    continue
                if id(e) in drop_ids or id(other) in drop_ids:
                    continue
                if not self._is_bleed_pair(e, other):
                    continue
                mic_entry, sys_entry = (e, other) if e["channel"] == "You" else (other, e)
                mic_rms = _samples_rms(mic_entry["samples"])
                sys_rms = _samples_rms(sys_entry["samples"])
                if mic_rms >= sys_rms:
                    drop_ids.add(id(sys_entry))
                else:
                    drop_ids.add(id(mic_entry))
        return drop_ids

    def _resolve_against_recent(self, ready_entries):
        """Return the set of `ready_entries` ids to drop because they
        bleed-match something already emitted (in self._recent_emitted).

        A genuine bleed pair's two sides can become "ready" in different
        flush_ready() calls — the earlier side is already gone from
        self._pending by the time the later side is checked, so
        _resolve_bleed alone misses it (see flush_ready). There's no
        retraction mechanism (v1 constraint — see the module's live-
        speaker-fix design notes), so the earlier, already-shown side
        can't be un-shown; the only thing left to do is suppress the
        later duplicate outright, regardless of which side has higher
        RMS."""
        drop_ids = set()
        for e in ready_entries:
            for other, _emitted_at in self._recent_emitted:
                if other["channel"] == e["channel"]:
                    continue
                if self._is_bleed_pair(e, other):
                    drop_ids.add(id(e))
                    break
        return drop_ids

    def _remember_emitted(self, results, now):
        """Prune self._recent_emitted to the bleed window and record newly
        -released entries in it, so a later-arriving bleed partner can
        still be matched against them (_resolve_against_recent)."""
        from src.transcriber import PER_SEGMENT_BLEED_WINDOW_S
        self._recent_emitted = [
            (e, t) for (e, t) in self._recent_emitted
            if now - t <= PER_SEGMENT_BLEED_WINDOW_S
        ]
        self._recent_emitted.extend((e, now) for e in results)

    def flush_ready(self, other_idle):
        """``other_idle``: ``{"You": bool, "Others": bool}`` — True when
        that channel's VAD is not currently mid-utterance. Returns entries
        ready to emit (bleed losers already excluded), removing them from
        the pending set."""
        from src.transcriber import PER_SEGMENT_BLEED_WINDOW_S
        now = time.monotonic()
        drop_ids = self._resolve_bleed(self._pending)
        ready, not_ready = [], []
        for e in self._pending:
            age = now - e["added_at"]
            other_channel = "Others" if e["channel"] == "You" else "You"
            released = age >= PER_SEGMENT_BLEED_WINDOW_S or (
                other_idle.get(other_channel, True) and age >= self.MIN_HOLD_S
            )
            (ready if released else not_ready).append(e)
        self._pending = not_ready
        drop_ids |= self._resolve_against_recent(
            [e for e in ready if id(e) not in drop_ids],
        )
        results = [e for e in ready if id(e) not in drop_ids]
        results.sort(key=lambda e: e["start"])
        self._remember_emitted(results, now)
        return results

    def flush_all(self):
        """Force-emit every remaining entry regardless of hold age. Called
        once at shutdown so a trailing utterance inside the hold window
        still reaches the user instead of being silently dropped."""
        now = time.monotonic()
        drop_ids = self._resolve_bleed(self._pending)
        drop_ids |= self._resolve_against_recent(
            [e for e in self._pending if id(e) not in drop_ids],
        )
        results = [e for e in self._pending if id(e) not in drop_ids]
        self._pending = []
        results.sort(key=lambda e: e["start"])
        self._remember_emitted(results, now)
        return results


def _samples_rms(samples) -> float:
    """Mean RMS amplitude of an in-memory float32 sample array. Live
    analogue of src/transcriber.py's ``_segment_rms`` (which reads the
    same metric from a WAV file) — the live path already holds each
    channel's utterance in memory, so there's no file to read. Only used
    to compare RMS BETWEEN the two channels for the same utterance, so the
    absolute scale doesn't need to match ``_segment_rms``'s PCM16 scale."""
    if samples is None or len(samples) == 0:
        return 0.0
    import numpy as np
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))


def _emit_live_seg(speaker, text, start, end, is_final):
    if not text:
        return
    print("LIVE_SEG:" + json.dumps({
        "text": text,
        "start": start,
        "end": end,
        "is_final": is_final,
        "speaker": speaker,
    }), flush=True)


class _LiveVadPipeline:
    """VAD-gated batch transcription pipeline for ONE audio channel (mic or
    system) of the live-transcript consumer.

    Replaces the earlier parakeet-mlx streaming approach with the
    Granola / OpenOats / Meetily pattern: Silero VAD detects utterance
    boundaries; each closed utterance is batch-transcribed by Parakeet
    for a stable, finalised segment. While speech is in progress, a
    throttled re-transcribe of the trailing few seconds emits a partial
    so the user sees text forming in real time without flicker between
    unrelated decoder hypotheses.

    Two independent instances are driven by ``_live_stdin_consumer`` (see
    ``create_pair()``) — one per channel, each with its own Silero VAD
    state — so speaker identity comes from which channel actually
    contains the speech, not a post-hoc RMS guess on a pre-mixed mono
    stream. ``process()`` itself is channel-agnostic; it only touches this
    instance's own state.

    Protocol emitted on stdout (unchanged from earlier streaming consumer
    so main.js / preload / ipc.ts wiring is reused, plus a new `speaker`
    field):

      LIVE_READY:<config json>     once, after both models are loaded
      LIVE_SEG:<segment json>      per partial OR final; carries "speaker"
      LIVE_ERROR:<error json>      on any unrecoverable failure

    Partials are emitted directly (``_emit`` → stdout, no delay). Finals
    are NOT emitted directly — ``_finalise`` hands them to a shared
    ``_PendingFinalsCoordinator`` so a same-instant utterance on the other
    channel can be checked for bleed before either reaches the user; see
    ``_live_stdin_consumer``.

    Architecture notes:
      * Audio is consumed at 16 kHz mono float32, already split to this
        channel by the caller (the combined stdin stream is interleaved
        stereo; ``_live_stdin_consumer`` de-interleaves before calling
        ``process()``). The pipeline itself doesn't resample or split.
      * Preroll ring holds the most recent ``PREROLL_CHUNKS`` chunks of
        pre-speech audio so the first syllable of every utterance is
        recovered after VAD fires (Silero always trips slightly late).
      * Partials see the trailing ``PARTIAL_WINDOW_S`` of the utterance.
        At 15 s, a 4-5 sentence monologue stays fully visible in the live
        bubble (the prior 5 s window meant the rolling view dropped
        earlier sentences off-screen during continuous speech). Parakeet
        decodes 15 s in ~150-250 ms on Apple Silicon, comfortably under
        the 400 ms partial interval. Going wider (e.g. matching MAX at
        30 s) would risk decode time creeping past the interval and
        back-pressuring the stdin pipe.
      * Final fires on Silero's SpeechEnd OR when the utterance hits
        ``MAX_UTTERANCE_S`` so a monologue still produces output.
    """

    PARTIAL_INTERVAL_S = 0.4
    PARTIAL_WINDOW_S = 15.0
    MIN_UTTERANCE_S = 0.5
    MAX_UTTERANCE_S = 30.0
    PREROLL_CHUNKS = 2  # ≈ 512 ms at 256 ms per callback

    # Keep-pace guard (issue #357). Read + VAD + partial/final decode run
    # synchronously on the single stdin-consumer thread, so a partial decode
    # that takes longer than the audio it represents back-pressures the stdin
    # pipe and the sidecar drifts behind real time (measured ~670 ms partial
    # decode on a fanless M1 Air vs the 400 ms interval → ~94 % of partials
    # over budget, audio backing up across the recording). Partials are
    # best-effort display only — finals accumulate every sample regardless —
    # so when decode is slow we stretch the *effective* partial cadence to an
    # EWMA of measured decode time, dropping the partials that would otherwise
    # queue up while always draining stdin. On fast machines (decode ≪ the
    # interval) the effective cadence is the base interval, unchanged.
    #
    # Scope + known limits (kept deliberately per-channel; the shared decode
    # coordinator belongs with the strategic ANE/threading rework):
    #   * Cadence is tracked per channel, so two channels in *sustained*
    #     simultaneous speech each keep their own pace but their decodes still
    #     run serially on the one consumer thread — combined load can exceed
    #     real time. The dominant single-speaker case (and the issue's own
    #     measurements) is fully covered; continuous cross-talk on a fanless
    #     Air is the residual gap, bounded by the stdin queue on the JS side.
    #   * The EWMA only samples when a partial actually decodes, and its ALPHA
    #     smoothing means a one-off spike inflates the interval only partly and
    #     decays back over the next few partials of sustained speech.
    KEEP_PACE_SAFETY = 1.15         # headroom over measured decode time
    KEEP_PACE_ALPHA = 0.3           # EWMA weight for the newest decode sample
    # Ceiling on the stretched cadence. High enough that a genuinely slow
    # decoder (e.g. onnx-asr on a Windows CPU, several seconds per 15 s window)
    # can still stretch far enough to keep pace, while ALPHA smoothing keeps a
    # spurious spike from pinning partials at the ceiling.
    KEEP_PACE_MAX_INTERVAL_S = 8.0

    @classmethod
    def _load_shared(cls, source_rate, source_label):
        """Load Parakeet config shared by both channel pipelines. Returns
        ``(init_kwargs, ready_payload)`` — ``init_kwargs`` is a dict of
        shared __init__ kwargs (np, sr, SpeechStart, SpeechEnd,
        transcribe_samples, language); ``ready_payload`` is the LIVE_READY
        body for the caller to print once it has also finished
        constructing the per-channel VAD state. Returns ``None`` if any
        setup step fails (after emitting LIVE_ERROR). Callers should bail
        out on ``None``. Does NOT emit LIVE_READY itself — see
        ``create_pair``.
        """
        try:
            import numpy as _np
        except ImportError:
            print("LIVE_ERROR:" + json.dumps({"stage": "import_numpy"}), flush=True)
            return None

        # Live transcription is Parakeet-only. Whisper users get the
        # post-stop pipeline (src.transcriber.WhisperTranscriber) and no
        # live drawer; main.js gates this by not spawning the
        # `transcribe-stream` sidecar for whisper recordings. The defensive
        # check below catches anyone driving the CLI directly with a whisper
        # config.
        try:
            from src.config import get_config
            _cfg = get_config()
            engine = _cfg.get_transcription_engine()
            language = _cfg.get_language() or "auto"
        except Exception as e:
            print("LIVE_ERROR:" + json.dumps({
                "stage": "load_config", "error": str(e),
            }), flush=True)
            return None

        if engine != "parakeet":
            print("LIVE_ERROR:" + json.dumps({
                "stage": "engine_not_supported_for_live",
                "engine": engine,
                "message": (
                    f"Live transcription is Parakeet-only; engine is {engine!r}. "
                    "Switch to Parakeet in Settings → Transcribe, or rely on the "
                    "post-stop transcription pipeline."
                ),
            }), flush=True)
            return None

        try:
            from src.parakeet import (
                transcribe_samples, ensure_loaded, model_sample_rate,
            )
        except ImportError as e:
            print("LIVE_ERROR:" + json.dumps({
                "stage": "import_parakeet", "error": str(e),
            }), flush=True)
            return None

        try:
            from src.silero_vad import (
                SpeechStart, SpeechEnd, VAD_SAMPLE_RATE, VAD_CHUNK_SAMPLES,
            )
        except ImportError as e:
            print("LIVE_ERROR:" + json.dumps({
                "stage": "import_silero", "error": str(e),
            }), flush=True)
            return None

        try:
            sr = model_sample_rate()
        except Exception as e:
            print("LIVE_ERROR:" + json.dumps({
                "stage": f"load_{engine}", "error": str(e),
            }), flush=True)
            return None

        if sr != VAD_SAMPLE_RATE:
            # Silero is hard-pinned to 16 kHz; if Parakeet's expected rate
            # ever diverges we'd need a real resampler here. Surface it
            # loudly rather than silently producing garbage.
            print("LIVE_ERROR:" + json.dumps({
                "stage": "rate_mismatch",
                "error": f"parakeet_rate={sr} != silero_rate={VAD_SAMPLE_RATE}",
            }), flush=True)
            return None

        ready_payload = {
            "engine": engine,
            "language": language,
            "sample_rate": sr,
            "vad_chunk_samples": VAD_CHUNK_SAMPLES,
            "min_utterance_s": cls.MIN_UTTERANCE_S,
            "max_utterance_s": cls.MAX_UTTERANCE_S,
            "partial_interval_s": cls.PARTIAL_INTERVAL_S,
        }
        if source_rate is not None:
            ready_payload["source_rate"] = source_rate
        if source_label is not None:
            ready_payload["source"] = source_label

        # Pre-load the active engine so the first SpeechEnd doesn't pay
        # warm-load latency on the user's very first utterance.
        try:
            ensure_loaded()
        except Exception as e:
            print("LIVE_ERROR:" + json.dumps({
                "stage": "ensure_loaded", "error": str(e),
            }), flush=True)
            return None

        # LIVE_READY is NOT emitted here — the caller (create_pair) still
        # has to construct both channels' Silero VAD instances, and
        # LIVE_READY is documented (and main.js relies on it) to mean
        # "fully ready, both models loaded." Emitting it before that would
        # let the renderer flip to 'streaming' and then immediately get a
        # LIVE_ERROR if VAD construction fails.
        return {
            "np": _np,
            "sr": sr,
            "SpeechStart": SpeechStart,
            "SpeechEnd": SpeechEnd,
            "transcribe_samples": transcribe_samples,
            "language": language,
        }, ready_payload

    @classmethod
    def create_pair(cls, source_rate, source_label):
        """Load the shared model/VAD config once, construct both channels'
        Silero VAD state, and only THEN emit LIVE_READY (once) — so
        LIVE_READY genuinely means "both models loaded," matching what
        main.js/the renderer treat it as. Returns two independent pipeline
        instances — mic ("You") and system ("Others") — each with its own
        VAD state and a shared ``_PendingFinalsCoordinator`` for
        cross-channel bleed dedup. Returns ``(None, None)`` on failure
        (LIVE_ERROR already emitted)."""
        loaded = cls._load_shared(source_rate, source_label)
        if loaded is None:
            return None, None
        shared, ready_payload = loaded
        try:
            from src.silero_vad import SileroProcessor
            mic_vad = SileroProcessor()
            sys_vad = SileroProcessor()
        except Exception as e:
            print("LIVE_ERROR:" + json.dumps({
                "stage": "load_silero", "error": str(e),
            }), flush=True)
            return None, None
        print("LIVE_READY:" + json.dumps(ready_payload), flush=True)
        pending_finals = _PendingFinalsCoordinator()
        mic_pipeline = cls(vad=mic_vad, speaker="You",
                            pending_finals=pending_finals, **shared)
        sys_pipeline = cls(vad=sys_vad, speaker="Others",
                            pending_finals=pending_finals, **shared)
        return mic_pipeline, sys_pipeline

    def __init__(self, np, vad, sr, SpeechStart, SpeechEnd, transcribe_samples,
                 speaker, pending_finals, language="auto"):
        self.np = np
        self.vad = vad
        self.sr = sr
        self.SpeechStart = SpeechStart
        self.SpeechEnd = SpeechEnd
        self.transcribe_samples = transcribe_samples
        # "You" (mic) or "Others" (system) — fixed for this instance's
        # lifetime, carried on every emitted LIVE_SEG.
        self.speaker = speaker
        self.pending_finals = pending_finals
        # Passed through to every transcribe_samples() call. Parakeet is
        # multilingual + language-agnostic at inference, so "auto" and a
        # concrete code both produce the same decoding. The hint is
        # surfaced back to the summariser via detected_language when
        # concrete.
        self.language = "auto" if language in (None, "", "auto") else language
        self.partial_interval_samples = int(sr * self.PARTIAL_INTERVAL_S)
        self.partial_window_samples = int(sr * self.PARTIAL_WINDOW_S)
        self.min_utterance_samples = int(sr * self.MIN_UTTERANCE_S)
        self.max_utterance_samples = int(sr * self.MAX_UTTERANCE_S)

        # Mutable state for the run.
        self.speech_samples = np.empty((0,), dtype=np.float32)
        self.speech_start_offset = 0
        self.last_partial_count = 0
        self.last_partial_text = ""
        self.preroll: list = []
        self.cursor = 0
        # Keep-pace guard state (issue #357): EWMA of measured partial-decode
        # wall-time, used to stretch the effective partial cadence so a slow
        # decode can't back-pressure stdin. 0.0 until the first partial has
        # been timed (until then the fast path uses the base interval).
        self._partial_decode_ewma_s = 0.0
        self._keep_pace_max_interval_samples = int(sr * self.KEEP_PACE_MAX_INTERVAL_S)

    def parse_float32_bytes(self, raw_bytes):
        """Parse raw little-endian float32 bytes into a 1-D float32 array.

        Used by the stdin consumer so the consumer itself doesn't need a
        guarded numpy import — the pipeline already failed at
        create_pair() time if numpy was missing, so by the time we get
        here it exists.
        ``.copy()`` because ``frombuffer`` returns a read-only view of
        the input bytes; downstream VAD code mutates in place.
        """
        return self.np.frombuffer(raw_bytes, dtype=self.np.float32).copy()

    def process(self, chunk):
        """Feed one float32 1-D chunk through the VAD + transcribe pipeline."""
        if chunk.size == 0:
            return
        was_in_speech = self.vad.in_speech
        events = self.vad.process(chunk)
        self.cursor += len(chunk)

        for ev in events:
            if isinstance(ev, self.SpeechStart):
                preroll_audio = (
                    self.np.concatenate(self.preroll) if self.preroll
                    else self.np.empty((0,), dtype=self.np.float32)
                )
                self.speech_samples = preroll_audio
                self.speech_start_offset = max(
                    0, self.cursor - len(chunk) - len(preroll_audio),
                )
                self.last_partial_count = 0
                self.last_partial_text = ""
            elif isinstance(ev, self.SpeechEnd):
                self._finalise()

        if self.vad.in_speech:
            self.speech_samples = self.np.concatenate([self.speech_samples, chunk])
            self.preroll = []
            if len(self.speech_samples) >= self.max_utterance_samples:
                self._finalise()
            else:
                self._maybe_emit_partial()
        else:
            self.preroll.append(chunk)
            if len(self.preroll) > self.PREROLL_CHUNKS:
                self.preroll.pop(0)

        if was_in_speech != self.vad.in_speech:
            logger.debug(
                "VAD transition: in_speech=%s buffer=%d samples",
                self.vad.in_speech, len(self.speech_samples),
            )

    def finalize(self):
        """Drain VAD on shutdown so a trailing utterance still emits.

        Callers should call this once after their input loop exits (EOF,
        stop_event set, etc.)."""
        for ev in self.vad.flush():
            if isinstance(ev, self.SpeechEnd):
                self._finalise()
        if len(self.speech_samples) >= self.min_utterance_samples:
            self._finalise()

    def _emit(self, text, start_samples, end_samples, is_final):
        _emit_live_seg(
            speaker=self.speaker,
            text=text,
            start=start_samples / self.sr,
            end=end_samples / self.sr,
            is_final=is_final,
        )

    def _finalise(self):
        if len(self.speech_samples) < self.min_utterance_samples:
            self.speech_samples = self.np.empty((0,), dtype=self.np.float32)
            self.last_partial_count = 0
            self.last_partial_text = ""
            return
        try:
            result = self.transcribe_samples(self.speech_samples, language=self.language)
            text = (result.get("text") or "").strip() if result else ""
        except Exception as e:
            print("LIVE_ERROR:" + json.dumps({
                "stage": "transcribe_final", "error": str(e),
            }), flush=True)
            self.speech_samples = self.np.empty((0,), dtype=self.np.float32)
            self.last_partial_count = 0
            self.last_partial_text = ""
            return
        end_sample = self.speech_start_offset + len(self.speech_samples)
        # Route through the shared coordinator instead of emitting
        # directly — it holds the segment briefly so a same-instant
        # utterance on the other channel can be checked for bleed before
        # either reaches the user (see _live_stdin_consumer).
        self.pending_finals.add(
            channel=self.speaker,
            text=text,
            start=self.speech_start_offset / self.sr,
            end=end_sample / self.sr,
            samples=self.speech_samples,
        )
        # Advance the offset so a continued utterance (e.g. when
        # MAX_UTTERANCE_S forces a mid-monologue final) doesn't reuse the
        # just-emitted segment's start time on its next partial/final.
        self.speech_start_offset = end_sample
        self.speech_samples = self.np.empty((0,), dtype=self.np.float32)
        self.last_partial_count = 0
        self.last_partial_text = ""

    def _effective_partial_interval_samples(self):
        """Adaptive partial cadence in samples (issue #357 keep-pace guard).

        Base cadence is ``partial_interval_samples`` (0.4 s of audio). Once a
        partial decode has been timed and its EWMA exceeds that budget, the
        sidecar would fall behind real time, so we require at least as much
        *audio* between partials as the decode takes wall-clock (× a safety
        margin), capped at ``KEEP_PACE_MAX_INTERVAL_S`` so a one-off spike
        can't starve partials entirely. On fast machines (decode ≪ budget)
        this returns the base cadence unchanged.
        """
        if self._partial_decode_ewma_s <= 0.0:
            return self.partial_interval_samples
        pace_samples = int(self._partial_decode_ewma_s * self.KEEP_PACE_SAFETY * self.sr)
        effective = max(self.partial_interval_samples, pace_samples)
        return min(effective, self._keep_pace_max_interval_samples)

    def _record_partial_decode_time(self, dt_s):
        """Fold a measured partial-decode wall-time into the keep-pace EWMA."""
        if dt_s < 0:
            return
        if self._partial_decode_ewma_s <= 0.0:
            self._partial_decode_ewma_s = dt_s
        else:
            self._partial_decode_ewma_s = (
                (1.0 - self.KEEP_PACE_ALPHA) * self._partial_decode_ewma_s
                + self.KEEP_PACE_ALPHA * dt_s
            )

    def _maybe_emit_partial(self):
        delta = len(self.speech_samples) - self.last_partial_count
        if delta < self._effective_partial_interval_samples():
            return
        if len(self.speech_samples) < self.min_utterance_samples:
            return
        # Only the trailing window — re-transcribing the full utterance
        # every partial would scale O(n²) with utterance length.
        tail = self.speech_samples[-self.partial_window_samples:]
        decode_started = time.monotonic()
        try:
            result = self.transcribe_samples(tail, language=self.language)
        except Exception as e:
            # Partials are best-effort. Don't tear down the consumer over
            # a transient decode hiccup; the next partial/final retries.
            # Still fold the wall-time spent into the keep-pace EWMA — a
            # decode that burns 700 ms before throwing is exactly the kind of
            # cost that must widen the cadence, or a failing decoder would
            # rebuild the backlog at the tight interval it was meant to relieve.
            self._record_partial_decode_time(time.monotonic() - decode_started)
            logger.debug("partial transcribe failed: %s", e)
            self.last_partial_count = len(self.speech_samples)
            return
        # Fold real decode wall-time into the keep-pace EWMA before anything
        # can early-return, so a slow machine widens the next interval even
        # when the text is empty or unchanged.
        self._record_partial_decode_time(time.monotonic() - decode_started)
        text = (result.get("text") or "").strip() if result else ""
        self.last_partial_count = len(self.speech_samples)
        if text and text != self.last_partial_text:
            self.last_partial_text = text
            self._emit(
                text,
                start_samples=self.speech_start_offset + max(
                    0, len(self.speech_samples) - self.partial_window_samples,
                ),
                end_samples=self.speech_start_offset + len(self.speech_samples),
                is_final=False,
            )


def _live_stdin_consumer():
    """Live consumer fed by raw float32 stdin (renderer-driven system-audio
    path). The renderer captures mic + system audio via Web Audio and
    pushes 16 kHz INTERLEAVED STEREO float32 chunks (mic=L, system=R) to
    main.js over IPC; main.js spawns this subprocess and writes those
    chunks to our stdin. Each channel is de-interleaved here and driven
    through its own independent ``_LiveVadPipeline`` so speaker identity
    is a structural fact (which channel the audio came from), not a
    post-hoc RMS guess on a pre-mixed mono stream.

    Exits cleanly on stdin EOF (main.js closes the pipe on stop) or on
    SIGTERM. Input format is contract: 16 kHz interleaved stereo float32,
    native byte order. Any other input is undefined behaviour.
    """
    import sys
    import signal

    # numpy is imported (and guarded) inside _LiveVadPipeline._load_shared()
    # so an absent install emits LIVE_ERROR and returns None rather than
    # crashing the subprocess before main.js sees any signal.
    mic_pipeline, sys_pipeline = _LiveVadPipeline.create_pair(
        source_rate=None, source_label="stdin",
    )
    if mic_pipeline is None or sys_pipeline is None:
        return
    coordinator = mic_pipeline.pending_finals  # shared with sys_pipeline

    # Signal handler: SIGTERM from main.js (on stop) should flush + exit
    # cleanly. SIGINT covers terminal Ctrl-C in dev runs.
    stop_flag = [False]
    def _on_signal(signum, frame):
        stop_flag[0] = True
    try:
        signal.signal(signal.SIGTERM, _on_signal)
        signal.signal(signal.SIGINT, _on_signal)
    except (AttributeError, ValueError):
        pass

    def _flush_ready():
        other_idle = {
            "You": not mic_pipeline.vad.in_speech,
            "Others": not sys_pipeline.vad.in_speech,
        }
        for e in coordinator.flush_ready(other_idle):
            _emit_live_seg(
                speaker=e["channel"], text=e["text"],
                start=e["start"], end=e["end"], is_final=True,
            )

    # Read stdin in 4 KB blocks (~512 stereo frames per read at 16 kHz).
    # The block size is a latency-vs-syscall-overhead trade; smaller
    # blocks give finer VAD timing but more read() calls. 4 KB is
    # comfortable. Must stay a multiple of 8 bytes (one stereo frame = 2
    # float32 samples) — the pending-tail slicing below enforces that.
    BLOCK_BYTES = 4096
    pending = bytearray()
    try:
        stdin_buf = sys.stdin.buffer
        while not stop_flag[0]:
            block = stdin_buf.read(BLOCK_BYTES)
            if not block:
                break  # EOF
            pending.extend(block)
            n_frames = (len(pending) // 4) // 2  # stereo frames (L+R pairs)
            if n_frames == 0:
                continue
            # Slice off complete stereo frames; leave any partial-frame
            # tail in pending for the next read.
            usable_bytes = n_frames * 2 * 4
            usable = bytes(pending[:usable_bytes])
            del pending[:usable_bytes]
            stereo = mic_pipeline.parse_float32_bytes(usable).reshape(-1, 2)
            mic_pipeline.process(mic_pipeline.np.ascontiguousarray(stereo[:, 0]))
            sys_pipeline.process(sys_pipeline.np.ascontiguousarray(stereo[:, 1]))
            _flush_ready()
        mic_pipeline.finalize()
        sys_pipeline.finalize()
        for e in coordinator.flush_all():
            _emit_live_seg(
                speaker=e["channel"], text=e["text"],
                start=e["start"], end=e["end"], is_final=True,
            )
    except Exception as e:
        print("LIVE_ERROR:" + json.dumps({
            "stage": "consumer_loop", "error": str(e),
        }), flush=True)


@cli.command(name='transcribe-stream')
def transcribe_stream_cmd():
    """Run the VAD-gated live transcription consumer over raw stdin audio.

    The pipe contract: caller writes raw 16 kHz INTERLEAVED STEREO
    float32 little-endian samples (mic=L, system=R) to our stdin; we emit
    LIVE_READY / LIVE_SEG / LIVE_ERROR NDJSON lines to stdout, each
    LIVE_SEG carrying a "speaker": "You"|"Others" field set directly from
    which channel produced it. Used by main.js for the renderer-driven
    system-audio path, where the Web Audio capture is downsampled and
    interleaved in the renderer and pushed to us through IPC.
    """
    _live_stdin_consumer()


@cli.command()
def test():
    """Quick system test - check components can initialize"""
    print("🧪 Quick system test...")
    
    try:
        # Test transcriber availability
        print("🗣️ Testing Whisper transcriber...")
        if not WhisperTranscriber:
            print("❌ Whisper transcriber not available")
            print("ERROR: Whisper not installed")
            return
            
        try:
            from src.config import get_config
            transcriber = WhisperTranscriber(model_size=get_config().get_whisper_model())
            print("✅ Whisper transcriber ready")
        except Exception as e:
            print(f"❌ Whisper initialization failed: {e}")
            print(f"ERROR: {e}")
            return
        
        # Test Ollama availability (lightweight check)
        print("🧠 Testing Ollama availability...")
        if not OllamaSummarizer:
            print("❌ Ollama summarizer not available")
            print("ERROR: Ollama dependencies missing")
            return
            
        try:
            # Just check if we can initialize without making API calls
            summarizer = OllamaSummarizer()
            print("✅ Ollama summarizer ready")
        except Exception as e:
            print(f"❌ Ollama initialization failed: {e}")
            print(f"ERROR: {e}")
            return
        
        print("🎉 System check passed!")
        print("SUCCESS: All components are working correctly")
        
    except Exception as e:
        print(f"❌ System test failed: {e}")
        print(f"ERROR: {e}")
        return


def _parse_meeting_markdown(md_path):
    """Parse a .md meeting file into the standard meeting dict.

    Mirrored by parseMeetingMarkdown in app/main.js (the detail-page /
    get-meeting parser, which reads the .md directly to avoid a Python
    round-trip). The two MUST surface the same session_info / meeting-dict
    contract — they drift silently otherwise (see #346, and #313 for a prior
    drift). Any change here has to land there too.
    """
    content = md_path.read_text(encoding='utf-8')

    # Split frontmatter
    meta = {}
    body = content
    if content.startswith('---'):
        parts = content.split('---', 2)
        if len(parts) >= 3:
            for line in parts[1].strip().split('\n'):
                if ':' in line:
                    key, _, value = line.partition(':')
                    value = value.strip()
                    if value.startswith('"') and value.endswith('"'):
                        import re as _re
                        value = _re.sub(r'\\(.)', lambda m: m.group(1), value[1:-1])
                    elif value.startswith('['):
                        try:
                            value = json.loads(value)
                        except (ValueError, TypeError):
                            value = []
                    elif value == 'null':
                        value = None
                    elif value == 'true':
                        value = True
                    elif value == 'false':
                        value = False
                    else:
                        try:
                            value = int(value)
                        except (ValueError, TypeError):
                            pass
                    meta[key.strip()] = value
            body = parts[2].strip()

    body = _normalize_markdown_for_parsing(body)

    # Parse markdown body into sections
    sections = {}
    current_section = None
    current_lines = []

    for line in body.split('\n'):
        if line.startswith('## '):
            if current_section:
                sections[current_section] = '\n'.join(current_lines).strip()
            current_section = line[3:].strip().lower()
            current_lines = []
        else:
            current_lines.append(line)
    if current_section:
        sections[current_section] = '\n'.join(current_lines).strip()

    # Extract structured fields
    participants = []
    if 'participants' in sections:
        participants = [p.strip() for p in sections['participants'].split(',') if p.strip()]

    key_points = []
    if 'key points' in sections:
        for line in sections['key points'].split('\n'):
            line = line.strip()
            if line.startswith('- '):
                key_points.append(line[2:])

    action_items = []
    if 'action items' in sections:
        for line in sections['action items'].split('\n'):
            line = line.strip()
            if line.startswith('- '):
                action_items.append(line[2:].replace('[ ] ', '').replace('[x] ', ''))

    discussion_areas = []
    if 'key topics' in sections:
        current_topic = None
        topic_lines = []
        for line in sections['key topics'].split('\n'):
            if line.startswith('### '):
                if current_topic:
                    discussion_areas.append({
                        'title': current_topic,
                        'analysis': '\n'.join(topic_lines).strip()
                    })
                current_topic = line[4:].strip()
                topic_lines = []
            else:
                topic_lines.append(line)
        if current_topic:
            discussion_areas.append({
                'title': current_topic,
                'analysis': '\n'.join(topic_lines).strip()
            })

    session_info = {
        'name': meta.get('title', md_path.stem),
        'processed_at': meta.get('date', ''),
        'duration_seconds': meta.get('duration_seconds'),
        'summary_file': str(md_path),
        'output_language': meta.get('language'),
        # Provenance of the output language, so recovery paths (reprocess /
        # generate-report / regen-title / chat) can tell a real user pin or
        # Whisper engine detection from a bare Parakeet fallback (#283). Old .md
        # files predating these keys read as None -> treated as no provenance
        # (re-detect), preserving prior behaviour.
        'configured_language': meta.get('configured_language'),
        'detected_language': meta.get('detected_language'),
    }
    # A meeting whose transcription crashed carries these markers so the UI
    # can render an honest failure state (and a future retry) rather than a
    # blank note. Only thread them through when present so normal meetings'
    # session_info shape is unchanged.
    if meta.get('transcription_failed'):
        session_info['transcription_failed'] = True
        session_info['reprocessable'] = bool(meta.get('reprocessable'))
        if meta.get('audio_file'):
            session_info['audio_file'] = meta.get('audio_file')
        if meta.get('error'):
            session_info['error'] = meta.get('error')
    # A live-sourced meeting (#207): the batch transcription was empty so this
    # transcript came from the live capture. Surface the flag so the UI can
    # tell the user no batch transcript exists.
    if meta.get('is_live_transcript'):
        session_info['is_live_transcript'] = True
    # A transcript-only meeting (#258): auto-summarize was off, so this note has
    # a transcript but no summary yet. Surface the flag so the UI can offer a
    # "Generate notes" CTA instead of a blank/"no summary" state.
    if meta.get('notes_generated') is False:
        session_info['notes_generated'] = False
    # A continued meeting whose transcript grew after its notes were generated
    # (continue-recording append): the summary no longer reflects the full
    # transcript. Surface the flag so the UI offers "Regenerate notes";
    # reprocess clears it when it rewrites the note.
    if meta.get('notes_stale'):
        session_info['notes_stale'] = True
    # An instant-stop placeholder: written from the live transcript at stop
    # while batch transcribe/summarise upgrades it in the background. Surface
    # the flag so the detail view shows a quiet "finishing up" affordance.
    if meta.get('processing'):
        session_info['processing'] = True

    return {
        'session_info': session_info,
        'summary': sections.get('summary', ''),
        'participants': participants,
        'discussion_areas': discussion_areas,
        'key_points': key_points,
        'action_items': action_items,
        'transcript': sections.get('transcript', ''),
        'is_diarised': meta.get('is_diarised', False),
        'diarised_text': sections.get('transcript', '') if meta.get('is_diarised') else None,
        'user_notes': sections.get('user notes'),
        'folders': meta.get('folders', []),
    }


@cli.command()
def list_meetings():
    """List all processed meetings - optimized for fast loading"""
    from src.config import get_data_dirs, get_config
    dirs = get_data_dirs()
    output_dir = dirs["output"]

    # Ensure output directory exists
    output_dir.mkdir(parents=True, exist_ok=True)

    # Stems that still have their source recording on disk. Read as ONE
    # directory listing rather than a per-meeting existence check, because
    # this command is on the app's cold-start path and is deliberately
    # "optimized for fast loading" -- with a listing the cost is a single
    # syscall regardless of library size, and each meeting is then a set
    # lookup. Extension-agnostic on purpose: the capture pipeline saves
    # whatever the source produced (.webm system audio, .wav native
    # captures, .m4a/.mp3 imports), so only the stem is meaningful.
    def _recorded_stems(recordings_dir) -> set:
        try:
            # FILES only. A directory that happens to be named like a
            # recording (`recordings/note.wav/`) would otherwise report the
            # note as having audio it does not have. scandir keeps this a
            # single listing -- the is_file() check comes from the entry
            # already returned, not from an extra stat per name.
            return {
                Path(entry.name).stem
                for entry in os.scandir(recordings_dir)
                if entry.is_file()
            }
        except OSError:
            # No recordings dir yet (fresh install) is not an error -- it
            # just means nothing has audio.
            return set()

    def _summary_stem(summary_path) -> str:
        """`<stem>_summary.{md,json}` -> `<stem>`, stripping only a TRAILING
        marker. `str.replace` removes every occurrence, so a note whose own
        name contains the marker (`client_summary.v1_summary.md`) came back
        as `client.v1`. That was harmless while the stem only fed the
        dedup set, where a wrong-but-consistent key still dedups; matching
        it against real filenames on disk is what makes it visible. Same
        rule reprocess and app/main.js's delete path already use."""
        name = summary_path.stem
        return name[:-len('_summary')] if name.endswith('_summary') else name

    audio_stems = _recorded_stems(dirs["recordings"])

    # Collect summary files from current output dir (JSON preferred over MD)
    seen_files = set()
    seen_stems = set()
    summaries = []
    # JSON first — if both .json and .md exist, JSON wins (it has structured data)
    for pattern in ("*_summary.json", "*_summary.md"):
        for f in output_dir.glob(pattern):
            stem = _summary_stem(f)
            if stem not in seen_stems:
                summaries.append((f, stem))
                seen_files.add(f.resolve())
                seen_stems.add(stem)

    # Also scan the default location if a custom path is set,
    # so meetings stored before the path change remain visible
    custom = get_config().get_storage_path()
    if custom:
        from src.config import is_bundled, get_user_data_dir
        if is_bundled():
            default_output = get_user_data_dir() / "output"
        else:
            default_output = Path(__file__).parent / "output"
        if default_output.exists():
            # Meetings found here keep their audio in the DEFAULT recordings
            # dir, not the custom one -- they predate the path change.
            audio_stems |= _recorded_stems(default_output.parent / "recordings")
            for pattern in ("*_summary.json", "*_summary.md"):
                for f in default_output.glob(pattern):
                    stem = _summary_stem(f)
                    if f.resolve() not in seen_files and stem not in seen_stems:
                        summaries.append((f, stem))
                        seen_files.add(f.resolve())
                        seen_stems.add(stem)

    meetings = []

    # Single-pass: read each file once, extract sort key and data together
    for summary_file, stem in summaries:
        try:
            if summary_file.suffix == '.md':
                parsed = _parse_meeting_markdown(summary_file)
                sort_key = parsed.get('session_info', {}).get('processed_at', '')
                # Strip the transcript (and diarised copy) from the LIST payload
                # to match the JSON path — the full text is fetched lazily by
                # get-meeting for the detail page. Keep has_transcript so the UI
                # still knows a transcript exists.
                essential_meeting = parsed
                essential_meeting['has_transcript'] = bool(parsed.get('transcript'))
                essential_meeting.pop('transcript', None)
                essential_meeting.pop('diarised_text', None)
            else:
                with open(summary_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    sort_key = data.get('session_info', {}).get('processed_at', '')
                    essential_meeting = {
                        "session_info": data.get("session_info", {}),
                        "summary": data.get("summary", ""),
                        "participants": data.get("participants", []),
                        "discussion_areas": data.get("discussion_areas", []),
                        "key_points": data.get("key_points", []),
                        "action_items": data.get("action_items", []),
                        "has_transcript": bool(data.get("transcript")),
                        "is_diarised": data.get("is_diarised", False),
                        "diarised_text": data.get("diarised_text"),
                        "folders": data.get("folders", []),
                        "user_notes": data.get("user_notes"),
                    }
            # Whether the ORIGINAL audio is still on disk. keep_recordings
            # defaults off, so for most notes it is not -- and everything
            # that needs the audio (re-transcribe, speaker samples, any
            # future re-diarization) is silently unavailable without it,
            # with nothing in the list saying so until you open the note
            # and find the action missing.
            essential_meeting['has_audio'] = stem in audio_stems
            meetings.append((sort_key, essential_meeting))
        except Exception as e:
            logger.warning(f"Failed to load {summary_file}: {e}")
            continue

    meetings.sort(key=lambda x: x[0], reverse=True)
    meetings = [m for _, m in meetings]
    
    # Output as compact JSON for Electron (no indentation for speed)
    print(json.dumps(meetings, separators=(',', ':')))


@cli.command()
@click.argument('summary_file', required=True)
@click.option('--regenerate-title', is_flag=True, default=False, help='Also regenerate the meeting title')
@click.option('--retranscribe', is_flag=True, default=False,
              help='Re-run transcription on the source recording (requires the audio to '
                   'still exist) with the current settings before re-summarising')
def reprocess(summary_file, regenerate_title, retranscribe):
    """Reprocess a failed summary by re-running Ollama analysis on existing transcript"""
    import json
    from pathlib import Path

    import base64

    recorder = MeetingPipeline()
    summary_path = Path(summary_file)

    if not summary_path.exists():
        print(f"ERROR: Summary file not found: {summary_file}")
        sys.exit(1)

    try:
        # Load existing summary file (JSON or MD)
        if summary_path.suffix == '.md':
            existing_data = _parse_meeting_markdown(summary_path)
        else:
            with open(summary_path, 'r') as f:
                existing_data = json.load(f)

        # Re-transcribe (#266): re-run ASR on the ORIGINAL recording with the
        # CURRENT global engine/model/language settings, then fall through into
        # the normal summarise+rewrite path below so the rewritten note carries a
        # fresh transcript AND a fresh summary (the #249 standard-backup still
        # runs). MVP gate: only possible when the source audio still exists on
        # disk (keep-recordings was on); if it's gone, fail cleanly and touch
        # nothing. The non-retranscribe path is unchanged (flag defaults false).
        if retranscribe:
            import asyncio
            session_name = existing_data.get('session_info', {}).get('name', 'Reprocessed')
            stem = summary_path.stem
            if stem.endswith('_summary'):
                stem = stem[:-len('_summary')]
            recording = _find_recording_for_stem(recorder.recordings_dir, stem)
            if recording is None:
                # Distinct marker so the renderer surfaces "recording no longer
                # available" rather than a generic failure — nothing is written.
                print("STREAM_ERROR:RETRANSCRIBE_NO_AUDIO", flush=True)
                sys.exit(1)

            print(f"Re-transcribing recording: {recording.name}", flush=True)
            # Keep the Electron inactivity watchdog alive across ASR using the
            # backend's REAL per-chunk progress signal — the same mechanism
            # process-streaming uses (not the capped summary heartbeat, which
            # stops after ~30 beats and could let the 8-min watchdog kill a
            # genuinely long transcription, e.g. a multi-hour meeting on CPU).
            # A heartbeat must never break transcription — if the registry can't
            # even import, transcribe without one.
            try:
                from src.parakeet import set_chunk_heartbeat
            except Exception:
                def set_chunk_heartbeat(_cb):
                    pass

            def _transcribe_heartbeat(done, total):
                sys.stdout.write(f"HEARTBEAT:transcribe:{done}/{total}\n")
                sys.stdout.flush()

            print("HEARTBEAT:transcribe:start", flush=True)
            set_chunk_heartbeat(_transcribe_heartbeat)
            try:
                transcribe_result = asyncio.run(
                    recorder.transcribe_audio(str(recording), session_name)
                )
            finally:
                set_chunk_heartbeat(None)

            if transcribe_result.get("transcription_failed"):
                err_msg = str(
                    transcribe_result.get("error") or "transcription failed"
                ).replace('\n', ' ').replace('\r', ' ')
                print(f"STREAM_ERROR:{err_msg}", flush=True)
                sys.exit(1)

            # Mirror process_streaming's `## Transcript` content exactly:
            # diarised text when diarisation ran, else the flat transcript.
            fresh_transcript = (
                transcribe_result.get("diarised_text")
                or transcribe_result.get("transcript_text")
                or ""
            )
            existing_data['transcript'] = fresh_transcript
            existing_data['is_diarised'] = transcribe_result.get("is_diarised", False)
            existing_data['diarised_text'] = transcribe_result.get("diarised_text")
            # Refresh language provenance from the NEW transcribe result — the
            # transcript changed, so the persisted configured/detected/output
            # values no longer describe it. resolve_persisted_output_language
            # (below) then trusts this fresh, pin/engine-backed output_language.
            _si = existing_data.setdefault('session_info', {})
            _si['configured_language'] = transcribe_result.get("configured_language")
            _si['detected_language'] = transcribe_result.get("detected_language")
            _si['output_language'] = transcribe_result.get("output_language")
            # A full re-transcribe replaces any live-sourced transcript, so the
            # live-transcript flag (#207) no longer applies to this note.
            _si.pop('is_live_transcript', None)

            # This re-transcribe just re-ran diarization at full cost on the
            # original audio, so the new clusters describe the transcript
            # that is being written here -- the OLD sidecar (if any) now
            # describes a transcript that no longer exists, and its cluster
            # ids no longer line up with anything. Overwriting it is the
            # correct outcome, not a loss.
            #
            # KNOWN CONSEQUENCE, deliberately not worked around: a re-run
            # produces its own independent cluster numbering, so any
            # confirmations already recorded against the old ids are left
            # pointing at clusters that may now be different people. The
            # user is re-transcribing precisely because they consider the
            # old result wrong, and silently carrying old confirmations onto
            # new clusters would be the worse failure -- it would attach a
            # real person's name to whichever voice happened to inherit
            # their id. Re-confirming after a re-transcribe is intended.
            # Written to the CONFIGURED output dir, not next to the summary
            # path this command happens to be handed. Every reader --
            # suggest-speakers, confirm-speaker, speaker-naming-status,
            # backfill -- resolves the sidecar through
            # get_data_dirs()["output"] and nowhere else, so a sidecar
            # beside a summary living anywhere else would be written and
            # then never found by anything.
            from src.config import get_data_dirs as _get_data_dirs
            _persist_speaker_sidecar(_get_data_dirs()["output"], stem, transcribe_result)

        # Get transcript from the data
        transcript = existing_data.get('transcript', '')
        if not transcript:
            print("ERROR: No transcript found in summary file")
            sys.exit(1)

        session_name = existing_data.get('session_info', {}).get('name', 'Reprocessed')
        duration_minutes = existing_data.get('session_info', {}).get('duration_minutes', 10)
        if duration_minutes is None:
            ds = existing_data.get('session_info', {}).get('duration_seconds')
            duration_minutes = int(ds / 60) if ds else 10

        # Load user notes from the meeting data
        notes_text = existing_data.get('user_notes')

        print(f"Reprocessing summary for: {session_name}")
        print(f"Transcript length: {len(transcript)} characters")
        if notes_text:
            print(f"User notes: {len(notes_text)} characters")

        # Resolve output language. A persisted value is only trusted when it was
        # pin- or engine-backed; a stale Parakeet auto-mode "en" (buggy fallback,
        # #283) is re-detected from the transcript instead of re-pinning English.
        from src.config import get_config
        existing_session_info = existing_data.get("session_info", {})
        output_language = resolve_persisted_output_language(
            existing_session_info, transcript, get_config().get_language()
        )

        # Use streaming summarization (same as new recordings)
        if recorder.summarizer is None:
            from src.summarizer import OllamaSummarizer
            recorder.summarizer = OllamaSummarizer()

        print("Generating summary...", flush=True)
        streamed_chunks = []
        # Same watchdog-liveness cover as process_streaming: model load +
        # prompt eval is silent until the first streamed token.
        summary_heartbeat = _start_summary_heartbeat()
        _stream_error = None
        try:
            for chunk in recorder.summarizer.summarize_transcript_streaming(
                transcript, duration_minutes, output_language, notes_text,
                progress_callback=_emit_progress,
            ):
                summary_heartbeat.set()
                encoded = base64.b64encode(chunk.encode('utf-8')).decode('ascii')
                sys.stdout.write(f"CHUNK:{encoded}\n")
                sys.stdout.flush()
                streamed_chunks.append(chunk)
        except Exception as e:
            _stream_error = e
        finally:
            summary_heartbeat.set()

        if _stream_error is not None:
            logger.error(f"Summarization failed: {_stream_error}")
            # The renderer's parser reads STREAM_ERROR line-by-line, so a
            # message containing newlines (tracebacks can) would be truncated
            # to its first line. Flatten newlines into spaces so the whole
            # message survives on one line.
            err_msg = str(_stream_error).replace('\n', ' ').replace('\r', ' ')
            print(f"STREAM_ERROR:{err_msg}", flush=True)
            sys.exit(1)

        streamed_md = _apply_chinese_variant(''.join(streamed_chunks)) or ''

        # Regenerate the title when explicitly forced OR when the note still has
        # an auto/placeholder name. The latter is the common case now that the
        # pipeline is transcript-first (#276): with auto-summarize off, a fresh
        # recording is saved transcript-only as "Note", and the user fills it in
        # later via "Generate notes" — which reprocesses with regenerate_title
        # False. Without this, that path produced a summary but left the title
        # stuck at "Note" forever. Gating on _AUTO_NAMED_PATTERN mirrors
        # process_streaming's title step and protects a user-renamed note from
        # being overwritten.
        # `not session_name` guards a note whose title is null/empty: it should
        # be named (treat as auto), and it must short-circuit before the regex
        # since re.match(None) raises.
        if regenerate_title or not session_name or _AUTO_NAMED_PATTERN.match(session_name):
            # generate_title logs its own failure detail and returns None rather
            # than raising, so a failure just leaves the current name standing.
            generated_title = recorder.summarizer.generate_title(
                streamed_md, transcript, language=output_language
            )
            generated_title = _apply_chinese_variant(generated_title)
            if generated_title:
                session_name = generated_title
                existing_data["session_info"]["name"] = generated_title
                print(f"TITLE:{session_name}", flush=True)
                print(f"Auto-generated title: {session_name}")

        # Add reprocess timestamp
        existing_data["session_info"]["reprocessed_at"] = datetime.now().isoformat()

        # #249: snapshot the prior Standard note as a switchable backup BEFORE we
        # overwrite the note file, so a regenerate never loses the previous
        # summary. read_meeting + the sidecar are format-agnostic, so this runs
        # once for BOTH .md and .json meetings (above the format branch below).
        # Only snapshot an existing file — a brand-new meeting has nothing to
        # back up.
        if summary_path.exists():
            from src import report_store, reports as _reports
            _backup_md = report_store.read_meeting(summary_path)["summary_markdown"]
            if _backup_md.strip():
                _stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
                _sidecar = report_store.load_sidecar(summary_path)
                _reports.append_report(_sidecar, _reports.make_report(
                    "standard-backup", f"Standard · {_stamp}",
                    existing_data.get("session_info", {}).get("model")
                    or recorder.summarizer.model_name, _backup_md))
                # append_report sets active_report to the backup; the live note
                # should stay the default view after regenerate, so clear it:
                _sidecar["active_report"] = None
                report_store.save_sidecar(summary_path, _sidecar)

        # Save updated summary
        if summary_path.suffix == '.md':
            session_name = existing_data.get('session_info', {}).get('name', 'Reprocessed')
            md_lines = ['---']
            # This rebuild intentionally omits notes_generated: reprocessing a
            # transcript-only note (#258) generates the summary, so the rewritten
            # frontmatter naturally flips the meeting out of the "no notes yet"
            # state. The state-flip is intended, not an accidental key drop.
            md_meta = {
                'title': session_name,
                'date': existing_data.get('session_info', {}).get('processed_at', datetime.now().isoformat()),
                'duration_seconds': existing_data.get('session_info', {}).get('duration_seconds'),
                'language': output_language,
                # Carry the ORIGINAL provenance forward, not the re-resolved
                # output_language: a text-detected value must not masquerade as a
                # pin/engine detection (it stays re-detectable, idempotently).
                'configured_language': existing_session_info.get('configured_language'),
                'detected_language': existing_session_info.get('detected_language'),
                'is_diarised': existing_data.get('is_diarised', False),
                # Carry forward folder membership so a regenerate never silently
                # removes the meeting from its folders (matches _parse_meeting_markdown's
                # default-to-[] shape; patched surgically by src/folders.py).
                'folders': existing_data.get('folders', []),
            }
            # Preserve the live-transcript flag (#207) only when true, matching the
            # "only set when true, never explicit false" pattern used elsewhere.
            if existing_data.get('session_info', {}).get('is_live_transcript'):
                md_meta['is_live_transcript'] = True
            for k, v in md_meta.items():
                if v is None:
                    md_lines.append(f'{k}: null')
                elif isinstance(v, bool):
                    md_lines.append(f'{k}: {"true" if v else "false"}')
                elif isinstance(v, int):
                    md_lines.append(f'{k}: {v}')
                elif isinstance(v, list):
                    md_lines.append(f'{k}: {json.dumps(v)}')
                else:
                    escaped = str(v).replace('\\', '\\\\').replace('"', '\\"')
                    md_lines.append(f'{k}: "{escaped}"')
            md_lines.append('---')
            md_lines.append('')
            # Write the raw streamed markdown (preserves LLM formatting)
            md_lines.append(streamed_md)
            md_lines.append('')
            md_lines.append('## Transcript')
            md_lines.append('')
            md_lines.append(transcript)
            if notes_text:
                md_lines.append('')
                md_lines.append('## User Notes')
                md_lines.append('')
                md_lines.append(notes_text)
            _atomic_write_text(summary_path, '\n'.join(md_lines))
        else:
            # JSON format: parse streamed markdown into structured fields
            parsed = recorder._parse_streamed_markdown(streamed_md)
            existing_data.update({
                "summary": parsed.get("summary", "") or "",
                "participants": parsed.get("participants", []) or [],
                "discussion_areas": parsed.get("discussion_areas", []) or [],
                "key_points": parsed.get("key_points", []) or [],
                "action_items": parsed.get("action_items", []) or [],
            })
            # The regenerated summary now covers the full (possibly appended)
            # transcript — clear the continue-recording stale marker. The .md
            # branch clears it implicitly by omitting it from the rebuilt
            # frontmatter (see the intentional-omission note above).
            existing_data.get("session_info", {}).pop("notes_stale", None)
            with open(summary_path, 'w') as f:
                json.dump(existing_data, f, indent=2)

        # Signal completion only AFTER the note file is fully written. The
        # renderer reads the note the instant it sees STREAM_COMPLETE, so
        # emitting it before the write above is a write-after-complete race
        # (the #249 backup widened the window). It surfaced as a stale read on
        # Windows CI — map-reduce-chunking.t2 saw the pre-reprocess summary —
        # while macOS happened to win the race. Mirrors process_streaming's
        # write-before-complete intent.
        print("STREAM_COMPLETE", flush=True)

        print(f"Summary reprocessed successfully: {summary_path}")

    except Exception as e:
        print(f"ERROR: Failed to reprocess summary: {e}")
        sys.exit(1)


def _patch_summary_date(summary_path: Path, date_value: str) -> bool:
    """Overwrite a .md summary's frontmatter `date:` field in place.

    process-streaming always stamps `date` with "now" -- correct for a
    brand-new recording, wrong for full-reprocess's re-run of an existing
    meeting, since the app displays this date as when the meeting happened.
    Returns whether a `date:` line was actually found and patched."""
    try:
        original = summary_path.read_text(encoding="utf-8")
    except OSError as e:
        logger.warning(f"Could not read {summary_path} to patch date: {e}")
        return False
    escaped = str(date_value).replace('\\', '\\\\').replace('"', '\\"')
    patched, count = re.subn(
        r'^date:.*$', f'date: "{escaped}"', original, count=1, flags=re.MULTILINE,
    )
    if count == 0:
        return False
    tmp_path = summary_path.with_name(summary_path.name + ".tmp")
    tmp_path.write_text(patched, encoding="utf-8")
    tmp_path.replace(summary_path)
    return True


@cli.command(name='full-reprocess')
@click.argument('meeting_stem')
@click.option(
    '--audio-file', 'audio_file_override', default=None,
    help="Use this audio file instead of looking one up by meeting_stem in the recordings dir "
         "(e.g. a manually preserved copy saved under a different name).",
)
def full_reprocess(meeting_stem, audio_file_override):
    """Re-run the FULL pipeline (transcribe + diarize + summarize) for one
    already-processed meeting, from its original source audio.

    A developer/maintenance tool for re-validating a meeting after a pipeline
    code change (e.g. a diarization fix) -- distinct from `reprocess`, which
    only re-runs summarization on an already-saved transcript. Not wired into
    the UI.

    Requires the meeting's original source audio to still be on disk (only
    true when keep_recordings was enabled at record time) -- pass
    --audio-file to point at a manually preserved copy instead. Always backs
    up the existing transcript/summary/speakers sidecar (as `<file>.bak-
    <timestamp>`) before overwriting -- this command's whole purpose is to
    overwrite, but never without a safety copy first.

    Restores the meeting's name, user notes, folder membership, original
    date (process-streaming always stamps "now", which would otherwise make
    an old meeting show up as recorded today), and the `## Participants`
    section (from already-confirmed person profiles) afterward, since
    process-streaming has no knowledge of any of these. Does NOT carry
    forward old per-line transcript speaker relabels -- a
    fresh diarization run assigns new cluster ids, so previously confirmed
    speakers need a fresh `confirm-speaker` pass against the new
    {stem}_speakers.json sidecar to relabel the new transcript.
    """
    import shutil

    from src.config import get_config, get_data_dirs
    from src.folders import get_folders_manager
    from src.speaker_suggestions import confirmed_participant_names

    dirs = get_data_dirs()
    output_dir = dirs["output"]
    recordings_dir = dirs["recordings"]
    transcripts_dir = dirs["transcripts"]

    # Resolve the existing summary (JSON preferred over MD), matching every
    # other stem-keyed lookup in this codebase (_update_summary_participants,
    # list_meetings).
    json_path = output_dir / f"{meeting_stem}_summary.json"
    md_path = output_dir / f"{meeting_stem}_summary.md"
    if json_path.exists():
        summary_path = json_path
        try:
            existing_data = json.loads(json_path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as e:
            print(json.dumps({"success": False, "error": f"Could not read {json_path}: {e}"}))
            sys.exit(1)
    elif md_path.exists():
        summary_path = md_path
        existing_data = _parse_meeting_markdown(md_path)
    else:
        print(json.dumps({"success": False, "error": f"No summary found for meeting {meeting_stem!r}"}))
        sys.exit(1)

    if audio_file_override:
        audio_path = Path(audio_file_override)
        if not audio_path.exists():
            print(json.dumps({"success": False, "error": f"--audio-file not found: {audio_file_override}"}))
            sys.exit(1)
    else:
        audio_path = _find_recording_file(recordings_dir, meeting_stem)
        if audio_path is None:
            print(json.dumps({
                "success": False,
                "error": f"No source audio on disk for {meeting_stem!r} -- keep_recordings must have "
                         "been enabled when it was recorded, or pass --audio-file.",
            }))
            sys.exit(1)

    # Back up every existing file for this stem before anything is touched --
    # process-streaming itself has zero overwrite protection.
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    backed_up = []
    transcript_path = transcripts_dir / f"{meeting_stem}_transcript.txt"
    speakers_path = output_dir / f"{meeting_stem}_speakers.json"
    for existing_path in (summary_path, transcript_path, speakers_path):
        if existing_path.exists():
            backup_path = existing_path.with_name(f"{existing_path.name}.bak-{stamp}")
            shutil.copy2(existing_path, backup_path)
            backed_up.append(str(backup_path))

    # Preserve what process-streaming has no way to know about on its own.
    session_name = existing_data.get('session_info', {}).get('name') or meeting_stem
    notes_text = existing_data.get('user_notes')
    folder_ids = existing_data.get('folders') or []
    original_date = existing_data.get('session_info', {}).get('processed_at') or None
    notes_file = None
    if notes_text:
        notes_file = str(output_dir / f".full_reprocess_notes_{meeting_stem}_{stamp}.txt")
        Path(notes_file).write_text(notes_text, encoding='utf-8')

    try:
        process_streaming.callback(str(audio_path), session_name, notes_file, None, None)
    finally:
        if notes_file:
            try:
                Path(notes_file).unlink()
            except OSError:
                pass

    # process-streaming always writes .md (never .json), regardless of the
    # pre-reprocess format -- the new summary lives here from now on.
    new_summary_path = output_dir / f"{meeting_stem}_summary.md"

    if folder_ids:
        folders_mgr = get_folders_manager()
        for folder_id in folder_ids:
            folders_mgr.add_meeting_to_folder(new_summary_path, folder_id)

    date_preserved = bool(original_date) and _patch_summary_date(new_summary_path, original_date)

    # Restore the Participants section from already-confirmed person
    # profiles -- process-streaming has no knowledge of them, and a fresh
    # run wipes any prior participants section.
    config = get_config()
    participant_names = confirmed_participant_names(meeting_stem, config.get_person_profiles())
    _update_summary_participants(output_dir, meeting_stem, participant_names)

    turn_manifest_entries = 0
    if speakers_path.exists():
        try:
            sidecar_data = json.loads(speakers_path.read_text(encoding='utf-8'))
            turn_manifest_entries = len(sidecar_data.get("transcript_lines") or [])
        except (OSError, ValueError):
            pass

    print(json.dumps({
        "success": True,
        "meeting_stem": meeting_stem,
        "audio_file_used": str(audio_path),
        "backed_up": backed_up,
        "folders_restored": folder_ids,
        "turn_manifest_entries": turn_manifest_entries,
        "participants_restored": participant_names,
        "notes_preserved": bool(notes_text),
        "date_preserved": date_preserved,
        "note": "Previously confirmed per-line speaker labels in the transcript were reset by this "
                "reprocess (new diarization run -> new cluster ids). Re-run confirm-speaker against "
                "the new speakers sidecar to restore them.",
    }))


@cli.command(name='set-active-report')
@click.argument('summary_file')
@click.argument('report_id')
def set_active_report(summary_file, report_id):
    """Persist which report version is shown (report_id 'standard' clears it)."""
    from src import report_store, reports as _reports
    if not Path(summary_file).exists():
        print(json.dumps({"success": False, "error": "Summary file not found"}))
        sys.exit(1)
    sidecar = report_store.load_sidecar(summary_file)
    ok = _reports.set_active(sidecar, report_id)
    if ok:
        report_store.save_sidecar(summary_file, sidecar)
    print(json.dumps({"success": ok} if ok else {"success": False, "error": "Unknown report"}))
    if not ok:
        sys.exit(1)


@cli.command(name='delete-report')
@click.argument('summary_file')
@click.argument('report_id')
def delete_report(summary_file, report_id):
    """Delete a saved report version from a meeting."""
    from src import report_store, reports as _reports
    if not Path(summary_file).exists():
        print(json.dumps({"success": False, "error": "Summary file not found"}))
        sys.exit(1)
    sidecar = report_store.load_sidecar(summary_file)
    ok = _reports.remove_report(sidecar, report_id)
    if ok:
        report_store.save_sidecar(summary_file, sidecar)
    print(json.dumps({"success": ok} if ok else {"success": False, "error": "Unknown report"}))
    if not ok:
        sys.exit(1)


@cli.command(name='generate-report')
@click.argument('summary_file', required=True)
@click.argument('template_id', required=True)
def generate_report(summary_file, template_id):
    """Generate a template-based report and write it to the meeting sidecar."""
    import base64
    from src import report_store, reports as _rpts
    from src.config import get_config

    recorder = MeetingPipeline()
    summary_path = Path(summary_file)

    if not summary_path.exists():
        print(f"ERROR: Summary file not found: {summary_file}")
        sys.exit(1)

    try:
        meeting = report_store.read_meeting(summary_path)
    except Exception as e:
        print(f"ERROR: Failed to load summary file: {e}")
        sys.exit(1)

    # Unknown template → surface as a stream error so the IPC handler (which only
    # watches the streaming protocol) reports failure instead of silent success.
    config = get_config()
    tmpl = config.get_template(template_id)
    if tmpl is None:
        print("STREAM_ERROR:Unknown template", flush=True)
        sys.exit(1)

    transcript = meeting["transcript"]
    if not transcript:
        print("ERROR: No transcript found in summary file")
        sys.exit(1)

    duration_minutes = meeting["duration_minutes"] or 10
    notes_text = meeting["notes"]

    # Resolve output language: template language takes precedence over "auto"
    if tmpl.get("language") and tmpl["language"] != "auto":
        output_language = tmpl["language"]
    else:
        # Trust the meeting's persisted language only when pin-/engine-backed;
        # otherwise re-detect from the transcript so a stale Parakeet auto-mode
        # "en" (#283) doesn't force English reports. read_meeting surfaces the
        # provenance fields (None for markdown, which never stored them).
        persisted_info = {
            "output_language": meeting["language"],
            "configured_language": meeting.get("configured_language"),
            "detected_language": meeting.get("detected_language"),
        }
        output_language = resolve_persisted_output_language(
            persisted_info, transcript, config.get_language()
        )

    if recorder.summarizer is None:
        from src.summarizer import OllamaSummarizer
        recorder.summarizer = OllamaSummarizer()

    print("Generating report...", flush=True)
    streamed_chunks = []
    summary_heartbeat = _start_summary_heartbeat()
    _stream_error = None
    try:
        for chunk in recorder.summarizer.summarize_transcript_streaming(
            transcript, duration_minutes, output_language, notes_text,
            progress_callback=_emit_progress,
            template_prompt=tmpl["prompt"],
        ):
            summary_heartbeat.set()
            encoded = base64.b64encode(chunk.encode('utf-8')).decode('ascii')
            sys.stdout.write(f"CHUNK:{encoded}\n")
            sys.stdout.flush()
            streamed_chunks.append(chunk)
    except Exception as e:
        _stream_error = e
    finally:
        summary_heartbeat.set()

    if _stream_error is not None:
        logger.error(f"Report generation failed: {_stream_error}")
        err_msg = str(_stream_error).replace('\n', ' ').replace('\r', ' ')
        print(f"STREAM_ERROR:{err_msg}", flush=True)
        sys.exit(1)

    streamed_md = _apply_chinese_variant(''.join(streamed_chunks)) or ''

    # Do NOT persist an empty report — surface a stream error instead.
    if not streamed_md.strip():
        print("STREAM_ERROR:Model returned an empty report", flush=True)
        sys.exit(1)

    # Write the sidecar BEFORE emitting STREAM_COMPLETE so the renderer's
    # refetch (triggered by the completion event) never reads stale data.
    sidecar = report_store.load_sidecar(summary_path)
    report = _rpts.make_report(
        template_id, tmpl["name"], recorder.summarizer.model_name, streamed_md
    )
    _rpts.append_report(sidecar, report)
    report_store.save_sidecar(summary_path, sidecar)
    print("STREAM_COMPLETE", flush=True)
    print(f"SAVED:{report_store.sidecar_path(summary_path)}")


@cli.command('regen-title')
@click.argument('summary_file', required=True)
def regen_title(summary_file):
    """Regenerate only the title for an existing meeting."""
    import json
    from pathlib import Path

    recorder = MeetingPipeline()
    summary_path = Path(summary_file)

    if not summary_path.exists():
        print(f"ERROR: Summary file not found: {summary_file}")
        sys.exit(1)

    try:
        if summary_path.suffix == '.md':
            existing_data = _parse_meeting_markdown(summary_path)
        else:
            with open(summary_path, 'r') as f:
                existing_data = json.load(f)

        transcript = existing_data.get('transcript', '')
        summary = existing_data.get('summary', '')
        session_info = existing_data.get('session_info', {})

        if not transcript and not summary:
            print("ERROR: No transcript or summary found in file")
            sys.exit(1)

        # Trust the persisted language only when pin-/engine-backed; otherwise
        # re-detect so a stale Parakeet auto-mode "en" (#283) doesn't force an
        # English title. Fall back to the summary text when there's no
        # transcript (summary is already in the note's language).
        from src.config import get_config
        output_language = resolve_persisted_output_language(
            session_info, transcript or summary, get_config().get_language()
        )

        if recorder.summarizer is None:
            from src.summarizer import OllamaSummarizer
            recorder.summarizer = OllamaSummarizer()

        generated_title = recorder.summarizer.generate_title(summary, transcript, language=output_language)
        generated_title = _apply_chinese_variant(generated_title)
        if not generated_title:
            print("ERROR: Title generation returned empty result")
            sys.exit(1)

        # Update and save
        existing_data['session_info']['name'] = generated_title
        if summary_path.suffix == '.md':
            # Rewrite the title in the YAML front matter only
            text = summary_path.read_text(encoding='utf-8')
            import re
            escaped = generated_title.replace('\\', '\\\\').replace('"', '\\"')
            text = re.sub(r'^title:.*$', f'title: "{escaped}"', text, flags=re.MULTILINE)
            _atomic_write_text(summary_path, text)
        else:
            with open(summary_path, 'w') as f:
                json.dump(existing_data, f, indent=2)

        print(f"TITLE:{generated_title}", flush=True)
        print(f"Title updated: {generated_title}")

    except Exception as e:
        print(f"ERROR: Failed to regenerate title: {e}")
        sys.exit(1)


@cli.command()
@click.argument('transcript_file')
@click.option('--question', '-q', required=True, help='Question to ask about the transcript')
def query(transcript_file, question):
    """Query a transcript with AI."""
    from pathlib import Path

    transcript_path = Path(transcript_file)
    # Collected from the meeting file (if any) so the language resolver can weigh
    # the note's persisted output_language against its provenance (#283). Plain
    # .txt transcripts leave this empty -> pure text-detection / config fallback.
    session_info = {}
    # Language detection must run over the RAW transcript only, not the combined
    # summary+topics+transcript context below: detection samples the first ~8000
    # chars, so a legacy English summary would flip a German meeting to "en"
    # before the transcript is ever reached. Falls back to transcript_text when a
    # note has no separate transcript body.
    detect_text = None

    # Handle summary JSON files (extract transcript from them)
    if transcript_file.endswith('.json'):
        if not transcript_path.exists():
            print(json.dumps({"success": False, "error": f"File not found: {transcript_file}"}))
            return

        try:
            with open(transcript_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                transcript_text = data.get('transcript', '')
                if not transcript_text:
                    print(json.dumps({"success": False, "error": "No transcript found in summary file"}))
                    return
                session_info = data.get("session_info", {})
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Failed to read summary file: {e}"}))
            return
    elif transcript_file.endswith('.md'):
        # Handle markdown summary files — parse sections
        if not transcript_path.exists():
            print(json.dumps({"success": False, "error": f"File not found: {transcript_file}"}))
            return

        try:
            meeting_data = _parse_meeting_markdown(transcript_path)
            raw_transcript = meeting_data.get('transcript', '')
            # Build rich context: summary + key points + transcript
            parts = []
            if meeting_data.get('summary'):
                parts.append(f"SUMMARY:\n{meeting_data['summary']}")
            if meeting_data.get('discussion_areas'):
                topics = '\n'.join(f"- {d['title']}: {d['analysis']}" for d in meeting_data['discussion_areas'])
                parts.append(f"KEY TOPICS:\n{topics}")
            if meeting_data.get('key_points'):
                points = '\n'.join(f"- {p}" for p in meeting_data['key_points'])
                parts.append(f"KEY POINTS:\n{points}")
            if raw_transcript:
                parts.append(f"TRANSCRIPT:\n{raw_transcript}")
            transcript_text = '\n\n'.join(parts)
            detect_text = raw_transcript
            session_info = meeting_data.get("session_info", {})
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Failed to read summary file: {e}"}))
            return
    else:
        # Handle plain text transcript files
        if not transcript_path.exists():
            print(json.dumps({"success": False, "error": f"File not found: {transcript_file}"}))
            return

        try:
            with open(transcript_path, 'r', encoding='utf-8') as f:
                transcript_text = f.read()
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Failed to read transcript: {e}"}))
            return

    if not transcript_text or transcript_text.strip() == "":
        print(json.dumps({"success": False, "error": "Transcript is empty"}))
        return

    # Use the user's configured model for all providers
    try:
        from src.config import get_config
        config = get_config()
        # The note's saved output_language is only a real pin when provenance-
        # backed (a user pin or a Whisper detection). A stale Parakeet auto-mode
        # "en" fallback (#283) must not lock chat to English, so re-detect from
        # the RAW transcript in that case. CLI contract is unchanged: the caller
        # still passes only <file> -q <question>; provenance comes from the note.
        language = resolve_persisted_output_language(
            session_info, detect_text or transcript_text, config.get_language()
        )
        summarizer = OllamaSummarizer()
        answer = summarizer.query_transcript(transcript_text, question, language=language)

        if answer:
            print(json.dumps({"success": True, "answer": answer}))
        else:
            print(json.dumps({"success": False, "error": "Failed to get response from AI"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Query failed: {e}"}))


@cli.command(name='query-streaming')
@click.argument('transcript_file')
@click.option('--question', '-q', required=True, help='Question to ask about the transcript')
def query_streaming(transcript_file, question):
    """Query a transcript with streaming output. Emits CHUNK:base64 lines then STREAM_COMPLETE."""
    import sys
    import base64
    from pathlib import Path

    transcript_path = Path(transcript_file)
    # Collected from the meeting file (if any) so the language resolver can weigh
    # the note's persisted output_language against its provenance (#283). Plain
    # .txt transcripts leave this empty -> pure text-detection / config fallback.
    session_info = {}
    # Detect language over the RAW transcript only (not the combined context
    # below), so a legacy English summary in the first ~8000 chars can't flip a
    # German meeting to "en". Falls back to transcript_text when absent.
    detect_text = None

    if transcript_file.endswith('.json'):
        if not transcript_path.exists():
            print(f"STREAM_ERROR:File not found: {transcript_file}", flush=True)
            return
        try:
            with open(transcript_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                transcript_text = data.get('transcript', '')
                if not transcript_text:
                    print("STREAM_ERROR:No transcript found in summary file", flush=True)
                    return
                session_info = data.get("session_info", {})
        except Exception as e:
            print(f"STREAM_ERROR:Failed to read file: {e}", flush=True)
            return
    elif transcript_file.endswith('.md'):
        if not transcript_path.exists():
            print(f"STREAM_ERROR:File not found: {transcript_file}", flush=True)
            return
        try:
            meeting_data = _parse_meeting_markdown(transcript_path)
            parts = []
            if meeting_data.get('summary'):
                parts.append(f"SUMMARY:\n{meeting_data['summary']}")
            if meeting_data.get('discussion_areas'):
                topics = '\n'.join(f"- {d['title']}: {d['analysis']}" for d in meeting_data['discussion_areas'])
                parts.append(f"KEY TOPICS:\n{topics}")
            if meeting_data.get('key_points'):
                points = '\n'.join(f"- {p}" for p in meeting_data['key_points'])
                parts.append(f"KEY POINTS:\n{points}")
            if meeting_data.get('transcript'):
                parts.append(f"TRANSCRIPT:\n{meeting_data['transcript']}")
            transcript_text = '\n\n'.join(parts)
            detect_text = meeting_data.get('transcript', '')
            session_info = meeting_data.get("session_info", {})
        except Exception as e:
            print(f"STREAM_ERROR:Failed to read file: {e}", flush=True)
            return
    else:
        if not transcript_path.exists():
            print(f"STREAM_ERROR:File not found: {transcript_file}", flush=True)
            return
        try:
            transcript_text = transcript_path.read_text(encoding='utf-8')
        except Exception as e:
            print(f"STREAM_ERROR:Failed to read file: {e}", flush=True)
            return

    from src.config import get_config
    # Provenance-aware: honour the note's saved language only when it was a real
    # pin or a Whisper detection, else re-detect (over the RAW transcript) so a
    # stale Parakeet "en" (#283) doesn't lock chat to English. CLI contract
    # unchanged (<file> -q <question>).
    language = resolve_persisted_output_language(
        session_info, detect_text or transcript_text, get_config().get_language()
    )

    try:
        summarizer = OllamaSummarizer()
        for chunk in summarizer.query_transcript_streaming(transcript_text, question, language=language):
            encoded = base64.b64encode(chunk.encode('utf-8')).decode('ascii')
            sys.stdout.write(f"CHAT_CHUNK:{encoded}\n")
            sys.stdout.flush()
        print("CHAT_STREAM_COMPLETE", flush=True)
    except Exception as e:
        print(f"CHAT_STREAM_ERROR:{e}", flush=True)

MAX_LIVE_QUERY_STDIN_BYTES = 1024 * 1024  # 1 MiB
MAX_LIVE_QUERY_TRANSCRIPT_CHARS = 100_000
MAX_LIVE_QUERY_QUESTION_CHARS = 2_000
MAX_LIVE_QUERY_ANSWER_BYTES = 1024 * 1024  # 1 MiB


@cli.command(name='query-live-streaming')
@click.pass_context
def query_live_streaming(ctx):
    """Answer a question from the finalized live transcript.

    Reads bounded JSON ``{"transcript": "...", "question": "..."}`` from
    stdin and uses the same persisted provider and model as meeting summaries.
    Streams ``CHAT_CHUNK:<base64>`` lines, then ``CHAT_STREAM_COMPLETE`` (or a
    fixed ``CHAT_STREAM_ERROR`` on failure). Transcript and question content
    never enters argv, logs, or error text.
    """
    import sys
    import json
    import base64
    # This subprocess emits a machine protocol only. Provider/config diagnostics
    # stay suppressed so no transcript or question content can reach stderr.
    previous_logging_disable = logging.root.manager.disable
    logging.disable(logging.CRITICAL)
    ctx.call_on_close(lambda: logging.disable(previous_logging_disable))

    try:
        input_stream = getattr(sys.stdin, "buffer", sys.stdin)
        raw_payload = input_stream.read(MAX_LIVE_QUERY_STDIN_BYTES + 1)
        if isinstance(raw_payload, str):
            raw_payload = raw_payload.encode("utf-8")
    except Exception:
        raw_payload = b""

    if not raw_payload or not raw_payload.strip():
        print(
            "CHAT_STREAM_ERROR:Empty live transcript (nothing to query)",
            flush=True,
        )
        sys.exit(1)

    if len(raw_payload) > MAX_LIVE_QUERY_STDIN_BYTES:
        print(
            "CHAT_STREAM_ERROR:Live query payload exceeds maximum length",
            flush=True,
        )
        sys.exit(1)

    try:
        data = json.loads(raw_payload)
    except Exception:
        print(
            "CHAT_STREAM_ERROR:Invalid live query payload",
            flush=True,
        )
        sys.exit(1)

    if not isinstance(data, dict):
        print(
            "CHAT_STREAM_ERROR:Invalid live query payload",
            flush=True,
        )
        sys.exit(1)

    transcript = data.get("transcript")
    question = data.get("question")

    if not isinstance(transcript, str) or not transcript.strip():
        print(
            "CHAT_STREAM_ERROR:Empty live transcript (nothing to query)",
            flush=True,
        )
        sys.exit(1)

    if not isinstance(question, str) or not question.strip():
        print(
            "CHAT_STREAM_ERROR:Empty live query question",
            flush=True,
        )
        sys.exit(1)

    if len(transcript) > MAX_LIVE_QUERY_TRANSCRIPT_CHARS:
        print(
            "CHAT_STREAM_ERROR:Live transcript exceeds maximum length",
            flush=True,
        )
        sys.exit(1)

    if len(question) > MAX_LIVE_QUERY_QUESTION_CHARS:
        print(
            "CHAT_STREAM_ERROR:Live query question exceeds maximum length",
            flush=True,
        )
        sys.exit(1)

    from src.config import get_config

    # Reuse the same language resolution the query prompt uses so the live
    # answer respects the user's language pin / detection like every other path.
    language = resolve_output_language(
        get_config().get_language(), None, transcript.strip()
    )

    try:
        summarizer = OllamaSummarizer()
        total_answer_bytes = 0
        for chunk in summarizer.query_transcript_streaming_strict(
            transcript.strip(), question.strip(), language=language
        ):
            if not isinstance(chunk, str):
                raise TypeError("Live query provider returned a non-text chunk")
            chunk_bytes = chunk.encode('utf-8')
            total_answer_bytes += len(chunk_bytes)
            if total_answer_bytes > MAX_LIVE_QUERY_ANSWER_BYTES:
                raise ValueError("Live query answer exceeded size limit")
            encoded = base64.b64encode(chunk_bytes).decode('ascii')
            sys.stdout.write(f"CHAT_CHUNK:{encoded}\n")
            sys.stdout.flush()
        print("CHAT_STREAM_COMPLETE", flush=True)
    except Exception:
        print("CHAT_STREAM_ERROR:Live query failed", flush=True)
        sys.exit(1)

def _chat_corpus_char_budget(ai_provider: str, model: str) -> int:
    """Char budget for the cross-note chat corpus, sized to the active model.

    Cloud/adapter models have large windows (Anthropic 200k, recent OpenAI
    128k+ tokens), so we use a generous fixed budget. Local/remote Ollama
    windows are smaller, so we derive the budget from the model's num_ctx (the
    same window the summariser requests) — a smaller local model then answers
    over fewer, most-recent notes instead of overflowing. ~3.5 chars/token;
    reserve ~45% of the window for the question, prompt scaffold and reply.
    Pure function so it's unit-testable without notes or a model.
    """
    if ai_provider in ("local", "remote"):
        from src.summarizer import resolve_num_ctx
        return int(resolve_num_ctx(model) * 3.5 * 0.55)
    return 400_000


@cli.command(name='chat-global-streaming')
@click.option('--question', '-q', required=True, help='Question to ask across notes')
@click.option('--folder', '-f', default=None, help='Folder ID to scope the corpus to (default: all notes)')
def chat_global_streaming(question, folder):
    """Cross-note chat: gather meeting title + summary + key points, feed as
    context to the configured LLM, stream the answer. Optionally scope to a
    single folder; default queries every note.

    Works with every provider — cloud / org adapter / local / remote Ollama.
    The assembled corpus is capped to the active model's context window
    (model-aware budget below), so a local model with a smaller window simply
    answers over fewer (most-recent) notes rather than overflowing. We don't
    have retrieval (RAG) yet, so older notes beyond the budget are omitted."""
    import sys
    import base64
    from pathlib import Path
    from src.config import get_config, get_data_dirs

    config = get_config()
    dirs = get_data_dirs()
    output_dir = dirs["output"]

    # Collect every summary file, preferring .md (the new format) but reading
    # legacy .json too so users with old recordings aren't excluded.
    summaries: list[tuple[Path, dict]] = []
    seen = set()
    for f in sorted(output_dir.glob("*_summary.md")):
        try:
            data = _parse_meeting_markdown(f)
            summaries.append((f, data))
            seen.add(f.stem.replace('_summary', ''))
        except Exception:
            # Best-effort listing: a single malformed/legacy note must never
            # break the whole meeting list — skip it and keep scanning.
            continue
    for f in sorted(output_dir.glob("*_summary.json")):
        if f.stem.replace('_summary', '') in seen:
            continue
        try:
            with open(f, 'r', encoding='utf-8') as fh:
                summaries.append((f, json.load(fh)))
        except (OSError, ValueError):
            continue

    # Folder scoping. Each meeting record carries a 'folders' array of IDs;
    # filter to only those that include the requested ID. Empty folder ID
    # or 'all' explicitly means no filter.
    if folder and folder != 'all':
        summaries = [
            (path, data) for (path, data) in summaries
            if isinstance(data.get('folders'), list) and folder in data['folders']
        ]

    if not summaries:
        if folder and folder != 'all':
            print("CHAT_STREAM_ERROR:No notes in this folder yet. Pick another or remove the filter.", flush=True)
        else:
            print("CHAT_STREAM_ERROR:No notes found yet. Record a meeting first.", flush=True)
        return

    # Most-recent first so the model weights newer context higher when token
    # budget is tight. Each block is kept compact (title + summary + key
    # points + action items) — full transcripts would blow even a 200k window.
    def sort_key(item):
        _, data = item
        return data.get("session_info", {}).get("processed_at") or ""

    summaries.sort(key=sort_key, reverse=True)

    # Cap the assembled corpus so a user with hundreds of meetings can't blow
    # past the active model's context window (see _chat_corpus_char_budget).
    CORPUS_CHAR_BUDGET = _chat_corpus_char_budget(
        config.get_ai_provider(), config.get_model()
    )
    blocks = []
    used_chars = 0
    truncated = 0
    for _, data in summaries:
        info = data.get("session_info", {}) or {}
        name = info.get("name") or "Untitled"
        date = (info.get("processed_at") or "")[:10]
        summary = (data.get("summary") or "").strip()
        key_points = data.get("key_points") or []
        action_items = data.get("action_items") or []
        block = [f"## {name}" + (f" — {date}" if date else "")]
        if summary:
            block.append(summary)
        if key_points:
            block.append("Key points:\n" + "\n".join(f"- {p}" for p in key_points))
        if action_items:
            block.append("Action items:\n" + "\n".join(f"- {a}" for a in action_items))
        block_text = "\n".join(block)
        # +5 accounts for the "\n\n---\n\n" separator added later.
        if used_chars + len(block_text) + 5 > CORPUS_CHAR_BUDGET:
            # If the very first block is already larger than the budget,
            # truncate it so we still send something representative rather
            # than blasting the model with an oversized prompt.
            if not blocks:
                budget_left = max(0, CORPUS_CHAR_BUDGET - used_chars - 80)
                if budget_left > 0:
                    truncated_block = block_text[:budget_left].rstrip() + "\n…(truncated)"
                    blocks.append(truncated_block)
                    used_chars += len(truncated_block) + 5
            truncated = len(summaries) - len(blocks)
            break
        blocks.append(block_text)
        used_chars += len(block_text) + 5

    corpus = "\n\n---\n\n".join(blocks)
    if truncated:
        corpus += (
            f"\n\n---\n\n_Note: {truncated} older note(s) omitted to stay within"
            " the model's context window. Ask about a specific older meeting"
            " to pull it in directly._"
        )

    language = config.get_language()
    if language == "auto":
        language = "en"

    try:
        summarizer = OllamaSummarizer()
        for chunk in summarizer.query_transcript_streaming(corpus, question, language=language):
            encoded = base64.b64encode(chunk.encode('utf-8')).decode('ascii')
            sys.stdout.write(f"CHAT_CHUNK:{encoded}\n")
            sys.stdout.flush()
        print("CHAT_STREAM_COMPLETE", flush=True)
    except Exception as e:
        print(f"CHAT_STREAM_ERROR:{e}", flush=True)


@cli.command()
def list_failed():
    """List summary files that failed processing (have fallback summaries)"""
    import json
    from src.config import get_data_dirs, get_config
    dirs = get_data_dirs()
    output_dir = dirs["output"]

    # Collect from current and default locations
    seen_files = set()
    summaries = []
    for f in output_dir.glob("*_summary.json"):
        summaries.append(f)
        seen_files.add(f.resolve())
    custom = get_config().get_storage_path()
    if custom:
        from src.config import is_bundled, get_user_data_dir
        if is_bundled():
            default_output = get_user_data_dir() / "output"
        else:
            default_output = Path(__file__).parent / "output"
        if default_output.exists():
            for f in default_output.glob("*_summary.json"):
                if f.resolve() not in seen_files:
                    summaries.append(f)

    failed_summaries = []
    
    for summary_file in summaries:
        try:
            with open(summary_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                
                # Check for signs of failed processing
                summary_text = data.get("summary", "")
                if (summary_text.startswith("Meeting transcript recorded but detailed analysis failed") or 
                    summary_text.startswith("No transcript was generated") or
                    len(data.get("participants", [])) == 0 and len(data.get("key_points", [])) == 0):
                    failed_summaries.append({
                        "file": str(summary_file),
                        "name": data.get("session_info", {}).get("name", "Unknown"),
                        "processed_at": data.get("session_info", {}).get("processed_at", "Unknown"),
                        "summary": summary_text[:100] + "..." if len(summary_text) > 100 else summary_text
                    })
        except Exception as e:
            continue
    
    if failed_summaries:
        print("🔍 Failed Summaries Found:")
        print("=" * 50)
        for failed in failed_summaries:
            print(f"📁 File: {failed['file']}")
            print(f"📊 Name: {failed['name']}")
            print(f"🕐 Processed: {failed['processed_at']}")
            print(f"📝 Summary: {failed['summary']}")
            print(f"🔄 Reprocess: python simple_recorder.py reprocess \"{failed['file']}\"")
            print("-" * 50)
        print(f"Total failed summaries: {len(failed_summaries)}")
    else:
        print("✅ No failed summaries found - all processing completed successfully!")


@cli.command()
def clear_state():
    """Clear recording state (useful for resetting stuck recordings)"""
    recorder = MeetingPipeline()
    
    if recorder.state_file.exists():
        recorder.state_file.unlink()
        print("SUCCESS: Recording state cleared")
    else:
        print("SUCCESS: No state file found - already clear")


def _run_speaker_model_command(command: str, timeout: int) -> dict:
    """Run a non-audio command on the macOS diarization sidecar.

    The sidecar is the single authority for its FluidAudio cache layout. Keep
    this wrapper deliberately narrow and return only validated JSON so stderr
    from model loaders never crosses the renderer IPC boundary.
    """
    import subprocess
    from src.transcriber import _resolve_steno_diarize

    binary = _resolve_steno_diarize()
    if not binary:
        return {
            "success": False,
            "ready": False,
            "error": "Speaker diarization is unavailable on this system",
        }
    try:
        result = subprocess.run(
            [binary, command],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        logger.warning("Speaker diarization model command could not complete")
        return {
            "success": False,
            "ready": False,
            "error": "Speaker diarization model setup could not complete",
        }

    payload = None
    decoder = json.JSONDecoder()
    # CoreML can write native E5RT diagnostics to stdout without a trailing
    # newline, directly before the sidecar's JSON response. Decode each object
    # start and keep the last complete model-status object. Native libraries
    # may also print teardown diagnostics after the JSON, so neither prefix
    # nor suffix noise is part of the response contract.
    for offset, character in enumerate(result.stdout):
        if character != "{":
            continue
        try:
            candidate, _end = decoder.raw_decode(result.stdout, offset)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(candidate, dict)
            and isinstance(candidate.get("ready"), bool)
            and isinstance(candidate.get("required_models"), list)
            and isinstance(candidate.get("missing_models"), list)
            and isinstance(candidate.get("cache_directory"), str)
        ):
            payload = candidate

    allowed_return_codes = {0, 3} if command == "model-status" else {0}
    if result.returncode not in allowed_return_codes or payload is None:
        logger.warning(
            "Speaker diarization model command failed with exit code %s",
            result.returncode,
        )
        return {
            "success": False,
            "ready": False,
            "error": "Speaker diarization model setup failed",
        }

    return {"success": True, **payload}


@cli.command(name="speaker-model-status")
def speaker_model_status():
    """Report whether the local speaker-diarization models are ready."""
    print(json.dumps(_run_speaker_model_command("model-status", timeout=15)))


@cli.command(name="prepare-speaker-models")
def prepare_speaker_models():
    """Download and compile the macOS speaker-diarization models."""
    payload = _run_speaker_model_command("prepare-models", timeout=60 * 60)
    print(json.dumps(payload))
    if not payload.get("success") or not payload.get("ready"):
        sys.exit(1)


@cli.command()
@click.option('--json', 'as_json', is_flag=True,
              help='Emit a single machine-readable JSON object instead of the human-readable report.')
def setup_check(as_json):
    """Check system setup and dependencies"""
    import subprocess
    import sys
    import os

    if not as_json:
        print("🔧 Steno Setup Check")
        print("=" * 25)

    checks = []
    
    # Check Python version
    try:
        version = sys.version_info
        if version.major >= 3 and version.minor >= 8:
            checks.append(("✅ Python", f"{version.major}.{version.minor}.{version.micro}"))
        else:
            checks.append(("❌ Python", f"{version.major}.{version.minor}.{version.micro} (need 3.8+)"))
    except Exception as e:
        checks.append(("❌ Python", f"Error: {e}"))
    
    # Check required directories - uses centralised get_data_dirs()
    from src.config import get_data_dirs
    base_dirs = get_data_dirs()
    
    for dir_name, dir_path in base_dirs.items():
        if dir_path.exists():
            checks.append((f"✅ {dir_name}/", f"exists at {dir_path}"))
        else:
            dir_path.mkdir(parents=True, exist_ok=True)
            checks.append((f"✅ {dir_name}/", f"created at {dir_path}"))
    
    # Check Ollama - use bundled or system Ollama
    try:
        from src.ollama_manager import get_ollama_binary
        ollama_path = get_ollama_binary()
        if ollama_path:
            if 'bin/ollama' in str(ollama_path) or '_internal/ollama' in str(ollama_path):
                checks.append(("✅ Ollama", "bundled"))
            else:
                checks.append(("✅ Ollama", f"found at {ollama_path}"))
        else:
            checks.append(("❌ Ollama", "not found"))
    except Exception as e:
        checks.append(("❌ Ollama", f"Error: {e}"))
    
    # Check ffmpeg (bundled locations first, then system)
    try:
        ffmpeg_found = False
        possible_ffmpeg_paths = []
        ffmpeg_exe_suffix = ".exe" if sys.platform == "win32" else ""
        ffmpeg_binary = f"ffmpeg{ffmpeg_exe_suffix}"

        # Check bundled ffmpeg (PyInstaller bundle)
        if getattr(sys, 'frozen', False):
            exe_dir = Path(sys.executable).parent
            for candidate in [
                exe_dir / ffmpeg_binary,                # bundle root (stenoai.spec places it at '.')
                exe_dir / '_internal' / ffmpeg_binary,  # _internal subdirectory
            ]:
                if candidate.exists():
                    possible_ffmpeg_paths.append(('bundled', str(candidate)))

        possible_ffmpeg_paths.append((None, 'ffmpeg'))  # PATH (Windows resolves via PATHEXT)
        if sys.platform != "win32":
            possible_ffmpeg_paths.extend([
                (None, '/opt/homebrew/bin/ffmpeg'),     # Homebrew Apple Silicon
                (None, '/usr/local/bin/ffmpeg'),        # Homebrew Intel
                (None, '/usr/bin/ffmpeg'),              # System
            ])

        for label, path in possible_ffmpeg_paths:
            try:
                result = subprocess.run([path, '-version'],
                                      capture_output=True, timeout=5)
                if result.returncode == 0:
                    checks.append(("✅ ffmpeg", label or f"found at {path}"))
                    ffmpeg_found = True
                    break
            except (subprocess.TimeoutExpired, FileNotFoundError):
                continue

        if not ffmpeg_found:
            install_hint = (
                "winget install Gyan.FFmpeg" if sys.platform == "win32"
                else "brew install ffmpeg"
            )
            checks.append(("❌ ffmpeg", f"not found - run: {install_hint}"))
    except Exception as e:
        checks.append(("❌ ffmpeg", f"Error: {e}"))

    # Acoustic speaker diarization ships only on macOS. Its model-status
    # command is read-only: a missing cache routes the user through onboarding
    # instead of silently downloading models during their first meeting.
    if sys.platform == "darwin":
        speaker_models = _run_speaker_model_command("model-status", timeout=15)
        if speaker_models.get("success") and speaker_models.get("ready"):
            checks.append(("✅ speaker-diarization-model", "ready"))
        elif speaker_models.get("success"):
            checks.append(("⚠️ speaker-diarization-model", "not installed (optional)"))
        else:
            checks.append(("⚠️ speaker-diarization-model", "unavailable (optional)"))
    
    # Skip Ollama model check during setup - service starts automatically when needed
    # Just verify Ollama binary is installed
    # The model will be downloaded during setup if needed
    
    # Check Python dependencies
    try:
        import sounddevice
        checks.append(("✅ sounddevice", "audio recording"))
    except ImportError:
        checks.append(("❌ sounddevice", "pip install sounddevice"))
    
    # Check for whisper backend (prefer pywhispercpp, fallback to openai-whisper)
    whisper_found = False
    try:
        import pywhispercpp
        checks.append(("✅ whisper", "pywhispercpp (fast)"))
        whisper_found = True
    except ImportError:
        pass

    if not whisper_found:
        try:
            import whisper
            checks.append(("✅ whisper", "openai-whisper"))
            whisper_found = True
        except ImportError:
            pass

    if not whisper_found:
        checks.append(("❌ whisper", "pip install pywhispercpp"))
    
    try:
        import ollama
        checks.append(("✅ ollama-python", "LLM client"))
    except ImportError:
        checks.append(("❌ ollama-python", "pip install ollama"))

    # Check if whisper model is downloaded. pywhispercpp uses platformdirs, so
    # the cache dir varies per OS — check the canonical location for each.
    whisper_candidates = [
        Path.home() / "Library" / "Application Support" / "pywhispercpp" / "models",
        Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "pywhispercpp" / "models",
        Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))) / "pywhispercpp" / "models",
    ]
    whisper_models = []
    for whisper_model_path in whisper_candidates:
        if whisper_model_path.exists():
            whisper_models = list(whisper_model_path.glob("ggml-*.bin"))
            if whisper_models:
                break
    if whisper_models:
        model_name = whisper_models[0].stem.replace("ggml-", "")
        checks.append(("✅ whisper-model", f"{model_name} downloaded"))
    else:
        checks.append(("⚠️ whisper-model", "will download on first use (~500MB)"))

    # Check if LLM model is downloaded (check ~/.ollama/models/)
    ollama_models_path = Path.home() / ".ollama" / "models" / "manifests" / "registry.ollama.ai" / "library"
    if ollama_models_path.exists() and any(ollama_models_path.iterdir()):
        model_names = [d.name for d in ollama_models_path.iterdir() if d.is_dir()]
        checks.append(("✅ llm-model", ", ".join(model_names[:2])))
    else:
        checks.append(("❌ llm-model", "no model installed - needed for summaries"))

    # Derive a structured, machine-readable view of the checks. This is the
    # single source of truth for each check's (name, status, detail) and for the
    # overall verdict; both the JSON output and the human summary below read from
    # it, so the pass/fail logic is never duplicated. Status is decoded from the
    # emoji the check-building code above attached to each label:
    #   ✅ -> pass (ok),  ⚠️ -> warn (ok),  ❌ -> fail (not ok).
    structured = []
    all_good = True
    for label, detail in checks:
        if label.startswith("❌"):
            status, ok = "fail", False
            all_good = False
        elif label.startswith("⚠"):
            status, ok = "warn", True
        else:
            status, ok = "pass", True
        # Strip the leading status emoji to get the bare check name.
        name = label.split(" ", 1)[1] if " " in label else label
        structured.append({"name": name, "ok": ok, "status": status, "detail": detail})

    if as_json:
        print(json.dumps({"allGood": all_good, "checks": structured}))
        return {"success": all_good, "checks": checks}

    # Human-readable summary
    for label, detail in checks:
        print(f"{label:<20} {detail}")

    print("\n" + "=" * 25)
    if all_good:
        print("🎉 System check passed! Ready to record meetings.")
    else:
        print("⚠️ Setup incomplete. Please install missing dependencies.")

    return {"success": all_good, "checks": checks}


@cli.command()
def list_models():
    """List all supported models with metadata"""
    from src.config import get_config

    config = get_config()
    provider = config.get_ai_provider()
    current_model = config.get_model()

    if provider == "remote":
        remote_url = config.get_remote_ollama_url()
        if not remote_url:
            result = {
                "current_model": current_model,
                "supported_models": {},
                "provider": "remote",
                "error": "No remote Ollama URL configured"
            }
            print(json.dumps(result, indent=2))
            return

        try:
            import ollama as ollama_pkg
            client = ollama_pkg.Client(host=remote_url)
            response = client.list()
            raw_models = getattr(response, 'models', []) or []
            models = {}
            for m in raw_models:
                name = getattr(m, 'model', '')
                if not name:
                    continue
                # Extract human-readable size
                size_bytes = getattr(m, 'size', 0) or 0
                if size_bytes >= 1_000_000_000:
                    size_str = f"{size_bytes / 1_000_000_000:.1f}GB"
                elif size_bytes >= 1_000_000:
                    size_str = f"{size_bytes / 1_000_000:.0f}MB"
                else:
                    size_str = f"{size_bytes}B"

                # Extract details string
                details = getattr(m, 'details', None)
                detail_parts = []
                if details:
                    family = getattr(details, 'family', '') or ''
                    param_size = getattr(details, 'parameter_size', '') or ''
                    quant = getattr(details, 'quantization_level', '') or ''
                    if family:
                        detail_parts.append(family)
                    if param_size:
                        detail_parts.append(param_size)
                    if quant:
                        detail_parts.append(quant)

                models[name] = {
                    "size": size_str,
                    "description": " / ".join(detail_parts) if detail_parts else "",
                    "installed": True
                }

            result = {
                "current_model": current_model,
                "supported_models": models,
                "provider": "remote"
            }
        except Exception as e:
            error_msg = "Could not connect to remote Ollama server"
            if "Connection refused" in str(e) or "ConnectError" in str(e):
                error_msg = "Remote Ollama server is not reachable"
            elif "timed out" in str(e).lower() or "Timeout" in str(e):
                error_msg = "Remote Ollama server timed out"
            result = {
                "current_model": current_model,
                "supported_models": {},
                "provider": "remote",
                "error": error_msg
            }
    else:
        # Per-entry dicts must be copied, not mutated in place: list_supported_models()
        # returns a shallow copy whose nested dicts are the SAME objects as
        # Config.SUPPORTED_MODELS. Mutating them directly would leak 'installed' /
        # 'mlx_tag' / 'mlx_installed' into the class-level dict, contaminating any
        # later call within the same process (e.g. repeated invocations in tests).
        models = {model_id: dict(info) for model_id, info in config.list_supported_models().items()}
        try:
            import ollama as ollama_pkg
            installed_names = {getattr(m, 'model', '') for m in (getattr(ollama_pkg.list(), 'models', []) or [])}
        except Exception:
            # Best-effort: Ollama may be absent, not running, or unreachable
            # (import or HTTP/connection errors) — treat nothing as installed
            # rather than failing the model-status listing.
            installed_names = set()
        from src.config import is_apple_silicon, Config
        apple_silicon = provider == "local" and is_apple_silicon()
        for model_id, info in models.items():
            # Match exactly, or where Ollama appended extra detail after the tag
            # e.g. "deepseek-r1:14b" matches "deepseek-r1:14b-qwen-distill-q4_K_M"
            gguf_installed = any(
                name == model_id or name.startswith(model_id + '-')
                for name in installed_names
            )
            # Kept distinct from 'installed' below: a model pulled straight to
            # its NVFP4 tag (general "Select" resolves to that on Apple
            # Silicon) never has the GGUF blob itself in Ollama, so callers
            # that need to know "is the GGUF id actually there" (e.g. the
            # Settings delete-to-free-space action, which must not try to
            # delete a tag that was never pulled) can't rely on 'installed'
            # alone once it's true-via-NVFP4-fallback.
            info['gguf_installed'] = gguf_installed
            info['installed'] = gguf_installed
            if apple_silicon:
                mlx_tag = Config._MLX_EQUIVALENTS.get(model_id)
                if mlx_tag:
                    info['mlx_tag'] = mlx_tag
                    mlx_size = Config._MLX_SIZES.get(mlx_tag)
                    if mlx_size:
                        info['mlx_size'] = mlx_size
                    info['mlx_installed'] = any(
                        name == mlx_tag or name.startswith(mlx_tag + '-')
                        for name in installed_names
                    )
                    # Fully usable even though the GGUF id itself was never
                    # downloaded -- report it installed rather than leaving
                    # "Select" re-offered.
                    if info['mlx_installed']:
                        info['installed'] = True
        result = {
            "current_model": current_model,
            "supported_models": models,
            # The actual configured provider ('local', 'cloud', 'adapter').
            # This used to be hardcoded "local", which made debug logs claim
            # a local provider while summaries went through the org adapter.
            "provider": provider
        }

    print(json.dumps(result, indent=2))


@cli.command()
def get_model():
    """Get the currently configured model"""
    from src.config import get_config

    config = get_config()
    current_model = config.get_model()
    model_info = config.get_model_info(current_model)

    result = {
        "model": current_model,
        "info": model_info
    }

    print(json.dumps(result, indent=2))


@cli.command()
@click.argument('model_name')
def set_model(model_name):
    """Set the preferred model for summarization"""
    from src.config import get_config

    config = get_config()

    # Validate model
    if model_name not in config.SUPPORTED_MODELS:
        print(f"WARNING: Model '{model_name}' is not in the recommended list.")
        print(f"Supported models: {', '.join(config.SUPPORTED_MODELS.keys())}")
        print(f"Setting anyway (make sure it's installed with 'ollama pull {model_name}')")

    success = config.set_model(model_name)

    if success:
        print(f"SUCCESS: Model set to {model_name}")
        print(json.dumps({"success": True, "model": model_name}))
    else:
        print(f"ERROR: Failed to save model configuration")
        print(json.dumps({"success": False, "error": "Failed to save config"}))
        # Exit non-zero so callers (e.g. the setup-ollama-and-model reuse path in
        # main.js) can't read a config-write failure as success — the model was
        # NOT persisted as active. sys.exit (not bare exit) for the PyInstaller bundle.
        sys.exit(1)


@cli.command(name='list-templates')
def list_templates():
    """List all report templates (built-in + custom) and the default id."""
    from src.config import get_config
    config = get_config()
    print(json.dumps({
        "templates": config.get_templates(),
        "default_template_id": config.get_default_template_id(),
    }))


@cli.command(name='save-template')
@click.argument('template_json')
def save_template(template_json):
    """Create or update a template from a JSON object."""
    from src.config import get_config
    try:
        payload = json.loads(template_json)
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"Invalid JSON: {e}"}))
        sys.exit(1)
    ok, err, saved = get_config().save_template(payload)
    # Exit 0 regardless: the JSON on stdout IS the result. The IPC handler parses
    # it directly; non-zero exit would cause runPythonScript to reject and throw
    # away the structured error message (returning raw stderr instead).
    print(json.dumps({"success": ok, "template": saved} if ok
                     else {"success": False, "error": err}))


@cli.command(name='delete-template')
@click.argument('template_id')
def delete_template(template_id):
    """Delete a custom template by id."""
    from src.config import get_config
    ok = get_config().delete_template(template_id)
    print(json.dumps({"success": ok}))
    if not ok:
        sys.exit(1)


@cli.command(name='set-default-template')
@click.argument('template_id')
def set_default_template(template_id):
    """Set the default template used for auto-generation."""
    from src.config import get_config
    ok = get_config().set_default_template(template_id)
    print(json.dumps({"success": ok} if ok
                     else {"success": False, "error": "Failed to save config"}))
    if not ok:
        sys.exit(1)


@cli.command(name='reset-template')
@click.argument('template_id')
def reset_template(template_id):
    """Reset a built-in template to its shipped default (drops the override)."""
    from src.config import get_config
    ok = get_config().reset_template(template_id)
    print(json.dumps({"success": ok}))
    if not ok:
        sys.exit(1)


@cli.command(name='enroll-voiceprint')
@click.argument('name')
@click.argument('audio_file')
@click.option('--self', 'is_self', is_flag=True, default=False,
              help='Enroll as the device owner\'s own voice (matched to "You" on the mic channel).')
def enroll_voiceprint(name, audio_file, is_self):
    """Extract a voiceprint embedding from an audio clip and save it under NAME.

    Runs the real steno-diarize sidecar on the clip — the same embedding
    extraction pipeline used for actual meetings (FluidAudio's WeSpeaker
    model, overlap-excluded and averaged across chunks — see
    diarize-sidecar/Sources/main.swift) — rather than a separate ad-hoc
    embedding path, so enrollment-time and match-time embeddings are
    directly comparable. A clean solo clip should diarize as effectively
    one speaker; whichever speaker has the most total speaking time is
    used. Testing surface for the voiceprint-identification feature before
    any Settings/renderer UI exists — mirrors the existing template CLI
    commands (list/save/delete) in shape.
    """
    from src.config import get_config
    from src.transcriber import STENO_DIARIZE_TIMEOUT_FLOOR_S, _run_steno_diarize

    audio_path = Path(audio_file)
    if not audio_path.exists():
        print(json.dumps({"success": False, "error": f"Audio file not found: {audio_file}"}))
        sys.exit(1)

    result = _run_steno_diarize(audio_path, STENO_DIARIZE_TIMEOUT_FLOOR_S, extra_env=_DIARIZE_BULK_ENV)
    if not result:
        print(json.dumps({"success": False, "error": "Diarization/embedding failed (see logs)"}))
        sys.exit(1)
    segments, embeddings = result
    if not embeddings:
        print(json.dumps({"success": False, "error": "No voiceprint embedding extracted from clip"}))
        sys.exit(1)

    totals: dict = {}
    for seg in segments:
        totals[seg["speaker"]] = totals.get(seg["speaker"], 0.0) + (seg["end"] - seg["start"])
    candidates = [sid for sid in totals if sid in embeddings]
    if not candidates:
        print(json.dumps({"success": False, "error": "No embedded speaker found in clip"}))
        sys.exit(1)
    dominant = max(candidates, key=lambda sid: totals[sid])

    saved = get_config().save_voiceprint(
        name, embeddings[dominant], is_self=is_self, duration=totals[dominant],
    )
    if saved is None:
        print(json.dumps({"success": False, "error": "Could not save the voice profile."}))
        sys.exit(1)
    print(json.dumps({
        "success": True,
        "name": saved["name"],
        "centroid_sample_count": saved["centroid_sample_count"],
        "is_self": saved["is_self"],
    }))


@cli.command(name='enroll-self-from-person')
@click.argument('person')
def enroll_self_from_person(person):
    """Build the self ("You") voiceprint from an already-confirmed
    PersonProfile's evidence, instead of a fresh audio clip.

    The named-person store (PersonProfile/SpeakerPrototype, see
    src.config.add_speaker_prototype) and the self voiceprint
    (Config.save_voiceprint, is_self=True) are two separate systems --
    someone who confirmed themselves as a named person via confirm-speaker
    (e.g. because they were a guest in someone else's recording before
    becoming the device owner, or just used "New person" for themselves)
    had no way to power self-matching from that evidence. This bridges
    them: PERSON's positive prototypes (never hard_negatives) are fed
    through the existing save_voiceprint running-centroid + recent-samples
    machinery unchanged -- same math enroll-voiceprint uses, just sourced
    from whole-meeting, overlap-excluded, multi-chunk-averaged embeddings
    already sitting in the profile instead of a fresh solo clip.

    PERSON is a person_id or, failing that, a case/whitespace-insensitive
    display name (same resolution order as confirm-speaker's --person-id,
    but as a single positional argument since there's no --new-person
    ambiguity to guard against here).

    Prefers mic-channel prototypes -- self-match only ever runs on the mic
    channel (src.transcriber._apply_voiceprint_matches), so mic evidence is
    what the resulting voiceprint will actually be compared against. Falls
    back to every positive prototype if the person has none on mic.
    Prototypes are applied oldest-first so centroid_sample_count and the
    recent-samples FIFO end up exactly as if each had been confirmed via
    enroll-voiceprint in that original order.
    """
    from src.config import get_config
    from src.speaker_suggestions import prototype_channel_matches

    config = get_config()
    profiles = config.get_person_profiles()
    profile = next((p for p in profiles if p.get("person_id") == person), None)
    if profile is None:
        normalized = person.strip().casefold()
        matches = [p for p in profiles if (p.get("display_name") or "").strip().casefold() == normalized]
        if len(matches) == 1:
            profile = matches[0]
        elif len(matches) > 1:
            print(json.dumps({
                "success": False,
                "error": f"Multiple people named {person!r} -- use their person_id instead",
            }))
            sys.exit(1)
    if profile is None:
        print(json.dumps({"success": False, "error": f"No person found matching {person!r}"}))
        sys.exit(1)

    prototypes = profile.get("prototypes") or []
    mic_prototypes = [p for p in prototypes if prototype_channel_matches(p, "mic", "in_person")]
    mic_only = bool(mic_prototypes)
    pool = mic_prototypes if mic_only else prototypes
    if not pool:
        print(json.dumps({
            "success": False,
            "error": f"{profile['display_name']!r} has no confirmed prototypes to enroll from",
        }))
        sys.exit(1)

    pool = sorted(pool, key=lambda p: p.get("created_at") or 0)
    saved = None
    for prototype in pool:
        saved = config.save_voiceprint(
            profile["display_name"], prototype["embedding_mean"], is_self=True,
            duration=prototype.get("speech_duration_seconds"),
        )
        if saved is None:
            print(json.dumps({
                "success": False,
                "error": "Could not save the self voice profile.",
            }))
            sys.exit(1)

    print(json.dumps({
        "success": True,
        "name": saved["name"],
        "prototypes_used": len(pool),
        "mic_only": mic_only,
        "centroid_sample_count": saved["centroid_sample_count"],
    }))


@cli.command(name='list-voiceprints')
def list_voiceprints():
    """List stored voiceprints (name, centroid sample count, recent-sample
    count, self-flag) — never prints the raw embedding vectors."""
    from src.config import get_config
    voiceprints = get_config().get_voiceprints()
    print(json.dumps({
        "voiceprints": [
            {
                "name": v.get("name"),
                "centroid_sample_count": v.get("centroid_sample_count", 0),
                "recent_sample_count": len(v.get("embeddings") or []),
                "updated_at": v.get("updated_at"),
                "is_self": v.get("is_self", False),
            }
            for v in voiceprints
        ],
    }))


@cli.command(name='delete-voiceprint')
@click.argument('name')
def delete_voiceprint(name):
    """Delete a stored voiceprint by name."""
    from src.config import get_config
    ok = get_config().delete_voiceprint(name)
    print(json.dumps({"success": ok}))
    if not ok:
        sys.exit(1)


@cli.command(name='list-person-profiles')
def list_person_profiles():
    """List named (non-self) person profiles: display name, prototype/
    hard-negative counts per recording_type — never prints raw embeddings.
    Testing surface for the human-confirmed speaker-suggestion feature
    (see src.speaker_suggestions) before any approval UI exists — mirrors
    the existing template/voiceprint CLI commands in shape."""
    from src.config import get_config, get_data_dirs
    profiles = get_config().get_person_profiles()
    dirs = get_data_dirs()
    sample_lookup_cache = {"sidecars": {}, "clusters": {}, "recordings": {}}

    def _counts_by_context(entries):
        counts: dict = {}
        for e in entries:
            rt = e.get("recording_type", "unknown")
            counts[rt] = counts.get(rt, 0) + 1
        return counts

    print(json.dumps({
        "person_profiles": [
            {
                "person_id": p.get("person_id"),
                "display_name": p.get("display_name"),
                "prototype_counts": _counts_by_context(p.get("prototypes") or []),
                "hard_negative_counts": _counts_by_context(p.get("hard_negatives") or []),
                "sample_available": _resolve_person_sample(
                    p, dirs, lookup_cache=sample_lookup_cache,
                ) is not None,
                "updated_at": p.get("updated_at"),
            }
            for p in profiles
        ],
    }))


def _resolve_person_sample(
    profile: dict,
    dirs: dict,
    *,
    lookup_cache: Optional[dict] = None,
) -> Optional[dict]:
    """Return the best currently playable positive prototype for a person.

    The returned provenance stays inside Python. Renderer-facing profile
    listings expose only whether a sample is available, and the playback
    command resolves this again at click time so a deleted recording or a
    replaced diarization run cannot be played through stale UI state.
    """
    from src.speaker_suggestions import (
        clusters_from_sidecar_channel,
        merge_same_channel_fragments,
        prototype_run_matches,
        read_speakers_sidecar,
    )

    if not isinstance(profile, dict):
        return None

    cache = lookup_cache if isinstance(lookup_cache, dict) else {}
    sidecar_cache = cache.setdefault("sidecars", {})
    cluster_cache = cache.setdefault("clusters", {})
    recording_cache = cache.setdefault("recordings", {})

    prototypes = profile.get("prototypes") or []
    if not isinstance(prototypes, list):
        return None

    candidates = []
    for prototype in prototypes:
        if not isinstance(prototype, dict):
            continue
        meeting_id = prototype.get("meeting_id")
        channel = prototype.get("channel")
        speaker_id = prototype.get("diarization_speaker_id")
        if not all(isinstance(value, str) and value for value in (meeting_id, channel, speaker_id)):
            continue

        if meeting_id not in sidecar_cache:
            try:
                sidecar_cache[meeting_id] = read_speakers_sidecar(
                    Path(dirs["output"]), meeting_id,
                )
            except ValueError:
                sidecar_cache[meeting_id] = None
        sidecar = sidecar_cache[meeting_id]
        if not isinstance(sidecar, dict):
            continue
        diarization_run = sidecar.get("diarization_run") or {}
        if not isinstance(diarization_run, dict):
            continue
        sidecar_run_id = diarization_run.get("run_id")
        if not prototype_run_matches(prototype, sidecar_run_id):
            continue

        channels = sidecar.get("channels") or {}
        if not isinstance(channels, dict):
            continue
        channel_data = channels.get(channel)
        if not isinstance(channel_data, dict):
            continue
        cluster_key = (meeting_id, channel)
        if cluster_key not in cluster_cache:
            raw_clusters_by_id = channel_data.get("clusters") or {}
            resolved = None
            if isinstance(raw_clusters_by_id, dict):
                valid_clusters = {
                    sid: cluster
                    for sid, cluster in raw_clusters_by_id.items()
                    if isinstance(sid, str)
                    and isinstance(cluster, dict)
                    and isinstance(cluster.get("embedding"), list)
                    and bool(cluster["embedding"])
                    and all(
                        isinstance(value, (int, float))
                        for value in cluster["embedding"]
                    )
                }
                try:
                    raw_clusters = clusters_from_sidecar_channel(
                        meeting_id,
                        {**channel_data, "clusters": valid_clusters},
                    )
                    clusters, id_resolution = merge_same_channel_fragments(raw_clusters)
                    resolved = (raw_clusters_by_id, clusters, id_resolution)
                except (IndexError, KeyError, TypeError, ValueError, ZeroDivisionError):
                    pass
            cluster_cache[cluster_key] = resolved

        cluster_resolution = cluster_cache[cluster_key]
        if cluster_resolution is None:
            continue
        raw_clusters_by_id, clusters, id_resolution = cluster_resolution
        resolved_id = id_resolution.get(speaker_id)
        if resolved_id not in clusters:
            continue
        context = clusters[resolved_id][1]

        pooled_segments = [
            segment
            for fragment_id in [resolved_id, *context.merged_from]
            for segment in (raw_clusters_by_id.get(fragment_id, {}).get("segments") or [])
            if isinstance(segment, dict)
            and isinstance(segment.get("start"), (int, float))
            and isinstance(segment.get("end"), (int, float))
            and segment["end"] > segment["start"]
        ]
        if not pooled_segments:
            continue

        if meeting_id not in recording_cache:
            recording_cache[meeting_id] = _find_recording_file(
                Path(dirs["recordings"]), meeting_id,
            )
        recording_path = recording_cache[meeting_id]
        if recording_path is None:
            continue

        def _number(value) -> float:
            try:
                return float(value)
            except (TypeError, ValueError):
                return 0.0

        candidates.append({
            "meeting_id": meeting_id,
            "channel": channel,
            "diarization_speaker_id": speaker_id,
            "recording_path": recording_path,
            "pooled_segments": pooled_segments,
            "quality_score": _number(prototype.get("quality_score")),
            "created_at": _number(prototype.get("created_at")),
        })

    if not candidates:
        return None
    return min(
        candidates,
        key=lambda candidate: (
            -candidate["quality_score"],
            -candidate["created_at"],
            candidate["meeting_id"],
            candidate["channel"],
            candidate["diarization_speaker_id"],
        ),
    )


@cli.command(name="get-person-sample-audio")
@click.argument("person_id")
def get_person_sample_audio(person_id):
    """Return one representative, currently playable clip for a person.

    Profile provenance stays private to the backend. Missing people, stale
    sidecars, removed recordings, and extraction failures intentionally share
    one fixed response so local meeting and filesystem details cannot leak to
    the renderer through an error message.
    """
    import base64
    import tempfile

    from src.config import get_config, get_data_dirs
    from src.speaker_suggestions import extract_speaker_sample_audio

    profile = get_config().get_person_profile(person_id)
    sample = _resolve_person_sample(profile, get_data_dirs()) if profile else None
    if sample is None:
        print(json.dumps({"success": False, "error": "voice sample unavailable"}))
        return

    output_path = (
        Path(tempfile.gettempdir())
        / f"steno_person_sample_{os.getpid()}_{time.time_ns()}.wav"
    )
    try:
        ok = extract_speaker_sample_audio(
            sample["recording_path"],
            sample["channel"],
            sample["pooled_segments"],
            output_path,
        )
        if not ok:
            print(json.dumps({"success": False, "error": "voice sample unavailable"}))
            return
        audio_bytes = output_path.read_bytes()
        print(json.dumps({
            "success": True,
            "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
        }))
    except (OSError, ValueError):
        print(json.dumps({"success": False, "error": "voice sample unavailable"}))
    finally:
        output_path.unlink(missing_ok=True)


@cli.command(name='create-person-profile')
@click.argument('display_name')
def create_person_profile(display_name):
    """Create a new, empty named person profile."""
    from src.config import get_config
    config = get_config()
    if not config.begin_transaction():
        print(json.dumps({
            "success": False,
            "error": "Could not lock the person profile store.",
        }))
        sys.exit(1)
    try:
        profile = config.create_person_profile(display_name)
    except ValueError as e:
        config.rollback_transaction()
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
    if not config.commit_transaction():
        print(json.dumps({
            "success": False,
            "error": "Could not save the person profile.",
        }))
        sys.exit(1)
    print(json.dumps({"success": True, "person_id": profile["person_id"], "display_name": profile["display_name"]}))


def _refresh_participants_for_person(config, output_dir, person) -> None:
    """Recompute+rewrite the Participants list in every meeting summary
    `person` has a confirmed prototype in -- called after a rename (so a
    typo fix doesn't leave a stale old name behind) or a delete (the
    person naturally drops out since get_person_profiles() no longer
    includes them). `person` must be captured BEFORE the rename/delete
    (its prototypes are the only record of which meetings it touched)."""
    from src.speaker_suggestions import confirmed_participant_names

    if not person:
        return
    meeting_ids = sorted({
        p.get("meeting_id") for p in (person.get("prototypes") or []) if p.get("meeting_id")
    })
    if not meeting_ids:
        return
    profiles = config.get_person_profiles()
    for meeting_id in meeting_ids:
        _update_summary_participants(output_dir, meeting_id, confirmed_participant_names(meeting_id, profiles))


@cli.command(name='rename-person-profile')
@click.argument('person_id')
@click.argument('display_name')
def rename_person_profile(person_id, display_name):
    """Rename an existing person profile, and refresh the Participants
    list in every meeting summary this person was confirmed in."""
    from src.config import get_config, get_data_dirs
    config = get_config()
    person_before = config.get_person_profile(person_id)
    try:
        ok = config.rename_person_profile(person_id, display_name)
    except ValueError as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
    if ok:
        _refresh_participants_for_person(config, get_data_dirs()["output"], person_before)
    print(json.dumps({"success": ok}))
    if not ok:
        sys.exit(1)


@cli.command(name='delete-person-profile')
@click.argument('person_id')
def delete_person_profile(person_id):
    """Delete a person profile and all its prototypes/hard-negatives, and
    refresh the Participants list in every meeting summary this person was
    confirmed in (they simply no longer appear)."""
    from src.config import get_config, get_data_dirs
    config = get_config()
    person_before = config.get_person_profile(person_id)
    ok = config.delete_person_profile(person_id)
    if ok:
        _refresh_participants_for_person(config, get_data_dirs()["output"], person_before)
    print(json.dumps({"success": ok}))
    if not ok:
        sys.exit(1)


@cli.command(name='confirm-speaker')
@click.argument('meeting_stem')
@click.argument('channel')
@click.argument('diarization_speaker_id')
@click.option('--person-id', default=None, help="Confirm as this existing known person.")
@click.option('--new-person', default=None, help="Confirm as a brand-new person with this display name.")
@click.option('--expected-run-id', default=None, help="Reject the change if diarization was replaced.")
@click.option(
    '--relabel-transcript', is_flag=True, default=False,
    help="Also rewrite this speaker's turns in the meeting's saved transcript with their real name.",
)
def confirm_speaker(
    meeting_stem,
    channel,
    diarization_speaker_id,
    person_id,
    new_person,
    expected_run_id,
    relabel_transcript,
):
    """Confirm one diarized cluster as a real person.

    Creates the person's first SpeakerPrototype (or adds another if they
    already have some) from the cluster's embedding in the
    `{meeting_stem}_speakers.json` sidecar. For every OTHER speaker already
    confirmed in this same meeting+channel, records MUTUAL hard-negative
    evidence between them -- confirming speakers one at a time (as a human
    naturally would) still builds the full hard-negative graph once all of
    a meeting's speakers are confirmed, no batch call needed.

    Exactly one of --person-id/--new-person is required -- two explicit
    modes rather than one fuzzy name-lookup, so a typo can never silently
    create a duplicate person instead of matching an existing one.

    Re-confirming a cluster REASSIGNS it: any previous confirmation of the
    same cluster (same meeting+channel, including merged fragments) is
    removed first -- the stale person loses that positive prototype and the
    hard negatives the wrongful confirm created, and the new prototype is
    recorded as created_from="user_corrected". Re-confirming the same
    person replaces their prototype instead of duplicating it.

    By default does NOT touch the meeting's saved transcript -- this keeps
    the plain CLI/backfill-validation workflow's existing behavior
    unchanged. Pass --relabel-transcript (what the approval UI always
    does) to also rewrite this speaker's turns with their real name, via
    timestamp-overlap matching against the sidecar's stored segments (see
    src.speaker_suggestions.relabel_transcript_speaker) -- never fails the
    confirm itself if the transcript is missing or nothing matches.
    """
    from src.config import get_config, get_data_dirs
    from src.speaker_sidecar_store import SpeakerSidecarStore, StaleDiarizationRun
    from src.speaker_suggestions import (
        clear_cluster_review_state,
        clusters_from_sidecar_channel,
        confirmed_participant_names,
        merge_same_channel_fragments,
        prototype_channel_matches,
        prototype_run_matches,
        record_original_labels,
        relabel_transcript_exact,
        relabel_transcript_speaker,
    )

    if bool(person_id) == bool(new_person):
        print(json.dumps({"success": False, "error": "Specify exactly one of --person-id or --new-person"}))
        sys.exit(1)

    config = get_config()
    if not config.get_identity_matching_enabled():
        print(json.dumps({
            "success": False,
            "error": "Speaker identification is disabled in settings.",
        }))
        sys.exit(1)

    output_dir = get_data_dirs()["output"]
    store = SpeakerSidecarStore(output_dir)
    sidecar_lock = store.lock(meeting_stem)
    try:
        sidecar_lock.acquire()
    except (filelock.Timeout, OSError):
        print(json.dumps({"success": False, "error": "Could not lock the speaker analysis."}))
        sys.exit(1)
    click.get_current_context().call_on_close(sidecar_lock.release)
    sidecar = store.read(meeting_stem)
    if not isinstance(sidecar, dict):
        print(json.dumps({"success": False, "error": f"No speakers sidecar found for {meeting_stem!r}"}))
        sys.exit(1)
    current_run_token = store.run_token(sidecar)
    if expected_run_id is not None and current_run_token != expected_run_id:
        error = StaleDiarizationRun(expected_run_id, current_run_token)
        print(json.dumps({
            "success": False,
            "error": str(error),
            "error_code": error.error_code,
        }))
        sys.exit(1)
    channel_data = (sidecar.get("channels") or {}).get(channel)
    if channel_data is None:
        print(json.dumps({"success": False, "error": f"No {channel!r} channel in sidecar for {meeting_stem!r}"}))
        sys.exit(1)

    # Read once from the loaded sidecar rather than re-reading per call --
    # every prototype and hard negative this command writes below describes
    # a cluster from THIS sidecar, so they all carry the same run id. `None`
    # on a legacy sidecar with no diarization_run block, which every
    # add_speaker_prototype call already treats as "no run to record".
    run_id = (sidecar.get("diarization_run") or {}).get("run_id")

    raw_clusters = clusters_from_sidecar_channel(meeting_stem, channel_data)
    if diarization_speaker_id not in raw_clusters:
        print(json.dumps({
            "success": False,
            "error": f"No cluster {diarization_speaker_id!r} in {channel!r} channel of {meeting_stem!r}",
        }))
        sys.exit(1)

    # Same-recording diarizer fragments of one continuous voice (e.g. one
    # real speaker split into multiple IDs over a long call) collapse into
    # one entry here first, so confirming ANY of the fragment ids produces
    # the same high-quality, duration-weighted-combined prototype -- see
    # the plan doc's Phase 3.6.
    clusters, id_resolution = merge_same_channel_fragments(raw_clusters)
    resolved_id = id_resolution[diarization_speaker_id]

    # Refused HERE rather than only hidden in the panel, because this is
    # the point where the damage would become permanent and unattributable:
    # a confirm turns the cluster's embedding into a stored SpeakerPrototype
    # and, for every other person confirmed in this channel, into mutual
    # hard-negative evidence. A blended two-voice centroid enrolled as one
    # person degrades every future suggestion scored against that profile,
    # in meetings that have nothing to do with this one, with nothing in
    # the result pointing back at the cause. The panel's hiding is a
    # convenience; this is the guarantee.
    if clusters[resolved_id][1].contains_multiple_speakers:
        print(json.dumps({
            "success": False,
            "error": (
                f"Cluster {diarization_speaker_id!r} is marked as containing more than "
                "one person, so it cannot be confirmed as a single person. Clear the "
                "marking first if that was wrong."
            ),
        }))
        sys.exit(1)

    if not config.begin_transaction():
        print(json.dumps({
            "success": False,
            "error": "Could not lock the person profile store.",
        }))
        sys.exit(1)
    if new_person:
        try:
            person = config.create_person_profile(new_person)
        except ValueError as e:
            config.rollback_transaction()
            print(json.dumps({"success": False, "error": str(e)}))
            sys.exit(1)
    else:
        person = config.get_person_profile(person_id)
        if person is None:
            config.rollback_transaction()
            print(json.dumps({"success": False, "error": f"No person profile with id {person_id!r}"}))
            sys.exit(1)

    embedding, context = clusters[resolved_id]
    fragment_ids = {resolved_id, *context.merged_from}
    channel_recording_type = channel_data.get("recording_type")

    # Reassignment: if this exact cluster (or one of its merged fragments)
    # was already confirmed as someone, this confirm supersedes that -- the
    # review UI's "Change" flow is literally a re-confirm with a different
    # person. Remove the stale positive prototype(s); for a DIFFERENT
    # person, also remove the hard negatives that wrongful confirmation
    # created (theirs from this meeting+channel, and every profile's
    # negatives citing this cluster), since they were only recorded because
    # that person was believed present here. The mutual-negative loop below
    # rebuilds correct negatives against the people still confirmed in this
    # channel. A same-person re-confirm just replaces the prototype instead
    # of appending a duplicate.
    #
    # Every removal here is scoped to THIS sidecar's run, because the cluster
    # ids only identify a voice within one diarization run -- a re-diarization
    # renumbers from SPEAKER_0 with no memory of who held that id, so
    # unscoped these removals would treat a stranger's confirmation as this
    # cluster's previous owner and delete it.
    #
    # The cost is more than a stale positive prototype left standing: a
    # confirmation made against a superseded run can no longer be corrected
    # by re-confirming that id, which freezes the hard negatives it minted
    # too. The mutual-negative loop further down records each confirmed
    # cluster as negative evidence against the other people confirmed in this
    # channel, so a confirm that got the owner wrong leaves somebody holding
    # their OWN voice as a reason to refuse a future match -- and that entry
    # now outlives every later confirm instead of being rebuilt away by the
    # idempotency removals below. Clearing it takes `repair-speaker-profiles`,
    # which drops entries by prototype_id and is not run-scoped.
    reassigned_from = []
    for existing_person in config.get_person_profiles():
        removed = config.remove_speaker_evidence(
            existing_person["person_id"], meeting_id=meeting_stem,
            channel=channel, channel_recording_type=channel_recording_type,
            sids=fragment_ids, diarization_run_id=run_id,
        )
        if not removed or existing_person["person_id"] == person["person_id"]:
            continue
        reassigned_from.append(existing_person["display_name"])
        # Their negatives here rest on them having been present in this
        # channel at all, not on this one cluster -- so drop them only once
        # they own NO cluster here any more. Under many-to-one one person
        # legitimately owns several clusters of a meeting; taking one away
        # used to strip the negatives the clusters they KEEP still justify,
        # and the rebuild below only restores negatives for the person being
        # confirmed now, so that evidence was simply lost.
        #
        # Run-scoped like the removal it guards, and it has to be: a
        # leftover prototype from a superseded run would otherwise read as
        # "still owns a cluster here" and suppress the cleanup for good,
        # since nothing ever deletes that prototype. "Present" here means
        # present in the meeting as it is diarized NOW, which is the only
        # sense in which the negatives below are still justified.
        still_present = any(
            p.get("meeting_id") == meeting_stem
            and prototype_channel_matches(p, channel, channel_recording_type)
            and prototype_run_matches(p, run_id)
            for p in (config.get_person_profile(existing_person["person_id"]) or {}).get(
                "prototypes",
            ) or []
        )
        if not still_present:
            config.remove_speaker_evidence(
                existing_person["person_id"], meeting_id=meeting_stem,
                channel=channel, channel_recording_type=channel_recording_type,
                negative=True, diarization_run_id=run_id,
            )
        for other in config.get_person_profiles():
            if other["person_id"] == existing_person["person_id"]:
                continue
            config.remove_speaker_evidence(
                other["person_id"], meeting_id=meeting_stem,
                channel=channel, channel_recording_type=channel_recording_type,
                sids=fragment_ids, negative=True, diarization_run_id=run_id,
            )

    prototype = config.add_speaker_prototype(
        person["person_id"], embedding,
        recording_type=context.recording_type, meeting_id=meeting_stem,
        diarization_speaker_id=resolved_id,
        speech_duration_seconds=context.speech_duration_seconds,
        segment_count=context.segment_count,
        created_from="user_corrected" if reassigned_from else "user_confirmed",
        channel=channel, diarization_run_id=run_id,
    )

    # Mutual hard negatives against any OTHER speaker already confirmed in
    # this same meeting+channel -- scoped to this channel only (not
    # cross-channel): a hybrid meeting's mic and system speakers aren't
    # necessarily confirmed-different (e.g. echo/feedback bleed), so only
    # within-channel confirmations are trustworthy negative evidence.
    # prototype_channel_matches is what actually enforces the channel scope:
    # a (meeting_id, diarization_speaker_id) pair alone is ambiguous because
    # both channels number clusters from SPEAKER_0 independently, and
    # matching without it recorded hard negatives built from the wrong
    # channel's clusters whenever the ids happened to collide.
    # A cluster marked as mixed is excluded as a SOURCE of negative evidence
    # too, not just as a name. "Speaker B is not the person in cluster A" is
    # only true if cluster A is one person; when A is a blend of two voices,
    # the negative is recorded against a voice nobody has, and it suppresses
    # real matches for B in unrelated meetings. Reachable in practice:
    # confirm A, later discover A is mixed and mark it, then confirm B --
    # without this filter B inherits A's blended embedding as a hard
    # negative. (Marking A also strips A's own prototype; see
    # mark-speaker-cluster.)
    other_sids = [
        sid for sid in clusters
        if sid != resolved_id and not clusters[sid][1].contains_multiple_speakers
    ]
    # Rebuild rather than append. Confirming the same cluster as the same
    # person again -- the review UI's Approve on an already-confirmed row, or
    # simply redoing an assignment -- used to run the loop below a second
    # time and stack a duplicate of every negative in both directions, once
    # more on each repeat. Dropping the evidence this cluster produced first
    # makes the whole step idempotent: the loop then writes exactly the set
    # the current assignments justify.
    for existing_person in config.get_person_profiles():
        config.remove_speaker_evidence(
            existing_person["person_id"], meeting_id=meeting_stem,
            channel=channel, channel_recording_type=channel_recording_type,
            sids=fragment_ids, negative=True, diarization_run_id=run_id,
        )
    config.remove_speaker_evidence(
        person["person_id"], meeting_id=meeting_stem,
        channel=channel, channel_recording_type=channel_recording_type,
        negative=True, diarization_run_id=run_id,
    )

    hard_negatives_added = []
    for other_person in config.get_person_profiles():
        if other_person["person_id"] == person["person_id"]:
            continue
        # EVERY cluster that person owns here, not just the first one. One
        # person legitimately owns several clusters of a meeting -- the
        # diarizer splits a voice, and the reviewer assigns both halves to
        # them. Matching only the first prototype left the second cluster
        # with no negative evidence at all, so a later meeting could still
        # match this speaker to it.
        #
        # Run-scoped, because this selects a prototype by meeting+sid+channel
        # and then mints a negative from the CURRENT run's embedding for that
        # id. Unscoped, a prototype confirmed against a superseded run would
        # produce a negative about a voice that person was never confirmed
        # next to -- permanent suppression evidence built from a coincidence
        # of cluster numbering, in both directions, and it would keep firing
        # for as long as the meeting exists since the superseded prototype is
        # deliberately never deleted.
        matches = [
            p for p in (other_person.get("prototypes") or [])
            if p.get("meeting_id") == meeting_stem
            and p.get("diarization_speaker_id") in other_sids
            and prototype_channel_matches(p, channel, channel_recording_type)
            and prototype_run_matches(p, run_id)
        ]
        if not matches:
            continue
        # One negative per THEIR cluster, in this direction only: "the person
        # I am confirming is none of those clusters".
        for match in matches:
            other_sid = match["diarization_speaker_id"]
            other_embedding, other_context = clusters[other_sid]
            config.add_speaker_prototype(
                person["person_id"], other_embedding,
                recording_type=other_context.recording_type, meeting_id=meeting_stem,
                diarization_speaker_id=other_sid,
                speech_duration_seconds=other_context.speech_duration_seconds,
                segment_count=other_context.segment_count,
                created_from="user_confirmed", negative=True,
                channel=channel, diarization_run_id=run_id,
            )
        # And exactly ONE the other way: THIS cluster is a single piece of
        # evidence about them, however many clusters they own. Adding it per
        # match duplicated it, and every copy is another reason the matcher
        # refuses a real match for them later.
        config.add_speaker_prototype(
            other_person["person_id"], embedding,
            recording_type=context.recording_type, meeting_id=meeting_stem,
            diarization_speaker_id=resolved_id,
            speech_duration_seconds=context.speech_duration_seconds,
            segment_count=context.segment_count,
            created_from="user_confirmed", negative=True,
            channel=channel, diarization_run_id=run_id,
        )
        hard_negatives_added.append(other_person["display_name"])

    if not config.commit_transaction():
        print(json.dumps({
            "success": False,
            "error": "Could not save the speaker profile.",
        }))
        sys.exit(1)

    relabeled_lines = 0
    if relabel_transcript:
        transcript_path = get_data_dirs()["transcripts"] / f"{meeting_stem}_transcript.txt"
        turn_manifest = sidecar.get("transcript_lines")
        if turn_manifest:
            # Exact recorded provenance -- immune to the fuzzy-matching
            # cross-channel/same-channel mislabeling below (see
            # relabel_transcript_exact's docstring and the plan doc's
            # Phase 8). Only meetings processed after this manifest
            # existed have one; everything else falls back.
            target_ids = {(channel, sid) for sid in [resolved_id, *context.merged_from]}
            # BEFORE the rename, so the label each line carries today is
            # still readable. Without it, naming a cluster is irreversible
            # in the transcript and marking it as mixed later would leave
            # the name standing. First write wins, so re-confirming (the
            # "Change" flow) never records a person's name as the original.
            record_original_labels(
                output_dir,
                meeting_stem,
                transcript_path,
                target_ids,
                lock_held=True,
            )
            relabeled_lines = relabel_transcript_exact(
                transcript_path, turn_manifest, target_ids, person["display_name"],
            )
        else:
            raw_clusters_by_id = channel_data.get("clusters") or {}
            pooled_segments = []
            for fragment_id in [resolved_id, *context.merged_from]:
                pooled_segments.extend(raw_clusters_by_id.get(fragment_id, {}).get("segments") or [])
            relabeled_lines = relabel_transcript_speaker(transcript_path, pooled_segments, person["display_name"])

    # Naming the cluster supersedes "a human kept this generic": the row is
    # now decided, and leaving the marking would have the panel report a
    # confirmed row as still parked. Swept across every fragment, because
    # the merged row reads generic when ANY member carries the key.
    clear_cluster_review_state(
        output_dir,
        meeting_stem,
        channel,
        fragment_ids,
        current_run_token,
        lock_held=True,
    )

    # Cheap and always-safe (unlike transcript relabeling, no reason to
    # gate this behind a flag) -- keeps the meeting's Participants chip in
    # sync with every confirm, including plain CLI/backfill-validation use.
    participant_names = confirmed_participant_names(meeting_stem, config.get_person_profiles())
    _update_summary_participants(output_dir, meeting_stem, participant_names)

    print(json.dumps({
        "success": True,
        "person_id": person["person_id"],
        "display_name": person["display_name"],
        "prototype_id": prototype["prototype_id"],
        "resolved_diarization_speaker_id": resolved_id,
        "merged_from": context.merged_from,
        "relabeled_lines": relabeled_lines,
        "hard_negatives_added_against": hard_negatives_added,
        "reassigned_from": reassigned_from,
        "participants_updated": participant_names,
    }))


@cli.command(name='speaker-timestamps')
@click.argument('meeting_stem')
@click.argument('channel')
@click.argument('diarization_speaker_id')
def speaker_timestamps(meeting_stem, channel, diarization_speaker_id):
    """Print every timestamp range where a diarized cluster was detected
    speaking -- for manually cross-referencing against your own memory of
    the meeting (or the saved transcript's [MM:SS] markers) before running
    `confirm-speaker`, since a cluster id and a duration total alone don't
    tell you WHO it actually is.
    """
    from src.config import get_data_dirs
    from src.speaker_suggestions import read_speakers_sidecar
    from src.transcriber import _format_timestamp

    output_dir = get_data_dirs()["output"]
    sidecar = read_speakers_sidecar(output_dir, meeting_stem)
    if sidecar is None:
        print(json.dumps({"success": False, "error": f"No speakers sidecar found for {meeting_stem!r}"}))
        sys.exit(1)
    channel_data = (sidecar.get("channels") or {}).get(channel)
    if channel_data is None:
        print(json.dumps({"success": False, "error": f"No {channel!r} channel in sidecar for {meeting_stem!r}"}))
        sys.exit(1)
    cluster = (channel_data.get("clusters") or {}).get(diarization_speaker_id)
    if cluster is None:
        print(json.dumps({
            "success": False,
            "error": f"No cluster {diarization_speaker_id!r} in {channel!r} channel of {meeting_stem!r}",
        }))
        sys.exit(1)

    segments = cluster.get("segments") or []
    print(f"{meeting_stem} [{channel}] {diarization_speaker_id}: "
          f"{cluster.get('speech_duration_seconds', 0):.1f}s total across {len(segments)} turns")
    for seg in segments:
        print(f"  [{_format_timestamp(seg['start'])} - {_format_timestamp(seg['end'])}]")


@cli.command(name='set-cluster-review-state')
@click.argument('meeting_stem')
@click.argument('channel')
@click.argument('diarization_speaker_id')
@click.option(
    '--generic/--clear', 'generic', default=True,
    help="--generic (default) records that a human reviewed this cluster and "
         "chose to leave it unnamed; --clear removes that marking.",
)
@click.option('--expected-run-id', default=None, help="Reject the change if diarization was replaced.")
def set_cluster_review_state_command(
    meeting_stem, channel, diarization_speaker_id, generic, expected_run_id,
):
    """Record how far the review got on one diarized cluster.

    "Keep generic" is the only review outcome that leaves no other trace. A
    confirm writes a prototype, a mixed marking writes its own key, but
    deciding to leave a row alone used to change nothing on disk -- so a
    restart, or merely navigating away and back, re-presented every row the
    reviewer had already dealt with. That is the work the button exists to
    save, undone by the panel unmounting.

    It changes no score and no suggestion: it says the reviewer stopped
    here, not that the voice is unidentifiable. Naming the cluster or
    marking it as holding several people supersedes it, and both clear it.
    """
    from src.config import get_data_dirs
    from src.speaker_sidecar_store import StaleDiarizationRun
    from src.speaker_suggestions import (
        REVIEW_STATE_GENERIC,
        clusters_from_sidecar_channel,
        merge_same_channel_fragments,
        set_cluster_review_state,
    )

    output_dir = get_data_dirs()["output"]
    state = REVIEW_STATE_GENERIC if generic else None
    try:
        sidecar = set_cluster_review_state(
            output_dir,
            meeting_stem,
            channel,
            diarization_speaker_id,
            state,
            expected_run_id,
        )
    except StaleDiarizationRun as error:
        print(json.dumps({
            "success": False,
            "error": str(error),
            "error_code": error.error_code,
        }))
        sys.exit(1)
    if sidecar is None:
        print(json.dumps({
            "success": False,
            "error": f"No cluster {diarization_speaker_id!r} in {channel!r} channel of {meeting_stem!r}",
        }))
        sys.exit(1)

    # The reach, not just the id: the panel shows merged rows, so a caller
    # needs to know which raw clusters the row it just marked covers --
    # same reporting mark-speaker-cluster does, and the same reason.
    channel_data = (sidecar.get("channels") or {}).get(channel) or {}
    resolved_id = diarization_speaker_id
    fragment_ids = [diarization_speaker_id]
    try:
        clusters, id_resolution = merge_same_channel_fragments(
            clusters_from_sidecar_channel(meeting_stem, channel_data)
        )
    except (KeyError, TypeError, ValueError):
        # The mark is already on disk by now; only the merge that computes
        # its reach can still fail, and it does whenever any OTHER cluster
        # in this channel lacks a usable embedding. Report the raw id
        # rather than failing an action that already succeeded.
        # (A structurally wrong channels/clusters map cannot get this far --
        # the write refuses it first; see _freshest_channel.)
        clusters, id_resolution = {}, {}
    resolved_id = id_resolution.get(diarization_speaker_id, diarization_speaker_id)
    if resolved_id in clusters:
        fragment_ids = [resolved_id, *clusters[resolved_id][1].merged_from]

    print(json.dumps({
        "success": True,
        "meeting_id": meeting_stem,
        "channel": channel,
        "diarization_speaker_id": diarization_speaker_id,
        "resolved_diarization_speaker_id": resolved_id,
        "fragment_ids": fragment_ids,
        "review_state": state,
    }))


@cli.command(name='mark-speaker-cluster')
@click.argument('meeting_stem')
@click.argument('channel')
@click.argument('diarization_speaker_id')
@click.option(
    '--multiple/--single', 'multiple', default=True,
    help="--multiple (default) marks the cluster as holding more than one person; "
         "--single clears the marking.",
)
@click.option('--expected-run-id', default=None, help="Reject the change if diarization was replaced.")
def mark_speaker_cluster(
    meeting_stem, channel, diarization_speaker_id, multiple, expected_run_id,
):
    """Record that one diarized cluster holds MORE THAN ONE person -- the
    one fact about a cluster that cannot be measured, only witnessed.

    Diarizers fail in two directions. Splitting one person across several
    clusters is recoverable from the data itself (see
    merge_same_channel_fragments, which does it automatically at distance
    <= 0.10). Merging several people INTO one cluster is not: measured
    against a real three-person call, a cluster contaminated by someone
    briefly talking over the main speaker sat at cosine distance 0.8270
    from the person who contaminated it -- indistinguishable from any two
    unrelated speakers. No threshold finds that, and the per-chunk
    embeddings that might are not in the sidecar's contract. Somebody who
    was in the room is the only instrument that detects it.

    Marking a cluster takes it out of naming and out of voice
    identification entirely: it is withheld from suggestions, refused by
    `confirm-speaker`, and never enrolled as anyone's voice evidence. It
    also raises the meeting's reported `minimum_speaker_count`, since a
    mixed cluster is at least two people -- see that function on why
    nothing consumes that number yet.
    """
    from src.config import get_config, get_data_dirs
    from src.speaker_sidecar_store import SpeakerSidecarStore, StaleDiarizationRun
    from src.speaker_suggestions import (
        clear_cluster_review_state,
        confirmed_participant_names,
        merge_same_channel_fragments,
        clusters_from_sidecar_channel,
        minimum_speaker_count,
        restore_transcript_labels,
        set_cluster_multi_speaker,
    )

    output_dir = get_data_dirs()["output"]
    store = SpeakerSidecarStore(output_dir)
    sidecar_lock = store.lock(meeting_stem)
    try:
        sidecar_lock.acquire()
    except (filelock.Timeout, OSError):
        print(json.dumps({"success": False, "error": "Could not lock the speaker analysis."}))
        sys.exit(1)
    click.get_current_context().call_on_close(sidecar_lock.release)
    sidecar = store.read(meeting_stem)
    if not isinstance(sidecar, dict):
        print(json.dumps({
            "success": False,
            "error": "The speaker analysis is missing or invalid.",
        }))
        sys.exit(1)
    current_run_token = store.run_token(sidecar)
    if expected_run_id is not None and current_run_token != expected_run_id:
        error = StaleDiarizationRun(expected_run_id, current_run_token)
        print(json.dumps({
            "success": False,
            "error": str(error),
            "error_code": error.error_code,
        }))
        sys.exit(1)
    channels = sidecar.get("channels")
    channel_data = channels.get(channel) if isinstance(channels, dict) else None
    raw_clusters = channel_data.get("clusters") if isinstance(channel_data, dict) else None
    if not isinstance(raw_clusters, dict) or not isinstance(
        raw_clusters.get(diarization_speaker_id), dict,
    ):
        print(json.dumps({
            "success": False,
            "error": f"No cluster {diarization_speaker_id!r} in {channel!r} channel of {meeting_stem!r}",
        }))
        sys.exit(1)

    # Report the marking's reach, not just the raw id it was written to: a
    # cluster that merge_same_channel_fragments folded into another is
    # reviewed and displayed under its primary's id, so marking any
    # fragment withholds the whole merged cluster. Saying so here keeps
    # the CLI honest about what just happened.
    channel_recording_type = channel_data.get("recording_type")
    # From the rewritten document set_cluster_multi_speaker returned, which
    # carries the existing run forward -- marking a cluster is an annotation
    # of this diarization output, not a new one. `None` on a legacy sidecar.
    run_id = (sidecar.get("diarization_run") or {}).get("run_id")
    try:
        clusters, id_resolution = merge_same_channel_fragments(
            clusters_from_sidecar_channel(meeting_stem, channel_data)
        )
    except (KeyError, TypeError, ValueError):
        # Another malformed cluster can prevent merged-reach computation.
        # The raw target remains safe to withdraw and mark.
        clusters, id_resolution = {}, {}
    resolved_id = id_resolution.get(diarization_speaker_id, diarization_speaker_id)
    fragment_ids = {diarization_speaker_id}
    if resolved_id in clusters:
        fragment_ids = {resolved_id, *clusters[resolved_id][1].merged_from}

    # Marking a cluster mixed must UNDO any name already on it, not just
    # stop future ones. Order matters: someone typically confirms a cluster
    # first and only later -- on listening to a second excerpt -- realises
    # two people are in it. Leaving the earlier confirmation standing would
    # keep a blended two-voice embedding enrolled as that person, which is
    # the exact state this marking exists to prevent, and it stays reachable
    # from three other directions: enroll-self-from-person copies any
    # existing prototype into the self voiceprint, confirm-speaker treats a
    # confirmed neighbour as hard-negative evidence, and every future
    # suggestion is scored against the poisoned profile.
    #
    # Also removes the hard negatives that confirmation created -- they were
    # only ever recorded because this cluster was believed to be that
    # person, and a negative derived from a blended voice is wrong in both
    # directions.
    config = get_config()
    cleared_from = []
    restored_lines = 0
    if multiple and fragment_ids:
        if not config.begin_transaction():
            print(json.dumps({
                "success": False,
                "error": "Could not lock the person profile store.",
            }))
            sys.exit(1)
        # Run-scoped for the same reason the confirm path is: the cluster
        # this marking describes exists only within this run, so an entry
        # from a superseded run shares nothing with it but a reused id.
        for person in config.get_person_profiles():
            removed = config.remove_speaker_evidence(
                person["person_id"], meeting_id=meeting_stem,
                channel=channel, channel_recording_type=channel_recording_type,
                sids=fragment_ids, diarization_run_id=run_id,
            )
            if not removed:
                continue
            cleared_from.append(person["display_name"])
            # Restricted to THIS cluster's ids, same as the loop below. A
            # person's negatives in this meeting are earned one cluster at a
            # time -- "that voice over there is not Person Alpha" is evidence about
            # that other cluster, and marking this one does not touch it.
            # Clearing them all destroyed evidence silently, and the only
            # symptom would have been a worse suggestion months later.
            config.remove_speaker_evidence(
                person["person_id"], meeting_id=meeting_stem,
                channel=channel, channel_recording_type=channel_recording_type,
                sids=fragment_ids, negative=True, diarization_run_id=run_id,
            )
            for other in config.get_person_profiles():
                if other["person_id"] == person["person_id"]:
                    continue
                config.remove_speaker_evidence(
                    other["person_id"], meeting_id=meeting_stem,
                    channel=channel, channel_recording_type=channel_recording_type,
                    sids=fragment_ids, negative=True, diarization_run_id=run_id,
                )
        if not config.commit_transaction():
            print(json.dumps({
                "success": False,
                "error": "Could not update the speaker profiles.",
            }))
            sys.exit(1)

    # Persist the marking only after the profile cleanup is durable. If the
    # config write fails, leaving the cluster unmarked is recoverable by a
    # retry; leaving a poisoned biometric prototype active is not.
    try:
        sidecar = set_cluster_multi_speaker(
            output_dir,
            meeting_stem,
            channel,
            diarization_speaker_id,
            multiple,
            current_run_token,
            lock_held=True,
        )
    except (OSError, StaleDiarizationRun) as error:
        if isinstance(error, StaleDiarizationRun):
            print(json.dumps({
                "success": False,
                "error": str(error),
                "error_code": error.error_code,
            }))
            sys.exit(1)
        sidecar = None
    if sidecar is None:
        print(json.dumps({
            "success": False,
            "error": "Could not save the speaker marking.",
            "cleared_confirmation_from": cleared_from,
        }))
        sys.exit(1)

    if multiple and fragment_ids:
        # "A human kept this generic" is superseded by "a human says it is
        # several people". Clear it only after the stronger marking is safe.
        clear_cluster_review_state(
            output_dir,
            meeting_stem,
            channel,
            fragment_ids,
            current_run_token,
            lock_held=True,
        )
        # Derive the readable artefacts from durable state on every attempt.
        # A previous attempt can commit profile cleanup and then fail its
        # sidecar write. Retrying then has no newly-cleared person to report,
        # but it must still repair the transcript and Participants section.
        restored_lines = restore_transcript_labels(
            get_data_dirs()["transcripts"] / f"{meeting_stem}_transcript.txt",
            sidecar.get("transcript_lines") or [],
            {(channel, fid) for fid in fragment_ids},
        )
        _update_summary_participants(
            output_dir, meeting_stem,
            confirmed_participant_names(meeting_stem, config.get_person_profiles()),
        )

    print(json.dumps({
        "success": True,
        "meeting_id": meeting_stem,
        "channel": channel,
        "diarization_speaker_id": diarization_speaker_id,
        "resolved_diarization_speaker_id": resolved_id,
        "contains_multiple_speakers": multiple,
        # Names whose confirmation of THIS cluster was withdrawn by the
        # marking, so a caller can say so rather than letting a person
        # quietly disappear from the meeting.
        "cleared_confirmation_from": cleared_from,
        # How many transcript lines stopped carrying the withdrawn name.
        # Reported rather than assumed: a manifest that no longer describes
        # the transcript is refused outright (see restore_transcript_labels),
        # and then the name IS still in the file -- a caller that says
        # "removed" regardless would be lying about the artefact.
        "transcript_lines_restored": restored_lines,
        "minimum_speaker_count": minimum_speaker_count(sidecar.get("channels") or {}),
    }))


@cli.command(name='speaker-naming-status')
@click.argument('meeting_stem')
def speaker_naming_status(meeting_stem):
    """How many of this meeting's speaker clusters still have no name.

    Deliberately cheap and side-effect free -- no profile scoring, no
    transcript reads, no ffmpeg -- because it is called to decide whether
    to show one sentence in a delete confirmation, on a path where a slow
    or failing check must never stand between a user and deleting their
    own recording.

    Why it exists: a CONFIRMED person survives deleting the meeting (their
    prototype lives in config.json's person_profiles, bound to no meeting
    -- verified against a real library, where 5 of 19 working prototypes
    came from meetings deleted long ago). An UNNAMED cluster does not
    survive it, and cannot be recovered afterwards by any means: naming a
    voice requires hearing it, hearing it requires the source audio, and
    the delete takes the audio. So the last moment at which an unnamed
    cluster can still be named is just before the delete -- which is
    exactly when nobody is thinking about it.

    Reports `success: true` with zero counts for a meeting that has no
    sidecar at all (not diarized, or diarized before sidecars existed):
    nothing is at risk there, and a caller deciding whether to show a
    warning wants "nothing to warn about", not an error to handle.
    """
    from src.config import get_config, get_data_dirs
    from src.speaker_suggestions import (
        MULTI_SPEAKER_KEY,
        merge_same_channel_fragments,
        clusters_from_sidecar_channel,
        prototype_channel_matches,
        prototype_run_matches,
        read_speakers_sidecar,
    )

    config = get_config()
    if not config.get_identity_matching_enabled():
        print(json.dumps({
            "success": True, "meeting_id": meeting_stem, "has_sidecar": False,
            "total_clusters": 0, "named_clusters": 0, "unnamed_clusters": 0,
        }))
        return

    dirs = get_data_dirs()
    sidecar = read_speakers_sidecar(dirs["output"], meeting_stem)
    if sidecar is None:
        print(json.dumps({
            "success": True, "meeting_id": meeting_stem, "has_sidecar": False,
            "total_clusters": 0, "named_clusters": 0, "unnamed_clusters": 0,
        }))
        return

    # A name from a superseded diarization run does not name anything here:
    # the run this sidecar describes renumbered its clusters, so that
    # prototype's id now belongs to whichever voice inherited it. Counting
    # it as named is the one error direction that costs data -- it hides an
    # unnamed cluster from the delete warning, and an unnamed cluster cannot
    # be named again once the audio is gone.
    run_id = (sidecar.get("diarization_run") or {}).get("run_id")
    profiles = config.get_person_profiles()
    total = 0
    named = 0
    for channel_name, channel_data in (sidecar.get("channels") or {}).items():
        raw_clusters_by_id = channel_data.get("clusters") or {}
        recording_type = channel_data.get("recording_type")
        merged, _ = merge_same_channel_fragments(
            clusters_from_sidecar_channel(meeting_stem, channel_data)
        )
        for sid, (_embedding, context) in merged.items():
            # A cluster marked as mixed is not "waiting to be named" -- it
            # is one a human has already looked at and ruled out, so
            # counting it as unnamed would nag about the one row that can
            # never be resolved.
            if context.contains_multiple_speakers or any(
                raw_clusters_by_id.get(fid, {}).get(MULTI_SPEAKER_KEY)
                for fid in [sid, *context.merged_from]
            ):
                continue
            total += 1
            fragment_ids = [sid, *context.merged_from]
            if any(
                any(
                    p.get("meeting_id") == meeting_stem
                    and p.get("diarization_speaker_id") in fragment_ids
                    and prototype_channel_matches(p, channel_name, recording_type)
                    and prototype_run_matches(p, run_id)
                    for p in (person.get("prototypes") or [])
                )
                for person in profiles
            ):
                named += 1

    print(json.dumps({
        "success": True,
        "meeting_id": meeting_stem,
        "has_sidecar": True,
        "total_clusters": total,
        "named_clusters": named,
        "unnamed_clusters": total - named,
    }))


@cli.command(name='suggest-speakers')
@click.argument('meeting_stem')
def suggest_speakers(meeting_stem):
    """Suggest names for every diarized speaker cluster in one meeting.

    Reads the `{meeting_stem}_speakers.json` sidecar (written by the live
    pipeline or the backfill command — see src.speaker_suggestions) and
    ranks known person profiles as candidates per cluster. NEVER
    auto-assigns a name to the meeting's saved transcript — this only
    prints suggestions for review; applying one is a separate, explicit
    action (not yet wired to a command — the approval UI is the intended
    surface, see the plan doc).
    """
    from src.config import get_config
    from src.speaker_sidecar_store import SpeakerSidecarStore
    from src.speaker_suggestions import (
        SUGGESTION_MIN_AVG_TURN_SECONDS,
        build_transcript_manifest_index,
        clusters_from_sidecar_channel,
        extract_segment_samples,
        merge_same_channel_fragments,
        minimum_speaker_count,
        prototype_channel_matches,
        prototype_run_matches,
        read_speakers_sidecar,
        sample_text_from_samples,
        suggest_speakers_for_meeting,
    )
    from src.config import get_data_dirs
    from src.transcriber import _format_timestamp

    config = get_config()
    if not config.get_identity_matching_enabled():
        print(json.dumps({
            "success": True,
            "schema_version": 1,
            "diarization_run_id": None,
            "meeting_id": meeting_stem,
            "recording_available": False,
            "minimum_speaker_count": 0,
            "channels": {},
        }))
        return

    dirs = get_data_dirs()
    sidecar = read_speakers_sidecar(dirs["output"], meeting_stem)
    if sidecar is None:
        print(json.dumps({
            "success": True,
            "schema_version": 1,
            "diarization_run_id": None,
            "meeting_id": meeting_stem,
            "recording_available": False,
            "minimum_speaker_count": 0,
            "channels": {},
        }))
        return

    # Whether a play button can appear at all -- checked once per meeting,
    # not per cluster, since it's the same source recording either way.
    # Most historical meetings have no source audio left (keep_recordings
    # defaults off) -- the panel needs to know this upfront rather than
    # discovering it only after a failed play click.
    recording_path = _find_recording_file(dirs["recordings"], meeting_stem)
    transcript_path = dirs["transcripts"] / f"{meeting_stem}_transcript.txt"

    # Exact per-line provenance, present only on meetings recorded after the
    # manifest existed. Without it no excerpt TEXT is shown at all: a
    # backfill-produced sidecar re-diarized the audio in its own run, so its
    # segment timestamps were never the ones the saved transcript's [MM:SS]
    # markers came from, and matching text by proximity across the two put a
    # DIFFERENT participant's sentences under the owner's own mic cluster
    # (measured -- see cluster_transcript_lines). The play buttons are
    # unaffected; they cut audio at this run's own segments.
    turn_manifest = sidecar.get("transcript_lines")
    transcript_index = build_transcript_manifest_index(transcript_path, turn_manifest)

    # Which diarization run the clusters below belong to. A prototype
    # confirmed against a DIFFERENT run describes a voice this run may have
    # given to somebody else -- the diarizer numbers from SPEAKER_0 every
    # time with no memory of who held that id -- so it may not speak for
    # any row here. `None` on a legacy sidecar, where the predicate's
    # both-absent rule keeps every existing confirmation current.
    run_id = (sidecar.get("diarization_run") or {}).get("run_id")
    run_token = SpeakerSidecarStore(dirs["output"]).run_token(sidecar)

    profiles = config.get_person_profiles()
    # Merge fragments per channel first, then suggest for ALL channels in
    # one call -- used-person exclusivity is meeting-wide (a person can't
    # be the confirmed suggestion on both mic and system), so suggestion
    # must see every channel's clusters together.
    merged_by_channel = {}
    for channel_name, channel in (sidecar.get("channels") or {}).items():
        raw_clusters = clusters_from_sidecar_channel(meeting_stem, channel)
        # Same-recording diarizer fragments of one voice (see the plan
        # doc's Phase 3.6) collapse before scoring, so they're suggested as
        # one cluster instead of several partial-duration ones.
        merged_by_channel[channel_name], _ = merge_same_channel_fragments(raw_clusters)
    results_by_channel = suggest_speakers_for_meeting(merged_by_channel, profiles)

    channels_out = {}
    # People whose confirmation in this meeting was made against a run that
    # no longer describes anything on screen, keyed by person id so someone
    # who lost several clusters is reported once. Insertion-ordered, so the
    # notice reads in the order the clusters appear.
    stale_assignments = {}
    for channel_name, channel in (sidecar.get("channels") or {}).items():
        clusters = merged_by_channel[channel_name]
        results = results_by_channel[channel_name]
        raw_clusters_by_id = channel.get("clusters") or {}
        recording_type = channel.get("recording_type")
        cluster_out = {}
        for sid, r in results.items():
            context = clusters[sid][1]
            fragment_ids = [sid, *context.merged_from]
            pooled_segments = [
                seg
                for fragment_id in fragment_ids
                for seg in (raw_clusters_by_id.get(fragment_id, {}).get("segments") or [])
            ]
            avg_turn = (
                context.speech_duration_seconds / context.segment_count
                if context.segment_count else 0.0
            )
            target_ids = {(channel_name, fid) for fid in fragment_ids}
            # Built once per cluster: the collapsed row's quote is derived
            # from this same list below, and asking for it separately meant
            # a second transcript parse and manifest check per cluster.
            cluster_samples = extract_segment_samples(
                transcript_path, pooled_segments,
                turn_manifest=turn_manifest, target_ids=target_ids,
                transcript_index=transcript_index,
            )
            # Whether a human has ALREADY confirmed this exact cluster,
            # derived from real persisted state (an existing prototype),
            # not transient UI state -- a suggestion's status/tier can stay
            # "possible" even after a real confirm (SUGGESTION_MIN_CONFIRMED_MEETINGS
            # not yet met), and any client-side "just confirmed" feedback
            # is gone the moment the panel unmounts (e.g. navigating away
            # and back). This survives both.
            #
            # Only evidence from THIS run counts. A prototype confirmed
            # against a superseded run would otherwise show up as a
            # confirmation the user appears to have made themselves, on a
            # row that may be a different person entirely -- and unlike a
            # wrong suggestion, nothing about it invites a second look.
            confirmed_by_user = None
            confirmed_person_id = None
            superseded_owners = []
            for person in profiles:
                owned = [
                    p for p in (person.get("prototypes") or [])
                    if p.get("meeting_id") == meeting_stem
                    and p.get("diarization_speaker_id") in fragment_ids
                    and prototype_channel_matches(p, channel_name, recording_type)
                ]
                if not owned:
                    continue
                if any(prototype_run_matches(p, run_id) for p in owned):
                    if confirmed_by_user is None:
                        confirmed_by_user = person["display_name"]
                        # The id as well as the name: display names are not a
                        # stable identity (a rename can make two profiles read
                        # alike), and the panel uses this to tell which people
                        # already hold a cluster of THIS meeting.
                        confirmed_person_id = person["person_id"]
                else:
                    superseded_owners.append(person)
            # Reported per cluster and only while the cluster is still
            # unclaimed, so the notice this feeds can actually go away.
            # Nothing ever deletes a superseded prototype -- that is the
            # point of the run scoping -- so a notice derived from the
            # prototypes alone would outlive every action the user could
            # take to answer it.
            if confirmed_by_user is None:
                for person in superseded_owners:
                    stale_assignments.setdefault(person["person_id"], person["display_name"])
            cluster_out[sid] = {
                "status": r.status,
                "suggested_person_id": r.suggested_person_id,
                "suggested_name": r.suggested_name,
                "merged_from": context.merged_from,
                "candidates": [
                    {"person_id": c.person_id, "display_name": c.display_name,
                     "distance": round(c.distance, 4), "hard_negative_conflict": c.hard_negative_conflict,
                     "negative_distance": (
                         round(c.negative_distance, 4) if c.negative_distance is not None else None
                     )}
                    for c in r.candidates
                ],
                "reasons": r.reasons,
                # Nothing here identifies WHO a cluster is -- without some
                # anchor into the recording, a human reviewing an
                # "Unidentified speaker" row has no way to go listen and
                # figure out who it actually is. speech_duration_seconds/
                # segment_count give a sense of how substantial this
                # speaker's presence is; first_timestamp (MM:SS, earliest of
                # this cluster's pooled segments) is where in the recording
                # to go listen; sample_text quotes what they actually said
                # at the longest (most trustworthy) segment.
                "speech_duration_seconds": round(context.speech_duration_seconds, 1),
                "segment_count": context.segment_count,
                "first_timestamp": (
                    _format_timestamp(min(seg["start"] for seg in pooled_segments))
                    if pooled_segments else None
                ),
                # Derived from `samples` below rather than recomputed: both
                # come from the same excerpt list by construction, and
                # asking twice meant parsing the transcript and re-checking
                # the manifest a second time for every cluster.
                "sample_text": sample_text_from_samples(cluster_samples),
                # Several excerpts, chronological, each independently
                # playable (see extract_segment_samples / sample_segments --
                # `samples[i]` is what `get-speaker-sample-audio
                # --segment-index i` plays). One excerpt is a single roll of
                # the dice on whether the longest turn happens to contain
                # anything recognizable; several spread across the recording
                # are what let a human actually place a voice -- and hearing
                # two different voices under one cluster is the only way the
                # contamination behind `contains_multiple_speakers` becomes
                # visible at all.
                "samples": cluster_samples,
                # Set by `mark-speaker-cluster`, never derived: no measurable
                # property of a centroid distinguishes one voice from two
                # blended ones (0.8270 to the contaminating speaker in the
                # real case this was built for). True means a human said so,
                # and this cluster is out of naming for good.
                "contains_multiple_speakers": context.contains_multiple_speakers,
                # Set by `set-cluster-review-state`. Echoed so the panel can
                # read a reviewer's "leave this one generic" back out of
                # persisted state instead of component state -- which is
                # what makes it survive a remount and a restart. Changes no
                # score and no status: it is progress, not evidence.
                "review_state": context.review_state,
                # Same signal already used to gate suggestion status (real-
                # data-validated this session against the echo/crosstalk
                # artifact pattern) -- reused here to flag likely-artifact
                # rows so the review panel can hide them by default instead
                # of showing every raw diarizer cluster as equally
                # actionable noise. Never excludes a cluster from the
                # sidecar or from confirm-speaker -- purely a UI hint.
                "is_likely_artifact": avg_turn < SUGGESTION_MIN_AVG_TURN_SECONDS,
                "confirmed_by_user": confirmed_by_user,
                "confirmed_person_id": confirmed_person_id,
            }
        channels_out[channel_name] = cluster_out

    print(json.dumps({
        "success": True,
        "schema_version": 1,
        "diarization_run_id": run_token,
        "meeting_id": meeting_stem,
        "recording_available": recording_path is not None,
        # Clusters plus one extra for each cluster marked as mixed. Worth
        # surfacing because the real ceiling is invisible in the output:
        # Sortformer's four-slot architecture returns a five-person channel
        # as four clusters with nothing indicating anything was dropped.
        # No caller acts on this number today -- see minimum_speaker_count.
        "minimum_speaker_count": minimum_speaker_count(sidecar.get("channels") or {}),
        # Confirmations this meeting's re-diarization orphaned. The panel
        # renders one meeting-level notice from this: the clusters were
        # renumbered, these people's assignments no longer point at anything
        # on screen, and re-confirming them is the only thing that restores
        # the link. Empty is the normal case, including on every legacy
        # library, and their voice evidence is untouched either way -- it
        # keeps scoring candidates in every meeting.
        #
        # Known gap, accepted: someone whose only superseded prototype names
        # a cluster id the new run does not produce at all is never listed,
        # because the collection walks this run's clusters. Their assignment
        # really is orphaned, but no row here can carry them and the notice
        # says "re-confirm them", which they cannot. It only goes unnoticed
        # once every surviving cluster is confirmed -- until then the notice
        # is up anyway for the others.
        "stale_assignments": [
            {"person_id": pid, "display_name": name}
            for pid, name in stale_assignments.items()
        ],
        "channels": channels_out,
    }))


@cli.command(name='get-speaker-sample-audio')
@click.argument('meeting_stem')
@click.argument('channel')
@click.argument('diarization_speaker_id')
@click.option(
    '--segment-index', type=int, default=None,
    help="Play this entry of the cluster's `samples` list (as returned by "
         "suggest-speakers) instead of its longest turn.",
)
@click.option('--expected-run-id', default=None, help="Reject playback if diarization was replaced.")
def get_speaker_sample_audio(
    meeting_stem, channel, diarization_speaker_id, segment_index, expected_run_id,
):
    """Extract a short audio clip of one diarized cluster, for the review
    UI's play button. Picks the cluster's single LONGEST pooled segment
    (primary + merged fragments) to avoid cross-voice contamination --
    mirrors pasrom/meeting-transcriber's SpeakerNamingView.swift and uses
    the exact same time range `suggest-speakers`' `sample_text` quotes, so
    what a human reads matches what they'd hear.

    With `--segment-index i`, plays `samples[i]` from the same cluster's
    `suggest-speakers` output instead -- the two commands derive that list
    from identically-pooled segments via the shared `sample_segments`, so
    the clip always matches the excerpt shown next to it. An out-of-range
    index is an error rather than a silent fall back to the longest turn:
    hearing the wrong excerpt with no indication is how someone concludes
    two different speakers sound the same.

    Always fails gracefully (`{"success": false, "error": ...}`, never a
    non-JSON crash) when there's no source recording left on disk (the
    common case for an older backfilled meeting -- keep_recordings
    defaults off) or ffmpeg extraction otherwise fails -- this is a
    best-effort UI aid, never something that can break the review panel.
    """
    import tempfile

    from src.config import get_data_dirs
    from src.speaker_sidecar_store import SpeakerSidecarStore, StaleDiarizationRun
    from src.speaker_suggestions import (
        clusters_from_sidecar_channel,
        extract_segment_samples,
        extract_speaker_sample_audio,
        merge_same_channel_fragments,
        read_speakers_sidecar,
    )

    dirs = get_data_dirs()
    if expected_run_id is not None:
        try:
            SpeakerSidecarStore(dirs["output"]).assert_current(meeting_stem, expected_run_id)
        except StaleDiarizationRun as error:
            print(json.dumps({
                "success": False,
                "error": str(error),
                "error_code": error.error_code,
            }))
            sys.exit(1)
    sidecar = read_speakers_sidecar(dirs["output"], meeting_stem)
    if sidecar is None:
        print(json.dumps({"success": False, "error": f"No speakers sidecar found for {meeting_stem!r}"}))
        sys.exit(1)
    channel_data = (sidecar.get("channels") or {}).get(channel)
    if channel_data is None:
        print(json.dumps({"success": False, "error": f"No {channel!r} channel in sidecar for {meeting_stem!r}"}))
        sys.exit(1)

    raw_clusters = clusters_from_sidecar_channel(meeting_stem, channel_data)
    if diarization_speaker_id not in raw_clusters:
        print(json.dumps({
            "success": False,
            "error": f"No cluster {diarization_speaker_id!r} in {channel!r} channel of {meeting_stem!r}",
        }))
        sys.exit(1)

    clusters, id_resolution = merge_same_channel_fragments(raw_clusters)
    resolved_id = id_resolution[diarization_speaker_id]
    context = clusters[resolved_id][1]

    recording_path = _find_recording_file(dirs["recordings"], meeting_stem)
    if recording_path is None:
        print(json.dumps({"success": False, "error": "no source audio available"}))
        return

    raw_clusters_by_id = channel_data.get("clusters") or {}
    pooled_segments = [
        seg
        for fragment_id in [resolved_id, *context.merged_from]
        for seg in (raw_clusters_by_id.get(fragment_id, {}).get("segments") or [])
    ]

    # Resolve the index against the SAME list suggest-speakers rendered, so
    # the clip and the text beside it are the same moment. Built here rather
    # than inside the extractor because the list depends on the sidecar's
    # turn manifest, which only this command has loaded.
    target = None
    if segment_index is not None:
        samples = extract_segment_samples(
            dirs["transcripts"] / f"{meeting_stem}_transcript.txt",
            pooled_segments,
            turn_manifest=sidecar.get("transcript_lines"),
            target_ids={(channel, fid) for fid in [resolved_id, *context.merged_from]},
        )
        if not 0 <= segment_index < len(samples):
            print(json.dumps({
                "success": False,
                "error": f"No sample {segment_index} for {diarization_speaker_id!r}",
            }))
            return
        target = {"start": samples[segment_index]["start"], "end": samples[segment_index]["end"]}

    with tempfile.NamedTemporaryFile(
        prefix="steno-sample-",
        suffix=".wav",
        delete=False,
    ) as temp_audio:
        output_path = Path(temp_audio.name)
    try:
        ok = extract_speaker_sample_audio(
            recording_path, channel, pooled_segments, output_path,
            segment_index=target,
        )
        if not ok:
            print(json.dumps({"success": False, "error": "could not extract audio sample"}))
            return

        # Return the clip's bytes inline (base64), not a filesystem path: the
        # renderer's strict CSP (media-src 'self' blob:) has no file: allowance,
        # so a raw path could never actually play in the packaged app.
        import base64
        audio_bytes = output_path.read_bytes()
        print(json.dumps({
            "success": True,
            "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
        }))
    finally:
        output_path.unlink(missing_ok=True)


def _find_recording_file(recordings_dir, stem, extension=None):
    """Locate a meeting's source recording.

    `extension` (e.g. "webm"), if given, is the ONLY format considered --
    no auto-detection, no fallback to any other format present for that
    stem. Without it: the capture pipeline saves whatever format the
    source produced (`.webm` is the dominant one in real libraries, plus
    `.wav`/`.m4a`), so this prefers an exact `.wav` if one exists
    (already-decoded PCM), otherwise takes whatever's there -- ffmpeg
    (used throughout _split_stereo_to_channels/the Swift sidecar) decodes
    any container, so the extension doesn't otherwise matter."""
    if extension:
        path = recordings_dir / f"{stem}.{extension.lstrip('.')}"
        return path if path.exists() else None
    wav_path = recordings_dir / f"{stem}.wav"
    if wav_path.exists():
        return wav_path
    matches = sorted(recordings_dir.glob(f"{stem}.*"))
    return matches[0] if matches else None


def _enumerate_meeting_stems(output_dir):
    """Every meeting stem with a saved summary, JSON preferred over MD when
    both exist for the same stem -- same glob+dedupe shape as list_meetings/
    list_failed, without their "also rescan the default location after a
    custom storage_path change" migration handling (out of scope for a
    backfill/testing command)."""
    seen = set()
    stems = []
    for pattern in ("*_summary.json", "*_summary.md"):
        for f in sorted(output_dir.glob(pattern)):
            stem = f.stem.replace("_summary", "")
            if stem not in seen:
                seen.add(stem)
                stems.append(stem)
    return sorted(stems)


_MD_SECTION_HEADER_RE = re.compile(r"^## (.+?)\s*$")


def _update_summary_participants(output_dir: Path, meeting_stem: str, participant_names: list) -> None:
    """Overwrite {meeting_stem}_summary.{json,md}'s participants with
    `participant_names` (a full replace, not an append -- so a later
    Change/rename/delete on the person-profile side stays in sync the next
    time this is called for the same meeting). JSON preferred over MD when
    both exist, matching list_meetings' convention. Silently no-ops if
    neither summary file exists (a meeting can be deleted out from under a
    stale sidecar) -- this is a best-effort enhancement on a successful
    confirm/rename/delete, never something that should fail the caller.
    """
    json_path = output_dir / f"{meeting_stem}_summary.json"
    md_path = output_dir / f"{meeting_stem}_summary.md"

    if json_path.exists():
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError) as e:
            logger.warning(f"Could not read {json_path} to update participants: {e}")
            return
        if data.get("participants") == participant_names:
            return
        data["participants"] = participant_names
        _atomic_write_json(json_path, data)
        return

    if not md_path.exists():
        return
    try:
        original = md_path.read_text(encoding="utf-8")
    except OSError as e:
        logger.warning(f"Could not read {md_path} to update participants: {e}")
        return

    lines = original.split("\n")
    # Locate an existing "## Participants" section's span (header line plus
    # every following line up to the next "## " header or EOF) via a raw
    # line-level splice -- NOT a full parse/re-render through
    # _parse_meeting_markdown (which lowercases headers and loses exact
    # section order/formatting), so every other section's exact text is
    # left byte-for-byte untouched.
    section_start = None
    section_end = None
    summary_end = None  # line AFTER "## Summary"'s body, for insertion when no Participants section exists
    i = 0
    while i < len(lines):
        m = _MD_SECTION_HEADER_RE.match(lines[i])
        if m:
            header = m.group(1).strip().lower()
            body_start = i + 1
            body_end = body_start
            while body_end < len(lines) and not _MD_SECTION_HEADER_RE.match(lines[body_end]):
                body_end += 1
            if header == "participants":
                section_start, section_end = i, body_end
            elif header == "summary" and summary_end is None:
                summary_end = body_end
            i = body_end
            continue
        i += 1

    new_section = ["## Participants", ""]
    if participant_names:
        new_section.append(", ".join(participant_names))
        new_section.append("")

    if section_start is not None:
        if participant_names:
            spliced = lines[:section_start] + new_section + lines[section_end:]
        else:
            # No participants left (e.g. the only confirmed person was
            # deleted) -- drop the section entirely rather than writing an
            # empty one, so the parser's `if 'participants' in sections`
            # branch correctly falls back to [].
            spliced = lines[:section_start] + lines[section_end:]
    elif participant_names:
        if summary_end is None:
            # No "## Summary" section found (shouldn't happen for any
            # summary this codebase writes) -- append at the end rather
            # than silently dropping the update.
            spliced = lines + [""] + new_section
        else:
            # Every section this codebase writes already ends its body with
            # a blank separator line before the next "## " header (or EOF),
            # so `lines[:summary_end]` already ends in "" -- no extra blank
            # needed here, or every insertion would leave a double blank.
            spliced = lines[:summary_end] + new_section + lines[summary_end:]
    else:
        return  # nothing to add, nothing to remove

    if spliced == lines:
        return

    tmp_path = md_path.with_name(md_path.name + ".tmp")
    tmp_path.write_text("\n".join(spliced), encoding="utf-8")
    tmp_path.replace(md_path)


@cli.command(name='backfill-speaker-embeddings')
@click.option('--limit', type=int, default=None,
              help='Process at most N meetings that actually need it (already-processed/no-audio '
                   'meetings don\'t count against this).')
@click.option('--extension', 'extension', default=None,
              help='Only consider recordings with this extension (e.g. "webm"), no auto-detection/fallback to '
                   'other formats for the same meeting. Default: prefer .wav, else whatever format is present.')
@click.option('--force', is_flag=True, default=False,
              help='Reprocess meetings that already have a {stem}_speakers.json sidecar '
                   '(default: skip them -- diarization + embedding extraction is expensive, '
                   'sometimes 10+ minutes for a long recording).')
@click.option('--meeting', 'meeting_stem', default=None,
              help='Process only this one meeting stem, ignoring --limit/the already-processed skip '
                   '(always reprocesses it) -- for refreshing a single meeting (e.g. after a sidecar '
                   'schema change) without re-doing the whole library via --force.')
def backfill_speaker_embeddings(limit, extension, force, meeting_stem):
    """Re-diarize + extract speaker embeddings for every existing meeting
    whose source audio is still on disk, writing {stem}_speakers.json
    sidecars for src.speaker_suggestions to read.

    Diarizes and embeds only -- explicitly skips ASR/_tag_channel_segments/
    transcribe_diarised entirely, so this never re-transcribes anything and
    NEVER touches a meeting's saved transcript file.

    Skips meetings that already have a sidecar by default -- pass --force
    to redo them all (e.g. after a diarize-sidecar/embedding-quality
    change), or --meeting <stem> to refresh just one. Meetings with no
    source recording on disk (keep_recordings defaults to False, so many
    historical meetings won't have one) are always skipped and reported,
    never treated as failures. The capture pipeline saves whatever format
    the source produced (.webm/.wav/.m4a, no single fixed extension) --
    use --extension to restrict to exactly one format instead of the
    default auto-detection.
    """
    from src.config import get_config, get_data_dirs
    from src.transcriber import WhisperTranscriber, STENO_DIARIZE_TIMEOUT_FLOOR_S, _run_steno_diarize
    from src.speaker_suggestions import (
        build_clusters_from_diarization, count_review_markings,
        determine_recording_type, read_speakers_sidecar,
        speakers_sidecar_path, write_speakers_sidecar,
    )

    # This command exists specifically to extract+persist speaker
    # embeddings outside the normal per-meeting pipeline, which is exactly
    # what identity_matching_enabled=False turns off there (see
    # src.transcriber._identity_matching_enabled) -- without this check,
    # the setting would be silently bypassable by just running this CLI.
    if not get_config().get_identity_matching_enabled():
        print(json.dumps({
            "success": False,
            "error": "Identity matching is disabled in settings; not extracting speaker embeddings.",
        }))
        sys.exit(1)

    dirs = get_data_dirs()
    output_dir = dirs["output"]
    recordings_dir = dirs["recordings"]

    skipped_already_processed = []
    if meeting_stem:
        all_stems = [meeting_stem]
        stems = [meeting_stem]  # explicitly named -> always (re)process it
    else:
        all_stems = _enumerate_meeting_stems(output_dir)
        stems = []
        for stem in all_stems:
            if not force and speakers_sidecar_path(output_dir, stem).exists():
                skipped_already_processed.append(stem)
                continue
            stems.append(stem)
        if limit:
            stems = stems[:limit]

    # No model load needed -- _split_stereo_to_channels/_check_rms_energy
    # are pure audio-file helpers that don't touch instance state.
    transcriber = WhisperTranscriber.__new__(WhisperTranscriber)

    processed = []
    skipped_no_audio = []
    skipped_no_clusters = []
    lost_multi_speaker_markings = []
    lost_review_state_markings = []
    errors = []

    for stem in stems:
        recording_path = _find_recording_file(recordings_dir, stem, extension=extension)
        if recording_path is None:
            skipped_no_audio.append(stem)
            continue
        # Read BEFORE the re-diarization overwrites it, so the report below
        # can name what this run is about to discard.
        previous_sidecar = read_speakers_sidecar(output_dir, stem)
        try:
            mic_path, system_path, duration = transcriber._split_stereo_to_channels(recording_path)
            channel_paths = [("mic", mic_path), ("system", system_path)] if mic_path else [("mic", recording_path)]

            channels_out = {}
            for channel_name, channel_path in channel_paths:
                if channel_path is None:
                    continue
                has_audio = transcriber._check_rms_energy(channel_path)
                if not has_audio:
                    continue
                timeout = max(STENO_DIARIZE_TIMEOUT_FLOOR_S, int(duration or 0))
                result = _run_steno_diarize(channel_path, timeout, extra_env=_DIARIZE_BULK_ENV)
                if not result:
                    continue
                segments, embeddings = result
                if not embeddings:
                    continue

                clusters = build_clusters_from_diarization(segments, embeddings)
                if not clusters:
                    continue
                channels_out[channel_name] = {
                    "recording_type": determine_recording_type(channel_name, has_audio=True),
                    "clusters": clusters,
                }

            if channels_out:
                # Re-diarizing replaces the sidecar wholesale, and a
                # human's "this cluster holds more than one person" marking
                # cannot survive that: the new run numbers its clusters
                # independently, so the old ids describe nothing here. The
                # marking is genuinely gone rather than transferable -- but
                # it is the one thing in that file no re-run can reproduce,
                # so losing it is reported instead of silent.
                # Counted by the shared helper, so this report and
                # _persist_speaker_sidecar's cannot drift apart on what
                # counts as a marking (they are the only two places one is
                # ever lost).
                dropped = count_review_markings(previous_sidecar)
                if dropped["multi_speaker"]:
                    logger.warning(
                        "backfill-speaker-embeddings: %s had %d cluster(s) marked as "
                        "containing multiple speakers; re-diarization discards those markings.",
                        stem, dropped["multi_speaker"],
                    )
                    lost_multi_speaker_markings.append(
                        {"stem": stem, "clusters": dropped["multi_speaker"]})
                if dropped["review_state"]:
                    logger.warning(
                        "backfill-speaker-embeddings: %s had %d cluster(s) kept generic; "
                        "re-diarization discards those markings.",
                        stem, dropped["review_state"],
                    )
                    lost_review_state_markings.append(
                        {"stem": stem, "clusters": dropped["review_state"]})
                write_speakers_sidecar(output_dir, stem, channels_out)
                processed.append(stem)
            else:
                # A real audio file WAS found and diarization ran against
                # it -- distinct from skipped_no_audio (no file at all).
                # These used to share one list, which read as "no audio
                # found" for a meeting that in fact had audio and simply
                # produced no usable clusters (e.g. every channel fell
                # back to legacy single-speaker labeling, or a real
                # diarization failure) -- actively misleading when
                # diagnosing why a specific meeting has no sidecar.
                skipped_no_clusters.append(stem)
        except Exception as e:
            logger.warning(f"backfill-speaker-embeddings failed for {stem}: {e}")
            errors.append({"stem": stem, "error": str(e)})

    print(json.dumps({
        "success": True,
        "processed": processed,
        "skipped_no_audio": skipped_no_audio,
        "skipped_no_clusters": skipped_no_clusters,
        "skipped_already_processed": skipped_already_processed,
        "lost_multi_speaker_markings": lost_multi_speaker_markings,
        # Same shape and the same reason: a marking is a human statement the
        # re-diarization cannot carry over, and the only one in this file no
        # re-run can reproduce.
        "lost_review_state_markings": lost_review_state_markings,
        "errors": errors,
        "total_meetings": len(all_stems),
    }))


@cli.command(name='backfill-participants')
@click.option(
    '--relabel-transcripts', is_flag=True, default=False,
    help="Also retroactively relabel each meeting's saved transcript for every confirmed "
         "prototype -- safe/idempotent to rerun even where a transcript was already relabeled "
         "at confirm time. Off by default: this only matters for meetings confirmed via the "
         "bare CLI before the review UI existed (the UI always relabels at confirm time already).",
)
def backfill_participants(relabel_transcripts):
    """Recompute and write the Participants section/field for every meeting
    that has at least one confirmed person-profile prototype -- for
    meetings confirmed before this feature existed (see the plan doc's
    Phase 7). Read-only against person_profiles (creates no new
    prototypes/hard-negatives); only writes each meeting's summary file,
    and with --relabel-transcripts, its saved transcript."""
    from src.config import get_config, get_data_dirs
    from src.speaker_suggestions import (
        clusters_from_sidecar_channel,
        confirmed_participant_names,
        merge_same_channel_fragments,
        prototype_channel_matches,
        prototype_run_matches,
        read_speakers_sidecar,
        relabel_transcript_exact,
        relabel_transcript_multi,
    )

    config = get_config()
    profiles = config.get_person_profiles()
    dirs = get_data_dirs()
    output_dir = dirs["output"]
    transcripts_dir = dirs["transcripts"]

    meeting_ids = sorted({
        p.get("meeting_id")
        for person in profiles
        for p in (person.get("prototypes") or [])
        if p.get("meeting_id")
    })

    meetings_updated = []
    transcripts_relabeled = {}
    transcripts_skipped_ambiguous = {}
    for meeting_id in meeting_ids:
        names = confirmed_participant_names(meeting_id, profiles)
        _update_summary_participants(output_dir, meeting_id, names)
        meetings_updated.append({"meeting_id": meeting_id, "participants": names})

        if not relabel_transcripts:
            continue
        sidecar = read_speakers_sidecar(output_dir, meeting_id)
        if sidecar is None:
            continue
        transcript_path = transcripts_dir / f"{meeting_id}_transcript.txt"

        # Collect every (channel, display_name, resolved+merged ids,
        # segments, created_at) claim across ALL channels/people FIRST,
        # then relabel in one pass. Exact matching (when the sidecar has a
        # transcript_lines manifest) needs only the resolved ids per
        # person; the fuzzy fallback (relabel_transcript_multi, for
        # meetings recorded before the manifest existed) additionally
        # needs pooled_segments. Building both unconditionally is cheap
        # and keeps the branch below simple.
        turn_manifest = sidecar.get("transcript_lines")
        # Which run these cluster ids belong to. Relabeling reads a
        # prototype as "this person IS this cluster" and then writes their
        # name into the transcript, so it is scoped like every other reader
        # of a current assignment -- and unlike the participants line
        # above, which is deliberately not (see confirmed_participant_names).
        sidecar_run_id = (sidecar.get("diarization_run") or {}).get("run_id")
        assignments = []
        target_ids_by_name: dict = {}
        for channel_name, channel_data in (sidecar.get("channels") or {}).items():
            raw_clusters = clusters_from_sidecar_channel(meeting_id, channel_data)
            clusters, id_resolution = merge_same_channel_fragments(raw_clusters)
            raw_clusters_by_id = channel_data.get("clusters") or {}
            recording_type = channel_data.get("recording_type")
            for person in profiles:
                for prototype in (person.get("prototypes") or []):
                    if prototype.get("meeting_id") != meeting_id or not prototype_channel_matches(
                        prototype, channel_name, recording_type,
                    ):
                        continue
                    if not prototype_run_matches(prototype, sidecar_run_id):
                        # Confirmed against a run this sidecar no longer
                        # describes. The id survived the re-diarization, but
                        # the voice behind it did not, so writing this name
                        # onto its lines would put one participant's name on
                        # another's words -- the failure this whole slice
                        # exists to stop, and here it lands in the file the
                        # user reads as the record of the meeting.
                        continue
                    sid = prototype.get("diarization_speaker_id")
                    if sid not in id_resolution:
                        continue  # sidecar regenerated since this prototype was confirmed
                    resolved_id = id_resolution[sid]
                    _, context = clusters[resolved_id]
                    fragment_ids = [resolved_id, *context.merged_from]
                    display_name = person["display_name"]
                    target_ids_by_name.setdefault(display_name, set()).update(
                        (channel_name, fid) for fid in fragment_ids
                    )
                    pooled_segments = []
                    for fragment_id in fragment_ids:
                        pooled_segments.extend(raw_clusters_by_id.get(fragment_id, {}).get("segments") or [])
                    assignments.append((
                        channel_name, display_name, pooled_segments,
                        prototype.get("created_at") or 0,
                    ))

        if turn_manifest:
            # Exact recorded provenance -- immune to the fuzzy-matching
            # cross-channel/same-channel mislabeling relabel_transcript_multi's
            # collision detection can only partially guard against (see
            # relabel_transcript_exact's docstring and the plan doc's
            # Phase 8). Order doesn't matter here (unlike the fuzzy path):
            # each manifest entry has exactly one true (channel, sid), so
            # relabeling different people sequentially can't thrash.
            changed_here = 0
            for display_name, target_ids in target_ids_by_name.items():
                changed_here += relabel_transcript_exact(transcript_path, turn_manifest, target_ids, display_name)
            if changed_here:
                transcripts_relabeled[meeting_id] = changed_here
            continue

        # Fuzzy fallback for meetings recorded before the manifest existed.
        # Sorted oldest-first so a later "Change" correction on the SAME
        # channel still wins (see relabel_transcript_multi's docstring).
        assignments.sort(key=lambda a: a[3])
        changed_here, skipped_here = relabel_transcript_multi(
            transcript_path, [(c, n, s) for c, n, s, _ in assignments],
        )
        if changed_here:
            transcripts_relabeled[meeting_id] = changed_here
        if skipped_here:
            transcripts_skipped_ambiguous[meeting_id] = skipped_here

    print(json.dumps({
        "success": True,
        "meetings_updated": meetings_updated,
        "transcripts_relabeled": transcripts_relabeled,
        "transcripts_skipped_ambiguous": transcripts_skipped_ambiguous,
    }))


@cli.command(name='speaker-suggestion-report')
def speaker_suggestion_report():
    """Human-readable accuracy report: runs suggest-speakers over every
    meeting with a {stem}_speakers.json sidecar (from
    backfill-speaker-embeddings or the live pipeline) against the real
    person-profile library, so suggestion quality can be inspected before
    any approval UI exists. Same purpose as this session's AMI three-bucket
    reports, but against real meetings instead of a proxy dataset -- see
    the plan doc's Phase 3."""
    from src.config import get_config, get_data_dirs
    from src.speaker_suggestions import (
        clusters_from_sidecar_channel,
        merge_same_channel_fragments,
        suggest_speakers_for_meeting,
    )

    output_dir = get_data_dirs()["output"]
    config = get_config()
    profiles = config.get_person_profiles()
    if not profiles:
        print("No person profiles stored yet -- nothing to suggest against.")
        print("Create one with: simple_recorder.py create-person-profile <name>")
        return

    sidecar_files = sorted(output_dir.glob("*_speakers.json"))
    if not sidecar_files:
        print("No speakers sidecars found -- run backfill-speaker-embeddings first.")
        return

    total_clusters = 0
    status_counts = {"confirmed": 0, "possible": 0, "none": 0}
    # (meeting, sid, embedding, context) per merged MIC cluster, for the
    # self-match diagnostics section below.
    self_rows = []

    for sidecar_file in sidecar_files:
        stem = sidecar_file.stem.replace("_speakers", "")
        try:
            sidecar = json.loads(sidecar_file.read_text())
        except (json.JSONDecodeError, OSError) as e:
            print(f"{stem}: could not read sidecar ({e})")
            continue

        print(f"=== {stem} ===")
        merged_by_channel = {}
        for channel_name, channel in (sidecar.get("channels") or {}).items():
            raw_clusters = clusters_from_sidecar_channel(stem, channel)
            # Same-recording diarizer fragments of one voice (see the plan
            # doc's Phase 3.6) collapse before scoring/reporting.
            merged_by_channel[channel_name], _ = merge_same_channel_fragments(raw_clusters)
            for sid, (embedding, context) in merged_by_channel[channel_name].items():
                if context.merged_from:
                    print(f"  [{channel_name}] merged: {sid}, {', '.join(context.merged_from)} "
                          "(same-recording fragments of one voice)")
                if channel_name == "mic":
                    self_rows.append((stem, sid, embedding, context))
        results_by_channel = suggest_speakers_for_meeting(merged_by_channel, profiles)
        for channel_name in merged_by_channel:
            results = results_by_channel[channel_name]
            for sid in sorted(results):
                result = results[sid]
                total_clusters += 1
                status_counts[result.status] = status_counts.get(result.status, 0) + 1
                top = result.candidates[0] if result.candidates else None
                top_desc = f"{top.display_name!r} @ {top.distance:.4f}" if top else "no candidates"
                print(f"  [{channel_name}] {sid}: status={result.status} "
                      f"suggested={result.suggested_name!r} top_candidate={top_desc}")

    print()
    print(f"=== {total_clusters} clusters across {len(sidecar_files)} meetings ===")
    for status, count in status_counts.items():
        print(f"  {status}: {count}")

    # --- Self ("You") match diagnostics --------------------------------
    # The self path is separate from person-profile suggestions: it matches
    # mic-channel clusters against the enrolled self voiceprint
    # (src.transcriber._apply_voiceprint_matches) and fails SILENTLY --
    # labels just fall back to the dominant-duration guess, so a user whose
    # own voice never matches sees nothing except "it doesn't say You".
    # Print where every mic cluster actually lands relative to the
    # threshold, split by anchor (long-term centroid vs recent-samples
    # FIFO), so a failing self-match can be diagnosed with numbers instead
    # of guesses: re-enroll, re-tune, or accept.
    from src.transcriber import VOICEPRINT_DISTANCE_THRESHOLD, _voiceprint_distance
    from src.voiceprint import cosine_distance

    print()
    self_vp = next((v for v in config.get_voiceprints() if v.get("is_self")), None)
    if self_vp is None:
        print("=== self-match: NO self voiceprint enrolled ===")
        print('  The "You" label is never voice-matched without one -- enroll with:')
        print("  simple_recorder.py enroll-voiceprint <name> <audio_file> --is-self")
        return
    if not self_rows:
        print("=== self-match: no mic clusters found in any sidecar ===")
        return

    print(f"=== self-match: {len(self_rows)} mic clusters vs self voiceprint "
          f"{self_vp.get('name')!r} (threshold {VOICEPRINT_DISTANCE_THRESHOLD}) ===")
    sweep_thresholds = (VOICEPRINT_DISTANCE_THRESHOLD, 0.45, 0.50)
    sweep_counts = {t: 0 for t in sweep_thresholds}
    for stem, sid, embedding, context in self_rows:
        overall = _voiceprint_distance(embedding, self_vp)
        centroid = self_vp.get("centroid")
        centroid_desc = f"{cosine_distance(embedding, centroid):.4f}" if centroid else "n/a"
        fifo = list(self_vp.get("embeddings") or [])
        fifo_desc = (
            f"{min(cosine_distance(embedding, a) for a in fifo):.4f}" if fifo else "n/a"
        )
        for t in sweep_thresholds:
            if overall < t:
                sweep_counts[t] += 1
        verdict = "MATCH" if overall < VOICEPRINT_DISTANCE_THRESHOLD else "no match"
        print(f"  {stem} [{sid}]: distance={overall:.4f} ({verdict}) "
              f"centroid={centroid_desc} recent-best={fifo_desc} "
              f"duration={context.speech_duration_seconds:.0f}s "
              f"segments={context.segment_count}")
    print("  -- would match: "
          + ", ".join(f"{sweep_counts[t]} under {t:.2f}" for t in sweep_thresholds))
    print("  note: live matching only runs when a mic channel has 2+ clusters, "
          "and only the single closest cluster per meeting gets the label.")


@cli.command(name='repair-speaker-profiles')
@click.option(
    '--apply', 'apply_changes', is_flag=True, default=False,
    help="Write the repairs. Without this flag: dry run -- print the full report, change nothing.",
)
def repair_speaker_profiles(apply_changes):
    """One-time cleanup of stored person-profile evidence, for libraries
    built before the cross-channel confirm fix. Dry run by default; pass
    --apply to write. Three passes:

    A) Drop hard negatives created by the (since fixed) cross-channel id
       collision: mic and system channels number clusters independently, so
       confirm-speaker used to mistake "same meeting, same SPEAKER_N" on the
       OTHER channel for a same-channel confirmation and record negatives
       built from the wrong channel's clusters. Detectable after the fact:
       the negative's recording_type doesn't match the recording_type of the
       positive prototype it was derived from (both known, not "unknown").

    B) Dedupe entries sharing (meeting_id, diarization_speaker_id, channel)
       within one person's prototypes or hard_negatives -- re-confirms used
       to append instead of replace. Keeps the oldest.

    C) Backfill the channel field onto legacy entries from their meeting's
       sidecar (unique cluster-id ownership, disambiguated by recording_type
       when both channels share the id), so the recording_type fallback in
       prototype_channel_matches shrinks to entries whose sidecar is gone.
    """
    from src.config import get_config, get_data_dirs
    from src.speaker_suggestions import prototype_run_matches, read_speakers_sidecar

    config = get_config()
    profiles = config.get_person_profiles()
    output_dir = get_data_dirs()["output"]

    # (person_id, negative?) -> set of prototype_ids to drop / {id: channel}
    drops: dict = {}
    backfills: dict = {}
    per_person: dict = {}
    details = []

    def _stats(person):
        return per_person.setdefault(person["display_name"], {
            "collision_negatives_dropped": 0, "duplicates_removed": 0, "channels_backfilled": 0,
        })

    # Pass A -- collision-created hard negatives.
    for person in profiles:
        for negative in (person.get("hard_negatives") or []):
            n_meeting = negative.get("meeting_id")
            n_sid = negative.get("diarization_speaker_id")
            n_rt = negative.get("recording_type")
            if not negative.get("prototype_id") or not n_meeting or not n_sid or n_rt in (None, "unknown"):
                continue
            # Same run only. "This negative cites a cluster its owner holds
            # on the other channel" is evidence of a collision only if both
            # entries describe the same diarization run; across runs the id
            # was simply handed to a different voice, and reading that as a
            # collision would delete a negative that is exactly right for
            # the run it came from.
            owner_rts = {
                p.get("recording_type")
                for other in profiles if other["person_id"] != person["person_id"]
                for p in (other.get("prototypes") or [])
                if p.get("meeting_id") == n_meeting and p.get("diarization_speaker_id") == n_sid
                and prototype_run_matches(p, negative.get("diarization_run_id"))
            }
            owner_rts.discard(None)
            owner_rts.discard("unknown")
            if owner_rts and n_rt not in owner_rts:
                drops.setdefault((person["person_id"], True), set()).add(negative.get("prototype_id"))
                _stats(person)["collision_negatives_dropped"] += 1
                details.append(
                    f"{person['display_name']}: drop hard-negative from {n_meeting}/{n_sid} "
                    f"({n_rt} vs confirmed {'/'.join(sorted(owner_rts))}) -- cross-channel collision"
                )

    # Pass B -- duplicates within one person's list (oldest kept). The key
    # includes channel (recording_type for legacy entries): the same
    # SPEAKER_N on mic and system are different clusters, not duplicates.
    # It includes the diarization run for the same reason one step further
    # out: since confirmations are run-scoped, one person legitimately holds
    # the same meeting+channel+id twice, once per run. Without the run in
    # the key this pass drops the NEWER of the two -- keeping the superseded
    # entry and deleting the one that describes the meeting as it is now.
    for person in profiles:
        for negative_flag, key_name in ((False, "prototypes"), (True, "hard_negatives")):
            seen = set()
            entries = sorted(
                person.get(key_name) or [], key=lambda e: e.get("created_at") or 0,
            )
            already_dropped = drops.get((person["person_id"], negative_flag), set())
            for entry in entries:
                if not entry.get("prototype_id") or entry.get("prototype_id") in already_dropped:
                    continue
                meeting_id = entry.get("meeting_id")
                sid = entry.get("diarization_speaker_id")
                if not meeting_id or not sid:
                    continue
                dedupe_key = (
                    meeting_id, sid,
                    entry.get("channel") or entry.get("recording_type"),
                    entry.get("diarization_run_id"),
                )
                if dedupe_key in seen:
                    drops.setdefault((person["person_id"], negative_flag), set()).add(entry.get("prototype_id"))
                    _stats(person)["duplicates_removed"] += 1
                    details.append(
                        f"{person['display_name']}: drop duplicate "
                        f"{'hard-negative' if negative_flag else 'prototype'} from {meeting_id}/{sid}"
                    )
                else:
                    seen.add(dedupe_key)

    # Pass C -- backfill channel from the meeting's sidecar.
    sidecar_cache: dict = {}
    for person in profiles:
        for negative_flag, key_name in ((False, "prototypes"), (True, "hard_negatives")):
            already_dropped = drops.get((person["person_id"], negative_flag), set())
            for entry in person.get(key_name) or []:
                if (
                    not entry.get("prototype_id")
                    or entry.get("channel") is not None
                    or entry.get("prototype_id") in already_dropped
                ):
                    continue
                meeting_id = entry.get("meeting_id")
                sid = entry.get("diarization_speaker_id")
                if not meeting_id or not sid:
                    continue
                if meeting_id not in sidecar_cache:
                    sidecar_cache[meeting_id] = read_speakers_sidecar(output_dir, meeting_id)
                sidecar = sidecar_cache[meeting_id]
                if sidecar is None:
                    continue
                if not prototype_run_matches(
                    entry, (sidecar.get("diarization_run") or {}).get("run_id"),
                ):
                    # The sidecar describes a different run, so the cluster
                    # this id resolves to is whatever the diarizer numbered
                    # that way this time. Writing its channel onto the entry
                    # would turn a guess into recorded fact, and every later
                    # prototype_channel_matches would trust it. Left legacy,
                    # it keeps the recording_type proxy, which at least
                    # admits to being one.
                    continue
                owners = [
                    name for name, ch in (sidecar.get("channels") or {}).items()
                    if sid in (ch.get("clusters") or {})
                ]
                if len(owners) > 1:
                    owners = [
                        name for name in owners
                        if (sidecar["channels"][name].get("recording_type")) == entry.get("recording_type")
                    ]
                if len(owners) != 1 or owners[0] not in ("mic", "system"):
                    continue
                backfills.setdefault((person["person_id"], negative_flag), {})[entry["prototype_id"]] = owners[0]
                _stats(person)["channels_backfilled"] += 1

    if apply_changes:
        for (person_id, negative_flag), entry_ids in drops.items():
            config.remove_speaker_evidence_by_ids(person_id, entry_ids, negative=negative_flag)
        for (person_id, negative_flag), channels_by_id in backfills.items():
            config.set_speaker_evidence_channels(person_id, channels_by_id, negative=negative_flag)

    print(json.dumps({
        "success": True,
        "applied": apply_changes,
        "collision_negatives_dropped": sum(s["collision_negatives_dropped"] for s in per_person.values()),
        "duplicates_removed": sum(s["duplicates_removed"] for s in per_person.values()),
        "channels_backfilled": sum(s["channels_backfilled"] for s in per_person.values()),
        "people": per_person,
        "details": details,
    }, indent=2))


@cli.command()
def get_notifications():
    """Get the current notification preference"""
    from src.config import get_config

    config = get_config()
    enabled = config.get_notifications_enabled()

    result = {
        "notifications_enabled": enabled
    }

    print(json.dumps(result, indent=2))


@cli.command()
@click.argument('enabled', type=bool)
def set_notifications(enabled):
    """Set notification preference (True/False)"""
    from src.config import get_config

    config = get_config()
    success = config.set_notifications_enabled(enabled)

    if success:
        print(f"SUCCESS: Notifications {'enabled' if enabled else 'disabled'}")
        print(json.dumps({"success": True, "notifications_enabled": enabled}))
    else:
        print(f"ERROR: Failed to save notification preference")
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
def get_record_hotkey():
    """Get the current global record shortcut preference"""
    from src.config import get_config

    config = get_config()
    enabled = config.get_record_hotkey_enabled()

    result = {
        "record_hotkey_enabled": enabled
    }

    print(json.dumps(result, indent=2))


@cli.command()
@click.argument('enabled', type=bool)
def set_record_hotkey(enabled):
    """Set global record shortcut preference (True/False)"""
    from src.config import get_config

    config = get_config()
    success = config.set_record_hotkey_enabled(enabled)

    if success:
        print(f"SUCCESS: Record shortcut {'enabled' if enabled else 'disabled'}")
        print(json.dumps({"success": True, "record_hotkey_enabled": enabled}))
    else:
        print("ERROR: Failed to save record shortcut preference")
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
def get_dock_icon():
    """Get the current hide-dock-icon preference"""
    from src.config import get_config

    config = get_config()
    enabled = config.get_hide_dock_icon()

    print(json.dumps({"hide_dock_icon": enabled}))


@cli.command()
def get_org_auto_backup():
    """Get whether org auto-backup is enabled."""
    from src.config import get_config

    config = get_config()
    print(json.dumps({
        "org_auto_backup_enabled": config.get_org_auto_backup_enabled(),
        "org_auto_backup_preference_set": config.has_org_auto_backup_preference(),
    }))


@cli.command()
@click.argument('enabled', type=bool)
def set_org_auto_backup(enabled):
    """Set whether org auto-backup is enabled (True/False)."""
    from src.config import get_config

    config = get_config()
    success = config.set_org_auto_backup_enabled(enabled)
    if success:
        print(json.dumps({"success": True, "org_auto_backup_enabled": enabled}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
@click.argument('default', type=bool)
def seed_org_auto_backup(default):
    """Seed org auto-backup from the adapter's auto_share_default policy,
    only when the user has no stored preference yet (set-the-default-only)."""
    from src.config import get_config

    config = get_config()
    effective = config.seed_org_auto_backup_default(default)
    print(json.dumps({"success": True, "org_auto_backup_enabled": effective}))


@cli.command()
@click.argument('enabled', type=bool)
def set_dock_icon(enabled):
    """Set hide-dock-icon preference (True/False)"""
    from src.config import get_config

    config = get_config()
    success = config.set_hide_dock_icon(enabled)

    if success:
        print(f"SUCCESS: Hide dock icon {'enabled' if enabled else 'disabled'}")
        print(json.dumps({"success": True, "hide_dock_icon": enabled}))
    else:
        print(f"ERROR: Failed to save hide dock icon preference")
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
def get_menu_bar_icon():
    """Get the current show-menu-bar-icon preference"""
    from src.config import get_config

    config = get_config()
    enabled = config.get_show_menu_bar_icon()

    print(json.dumps({"show_menu_bar_icon": enabled}))


@cli.command()
@click.argument('enabled', callback=lambda ctx, param, v: v.lower() == 'true')
def set_menu_bar_icon(enabled):
    """Set show-menu-bar-icon preference (True/False)"""
    from src.config import get_config

    config = get_config()
    success = config.set_show_menu_bar_icon(enabled)

    if success:
        print(f"SUCCESS: Show menu bar icon {'enabled' if enabled else 'disabled'}")
        print(json.dumps({"success": True, "show_menu_bar_icon": enabled}))
    else:
        print(f"ERROR: Failed to save show menu bar icon preference")
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
def get_telemetry():
    """Get the current telemetry preference and anonymous ID"""
    from src.config import get_config

    config = get_config()
    enabled = config.get_telemetry_enabled()
    anonymous_id = config.get_anonymous_id()

    result = {
        "telemetry_enabled": enabled,
        "anonymous_id": anonymous_id
    }

    print(json.dumps(result, indent=2))


@cli.command()
@click.argument('enabled', type=bool)
def set_telemetry(enabled):
    """Set telemetry preference (True/False)"""
    from src.config import get_config

    config = get_config()
    success = config.set_telemetry_enabled(enabled)

    if success:
        print(f"SUCCESS: Telemetry {'enabled' if enabled else 'disabled'}")
        print(json.dumps({"success": True, "telemetry_enabled": enabled}))
    else:
        print(f"ERROR: Failed to save telemetry preference")
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
def get_privacy_notice_seen():
    """Get whether the one-time privacy notice has been acknowledged."""
    from src.config import get_config

    config = get_config()
    print(json.dumps({"privacy_notice_seen": config.get_privacy_notice_seen()}))


@cli.command()
def set_privacy_notice_seen():
    """Mark the one-time privacy notice as acknowledged."""
    from src.config import get_config

    config = get_config()
    success = config.set_privacy_notice_seen(True)
    if success:
        print(json.dumps({"success": True, "privacy_notice_seen": True}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
def get_system_audio():
    """Get the current system audio capture preference"""
    from src.config import get_config

    config = get_config()
    enabled = config.get_system_audio_enabled()

    print(json.dumps({"system_audio_enabled": enabled}))


@cli.command()
@click.argument('enabled', callback=lambda ctx, param, v: v.lower() == 'true')
def set_system_audio(enabled):
    """Set system audio capture preference (True/False)"""
    from src.config import get_config

    config = get_config()
    success = config.set_system_audio_enabled(enabled)

    if success:
        print(f"SUCCESS: System audio capture {'enabled' if enabled else 'disabled'}")
        print(json.dumps({"success": True, "system_audio_enabled": enabled}))
    else:
        print(f"ERROR: Failed to save system audio preference")
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
def get_auto_detect_meetings():
    """Get the current auto-detect meetings preference"""
    from src.config import get_config

    config = get_config()
    enabled = config.get_auto_detect_meetings_enabled()

    print(json.dumps({"auto_detect_meetings_enabled": enabled}))


@cli.command()
@click.argument('enabled', callback=lambda ctx, param, v: v.lower() == 'true')
def set_auto_detect_meetings(enabled):
    """Set auto-detect meetings preference (True/False)"""
    from src.config import get_config

    config = get_config()
    success = config.set_auto_detect_meetings_enabled(enabled)

    if success:
        print(json.dumps({"success": True, "auto_detect_meetings_enabled": enabled}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
def get_premeeting_notifications():
    """Get the current pre-meeting (calendar) notification preference"""
    from src.config import get_config

    config = get_config()
    enabled = config.get_premeeting_notifications_enabled()

    print(json.dumps({"premeeting_notifications_enabled": enabled}))


@cli.command()
@click.argument('enabled', callback=lambda ctx, param, v: v.lower() == 'true')
def set_premeeting_notifications(enabled):
    """Set pre-meeting (calendar) notification preference (True/False)"""
    from src.config import get_config

    config = get_config()
    success = config.set_premeeting_notifications_enabled(enabled)

    if success:
        print(json.dumps({"success": True, "premeeting_notifications_enabled": enabled}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
def get_launch_on_login():
    """Get the current launch-on-login preference"""
    from src.config import get_config

    config = get_config()
    enabled = config.get_launch_on_login()

    print(json.dumps({"launch_on_login": enabled}))


@cli.command()
@click.argument('enabled', callback=lambda ctx, param, v: v.lower() == 'true')
def set_launch_on_login(enabled):
    """Set launch-on-login preference (True/False)"""
    from src.config import get_config

    config = get_config()
    success = config.set_launch_on_login(enabled)

    if success:
        print(json.dumps({"success": True, "launch_on_login": enabled}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save config"}))


@cli.command()
def get_language():
    """Get the current language setting"""
    from src.config import get_config

    config = get_config()
    language = config.get_language()
    language_name = config.get_language_name(language)

    print(json.dumps({"language": language, "language_name": language_name}))


@cli.command()
@click.argument('language_code')
def set_language(language_code):
    """Set the language for transcription and summarization"""
    from src.config import get_config

    config = get_config()

    if language_code not in config.SUPPORTED_LANGUAGES:
        print(json.dumps({
            "success": False,
            "error": f"Unsupported language: {language_code}. Supported: {', '.join(config.SUPPORTED_LANGUAGES.keys())}"
        }))
        return

    success = config.set_language(language_code)

    if success:
        print(json.dumps({
            "success": True,
            "language": language_code,
            "language_name": config.get_language_name(language_code)
        }))
    else:
        print(json.dumps({"success": False, "error": "Failed to save language setting"}))


@cli.command(name='get-microphone')
def get_microphone_cmd():
    """Get the selected microphone device (null/null = system default)."""
    from src.config import get_config
    print(json.dumps(get_config().get_microphone_device()))


@cli.command(name='set-microphone')
@click.argument('device_id', default='')
@click.argument('label', default='')
def set_microphone_cmd(device_id, label):
    """Set the microphone device to record from ("default"/empty clears it)."""
    from src.config import get_config
    success = get_config().set_microphone_device(device_id or None, label or None)
    if success:
        result = get_config().get_microphone_device()
        print(json.dumps({"success": True, **result}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save microphone setting"}))


@cli.command(name='get-user-name')
def get_user_name_cmd():
    """Get the user's first name (for in-app greetings)."""
    from src.config import get_config
    print(json.dumps({"user_name": get_config().get_user_name()}))


@cli.command(name='set-user-name')
@click.argument('name', default='')
def set_user_name_cmd(name):
    """Set the user's first name. Empty string clears it."""
    from src.config import get_config
    success = get_config().set_user_name(name)
    if success:
        print(json.dumps({"success": True, "user_name": name.strip()}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save user name"}))


@cli.command()
def get_storage_path():
    """Get the current custom storage path"""
    from src.config import get_config
    config = get_config()
    storage_path = config.get_storage_path()
    print(json.dumps({"storage_path": storage_path}))


@cli.command()
@click.argument('storage_path', default='')
def set_storage_path(storage_path):
    """Set custom storage path (empty to reset to default)"""
    from src.config import get_config
    config = get_config()
    success = config.set_storage_path(storage_path)
    if success:
        print(json.dumps({"success": True, "storage_path": storage_path}))
    else:
        print(json.dumps({"success": False, "error": "Failed to set storage path"}))


@cli.command()
def list_folders():
    """List all folders"""
    from src.folders import get_folders_manager
    mgr = get_folders_manager()
    print(json.dumps({"folders": mgr.list_folders()}))


@cli.command()
@click.argument('name')
@click.option('--color', default='#6366f1')
def create_folder(name, color):
    """Create a new folder"""
    from src.folders import get_folders_manager
    mgr = get_folders_manager()
    folder = mgr.create_folder(name, color)
    if folder:
        print(json.dumps({"success": True, "folder": folder}))
    else:
        print(json.dumps({"success": False, "error": "Failed to create folder"}))


@cli.command()
@click.argument('folder_id')
@click.argument('icon')
def update_folder_icon(folder_id, icon):
    """Update a folder's icon"""
    from src.folders import get_folders_manager
    mgr = get_folders_manager()
    success = mgr.update_icon(folder_id, icon)
    print(json.dumps({"success": success}))


@cli.command()
@click.argument('folder_id')
@click.argument('name')
def rename_folder(folder_id, name):
    """Rename a folder"""
    from src.folders import get_folders_manager
    mgr = get_folders_manager()
    success = mgr.rename_folder(folder_id, name)
    print(json.dumps({"success": success}))


@cli.command()
@click.argument('folder_ids', nargs=-1, required=True)
def reorder_folders(folder_ids):
    """Reorder folders by providing folder IDs in desired order"""
    from src.folders import get_folders_manager
    mgr = get_folders_manager()
    success = mgr.reorder_folders(list(folder_ids))
    print(json.dumps({"success": success}))


@cli.command()
@click.argument('folder_id')
def delete_folder(folder_id):
    """Delete a folder"""
    from src.folders import get_folders_manager
    mgr = get_folders_manager()
    success = mgr.delete_folder(folder_id)
    print(json.dumps({"success": success}))


@cli.command()
@click.argument('summary_file')
@click.argument('folder_id')
def add_meeting_to_folder(summary_file, folder_id):
    """Add a meeting to a folder"""
    from src.folders import get_folders_manager
    mgr = get_folders_manager()
    success = mgr.add_meeting_to_folder(Path(summary_file), folder_id)
    print(json.dumps({"success": success}))


@cli.command()
@click.argument('summary_file')
@click.argument('folder_id')
def remove_meeting_from_folder(summary_file, folder_id):
    """Remove a meeting from a folder"""
    from src.folders import get_folders_manager
    mgr = get_folders_manager()
    success = mgr.remove_meeting_from_folder(Path(summary_file), folder_id)
    print(json.dumps({"success": success}))


@cli.command()
def get_ai_provider():
    """Get all AI provider configuration"""
    from src.config import get_config
    config = get_config()

    result = {
        "ai_provider": config.get_ai_provider(),
        "remote_ollama_url": config.get_remote_ollama_url(),
        "cloud_api_url": config.get_cloud_api_url(),
        "cloud_api_key_set": bool(config.get_cloud_api_key()),
        "cloud_provider": config.get_cloud_provider(),
        "cloud_model": config.get_cloud_model(),
        # The local/remote Ollama summarisation model, so the UI can show the
        # model that's actually answering under ai_provider=local/remote
        # (cloud/adapter use cloud_model / the org's server-side model).
        "model": config.get_model(),
        "bedrock_region": config.get_bedrock_region(),
        "bedrock_inference_profile": config.get_bedrock_inference_profile(),
        "bedrock_supported_models": list(config.SUPPORTED_BEDROCK_MODELS),
    }
    print(json.dumps(result))


@cli.command()
@click.argument('provider')
def set_ai_provider(provider):
    """Set the AI provider (local, remote, or cloud)"""
    from src.config import get_config
    config = get_config()

    if provider not in config.VALID_AI_PROVIDERS:
        print(json.dumps({
            "success": False,
            "error": f"Invalid provider: {provider}. Must be one of: {', '.join(config.VALID_AI_PROVIDERS)}"
        }))
        return

    success = config.set_ai_provider(provider)
    if success:
        print(json.dumps({"success": True, "ai_provider": provider}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save AI provider setting"}))


@cli.command()
@click.argument('url')
def set_remote_ollama_url(url):
    """Set the remote Ollama server URL"""
    from src.config import get_config
    config = get_config()
    success = config.set_remote_ollama_url(url)
    if success:
        print(json.dumps({"success": True, "remote_ollama_url": url}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save remote Ollama URL"}))


@cli.command()
@click.argument('url')
def set_cloud_api_url(url):
    """Set the cloud API URL"""
    from src.config import get_config
    config = get_config()
    success = config.set_cloud_api_url(url)
    if success:
        print(json.dumps({"success": True, "cloud_api_url": url}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save cloud API URL"}))


@cli.command()
@click.argument('provider')
def set_cloud_provider(provider):
    """Set the cloud provider type (openai or custom)"""
    from src.config import get_config
    config = get_config()

    if provider not in config.VALID_CLOUD_PROVIDERS:
        print(json.dumps({
            "success": False,
            "error": f"Invalid cloud provider: {provider}. Must be one of: {', '.join(config.VALID_CLOUD_PROVIDERS)}"
        }))
        return

    success = config.set_cloud_provider(provider)
    if success:
        print(json.dumps({"success": True, "cloud_provider": provider}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save cloud provider"}))


@cli.command()
@click.argument('model')
def set_cloud_model(model):
    """Set the cloud model name"""
    from src.config import get_config
    config = get_config()
    success = config.set_cloud_model(model)
    if success:
        print(json.dumps({"success": True, "cloud_model": model}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save cloud model"}))


@cli.command()
@click.argument('region')
def set_bedrock_region(region):
    """Set the AWS Bedrock region (e.g. us-east-1)"""
    from src.config import get_config
    config = get_config()
    success = config.set_bedrock_region(region)
    if success:
        print(json.dumps({"success": True, "bedrock_region": region}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save Bedrock region (empty?)"}))


@cli.command()
@click.argument('profile', required=False, default='')
def set_bedrock_inference_profile(profile):
    """Set the AWS Bedrock cross-region inference profile (empty clears)"""
    from src.config import get_config
    config = get_config()
    success = config.set_bedrock_inference_profile(profile)
    if success:
        print(json.dumps({"success": True, "bedrock_inference_profile": profile}))
    else:
        print(json.dumps({"success": False, "error": "Failed to save Bedrock inference profile"}))


@cli.command()
@click.argument('url')
def test_remote_ollama(url):
    """Test connection to a remote Ollama server"""
    try:
        import ollama as ollama_pkg
        client = ollama_pkg.Client(host=url)
        response = client.list()
        models = [getattr(m, 'model', '') for m in getattr(response, 'models', [])]
        print(json.dumps({"success": True, "models": models}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


# Model families OpenAI's /models endpoint mixes in alongside chat models —
# embeddings, speech, image and moderation. Excluded so the Settings model
# picker only offers models that actually answer chat completions (#198).
# NB: no "search" marker — the *-search-preview models are chat-completion
# models (web-search-grounded). "search" is a substring of "deep-research", but
# those are excluded by their own marker below, so the two don't interfere.
_OPENAI_NON_CHAT_MARKERS = (
    "embedding", "whisper", "tts", "audio", "realtime",
    "moderation", "dall-e", "image", "transcribe", "codex",
)

# Reasoning tiers OpenAI serves ONLY through the Responses API, never
# chat.completions. Steno talks to client.chat.completions.create, so offering
# one of these would 400 at request time — they must be dropped from the picker
# even though they pass the gpt-/o\d gate. ``deep-research`` is a substring match
# (covers o3-deep-research, o4-mini-deep-research and their dated snapshots); the
# ``-pro`` tier (gpt-5-pro, …-pro-YYYY-MM-DD) is matched as a ``-pro`` segment so
# dated snapshots drop too without snagging unrelated names.
_OPENAI_RESPONSES_ONLY_MARKERS = ("deep-research",)
_OPENAI_RESPONSES_ONLY_RE = re.compile(r"-pro(?:-|$)")


def _is_openai_chat_model(model_id: str) -> bool:
    """True for OpenAI chat/reasoning models (``gpt-*``, the ``o<n>`` reasoning
    series, ``chatgpt-*``), excluding the non-chat families above and the
    Responses-only reasoning tiers (``*-pro``, ``*-deep-research``). ``gpt-`` and
    ``o\\d`` are prefix/pattern matches so newer releases (gpt-4.1, o4, …) keep
    showing up without a code change. Applied to the openai provider only —
    custom OpenAI-compatible endpoints use their own naming, so their lists are
    left unfiltered."""
    mid = model_id.lower()
    if not (
        mid.startswith("gpt-")
        or mid.startswith("chatgpt-")
        or re.match(r"o\d", mid)
    ):
        return False
    if any(marker in mid for marker in _OPENAI_NON_CHAT_MARKERS):
        return False
    if any(marker in mid for marker in _OPENAI_RESPONSES_ONLY_MARKERS):
        return False
    if _OPENAI_RESPONSES_ONLY_RE.search(mid):
        return False
    return True


@cli.command()
def test_cloud_api():
    """Test connection to the cloud API"""
    from src.config import get_config
    config = get_config()

    cloud_api_key = config.get_cloud_api_key()
    cloud_provider = config.get_cloud_provider()
    cloud_api_url = config.get_cloud_api_url()

    if not cloud_api_key:
        print(json.dumps({"success": False, "error": "No API key configured"}))
        return

    try:
        if cloud_provider == "anthropic":
            from anthropic import Anthropic
            client = Anthropic(api_key=cloud_api_key)
            # Lightweight test: list models
            models_page = client.models.list(limit=10)
            model_ids = [m.id for m in models_page.data]
            print(json.dumps({"success": True, "models": model_ids}))
        elif cloud_provider == "bedrock":
            # Bedrock doesn't expose a cheap list endpoint via the bearer-token
            # API surface (ListFoundationModels needs SigV4). The Settings UI
            # uses the curated SUPPORTED_BEDROCK_MODELS list directly, so the
            # only thing left to verify is "does the key + region actually
            # answer Converse?". Send a 1-token ping to the configured model.
            import urllib.request
            import urllib.error
            from src.summarizer import bedrock_converse_url
            region = config.get_bedrock_region()
            profile = config.get_bedrock_inference_profile()
            model_id = config.get_cloud_model()
            target = profile or model_id
            url = bedrock_converse_url(region, target)
            body = json.dumps({
                "messages": [{"role": "user", "content": [{"text": "hi"}]}],
                "inferenceConfig": {"maxTokens": 1},
            }).encode("utf-8")
            headers = {
                "content-type": "application/json",
                "authorization": f"Bearer {cloud_api_key}",
            }
            try:
                req = urllib.request.Request(url, data=body, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=15) as resp:
                    resp.read()  # we only care about the status code
                # Surface the curated list as "models" so the UI's existing
                # dropdown wiring lights up after a successful test.
                print(json.dumps({
                    "success": True,
                    "models": list(config.SUPPORTED_BEDROCK_MODELS),
                }))
            except urllib.error.HTTPError as he:
                detail = ""
                try:
                    detail = he.read().decode("utf-8", errors="replace")[:300]
                except Exception:
                    # Best-effort error-detail extraction; must never mask the
                    # HTTPError we're about to report to the user.
                    pass
                print(json.dumps({
                    "success": False,
                    "error": f"Bedrock HTTP {he.code}: {detail or he.reason}",
                }))
        else:
            from openai import OpenAI
            base_url = cloud_api_url if cloud_provider == "custom" and cloud_api_url else None
            client = OpenAI(api_key=cloud_api_key, base_url=base_url)
            models = client.models.list()
            # Newest first so current chat models lead the Settings dropdown.
            # OpenAI returns ~50+ models in arbitrary order, mixing in
            # embeddings/audio/image/moderation; the old unfiltered [:10] slice
            # crowded those in and pushed newer chat models off the end (#198).
            # Keep only chat/reasoning models for the openai provider; custom
            # OpenAI-compatible endpoints keep every model (unknown naming).
            entries = sorted(
                models.data,
                key=lambda m: getattr(m, "created", 0) or 0,
                reverse=True,
            )
            if cloud_provider == "openai":
                entries = [m for m in entries if _is_openai_chat_model(m.id)]
            model_ids = [m.id for m in entries[:25]]
            print(json.dumps({"success": True, "models": model_ids}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


@cli.command()
def download_whisper_model():
    """Download the Whisper transcription model"""
    print("Downloading Whisper model...")

    try:
        from pywhispercpp.model import Model as WhisperCppModel

        # This will trigger the model download if not present
        print("Initializing Whisper model (will download if needed)...")
        from src.config import get_config
        model_size = get_config().get_whisper_model()
        model = WhisperCppModel(model_size)
        print("SUCCESS: Whisper model ready")

    except Exception as e:
        print(f"ERROR: Failed to download Whisper model: {e}")
        import sys
        sys.exit(1)


@cli.command()
@click.argument('model_name')
def check_model(model_name):
    """Check if a model is installed in Ollama (uses HTTP API)."""
    from src.config import get_config
    config = get_config()
    provider = config.get_ai_provider()

    if provider == "remote":
        remote_url = config.get_remote_ollama_url()
        if not remote_url:
            print(json.dumps({"installed": False, "model": model_name, "error": "No remote URL configured"}))
            return
        try:
            import ollama as ollama_pkg
            client = ollama_pkg.Client(host=remote_url)
            response = client.list()
            models = getattr(response, 'models', []) or []
            model_names = [getattr(m, 'model', '') for m in models]
            installed = model_name in model_names
            print(json.dumps({"installed": installed, "model": model_name}))
        except Exception as e:
            print(json.dumps({"installed": False, "model": model_name, "error": str(e)}))
    else:
        from src.ollama_manager import start_ollama_server
        start_ollama_server()
        try:
            import ollama
            response = ollama.list()
            models = getattr(response, 'models', []) or []
            model_names = [getattr(m, 'model', '') for m in models]
            installed = model_name in model_names
            print(json.dumps({"installed": installed, "model": model_name}))
        except Exception as e:
            print(json.dumps({"installed": False, "model": model_name, "error": str(e)}))


@cli.command()
@click.argument('model_name')
def pull_model(model_name):
    """Download an Ollama model (uses HTTP API)."""
    from src.ollama_manager import start_ollama_server
    start_ollama_server()
    try:
        import ollama
        # Ollama models are made of several blobs (weights, params, tokenizer,
        # ...), each streamed as its own 0-100% phase with a distinct status
        # string -- without a marker, the percentage appearing to "restart"
        # reads as a second, unrelated download. seen_statuses tracks which
        # weighted (total>0) phases have already started so blob_index only
        # advances on a genuinely new one, not on every repeated tick of the
        # same blob.
        seen_statuses = set()
        blob_index = 0
        for progress in ollama.pull(model_name, stream=True):
            status = getattr(progress, 'status', '') or ''
            total = getattr(progress, 'total', 0) or 0
            completed = getattr(progress, 'completed', 0) or 0
            if total > 0:
                if status not in seen_statuses:
                    seen_statuses.add(status)
                    blob_index += 1
                pct = int(completed / total * 100)
                # Byte counts and the blob/part index are appended in a
                # machine-parseable suffix, on the SAME line as the
                # percentage (not a separate print), so the renderer can
                # compute a live transfer rate and part label without either
                # ever desyncing from the percentage it corresponds to.
                print(f"{status} {pct}% ({completed}/{total}) [Part {blob_index}]", flush=True)
            elif status:
                print(status, flush=True)
        print(json.dumps({"success": True, "model": model_name}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


@cli.command(name='verify-model')
@click.argument('model_name')
def verify_model(model_name):
    """Smoke-test a just-pulled model with a 1-token chat call (uses HTTP API).

    Used only by the Settings "switch to faster build" flow, to prove an
    MLX/NVFP4 tag actually loads and responds before offering to delete the
    old GGUF build. A generous timeout accounts for MLX cold-load (several
    seconds after a fresh pull, per local benchmarking) -- a slow-but-working
    model must not be reported as a failure.
    """
    from src.ollama_manager import start_ollama_server
    start_ollama_server()
    try:
        import ollama
        client = ollama.Client(timeout=90)
        client.chat(
            model=model_name,
            messages=[{"role": "user", "content": "hi"}],
            options={"num_predict": 1},
        )
        print(json.dumps({"success": True, "error": None}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


@cli.command(name='delete-model')
@click.argument('model_name')
def delete_model(model_name):
    """Delete a locally-pulled Ollama model (uses HTTP API).

    Called by the Settings "switch to faster build" flow (the old GGUF tag,
    after its NVFP4 sibling has been pulled and verified) and by the general
    "delete this model to free up disk space" action (either the GGUF id or
    its NVFP4 sibling) -- never a tag currently in active use. Restricted to
    supported GGUF ids and their NVFP4 siblings: this is a destructive
    IPC-reachable operation, so it must not delete an arbitrary
    caller-supplied model name.
    """
    from src.config import get_config, Config

    allowed = set(get_config().list_supported_models()) | set(Config._MLX_EQUIVALENTS.values())
    if model_name not in allowed:
        print(json.dumps({"success": False, "error": f"Refusing to delete unsupported model: {model_name}"}))
        return
    try:
        import ollama
        ollama.delete(model=model_name)
        print(json.dumps({"success": True, "error": None}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


def pick_installed_supported_model(installed_names, preferred, supported_order, deprecated=()):
    """Pick the best already-installed supported Ollama model id, or None (#123).

    Args:
        installed_names: model ids the connected Ollama reports via /api/tags.
        preferred: ids to try first, in order — the configured model, then the
            packaged default. Honours "prefer the configured default if present".
        supported_order: the supported registry keys, ascending by capability
            (config.SUPPORTED_MODELS order); the fall-through when no preferred
            id is installed.
        deprecated: supported ids flagged deprecated — chosen only as a last
            resort so a live model always wins over a retired one.

    Returns the id to reuse, or None when nothing supported is installed (the
    caller then pulls the default).
    """
    installed = set(installed_names)
    supported = set(supported_order)
    dep = set(deprecated)
    for cand in preferred:
        if cand and cand in supported and cand in installed:
            return cand
    for cand in supported_order:
        if cand in installed and cand not in dep:
            return cand
    for cand in supported_order:
        if cand in installed and cand in dep:
            return cand
    return None


@cli.command(name='resolve-setup-model')
def resolve_setup_model():
    """Report an already-installed supported model so first-run setup can skip a
    redundant download (#123).

    Prints {"installed": "<model-id>"} when the connected Ollama already has a
    supported model, else {"installed": null}. Never pulls — the caller decides
    whether to download. Uses the HTTP API (ollama package), not the binary.
    """
    from src.config import get_config, Config
    from src.ollama_manager import start_ollama_server
    from src.config import is_apple_silicon

    result = {"installed": None, "pull_target": Config.DEFAULT_MODEL}
    try:
        start_ollama_server()
        import ollama
        resp = ollama.list()
        installed = {
            getattr(m, 'model', '') or ''
            for m in (getattr(resp, 'models', None) or [])
        }
        installed.discard('')
        config = get_config()
        deprecated = [
            mid for mid, meta in Config.SUPPORTED_MODELS.items()
            if meta.get('deprecated')
        ]
        # Canonicalize any already-installed MLX tag back to its GGUF id so an
        # Apple-Silicon machine that only has e.g. gemma4:e2b-nvfp4 (from a
        # prior manual switch) is still recognised as "has a supported model".
        # Also matches an NVFP4 tag with extra detail Ollama appended after
        # it (the same fuzzy pattern list_models() uses for GGUF ids below,
        # e.g. "deepseek-r1:14b" matching "deepseek-r1:14b-qwen-distill-q4_K_M")
        # -- an exact dict lookup alone would miss that and cause a redundant
        # re-download here even though list_models() already recognises it.
        def _canonicalize_mlx_tag(name):
            if name in Config._MLX_TO_GGUF:
                return Config._MLX_TO_GGUF[name]
            for mlx_tag, gguf_id in Config._MLX_TO_GGUF.items():
                if name.startswith(mlx_tag + '-'):
                    return gguf_id
            return name

        canonical_installed = {_canonicalize_mlx_tag(name) for name in installed}
        result["installed"] = pick_installed_supported_model(
            installed_names=canonical_installed,
            preferred=[config.get_model(), Config.DEFAULT_MODEL],
            supported_order=list(Config.SUPPORTED_MODELS.keys()),
            deprecated=deprecated,
        )
        result["pull_target"] = (
            Config._MLX_EQUIVALENTS.get(Config.DEFAULT_MODEL, Config.DEFAULT_MODEL)
            if is_apple_silicon()
            else Config.DEFAULT_MODEL
        )
    except Exception as e:
        result["error"] = str(e)
    print(json.dumps(result))


@cli.command(name='check-adapter')
@click.argument('url')
def check_adapter_cmd(url: str):
    """Probe an adapter's /health over HTTPS using the bundle's stdlib SSL stack.

    Diagnostic for the customer-side trust-store issue where the
    PyInstaller bundle's compiled-in CA paths don't exist on the host.
    Prints OK on a successful TLS handshake or the underlying SSL/HTTP
    error so support can paste it into a ticket.
    """
    import urllib.request
    import urllib.error

    url = url.rstrip('/') + '/health'
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            body = resp.read().decode('utf-8', errors='replace')
        print(f"OK {resp.status} {url}")
        print(body)
    except urllib.error.URLError as e:
        print(f"FAIL {url}")
        print(f"  reason: {e.reason}")
        sys.exit(1)
    except Exception as e:
        print(f"FAIL {url}")
        print(f"  error: {e}")
        sys.exit(1)


@cli.command(name='spike-parakeet')
def spike_parakeet_cmd():
    """Run the Parakeet TDT v3 spike from inside the bundled binary.

    Equivalent to ``python scripts/spike_parakeet.py`` but reachable from the
    PyInstaller bundle — that's the run that matters for proving MLX +
    parakeet-mlx survive the hardened runtime + codesign.
    """
    try:
        # Adjust sys.path so the dev-mode invocation finds scripts/ without
        # the user having to set PYTHONPATH. In a PyInstaller bundle the
        # script lives at sys._MEIPASS/scripts/ (datas=('scripts','scripts')
        # would be required to ship it — but we just inline the spike here
        # so the bundle doesn't need extra data files).
        from scripts.spike_parakeet import main as spike_main
    except ImportError:
        # PyInstaller bundle: the scripts/ tree isn't copied in (datas don't
        # include it). Re-import the spike logic inline by exec'ing the file
        # if it's beside us, otherwise just import the modules directly and
        # run the equivalent loop here.
        import importlib
        try:
            mod = importlib.import_module('scripts.spike_parakeet')
            spike_main = mod.main
        except ImportError:
            click.echo(
                json.dumps({
                    "event": "error",
                    "stage": "import_spike",
                    "message": "scripts/spike_parakeet.py not bundled; "
                               "run the dev-mode invocation instead."
                }),
                err=True,
            )
            sys.exit(2)
    sys.exit(spike_main())


if __name__ == '__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    cli()
