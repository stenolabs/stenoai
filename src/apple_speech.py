"""Bridge to the macOS SpeechTranscriber sidecar.

The Electron live path spawns ``steno-transcribe stream`` directly. Batch
transcription and setup use these small synchronous wrappers so the shared
Python pipeline keeps its existing normalized result shape.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Optional

_SIDECAR_CACHE: Optional[str] = None
_SIDECAR_LOCK = threading.Lock()


def resolve_sidecar() -> Optional[str]:
    """Return the executable Apple transcription sidecar, if available."""
    global _SIDECAR_CACHE
    if sys.platform != "darwin":
        return None
    if _SIDECAR_CACHE is not None:
        return _SIDECAR_CACHE

    with _SIDECAR_LOCK:
        if _SIDECAR_CACHE is not None:
            return _SIDECAR_CACHE
        candidates: list[Path] = []
        override = os.environ.get("STENOAI_TRANSCRIBE_SIDECAR_PATH")
        if override:
            candidates.append(Path(override))
        if getattr(sys, "frozen", False):
            executable_dir = Path(sys.executable).parent
            candidates.extend(
                (
                    executable_dir / "steno-transcribe",
                    executable_dir / "_internal" / "steno-transcribe",
                )
            )
        else:
            candidates.append(Path(__file__).resolve().parent.parent / "bin" / "steno-transcribe")

        for candidate in candidates:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                _SIDECAR_CACHE = str(candidate)
                return _SIDECAR_CACHE
        return None


def _run(arguments: list[str], *, timeout: float) -> dict[str, Any]:
    sidecar = resolve_sidecar()
    if sidecar is None:
        raise RuntimeError("Apple on-device transcription is unavailable in this build.")

    completed = subprocess.run(
        [sidecar, *arguments],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    payload: Any = None
    for line in reversed(lines):
        try:
            payload = json.loads(line)
            break
        except json.JSONDecodeError:
            continue

    if completed.returncode != 0:
        if isinstance(payload, dict) and isinstance(payload.get("error"), str):
            raise RuntimeError(payload["error"])
        raise RuntimeError("Apple on-device transcription failed.")
    if not isinstance(payload, dict):
        raise RuntimeError("Apple transcription sidecar returned invalid output.")
    return payload


def status(language: str = "auto") -> dict[str, Any]:
    """Return availability, locale support, and system-asset state."""
    if sys.platform != "darwin":
        return {
            "success": True,
            "available": False,
            "supported": False,
            "installed": False,
            "locale": None,
            "display_name": "Apple On-Device",
            "system_managed": True,
        }
    return _run(["status", language], timeout=15)


def prepare(language: str = "auto") -> dict[str, Any]:
    """Install the system-managed speech asset for ``language`` if needed."""
    return _run(["prepare", language], timeout=20 * 60)


def transcribe_file(
    audio_path: Path,
    *,
    language: str = "auto",
    timeout: float = 30 * 60,
) -> dict[str, Any]:
    """Transcribe one audio file and return the pipeline's normalized shape."""
    payload = _run(
        ["transcribe-file", str(audio_path), language],
        timeout=timeout,
    )
    text = payload.get("text")
    segments = payload.get("segments")
    if not isinstance(text, str) or not isinstance(segments, list):
        raise RuntimeError("Apple transcription sidecar returned an invalid transcript.")
    return payload
