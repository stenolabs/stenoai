"""Whisper model registry + downloader.

Mirrors the Ollama model UX: each entry has display name, size, and a
download path. UI calls into ``list_supported`` / ``is_installed`` and
``download_with_progress`` to stream progress while pulling models from
HuggingFace.

The keys here MUST be members of ``pywhispercpp.constants.AVAILABLE_MODELS``
(plain ``large`` is intentionally absent — pywhispercpp rejects it and the
native loader segfaults on the resulting NULL path).

``LANGUAGE_WHISPER_MODELS`` is a second, separate registry: community
fine-tunes for a single language, used in place of the main model only
when a recording is pinned to or detected as that language. They are not
pywhispercpp names, so they are always loaded by file path, and they are
never valid as the main ``whisper_model`` (a Hebrew-tuned model would
transcribe an English meeting badly).
"""
from __future__ import annotations

import hashlib
import logging
import os
import secrets
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)


SUPPORTED_WHISPER_MODELS: dict[str, dict] = {
    "large-v3-turbo": {
        "name": "Whisper Large V3 Turbo",
        "size": "1.6GB",
        "description": (
            "Best accuracy Whisper model. Supports 99 languages "
            "including non-European languages such as Chinese, "
            "Japanese, Arabic, Korean, and Hindi."
        ),
        "speed": "medium",
        "quality": "excellent",
    },
}


LANGUAGE_WHISPER_MODELS: dict[str, dict] = {
    # ivrit.ai's Hebrew fine-tune of large-v3-turbo (Apache-2.0). On the
    # ivrit.ai Hebrew leaderboard it roughly halves stock turbo's word error
    # rate (eval-d1 5.3% vs 8.4%, eval-whatsapp 7.1% vs 12.8%). The URL is
    # pinned to a commit and the download is checked against its SHA-256, so
    # a re-upload or a corrupted transfer can't silently change the weights.
    "ivrit-large-v3-turbo": {
        "name": "ivrit.ai Hebrew Turbo",
        "language": "he",
        "size": "1.6GB",
        "description": (
            "Whisper Large V3 Turbo fine-tuned on Hebrew by ivrit.ai. "
            "Used automatically for Hebrew recordings."
        ),
        "url": (
            "https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/"
            "resolve/2130c78e4a9cb4914cc4df91a1c3031407789705/ggml-model.bin"
        ),
        "sha256": "c8090411113357097bfafc2b8e228ec1639fa7f5fe4ecb5d054ac0ccef8641b1",
    },
}


def get_models_dir() -> Path:
    """Return the directory pywhispercpp uses for ggml weights."""
    try:
        from pywhispercpp.constants import MODELS_DIR
        return Path(MODELS_DIR)
    except Exception:
        from platformdirs import user_data_dir
        return Path(user_data_dir("pywhispercpp")) / "models"


def model_file_path(model_name: str) -> Path:
    return get_models_dir() / f"ggml-{model_name}.bin"


def is_installed(model_name: str) -> bool:
    return model_file_path(model_name).exists()


def language_model_for(language: str | None) -> str | None:
    """Return the installed language-specific model for ``language``, if any."""
    if not language:
        return None
    for key, meta in LANGUAGE_WHISPER_MODELS.items():
        if meta["language"] == language and is_installed(key):
            return key
    return None


def verify_language_model(model_name: str) -> bool:
    """Check an installed language model against its registered SHA-256.

    whisper.cpp doesn't reject a damaged ggml file: pywhispercpp returns a
    model with no weights, and the first transcribe call crashes the process.
    The file is therefore hashed before it is loaded (under a second for
    1.6 GB). A file that fails is deleted, so Settings offers the Download
    again and a re-pull replaces it.
    """
    expected = LANGUAGE_WHISPER_MODELS.get(model_name, {}).get("sha256")
    path = model_file_path(model_name)
    if not expected or not path.exists():
        return False
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as e:
        logger.warning("Could not read %s: %s", path, e)
        return False
    if digest.hexdigest() == expected:
        return True
    logger.warning("%s failed its checksum; removing it so it can be downloaded again", model_name)
    try:
        path.unlink()
    except OSError as e:
        logger.warning("Could not remove %s: %s", path, e)
    return False


def _download_url(model_name: str) -> str | None:
    if model_name in SUPPORTED_WHISPER_MODELS:
        return (
            "https://huggingface.co/ggerganov/whisper.cpp/"
            f"resolve/main/ggml-{model_name}.bin"
        )
    if model_name in LANGUAGE_WHISPER_MODELS:
        return LANGUAGE_WHISPER_MODELS[model_name]["url"]
    return None


def download_with_progress(
    model_name: str,
    progress_callback: Callable[[int, int, int], None],
) -> bool:
    """Download a whisper.cpp ggml weight file from HuggingFace.

    progress_callback receives ``(percent, downloaded_bytes, total_bytes)``
    on each percent change. Returns True on success.
    """
    url = _download_url(model_name)
    if url is None:
        logger.error("Unknown whisper model: %s", model_name)
        return False

    try:
        import requests
    except ImportError:
        logger.error("requests not available — cannot download whisper model")
        return False

    models_dir = get_models_dir()
    models_dir.mkdir(parents=True, exist_ok=True)
    dest = model_file_path(model_name)
    # A language model already on disk must still match its hash; a damaged
    # one is removed by verify_language_model and downloaded again below.
    if dest.exists() and (
        model_name not in LANGUAGE_WHISPER_MODELS or verify_language_model(model_name)
    ):
        size = dest.stat().st_size
        progress_callback(100, size, size)
        return True

    # Per-process unique temp file so two concurrent downloads of the same
    # model (rare — second app instance, or a double-click before the first
    # request has registered) can't clobber each other's bytes. The losing
    # writer's tmp is cleaned up by its own exception path; whoever renames
    # first wins, the other replace overwrites atomically with identical bytes
    # (os.replace, not Path.rename, which raises on Windows when dest exists).
    tmp = dest.with_suffix(dest.suffix + f".part-{os.getpid()}-{secrets.token_hex(4)}")

    # Language models are third-party fine-tunes, so their downloads must be
    # verified: an entry without a hash fails closed rather than installing
    # unchecked weights.
    expected_sha256 = None
    if model_name in LANGUAGE_WHISPER_MODELS:
        expected_sha256 = LANGUAGE_WHISPER_MODELS[model_name].get("sha256")
        if not expected_sha256:
            logger.error("No SHA-256 registered for language model: %s", model_name)
            return False
    digest = hashlib.sha256()

    try:
        with requests.get(url, stream=True, timeout=30) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length", 0))
            downloaded = 0
            last_pct = -1
            with open(tmp, "wb") as f:
                for chunk in resp.iter_content(chunk_size=128 * 1024):
                    if not chunk:
                        continue
                    f.write(chunk)
                    digest.update(chunk)
                    downloaded += len(chunk)
                    if total > 0:
                        pct = int(downloaded * 100 / total)
                        if pct != last_pct:
                            progress_callback(pct, downloaded, total)
                            last_pct = pct
        if expected_sha256 and digest.hexdigest() != expected_sha256:
            raise ValueError(f"checksum mismatch for {model_name}")
        os.replace(tmp, dest)
        return True
    except Exception as e:
        logger.error("Whisper model download failed: %s", e)
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        return False
