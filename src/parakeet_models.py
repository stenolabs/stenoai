"""Parakeet model registry + installer.

Mirrors ``src/whisper_models.py`` so the Settings / Setup IPC handlers
can list both engines through one shape — name, size, description,
``is_installed`` — without branching on engine in the renderer.

The active model id comes from ``src.parakeet`` which dispatches
between the MLX backend (mac) and the ONNX backend (Windows / Linux).
The user-facing name and behaviour are the same on every platform;
only the underlying HuggingFace repo (and thus the on-disk size +
cache layout) differs. Sizes here reflect the int8-quantised ONNX
encoder on Windows and the published MLX snapshot on mac.
"""
from __future__ import annotations

import logging
import os
import ssl
import sys
from pathlib import Path
from typing import Callable, Optional

from src.parakeet import DEFAULT_MODEL_ID  # platform-dispatched

logger = logging.getLogger(__name__)

_LAST_DOWNLOAD_ERROR: str | None = None
_SAW_SSL_CERTIFICATE_WARNING = False


def get_last_download_error() -> str | None:
    """Return the last sanitized download failure, for CLI JSON responses."""
    return _LAST_DOWNLOAD_ERROR


def _configure_tls_for_huggingface() -> None:
    """Apply the bundled certifi CA bundle before Hugging Face opens HTTPS.

    ``simple_recorder.py`` imports ``src.tls_bootstrap`` at CLI startup, but this
    module is also usable directly from tests and future entrypoints. Keep the
    TLS contract local to the code that imports ``huggingface_hub`` so model
    downloads do not depend on every caller remembering the bootstrap order.
    """
    from src import tls_bootstrap

    tls_bootstrap.configure()


def _is_ssl_certificate_text(text: str) -> bool:
    return "CERTIFICATE_VERIFY_FAILED" in text or "unable to get local issuer certificate" in text


def _is_ssl_certificate_error(error: BaseException) -> bool:
    """Return True for direct or wrapped certificate verification failures."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, ssl.SSLCertVerificationError):
            return True
        if _is_ssl_certificate_text(str(current)):
            return True
        current = current.__cause__ or current.__context__
    return False


class _SslCertificateWarningFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        global _SAW_SSL_CERTIFICATE_WARNING
        if _is_ssl_certificate_text(record.getMessage()):
            _SAW_SSL_CERTIFICATE_WARNING = True
        return True


_SSL_WARNING_FILTER = _SslCertificateWarningFilter()


SUPPORTED_PARAKEET_MODELS: dict[str, dict] = {
    DEFAULT_MODEL_ID: {
        "name": "Parakeet TDT v3",
        "size": "670MB" if sys.platform != "darwin" else "2.5GB",
        "description": (
            "Highest quality. Supports live transcription in English "
            "and 25 European languages — Spanish, French, German, "
            "Italian, Portuguese, Dutch, Russian, Polish, Czech, and "
            "16 others."
        ),
        "speed": "very fast",
        "quality": "excellent",
    },
}

_REQUIRED_SNAPSHOT_FILES: dict[str, tuple[str, ...]] = {
    "mlx-community/parakeet-tdt-0.6b-v3": (
        "config.json",
        "model.safetensors",
    ),
    "istupakov/parakeet-tdt-0.6b-v3-onnx": (
        "config.json",
        "encoder-model.int8.onnx",
        "decoder_joint-model.int8.onnx",
        "vocab.txt",
    ),
}



def _hf_cache_dir_for(model_id: str) -> Path:
    """HuggingFace hub cache directory for a given repo id.

    HF's on-disk layout is ``<hub>/models--<org>--<repo>/``. Resolution
    matches huggingface_hub's own precedence:

    1. ``HF_HUB_CACHE`` — newest, preferred env var.
    2. ``HUGGINGFACE_HUB_CACHE`` — older alias still honoured by HF.
    3. ``$HF_HOME/hub`` — when only the umbrella home is set.
    4. ``~/.cache/huggingface/hub`` — platform default.

    Without HF_HUB_CACHE in the precedence chain, anyone using the
    modern env var would see ``is_installed`` falsely report False even
    after a successful download.
    """
    hub_cache = (
        os.environ.get("HF_HUB_CACHE")
        or os.environ.get("HUGGINGFACE_HUB_CACHE")
    )
    if not hub_cache:
        hf_home = os.environ.get("HF_HOME")
        if hf_home:
            hub_cache = str(Path(hf_home) / "hub")
        else:
            hub_cache = str(Path.home() / ".cache" / "huggingface" / "hub")
    folder_name = "models--" + model_id.replace("/", "--")
    return Path(hub_cache) / folder_name


def is_installed(model_id: str = DEFAULT_MODEL_ID) -> bool:
    """Return True iff a complete runtime snapshot is present on disk.

    HuggingFace creates the snapshot directory and config symlink before a
    large weight download finishes. Treating any non-empty snapshot as
    installed makes the next backend process force ``HF_HUB_OFFLINE=1``, so it
    can neither resume the partial download nor load the missing weights.
    Require every file the selected runtime opens instead.

    This stays free of ``huggingface_hub`` imports because
    ``maybe_enable_offline`` must set its environment before the hub is first
    imported.
    """
    required_files = _REQUIRED_SNAPSHOT_FILES.get(model_id)
    if required_files is None:
        return False

    snapshots = _hf_cache_dir_for(model_id) / "snapshots"
    if not snapshots.is_dir():
        return False
    try:
        for snapshot in snapshots.iterdir():
            if not snapshot.is_dir():
                continue
            try:
                if all(
                    (snapshot / name).is_file()
                    and (snapshot / name).stat().st_size > 0
                    for name in required_files
                ):
                    return True
            except OSError:
                continue
    except OSError:
        return False
    return False


def maybe_enable_offline(model_id: str = DEFAULT_MODEL_ID) -> bool:
    """Force fully-offline HuggingFace resolution when the model is already
    on disk, so loading a cached model makes ZERO network calls (and can't
    hang on a flaky network). Returns whether offline mode was enabled.

    ``huggingface_hub`` reads ``HF_HUB_OFFLINE`` once, at import time, so this
    must run BEFORE the hub is first imported. The backends call it at the top
    of ``_load_model``, immediately before importing parakeet-mlx / onnx-asr,
    which is the latest-safe and only symmetric point.

    Gated on ``is_installed`` so a first-ever or interrupted download is left
    online and can finish. Once every runtime-required file is present, loading
    switches to fully offline resolution.

    ``setdefault`` so an operator who explicitly exported ``HF_HUB_OFFLINE=0``
    for debugging isn't overridden.
    """
    if not is_installed(model_id):
        return False
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    return True


def disable_implicit_hf_token() -> None:
    """Never send an implicit HuggingFace token when pulling our bundled models.

    Parakeet's weights live in PUBLIC HF repos, so they download fine
    anonymously. But ``huggingface_hub`` auto-attaches an *implicit* token to
    every request — from ``HF_TOKEN`` / ``HUGGING_FACE_HUB_TOKEN`` in the
    environment or a cached ``~/.cache/huggingface/token``. The desktop app is
    spawned by Electron and inherits the user's shell environment, so a stray,
    expired, or wrong-account token turns an anonymous public download into an
    ``HTTP 401 Unauthorized`` (a HEAD on config.json 401s, then parakeet-mlx
    masks the real cause with a bogus local-path ``FileNotFoundError``).

    ``HF_HUB_DISABLE_IMPLICIT_TOKEN=1`` tells the hub to send NO token unless
    one is passed explicitly — which we never do for these public pulls — so
    they're always anonymous and can't be broken by the user's environment. We
    only decline to *send* the token; we never read, mutate, or delete it.

    Like ``HF_HUB_OFFLINE``, the hub snapshots this constant at import time, so
    this MUST run before ``huggingface_hub`` is first imported (transitively via
    parakeet-mlx / onnx-asr). Callers invoke it at the top of ``_load_model``,
    right beside ``maybe_enable_offline``. ``setdefault`` so an operator who
    deliberately exported ``HF_HUB_DISABLE_IMPLICIT_TOKEN=0`` (to reach a
    private mirror, say) isn't overridden.
    """
    os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")


def download(
    model_id: str = DEFAULT_MODEL_ID,
    progress_callback: Optional[Callable[[dict], None]] = None,
) -> bool:
    """Fetch runtime files into the existing HF cache, then initialise the model.

    Progress reports completed files and, where the installed hub API supports
    it, bytes for the current file. Never estimates a total percentage or ETA.
    """
    global _LAST_DOWNLOAD_ERROR, _SAW_SSL_CERTIFICATE_WARNING
    _LAST_DOWNLOAD_ERROR = None
    _SAW_SSL_CERTIFICATE_WARNING = False

    if model_id not in SUPPORTED_PARAKEET_MODELS:
        _LAST_DOWNLOAD_ERROR = f"Unknown model: {model_id}"
        logger.error("Unknown Parakeet model: %s", model_id)
        return False

    try:
        emit = progress_callback or (lambda event: None)
        emit({"stage": "preparing"})
        if not is_installed(model_id):
            hub_loggers = (
                logging.getLogger("huggingface_hub"),
                logging.getLogger("huggingface_hub.utils._http"),
            )
            for hub_logger in hub_loggers:
                hub_logger.addFilter(_SSL_WARNING_FILTER)
            try:
                _download_snapshot(model_id, emit)
            finally:
                for hub_logger in hub_loggers:
                    hub_logger.removeFilter(_SSL_WARNING_FILTER)
        emit({"stage": "loading"})
        from src.parakeet import ensure_loaded
        # The hub was imported during download. Setting HF_HUB_OFFLINE in
        # the loader's environment is now too late for its import-time flag.
        # This CLI operation must load the completed cache, not resolve main
        # online again while the UI says the download has finished.
        _configure_tls_for_huggingface()
        from huggingface_hub import constants
        from huggingface_hub.utils import _http
        reset_sessions = getattr(_http, "reset_sessions", lambda: None)
        was_offline = constants.HF_HUB_OFFLINE
        constants.HF_HUB_OFFLINE = True
        try:
            # requests-based hub releases cache the adapter at session creation.
            reset_sessions()
            ensure_loaded(model_id)
        finally:
            constants.HF_HUB_OFFLINE = was_offline
            reset_sessions()
        emit({"stage": "complete"})
        return True
    except Exception as e:
        # parakeet-mlx / onnx-asr fall back to treating the repo id as a local
        # path when the HuggingFace fetch fails, so the exception that reaches
        # here is often a misleading ``FileNotFoundError: '<repo_id>/config.json'``
        # that masks the real cause (an HTTP 401/403/network error logged
        # upstream by huggingface_hub). Detect that shape and point at the
        # likely culprits instead of parroting the bogus local path.
        masks_http_failure = isinstance(e, FileNotFoundError) and model_id in str(e)
        if _is_ssl_certificate_error(e) or _SAW_SSL_CERTIFICATE_WARNING:
            _LAST_DOWNLOAD_ERROR = "TLS certificate verification failed while contacting Hugging Face"
            logger.error(
                "Parakeet model download failed for %s: TLS certificate "
                "verification failed while contacting Hugging Face. Steno tried "
                "to use the bundled certifi CA bundle; if this machine is behind "
                "a corporate proxy, VPN, or antivirus HTTPS inspection, configure "
                "SSL_CERT_FILE or REQUESTS_CA_BUNDLE to point at that network's "
                "root CA bundle. Underlying error: %s",
                model_id, e,
            )
        elif masks_http_failure:
            _LAST_DOWNLOAD_ERROR = "Hugging Face fetch did not complete"
            logger.error(
                "Parakeet model download failed for %s: the HuggingFace fetch "
                "did not complete (see the HTTP log line above). Common causes: "
                "no network, or a stale/invalid HF_TOKEN in the environment "
                "(public models download anonymously — a bad token forces a 401). "
                "Underlying error: %s",
                model_id, e,
            )
        else:
            _LAST_DOWNLOAD_ERROR = "Download failed"
            logger.error("Parakeet model download/load failed: %s", e)
        return False


def _download_snapshot(model_id: str, emit: Callable[[dict], None]) -> None:
    """Use HF's cache/resume/locking APIs, never a second model cache.

    Older hub releases lack per-file tqdm injection: they still report actual
    completed files. Newer releases expose byte callbacks for HTTP and Xet.
    """
    import inspect
    from tqdm.auto import tqdm

    _configure_tls_for_huggingface()
    disable_implicit_hf_token()
    from huggingface_hub import hf_hub_download

    revision = None
    files = _REQUIRED_SNAPSHOT_FILES[model_id]
    supports_progress = "tqdm_class" in inspect.signature(hf_hub_download).parameters
    for index, filename in enumerate(files):
        base = {"stage": "downloading", "completed_files": index, "total_files": len(files)}
        emit(base)

        class DownloadProgress(tqdm):
            def __init__(self, *args, **kwargs):
                # Electron pipes stdout/stderr. Older hub versions otherwise
                # disable tqdm (and its callbacks) when no terminal is attached.
                kwargs.pop("name", None)
                kwargs["disable"] = False
                super().__init__(*args, **kwargs)

            def display(self, *args, **kwargs):
                # n includes resumed bytes; this is file progress, not network
                # throughput. Avoid deriving speed or ETA from cached bytes.
                if self.unit == "B":
                    emit({**base, "file_bytes": self.n})

        kwargs = {"tqdm_class": DownloadProgress} if supports_progress else {}
        cached = hf_hub_download(model_id, filename, revision=revision, token=False, **kwargs)
        # The first file resolves main and writes its cache ref. Pin subsequent
        # files to that same snapshot so an upstream update cannot mix weights.
        if revision is None:
            revision = Path(cached).parent.name
        emit({**base, "completed_files": index + 1})
