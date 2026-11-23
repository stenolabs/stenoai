"""Parse the live-transcript snapshot Electron hands to ``process-streaming``.

Electron writes the finalised live segments captured during a recording to a
temp file at stop time (``app/live-transcript-format.js``) and passes its path
via ``--live-transcript``. The pipeline uses it twice: to summarise the meeting
seconds after Stop (``--early-summary``), and as the fallback transcript when
the batch transcription comes back unusable (#207).

Two on-disk shapes are accepted:

* **v1 (JSON)** -- ``{"format": "stenoai-live-transcript/v1", "segments":
  [{"start", "end", "speaker", "text"}, ...]}``. Speakers and timestamps are
  kept and rendered in the same ``[MM:SS] [Speaker] text`` shape the batch
  pipeline saves a diarised transcript in.
* **legacy plain text** -- the old snapshot (final segment texts joined by
  blank lines). Anything that is not a v1 JSON document is treated as this, so
  an older Electron build keeps working against a newer backend.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Optional

LIVE_SNAPSHOT_FORMAT = "stenoai-live-transcript/v1"


@dataclass(frozen=True)
class LiveSnapshot:
    transcript_text: str
    """Plain transcript (no labels) -- what the batch path calls ``text``."""
    diarised_text: Optional[str]
    """Labelled transcript, or None when only one speaker spoke."""
    is_diarised: bool
    duration_seconds: Optional[float] = None
    """End of the last segment; None for the legacy format (no timestamps)."""
    segments: list = field(default_factory=list)

    @property
    def text_for_note(self) -> str:
        """The transcript as the note shows it (labelled when diarised)."""
        return self.diarised_text or self.transcript_text


def _format_timestamp(seconds: float) -> str:
    # Mirrors src.transcriber._format_timestamp (not imported: that module
    # pulls in the ASR stack, which this parser must not need).
    if not math.isfinite(seconds):
        seconds = 0
    total = max(0, int(seconds))
    hh, rem = divmod(total, 3600)
    mm, ss = divmod(rem, 60)
    if hh:
        return f"{hh:d}:{mm:02d}:{ss:02d}"
    return f"{mm:02d}:{ss:02d}"


def _as_seconds(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, number) if math.isfinite(number) else 0.0


def _clean_segments(raw_segments) -> list[dict]:
    segments = []
    if not isinstance(raw_segments, list):
        return segments
    for seg in raw_segments:
        if not isinstance(seg, dict):
            continue
        text = seg.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        segments.append({
            "start": _as_seconds(seg.get("start")),
            "end": _as_seconds(seg.get("end")),
            "speaker": "Others" if seg.get("speaker") == "Others" else "You",
            "text": text.strip(),
        })
    return segments


def format_live_segments(segments: list[dict]) -> LiveSnapshot:
    """Collapse adjacent same-speaker segments into turns and render them.

    Same rules as ``app/live-transcript-format.js`` formatLiveTranscript and
    the batch ``_assemble_diarised_turns``: one speaker -> plain text only.
    """
    turns: list[tuple[float, str, list[str]]] = []
    for seg in segments:
        if turns and turns[-1][1] == seg["speaker"]:
            turns[-1][2].append(seg["text"])
        else:
            turns.append((seg["start"], seg["speaker"], [seg["text"]]))
    plain = "\n\n".join(" ".join(parts) for _start, _speaker, parts in turns).strip()
    is_diarised = len({speaker for _start, speaker, _parts in turns}) > 1
    diarised = (
        "\n\n".join(
            f"[{_format_timestamp(start)}] [{speaker}] {' '.join(parts)}"
            for start, speaker, parts in turns
        )
        if is_diarised else None
    )
    duration = max((seg["end"] for seg in segments), default=0.0) or None
    return LiveSnapshot(
        transcript_text=plain,
        diarised_text=diarised,
        is_diarised=is_diarised,
        duration_seconds=duration,
        segments=segments,
    )


def parse_live_snapshot(raw: Optional[str]) -> Optional[LiveSnapshot]:
    """Parse snapshot file contents; None when there is no usable text."""
    if raw is None:
        return None
    stripped = raw.strip()
    if not stripped:
        return None
    if stripped.startswith("{"):
        try:
            data = json.loads(stripped)
        except ValueError:
            data = None
        if isinstance(data, dict) and data.get("format") == LIVE_SNAPSHOT_FORMAT:
            snapshot = format_live_segments(_clean_segments(data.get("segments")))
            return snapshot if snapshot.transcript_text else None
    return LiveSnapshot(transcript_text=stripped, diarised_text=None, is_diarised=False)
