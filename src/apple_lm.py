"""Apple SystemLanguageModel sidecar: Advanced when the OS has it, else 3B Core.

The public FoundationModels API exposes ``SystemLanguageModel.default`` plus an
inspect-only ``variant`` (``coreAdvanced3`` / ``core3``). There is no
``init(variant:)`` — the OS picks Advanced where it is available and otherwise
serves the 3B Core model. This module probes that default and, when it is
available, is the local summarization default on Darwin.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

logger = logging.getLogger(__name__)

APPLE_SYSTEM_MODEL = "apple:system"
# Apple's on-device session window, in tokens. This is not a knob we send to
# the model — the OS owns the session — it only sizes OUR prompt budgets
# (resolve_num_ctx -> corpus/chunk/snapshot budgets in src.summarizer).
#
# Measured on this class of machine (AFM 3 Core Advanced, macOS 27) by feeding
# needle-in-filler prompts of increasing size straight at the sidecar: clean
# answers through ~37.9k chars, hard refusal from ~40.0k. At the repo's 3.5
# chars/token English assumption that cliff is ~11k tokens, so an 8k window is
# the honest figure and leaves the derived budgets (largest: ~15.8k chars for
# the chat corpus) well under half the measured ceiling. It was 4096, which
# silently halved every Apple budget.
APPLE_LM_NUM_CTX = 8192

_DISABLE_ENV = "STENOAI_DISABLE_APPLE_LM"
_BIN_ENV = "STENOAI_APPLE_LM_BIN"

_STATUS_LOCK = threading.Lock()
_STATUS_CACHE: Optional[Dict[str, Any]] = None
_STATUS_CACHE_BIN: Optional[str] = None


def is_apple_system_model(model_id: Optional[str]) -> bool:
    return model_id == APPLE_SYSTEM_MODEL


def apple_lm_disabled() -> bool:
    return os.environ.get(_DISABLE_ENV) == "1"


def reset_apple_lm_cache() -> None:
    """Drop the process-wide status cache. Tests only."""
    global _STATUS_CACHE, _STATUS_CACHE_BIN
    with _STATUS_LOCK:
        _STATUS_CACHE = None
        _STATUS_CACHE_BIN = None


def resolve_apple_lm_bin() -> Optional[str]:
    """Locate ``steno-apple-lm``. Darwin only; None when disabled or missing."""
    if apple_lm_disabled() or sys.platform != "darwin":
        return None
    candidates: list[str] = []
    override = os.environ.get(_BIN_ENV)
    if override:
        candidates.append(override)
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).parent
        candidates.extend(
            [
                str(exe_dir / "steno-apple-lm"),
                str(exe_dir / "_internal" / "steno-apple-lm"),
            ]
        )
    else:
        repo_root = Path(__file__).resolve().parent.parent
        candidates.append(str(repo_root / "bin" / "steno-apple-lm"))
    for cand in candidates:
        if os.access(cand, os.X_OK):
            return cand
    return None


def apple_lm_status() -> Dict[str, Any]:
    """Probe sidecar ``status``. Cached per process + binary path."""
    global _STATUS_CACHE, _STATUS_CACHE_BIN
    if apple_lm_disabled():
        return {"available": False, "reason": "disabled"}
    if sys.platform != "darwin":
        return {"available": False, "reason": "unsupported_os"}
    binary = resolve_apple_lm_bin()
    if not binary:
        return {"available": False, "reason": "sidecar_missing"}
    with _STATUS_LOCK:
        if _STATUS_CACHE is not None and _STATUS_CACHE_BIN == binary:
            return dict(_STATUS_CACHE)
    try:
        raw = _run_apple_lm(["status"], timeout=15)
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("status payload is not an object")
    except Exception as exc:
        logger.info("apple-lm status failed: %s", type(exc).__name__)
        payload = {"available": False, "reason": "sidecar_error"}
    with _STATUS_LOCK:
        _STATUS_CACHE = dict(payload)
        _STATUS_CACHE_BIN = binary
    return dict(payload)


def apple_lm_available() -> bool:
    return bool(apple_lm_status().get("available"))


def resolve_default_summary_model() -> str:
    """Apple system model when the sidecar reports available, else Ollama default."""
    from src.config import Config

    if apple_lm_available():
        return APPLE_SYSTEM_MODEL
    return Config.DEFAULT_MODEL


def apple_system_model_info(*, is_default: bool = False) -> Dict[str, str]:
    status = apple_lm_status()
    variant = status.get("variant")
    if variant == "coreAdvanced3":
        quality_bit = "Advanced"
    elif variant == "core3":
        quality_bit = "3B Core"
    else:
        quality_bit = "Advanced when available, else 3B Core"
    default_bit = " (default)" if is_default else ""
    display = status.get("display_name") or "Apple Intelligence"
    return {
        "name": display if isinstance(display, str) and display.strip() else "Apple Intelligence",
        "size": "",
        "params": "3B",
        "description": f"On-device System Language Model — {quality_bit}{default_bit}",
        "speed": "fast",
        "quality": "good",
    }


def complete(prompt: str, timeout: float = 7200) -> str:
    raw = _run_apple_lm(["complete"], stdin=prompt, timeout=timeout)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Apple Intelligence returned invalid output") from exc
    if not isinstance(payload, dict) or payload.get("error"):
        raise RuntimeError("Apple Intelligence request failed")
    text = payload.get("text") or ""
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("Apple Intelligence returned an empty response")
    return text


def stream_complete(prompt: str, timeout: float = 7200) -> Iterator[str]:
    binary = resolve_apple_lm_bin()
    if not binary:
        raise RuntimeError("Apple Intelligence sidecar is not available")
    proc = subprocess.Popen(
        [binary, "stream"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdin is not None
    assert proc.stdout is not None
    try:
        proc.stdin.write(prompt)
        proc.stdin.close()
        deadline = time.monotonic() + timeout
        line_queue: queue.Queue[Optional[str]] = queue.Queue()

        def _reader():
            try:
                for line in proc.stdout:
                    line_queue.put(line)
            except Exception:
                pass
            finally:
                line_queue.put(None)

        reader_thread = threading.Thread(target=_reader, daemon=True)
        reader_thread.start()

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Apple Intelligence stream timed out")
            try:
                line = line_queue.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError("Apple Intelligence stream timed out")
            if line is None:
                break
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError("Apple Intelligence returned invalid output") from exc
            if not isinstance(rec, dict) or rec.get("error"):
                raise RuntimeError("Apple Intelligence request failed")
            if rec.get("done"):
                return
            delta = rec.get("delta") or ""
            if delta:
                yield delta
        if proc.wait(timeout=5) not in (0, None):
            raise RuntimeError("Apple Intelligence request failed")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        # Deliberately NOT closing proc.stdout/stderr here. Popen closes them
        # when it is collected, which under CPython refcounting is immediately
        # after this frame; an explicit close instead blocks on the reader
        # thread's lock until the pipe's write end is released, and a sidecar
        # that spawned its own child leaves that end open after the kill —
        # measured as a 30 s hang. A momentarily-open fd in a short-lived CLI
        # beats a user-visible stall.


def _run_apple_lm(
    args: list[str],
    *,
    stdin: Optional[str] = None,
    timeout: float = 30,
) -> str:
    binary = resolve_apple_lm_bin()
    if not binary:
        raise FileNotFoundError("steno-apple-lm not found")
    logger.info("apple-lm %s (%s chars stdin)", args[0] if args else "?", len(stdin or ""))
    try:
        proc = subprocess.run(
            [binary, *args],
            input=stdin,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError("Apple Intelligence timed out") from exc
    if proc.returncode != 0:
        raise RuntimeError("Apple Intelligence request failed")
    return (proc.stdout or "").strip()


class AppleLMClient:
    """Duck-types the Ollama ``Client.chat`` surface used by OllamaSummarizer."""

    def chat(self, *, stream: bool = False, messages=None, **_kwargs):
        prompt = ""
        if messages:
            last = messages[-1] or {}
            prompt = last.get("content") or ""
        if stream:
            return self._stream(prompt)
        return {"message": {"content": complete(prompt)}}

    def _stream(self, prompt: str):
        for delta in stream_complete(prompt):
            yield {"message": {"content": delta}}
