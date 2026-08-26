"""
Configuration management for StenoAI.

Handles storing and loading user preferences like model selection.
"""

import copy
import json
import logging
import math
import os
import platform
import re
import shutil
import sys
import tempfile
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Optional, Dict, Any

import filelock

from src.whisper_models import SUPPORTED_WHISPER_MODELS as _WHISPER_REGISTRY
from src import templates as _templates
from src.speaker_schema import validate_display_name, validate_embedding

logger = logging.getLogger(__name__)

# AWS region shape: <code>[-gov]-<name>-<digit(s)>, e.g. us-east-1, eu-west-2,
# us-gov-west-1, cn-northwest-1. Centralised here (not just format-checked at
# one call site) because both this config layer and bedrock_converse_url()
# (src/summarizer.py, which imports this) must agree — a region string
# crafted to redirect the request via `user@host` URL syntax (e.g.
# "x@127.0.0.1:8443/") has to be rejected by both, not just whichever one an
# attacker didn't think to route around. See issue #299.
#
# Match with fullmatch() (never match()+"$" — "$" alone still allows a
# trailing "\n"). Digits are [0-9], not \d — \d is Unicode-aware by default
# and would accept visually-similar non-ASCII digits (e.g. Arabic-Indic "١").
BEDROCK_REGION_RE = re.compile(r"[a-z]{2}(-gov)?-[a-z]+-[0-9]{1,2}")


def _atomic_write(path: Path, render, encoding: str = 'utf-8') -> None:
    """Durably replace `path` with whatever `render(fh)` writes.

    The shared core behind _atomic_write_json and _atomic_write_text: a
    tempfile in the SAME directory (so the rename can't cross a filesystem
    boundary), flush + fsync so the bytes are on the platter before the
    rename, then os.replace — a single filesystem operation on POSIX and
    Windows. A crash, a full disk, or a killed process mid-write therefore
    leaves the previous file intact rather than a half-written one, and a
    concurrent reader sees either the old file or the new one, never a torn
    mix. The temp file is removed on any failure so a failed write leaves
    no debris next to the real file.

    `render` takes the open text handle and writes the payload; anything it
    raises propagates to the caller after cleanup.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(
        mode='w',
        dir=str(path.parent),
        prefix=f'.{path.name}.',
        suffix='.tmp',
        delete=False,
        encoding=encoding,
    )
    try:
        render(tmp)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        # Windows can transiently refuse the replace while another
        # process holds the destination open for read; a couple of
        # short retries cover that without a platform gate.
        for attempt in range(3):
            try:
                os.replace(tmp.name, path)
                return
            except PermissionError:
                if attempt == 2:
                    raise
                time.sleep(0.05)
    except Exception:
        try:
            tmp.close()
        except Exception:
            pass
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


def _atomic_write_json(path: Path, payload) -> None:
    """Write `payload` as JSON to `path` atomically.

    The shared atomic writer for every JSON file the CLI persists —
    config.json and folders.json here, recorder_state.json and the final
    summary JSON via the re-export in simple_recorder. config.json in
    particular is read by many concurrent CLI subprocesses; a plain
    truncate-and-rewrite lets a reader see a torn file, fall back to
    defaults, and (pre-fix) persist those defaults over the user's real
    settings. See _atomic_write for the durability mechanics.
    """
    _atomic_write(path, lambda fh: json.dump(payload, fh, indent=2))


def _atomic_write_text(path: Path, text: str, encoding: str = 'utf-8') -> None:
    """Write `text` to `path` atomically — the Path.write_text replacement.

    The summary Markdown is the app's primary user artifact and is rewritten
    in place on every reprocess, retranscribe, title regeneration and live
    append. Plain write_text truncates first, so a crash (or a full disk)
    between truncate and write leaves the user with an empty or half-written
    note and no previous version to fall back to. See _atomic_write.

    Note: the .md and its sidecar .json are each written atomically but are
    NOT written as one transaction — a crash between the two can still leave
    them disagreeing. Out of scope here; the individual files stay readable.
    """
    _atomic_write(path, lambda fh: fh.write(text), encoding=encoding)


def get_user_data_dir() -> Path:
    """Per-OS user data directory for stenoai when running as a frozen bundle.

    macOS:   ~/Library/Application Support/stenoai
    Windows: %APPDATA%/stenoai  (Roaming)
    Linux:   $XDG_DATA_HOME/stenoai or ~/.local/share/stenoai
    """
    # E2E isolation: a per-test temp dir set via STENOAI_USER_DATA_DIR wins for
    # the backend child too (the Electron parent propagates it via the inherited
    # env). Symmetric with app/main.js getUserDataDir(). Inert in production.
    override = os.environ.get("STENOAI_USER_DATA_DIR")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "stenoai"
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        return (Path(base) if base else Path.home() / "AppData" / "Roaming") / "stenoai"
    base = os.environ.get("XDG_DATA_HOME")
    return (Path(base) if base else Path.home() / ".local" / "share") / "stenoai"


def is_bundled() -> bool:
    """True when running from a PyInstaller-frozen bundle.

    The legacy "StenoAI.app"/"Applications" string check was a mac-only safety
    net; sys.frozen is the canonical PyInstaller marker on every platform, with
    the path check kept as a belt-and-braces for mac-source-in-Applications.
    """
    if getattr(sys, "frozen", False):
        return True
    path = str(Path(__file__))
    return "StenoAI.app" in path or "Applications" in path


def is_apple_silicon() -> bool:
    """True on macOS running on Apple Silicon (arm64/aarch64).

    The single gate for every Ollama-MLX-tag decision in this module — no
    other function should re-derive this check.
    """
    return sys.platform == "darwin" and platform.machine() in ("arm64", "aarch64")


class _AnyDiarizationRun:
    """The "no run scope at all" default of `remove_speaker_evidence`.

    A sentinel rather than `None`, because `None` is already a meaningful
    scope on this axis: it is what a legacy sidecar with no `diarization_run`
    block reports, and scoping to it must match only equally run-less
    evidence. Sharing one value for "don't filter by run" and "filter by the
    absence of a run" would either make every run-unaware caller start
    filtering or make a legacy-sidecar caller delete run-stamped evidence it
    cannot have produced.
    """

    def __repr__(self) -> str:
        return "ANY_DIARIZATION_RUN"


ANY_DIARIZATION_RUN = _AnyDiarizationRun()


class Config:
    """Manages application configuration with file persistence."""

    DEFAULT_MODEL = "gemma4:e2b-it-qat"

    # Supported models with metadata. Active models first (roughly ascending by
    # capability/size, default first), deprecated models last — the Settings UI
    # tucks deprecated entries into a collapsed, dimmed section and only surfaces
    # one if it's still the user's current model. Deprecated (rather than removed)
    # so a user already on the model keeps a recognised selection; fully retired
    # models are dropped from this dict.
    SUPPORTED_MODELS = {
        "gemma4:e2b-it-qat": {
            "name": "Gemma 4 E2B (QAT)",
            "size": "4.3GB",
            "params": "2B",
            "description": "Lightest Gemma 4, quantization-aware, real 128K context (default)",
            "speed": "fast",
            "quality": "good"
        },
        "gemma4:e4b-it-qat": {
            "name": "Gemma 4 E4B (QAT)",
            "size": "6.1GB",
            "params": "4B",
            "description": "Quantization-aware E4B — higher quality than E2B at a modest footprint",
            "speed": "medium",
            "quality": "excellent"
        },
        "llama3.2:3b": {
            "name": "Llama 3.2 3B",
            "size": "2GB",
            "params": "3B",
            "description": "Replaced by Gemma 4 E2B",
            "speed": "very fast",
            "quality": "good",
            "deprecated": True
        },
        "qwen3.5:9b": {
            "name": "Qwen 3.5 9B",
            "size": "6.6GB",
            "params": "9B",
            "description": "Excellent at structured output and action items",
            "speed": "medium",
            "quality": "excellent"
        },
        "gemma4:12b-it-qat": {
            "name": "Gemma 4 12B (QAT)",
            "size": "7.2GB",
            "params": "12B",
            "description": "Large 256K context, quantization-aware - best for long meetings",
            "speed": "medium",
            "quality": "excellent"
        },
        "gpt-oss:20b": {
            "name": "GPT-OSS 20B",
            "size": "14GB",
            "params": "20B",
            "description": "OpenAI open-weight model with reasoning capabilities",
            "speed": "medium",
            "quality": "excellent"
        },
    }


    # Single source of truth for the curated Whisper model lineup is
    # src/whisper_models.py — that module owns display names, sizes,
    # descriptions, and the installed-status check the UI cards consume.
    # The list form here is what the validation paths (set_whisper_model,
    # get_whisper_model fallback) compare against. Re-derive on import so
    # adding a model in whisper_models.py automatically widens validation.
    SUPPORTED_WHISPER_MODELS = list(_WHISPER_REGISTRY.keys())

    # Languages shown in the settings dropdown (curated/tested)
    SUPPORTED_LANGUAGES = {
        "auto": "Auto (detect)",
        "en": "English",
        "es": "Spanish",
        "fr": "French",
        "de": "German",
        "nl": "Dutch",
        "pt": "Portuguese",
        "ja": "Japanese",
        "zh-Hans": "Chinese (Simplified)",
        "zh-Hant": "Chinese (Traditional)",
        "ko": "Korean",
        "hi": "Hindi",
        "ar": "Arabic",
    }

    # Full ISO 639-1 language names for auto-detect passthrough.
    # Whisper supports 99 languages; this maps codes to display names
    # so the summarizer prompt gets a proper language name (e.g. "Polish")
    # rather than just a code (e.g. "pl").
    _LANGUAGE_NAMES = {
        "af": "Afrikaans", "am": "Amharic", "ar": "Arabic", "as": "Assamese",
        "az": "Azerbaijani", "ba": "Bashkir", "be": "Belarusian", "bg": "Bulgarian",
        "bn": "Bengali", "bo": "Tibetan", "br": "Breton", "bs": "Bosnian",
        "ca": "Catalan", "cs": "Czech", "cy": "Welsh", "da": "Danish",
        "de": "German", "el": "Greek", "en": "English", "es": "Spanish",
        "et": "Estonian", "eu": "Basque", "fa": "Persian", "fi": "Finnish",
        "fo": "Faroese", "fr": "French", "gl": "Galician", "gu": "Gujarati",
        "ha": "Hausa", "haw": "Hawaiian", "he": "Hebrew", "hi": "Hindi",
        "hr": "Croatian", "ht": "Haitian Creole", "hu": "Hungarian", "hy": "Armenian",
        "id": "Indonesian", "is": "Icelandic", "it": "Italian", "ja": "Japanese",
        "jw": "Javanese", "ka": "Georgian", "kk": "Kazakh", "km": "Khmer",
        "kn": "Kannada", "ko": "Korean", "la": "Latin", "lb": "Luxembourgish",
        "ln": "Lingala", "lo": "Lao", "lt": "Lithuanian", "lv": "Latvian",
        "mg": "Malagasy", "mi": "Maori", "mk": "Macedonian", "ml": "Malayalam",
        "mn": "Mongolian", "mr": "Marathi", "ms": "Malay", "mt": "Maltese",
        "my": "Myanmar", "ne": "Nepali", "nl": "Dutch", "nn": "Nynorsk",
        "no": "Norwegian", "oc": "Occitan", "pa": "Punjabi", "pl": "Polish",
        "ps": "Pashto", "pt": "Portuguese", "ro": "Romanian", "ru": "Russian",
        "sa": "Sanskrit", "sd": "Sindhi", "si": "Sinhala", "sk": "Slovak",
        "sl": "Slovenian", "sn": "Shona", "so": "Somali", "sq": "Albanian",
        "sr": "Serbian", "su": "Sundanese", "sv": "Swedish", "sw": "Swahili",
        "ta": "Tamil", "te": "Telugu", "tg": "Tajik", "th": "Thai",
        "tk": "Turkmen", "tl": "Tagalog", "tr": "Turkish", "tt": "Tatar",
        "uk": "Ukrainian", "ur": "Urdu", "uz": "Uzbek", "vi": "Vietnamese",
        "yi": "Yiddish", "yo": "Yoruba", "zh": "Chinese",
    }

    VALID_TRANSCRIPTION_ENGINES = ("parakeet", "whisper")
    DEFAULT_MCP_ENABLED: bool = False
    DEFAULT_MCP_PORT: int = 27127
    MIN_MCP_PORT: int = 1024
    MAX_MCP_PORT: int = 65535


    def __init__(self, config_path: Optional[Path] = None):
        """
        Initialize configuration manager.

        Args:
            config_path: Path to config file. If None, uses default location.
        """
        if config_path is None:
            # STENOAI_USER_DATA_DIR forces the data dir even from source (e2e
            # isolation), so the override in get_user_data_dir() is authoritative
            # whether the backend runs frozen or from source.
            if is_bundled() or os.environ.get("STENOAI_USER_DATA_DIR"):
                base_dir = get_user_data_dir()
            else:
                # Source dev: project root
                base_dir = Path(__file__).parent.parent

            base_dir.mkdir(parents=True, exist_ok=True)
            self.config_path = base_dir / "config.json"
        else:
            self.config_path = config_path

        # Captured before _load() because _load() returns defaults silently
        # when the file is missing — by the time migrations run we can't tell
        # "fresh install" from "loaded existing file" by inspecting self._config
        # alone (whisper_model and friends are in the defaults dict).
        self._existed_at_load = self.config_path.exists()
        # Set by _load() when an existing config file could not be parsed.
        # Migrations check it so a corrupt (or torn, mid-write) read never
        # gets its in-memory defaults persisted over the recoverable file.
        self._load_failed = False
        self._config: Dict[str, Any] = self._load()
        # Snapshot of exactly what was read from disk (or the defaults on a
        # fresh/corrupt load). _save() diffs self._config against this to write
        # back ONLY the keys this process actually changed, so a concurrent
        # writer's unrelated keys aren't clobbered (the lost-update fix).
        self._snapshot: Dict[str, Any] = copy.deepcopy(self._config)
        # A confirm-speaker operation updates several related profile entries.
        # Batch their otherwise-independent _save() calls into one atomic
        # config write so a failed final save cannot leave half a reassignment
        # on disk or relabel a transcript without the matching profile.
        self._transaction_backup: Optional[tuple[Dict[str, Any], Dict[str, Any]]] = None
        self._transaction_dirty = False
        self._transaction_lock = None
        self._migrate_cloud_model_map()
        self._migrate_whisper_model()
        self._migrate_summary_model()
        self._adopt_apple_system_default()
        self._migrate_transcription_engine()
        self._migrate_language_zh()
        self._migrate_privacy_notice_seen()
        self._migrate_identity_matching_privacy_default()
        self._normalize_templates()
        self._seed_sample_template()
        self._normalize_recipes()
        self._normalize_voiceprints()
        self._normalize_mcp_settings()


    def _migrate_language_zh(self) -> None:
        """Migrate the legacy single ``"zh"`` language to Simplified (``zh-Hans``).

        Chinese used to be one selectable entry ("zh"); it's now split into
        ``zh-Hans`` (Simplified) and ``zh-Hant`` (Traditional). whisper.cpp
        emits Simplified for "zh", so an existing "zh" user was effectively on
        Simplified — map them there and leave the Traditional opt-in to the
        Settings dropdown.
        """
        if self._load_failed:
            return  # never persist defaults over a corrupt-but-recoverable file
        if self._config.get("language") == "zh":
            self._config["language"] = "zh-Hans"
            self._save()

    def _migrate_transcription_engine(self) -> None:
        """Decide the active ASR engine on first launch of a version that has
        this field.

        New installs default to Parakeet. Existing users (config.json existed
        before this launch) stay on Whisper so their muscle memory and any
        Asian-language workflows aren't silently swapped under them; the
        Settings → Transcribe tab is how they opt into Parakeet.
        """
        if self._load_failed:
            return  # never persist defaults over a corrupt-but-recoverable file
        if self._config.get("transcription_engine") in self.VALID_TRANSCRIPTION_ENGINES:
            return
        self._config["transcription_engine"] = (
            "whisper" if self._existed_at_load else "parakeet"
        )
        self._save()

    def _migrate_privacy_notice_seen(self) -> None:
        """Seed the one-time privacy notice marker for fresh and existing installs.

        Fresh installs are disclosed during onboarding, so their default marker
        is True. Existing installs whose on-disk config predates the marker get
        False so the upgrade notice appears once. Inspecting the disk directly
        keeps a default-filled in-memory config from masking key absence.
        """
        if self._load_failed:
            return  # never persist defaults over a corrupt-but-recoverable file
        if not self._existed_at_load:
            self._config["privacy_notice_seen"] = True
            return

        on_disk = self._read_disk_for_merge()
        if on_disk is not None and "privacy_notice_seen" in on_disk:
            adopted = on_disk.get("privacy_notice_seen") is True
            self._config["privacy_notice_seen"] = adopted
            self._snapshot["privacy_notice_seen"] = adopted
            return

        self._config["privacy_notice_seen"] = False
        self._persist_privacy_notice_migration()
        # Keep an ordinary later _save() from bypassing the locked CAS. If the
        # persist lost a race, the helper has already adopted the disk value.
        self._snapshot["privacy_notice_seen"] = self._config[
            "privacy_notice_seen"
        ]

    def _persist_privacy_notice_migration(self) -> None:
        """Locked compare-and-set write for the privacy notice marker.

        Re-read config.json while holding the lock. If another process wrote
        the marker first, adopt its value rather than clobbering it. Failures
        leave the existing install's in-memory value False and retry next load.
        """
        lock_path = str(self.config_path) + ".lock"
        try:
            with filelock.FileLock(lock_path, timeout=self._SAVE_LOCK_TIMEOUT):
                base = self._read_disk_for_merge()
                if base is None:
                    return
                if "privacy_notice_seen" in base:
                    adopted = base.get("privacy_notice_seen") is True
                    self._config["privacy_notice_seen"] = adopted
                    self._snapshot["privacy_notice_seen"] = adopted
                    return
                base["privacy_notice_seen"] = False
                _atomic_write_json(self.config_path, base)
                self._snapshot["privacy_notice_seen"] = False
        except filelock.Timeout:
            logger.warning(
                "Timed out acquiring config lock for privacy notice migration; "
                "will retry on next load"
            )
        except Exception as e:
            logger.error(f"Error persisting privacy notice migration: {e}")

    IDENTITY_MATCHING_PRIVACY_DEFAULT_VERSION = 1

    def _migrate_identity_matching_privacy_default(self) -> None:
        """Disable the former implicit opt-in exactly once.

        Older releases stored identity matching as enabled by default, so an
        on-disk True value does not prove that the user chose biometric voice
        profiles. Configurations without the version marker are moved to the
        privacy-safe disabled state. Once marked, later user choices survive.
        """
        if self._load_failed:
            return
        if not self._existed_at_load:
            return

        current_version = self._config.get(
            "identity_matching_privacy_default_version", 0
        )
        if not isinstance(current_version, int):
            current_version = 0
        if current_version >= self.IDENTITY_MATCHING_PRIVACY_DEFAULT_VERSION:
            return

        self._config["identity_matching_enabled"] = False
        self._config[
            "identity_matching_privacy_default_version"
        ] = self.IDENTITY_MATCHING_PRIVACY_DEFAULT_VERSION
        if self._persist_identity_matching_privacy_default_migration():
            self._snapshot["identity_matching_enabled"] = self._config[
                "identity_matching_enabled"
            ]
            self._snapshot[
                "identity_matching_privacy_default_version"
            ] = self._config["identity_matching_privacy_default_version"]

    def _persist_identity_matching_privacy_default_migration(self) -> bool:
        """Persist the one-time privacy default with a locked compare-and-set."""
        lock_path = str(self.config_path) + ".lock"
        try:
            with filelock.FileLock(lock_path, timeout=self._SAVE_LOCK_TIMEOUT):
                base = self._read_disk_for_merge()
                if base is None:
                    return False
                version = base.get("identity_matching_privacy_default_version", 0)
                if not isinstance(version, int):
                    version = 0
                if version >= self.IDENTITY_MATCHING_PRIVACY_DEFAULT_VERSION:
                    adopted = base.get("identity_matching_enabled") is True
                    self._config["identity_matching_enabled"] = adopted
                    self._config["identity_matching_privacy_default_version"] = version
                    return True
                base["identity_matching_enabled"] = False
                base[
                    "identity_matching_privacy_default_version"
                ] = self.IDENTITY_MATCHING_PRIVACY_DEFAULT_VERSION
                _atomic_write_json(self.config_path, base)
                return True
        except filelock.Timeout:
            logger.warning(
                "Timed out acquiring config lock for speaker-identification "
                "privacy migration; will retry on next load"
            )
            return False
        except Exception as e:
            logger.error(
                "Error persisting speaker-identification privacy migration: "
                f"{e}"
            )
            return False

    def _migrate_whisper_model(self) -> None:
        """Map any out-of-current-list whisper model to the supported one.

        The curated lineup is now a single tier (large-v3-turbo), so any
        previously-supported but now-retired tier (tiny/base/small/medium/
        large/large-v3) migrates to it.
        """
        if self._load_failed:
            return  # never persist defaults over a corrupt-but-recoverable file
        current = self._config.get("whisper_model")
        if current is None or current in self.SUPPORTED_WHISPER_MODELS:
            return
        self._config["whisper_model"] = "large-v3-turbo"
        self._save()

    # Summary-model ids we renamed in place — a user pinned to the old tag is
    # moved to the equivalent, better-quantized build so they keep the model
    # they chose (rather than being dropped to the default). The new tag is a
    # different Ollama model, so the next summarisation pulls it on demand.
    _RENAMED_SUMMARY_MODELS = {
        "gemma4:4b": "gemma4:e4b-it-qat",
        "gemma4:12b": "gemma4:12b-it-qat",
    }

    # The three curated Gemma 4 QAT models' NVFP4/MLX-engine equivalents,
    # adopted on Apple Silicon for a large generation-speed win (Ollama's MLX
    # engine is GA there). Deliberately NOT applied to llama3.2:3b/qwen3.5:9b/
    # gpt-oss:20b — Ollama does not ship MLX builds of those.
    _MLX_EQUIVALENTS = {
        "gemma4:e2b-it-qat": "gemma4:e2b-nvfp4",
        "gemma4:e4b-it-qat": "gemma4:e4b-nvfp4",
        "gemma4:12b-it-qat": "gemma4:12b-nvfp4",
    }
    _MLX_TO_GGUF = {mlx_tag: gguf_id for gguf_id, mlx_tag in _MLX_EQUIVALENTS.items()}

    # NVFP4 blobs are a different quantization than their GGUF counterpart in
    # SUPPORTED_MODELS and can be meaningfully larger -- shown instead of the
    # GGUF size whenever the NVFP4 tag is what's actually installed or (on a
    # fresh pull) what "Select" will actually download. Keyed by the NVFP4
    # tag, not the GGUF id, matching how it's looked up in list_models().
    _MLX_SIZES = {
        "gemma4:e2b-nvfp4": "6.5GB",
        "gemma4:e4b-nvfp4": "8.8GB",
        "gemma4:12b-nvfp4": "7.7GB",
    }

    # Curated models we retired — a user pinned to one is migrated to the
    # default on load. Deliberately a specific allow-list, NOT "anything not in
    # SUPPORTED_MODELS": set_model intentionally allows arbitrary user-pulled
    # Ollama models (e.g. llama3.2:1b), and those must NOT be clobbered.
    _RETIRED_SUMMARY_MODELS = {"gemma3:4b", "deepseek-r1:14b"}

    def _migrate_summary_model(self) -> None:
        """Migrate a renamed or retired summary model on load.

        Renamed ids (gemma4:4b -> gemma4:e4b-it-qat, gemma4:12b ->
        gemma4:12b-it-qat) move to the equivalent quantization-aware build, so
        the user keeps their chosen model; the new tag is pulled on demand.
        Retired ids (gemma3:4b, deepseek-r1:14b) reset to the default. Only
        these specific ids migrate — custom/self-pulled models and the
        deprecated-but-kept llama3.2:3b are left alone.
        """
        if self._load_failed:
            return  # never persist defaults over a corrupt-but-recoverable file
        current = self._config.get("model")
        if current in self._RENAMED_SUMMARY_MODELS:
            self._config["model"] = self._RENAMED_SUMMARY_MODELS[current]
            self._save()
        elif current in self._RETIRED_SUMMARY_MODELS:
            self._config["model"] = self.DEFAULT_MODEL
            self._save()


    def _adopt_apple_system_default(self) -> None:
        """On Darwin, adopt Apple System Language Model when available and unset/auto."""
        if self._load_failed:
            return
        if self.get_ai_provider() != "local":
            return
        source = self._config.get("summary_model_source")
        current = self._config.get("model", self.DEFAULT_MODEL)
        from src.apple_lm import (
            APPLE_SYSTEM_MODEL,
            apple_lm_available,
        )

        if source is None:
            source = (
                "auto"
                if current in (self.DEFAULT_MODEL, APPLE_SYSTEM_MODEL)
                else "user"
            )
            self._config["summary_model_source"] = source

        if source == "auto":
            target = APPLE_SYSTEM_MODEL if apple_lm_available() else self.DEFAULT_MODEL
            if current != target:
                self._config["model"] = target
                self._save()

    def _migrate_cloud_model_map(self) -> None:
        """One-shot migration from legacy single 'cloud_model' to per-provider
        'cloud_models' map. Runs at load time (before any setters can change
        the provider) so the legacy value is correctly attributed to whichever
        provider was active when it was last saved."""
        if self._load_failed:
            # _load() returned defaults for a corrupt-but-present file. The
            # defaults carry a legacy 'cloud_model', so without this guard the
            # migration below would _save() and overwrite the recoverable file.
            self._config["cloud_models"] = {}
            return
        if isinstance(self._config.get("cloud_models"), dict):
            return  # Already migrated.
        legacy = self._config.get("cloud_model")
        has_legacy_value = isinstance(legacy, str) and legacy.strip()
        if not has_legacy_value:
            # Nothing to migrate; don't write just to persist an empty map.
            self._config["cloud_models"] = {}
            return
        current_provider = self._config.get("cloud_provider", "openai")
        if current_provider not in self.VALID_CLOUD_PROVIDERS:
            current_provider = "openai"
        self._config["cloud_models"] = {current_provider: legacy.strip()}
        self._save()

    def _load(self) -> Dict[str, Any]:
        """Load configuration from file.

        A parse failure on an existing file is retried once (a torn read
        racing a writer heals in milliseconds). If it still fails, the
        corrupt file is backed up to config.json.corrupt and we run on
        in-memory defaults with self._load_failed set — migrations skip
        writing so the original on disk stays recoverable.
        """
        if not self.config_path.exists():
            logger.info(f"Config file not found, creating default at {self.config_path}")
            return self._get_default_config()

        last_error = None
        for attempt in range(2):
            try:
                with open(self.config_path, 'r') as f:
                    config = json.load(f)
                    if not isinstance(config, dict):
                        # `null` / `[]` parse fine but crash every get/set
                        # later; route them through the corrupt-file path.
                        raise ValueError("config.json root is not an object")
                    logger.info(f"Loaded config from {self.config_path}")
                    return config
            except Exception as e:
                last_error = e
                if attempt == 0:
                    time.sleep(0.2)

        self._load_failed = True
        backup_path = self.config_path.with_name(self.config_path.name + ".corrupt")
        try:
            shutil.copy2(self.config_path, backup_path)
            logger.error(
                f"Error loading config: {last_error}. Using defaults in memory; "
                f"corrupt file backed up to {backup_path}"
            )
        except Exception as backup_error:
            logger.error(
                f"Error loading config: {last_error}. Using defaults in memory; "
                f"backup to {backup_path} also failed: {backup_error}"
            )
        return self._get_default_config()

    # Seconds to wait for the cross-process config lock before giving up and
    # falling back to an unlocked write. Generous enough to cover a normal
    # save on a busy disk, short enough that a truly stuck lock never blocks
    # the CLI for long.
    _SAVE_LOCK_TIMEOUT = 10

    def _read_disk_for_merge(self) -> Optional[Dict[str, Any]]:
        """Re-read config.json fresh for use as the merge base. Returns the
        parsed dict, or None if the file is missing / unparseable / not a dict
        (in which case the caller writes its own config wholesale). Must be
        called under the file lock so the read reflects any concurrent writer's
        just-completed atomic replace."""
        if not self.config_path.exists():
            return None
        try:
            with open(self.config_path, 'r') as f:
                data = json.load(f)
        except Exception:
            return None
        return data if isinstance(data, dict) else None

    @classmethod
    def _apply_changes(
        cls, base: Dict[str, Any], current: Dict[str, Any], snapshot: Any
    ) -> Dict[str, Any]:
        """Overlay onto `base` (fresh from disk) only the changes between
        `snapshot` (what we loaded) and `current` (our in-memory dict).

        Recurses into dict-valued keys so two processes editing DIFFERENT
        sub-keys of the SAME nested dict (e.g. per-provider `cloud_models`, or
        `template_overrides`) don't clobber each other — we assert only the
        sub-keys THIS process actually touched and keep the concurrent writer's
        sub-keys straight from disk. Scalars and lists are overlaid wholesale
        (a list has no clean per-element three-way merge, so last-writer-wins,
        matching the design's genuine-conflict stance). A key whose type
        changed between dict and non-dict also falls back to a wholesale
        overlay. Nested deletions (config's only deletion path, reset_template
        dropping a `template_overrides` entry) are propagated too.

        Returns a new dict; does not mutate `base`, `current`, or `snapshot`."""
        result = dict(base)
        snap = snapshot if isinstance(snapshot, dict) else {}
        for key, cur_val in current.items():
            if key in snap and snap[key] == cur_val:
                continue  # unchanged by us — keep disk's (possibly newer) value
            base_val = result.get(key)
            if isinstance(cur_val, dict) and isinstance(base_val, dict):
                result[key] = cls._apply_changes(base_val, cur_val, snap.get(key))
            else:
                result[key] = cur_val
        # Propagate keys we removed since load (present in our load snapshot,
        # gone from current). Our removal wins over a concurrent edit, symmetric
        # with how our edits overlay theirs.
        for key in snap:
            if key not in current:
                result.pop(key, None)
        return result

    def _merge_for_save(self) -> Dict[str, Any]:
        """Build the dict to persist: a fresh on-disk read with only the
        changes this process made since load overlaid on top (recursively for
        nested dicts — see _apply_changes).

        Diffing against self._snapshot (what we loaded) rather than writing
        self._config wholesale is what prevents the lost update — a concurrent
        writer's unrelated keys, present in the fresh read but untouched by us,
        survive. Must be called under the file lock."""
        base = self._read_disk_for_merge()
        if base is None:
            # Missing / corrupt / non-dict on disk: write our own config
            # wholesale. Preserves the corrupt-file recovery semantics — a
            # set() after a corrupt load still lays down a valid file.
            return dict(self._config)
        return self._apply_changes(base, self._config, self._snapshot)

    def _save(self) -> bool:
        """Save configuration to disk without clobbering concurrent writers.

        The app spawns a fresh CLI subprocess per operation (no daemon), so two
        near-simultaneous writers each do load-whole-config -> mutate one key ->
        write-whole-file and silently revert each other's unrelated keys
        (classic lost update). _atomic_write_json fixes torn files but not this.

        Fix: under a cross-process file lock (filelock: fcntl on POSIX / msvcrt
        on Windows, auto-released if a holder crashes) re-read config.json fresh
        as the merge base and overlay only the top-level keys this process
        changed. On lock timeout, degrade to a plain unlocked atomic write of
        our own config — a stuck lock must never block saves or raise.
        """
        if self._transaction_backup is not None:
            self._transaction_dirty = True
            return True

        lock_path = str(self.config_path) + ".lock"
        try:
            # filelock is NOT reentrant: _save() must never be called while
            # already holding this lock (no current path does).
            with filelock.FileLock(lock_path, timeout=self._SAVE_LOCK_TIMEOUT):
                merged = self._merge_for_save()
                _atomic_write_json(self.config_path, merged)
                # Adopt the merged result so a second _save() in this process
                # diffs against what we just wrote, not the stale load snapshot.
                self._config = merged
                self._snapshot = copy.deepcopy(merged)
                logger.info(f"Saved config to {self.config_path}")
                return True
        except filelock.Timeout:
            logger.warning(
                f"Timed out acquiring config lock at {lock_path}; "
                f"falling back to an unlocked atomic write"
            )
            try:
                _atomic_write_json(self.config_path, self._config)
                # Keep the snapshot consistent with what we just wrote so a
                # later save on this instance diffs correctly.
                self._snapshot = copy.deepcopy(self._config)
                return True
            except Exception as e:
                logger.error(f"Error saving config: {e}")
                return False
        except Exception as e:
            logger.error(f"Error saving config: {e}")
            return False

    def begin_transaction(self) -> bool:
        """Reload and defer mutations while holding the config file lock."""
        if self._transaction_backup is not None:
            raise RuntimeError("Config transaction already active")
        lock = filelock.FileLock(
            str(self.config_path) + ".lock", timeout=self._SAVE_LOCK_TIMEOUT,
        )
        try:
            lock.acquire()
        except filelock.Timeout:
            logger.error(f"Timed out acquiring config lock at {lock.lock_file}")
            return False
        fresh = self._read_disk_for_merge()
        if fresh is not None:
            self._config = fresh
            self._snapshot = copy.deepcopy(fresh)
        self._transaction_backup = (
            copy.deepcopy(self._config),
            copy.deepcopy(self._snapshot),
        )
        self._transaction_dirty = False
        self._transaction_lock = lock
        return True

    def commit_transaction(self) -> bool:
        """Commit a deferred batch, restoring in-memory state on failure."""
        if self._transaction_backup is None:
            raise RuntimeError("No Config transaction active")
        old_config, old_snapshot = self._transaction_backup
        dirty = self._transaction_dirty
        try:
            if dirty:
                _atomic_write_json(self.config_path, self._config)
                self._snapshot = copy.deepcopy(self._config)
            return True
        except Exception as error:
            logger.error(f"Error saving config transaction: {error}")
            self._config = old_config
            self._snapshot = old_snapshot
            return False
        finally:
            self._transaction_backup = None
            self._transaction_dirty = False
            if self._transaction_lock is not None:
                self._transaction_lock.release()
                self._transaction_lock = None

    def rollback_transaction(self) -> None:
        """Discard a deferred batch without touching the on-disk config."""
        if self._transaction_backup is None:
            return
        self._config, self._snapshot = self._transaction_backup
        self._transaction_backup = None
        self._transaction_dirty = False
        if self._transaction_lock is not None:
            self._transaction_lock.release()
            self._transaction_lock = None

    def _get_default_config(self) -> Dict[str, Any]:
        """Get default configuration."""
        from src.apple_lm import resolve_default_summary_model
        return {
            "model": resolve_default_summary_model(),
            "summary_model_source": "auto",
            "notifications_enabled": True,
            # Default ON — the calendar-based pre-meeting heads-up, independent
            # of notifications_enabled (which now only covers note-ready/
            # silence-auto-stop). Requires a connected calendar to fire at all.
            "premeeting_notifications_enabled": True,
            # Default ON — mirrors hide_dock_icon's absence from this dict
            # (both use a .get() fallback); listed explicitly here since it's
            # new and the default matters for the "both hidden" warning logic.
            "show_menu_bar_icon": True,
            "telemetry_enabled": True,
            # Fresh installs see the disclosure during onboarding. Existing
            # configs missing this key are migrated to False so the one-time
            # upgrade notice is shown.
            "privacy_notice_seen": True,
            # Default ON on macOS — CoreAudio Process Tap captures system
            # audio alongside the mic on macOS 14.4+. Older macOS auto-falls
            # back to mic-only via main.js's loadSystemAudioEnabled() OS gate.
            # Default OFF on Windows/Linux: the cross-platform loopback path
            # (electron-audio-loopback / Chromium WASAPI) works but is still
            # pending hardware verification, so it ships opt-in/experimental —
            # users enable it explicitly in Settings.
            "system_audio_enabled": sys.platform == "darwin",
            # Default ON — surfaces a "Meeting detected" notification when
            # any non-Steno app starts capturing the mic. Helper is gated
            # to macOS 14+ in main.js; users can flip off in Settings.
            "auto_detect_meetings_enabled": True,
            # Default ON — Steno auto-starts (hidden, in the tray/menu bar)
            # when the user logs in. main.js registers/removes the OS login
            # item and suppresses the first window show on a login launch.
            # Users opt out in Settings.
            "launch_on_login": True,
            # Default ON — the global (system-wide) record shortcut
            # (CommandOrControl+Shift+R) is registered at startup so recording
            # can be toggled from anywhere. Users turn it off in Settings when
            # it conflicts with another app (e.g. a browser's hard-reload).
            "record_hotkey_enabled": True,
            # "auto" so _resolve_output_language() picks the transcript's
            # detected language instead of silently defaulting every
            # unconfigured install to English summaries (#281).
            "language": "auto",
            "ai_provider": "local",
            "remote_ollama_url": "",
            "cloud_api_url": "",
            "cloud_provider": "openai",
            "cloud_model": "gpt-4o-mini",
            "anonymous_id": str(uuid.uuid4()),
            "storage_path": "",
            "keep_recordings": False,
            "auto_summarize_enabled": False,
            # Obsidian vault sync (#413). Off by default — a note only ever
            # leaves the app's own store when the user opts in and picks a
            # vault folder. One-way (Steno -> vault); see app/obsidian-sync.js.
            "obsidian_sync_enabled": False,
            "obsidian_vault_path": "",
            # Local MCP server settings (#contract-item-5).
            # Secret-free: the MCP API key is encrypted and stored separately by
            # the Electron main process in .mcp-api-key; config.json NEVER stores
            # credentials or tokens.
            "mcp_enabled": False,
            "mcp_port": 27127,
            # Default ON — when the app is idle and nothing is in flight, a
            # downloaded update installs itself and relaunches so the user
            # never has to click "Restart". The "update available/downloaded"
            # notification is unchanged; this only removes the manual click,
            # and main.js keeps autoInstallOnAppQuit as the safe fallback.
            "auto_install_when_idle": True,
            # Default OFF: cross-recording speaker identification creates and
            # stores biometric voice profiles. The user must enable it before
            # Steno extracts or stores speaker embeddings.
            #
            # This is independent of diarization itself. When it is off,
            # per-meeting speaker embeddings are not extracted, stored, or
            # matched, but "Speaker N" splitting within a meeting is
            # unaffected (it only depends on diarizer segments, not
            # embeddings). See src.transcriber's allow_self_match/
            # clusters_out gating.
            "identity_matching_enabled": False,
            "identity_matching_privacy_default_version":
                self.IDENTITY_MATCHING_PRIVACY_DEFAULT_VERSION,
            "whisper_model": "large-v3-turbo",
            "transcription_engine": "parakeet",
            "chat_recipes": [],
            "version": "1.0"
        }

    def get_storage_path(self) -> str:
        """Get the custom storage path. Empty string means use default."""
        return self._config.get("storage_path", "")

    def set_storage_path(self, storage_path: str) -> bool:
        """
        Set custom storage path for recordings/transcripts/output.

        Args:
            storage_path: Absolute path to storage directory, or empty string to reset to default.

        Returns:
            True if saved successfully, False otherwise.
        """
        if storage_path is None:
            storage_path = ""
        storage_path = storage_path.strip()

        if storage_path:
            sp = Path(storage_path)
            if not sp.is_absolute():
                logger.error(f"Storage path must be absolute: {storage_path}")
                return False
            # Create subdirectories at the new location. If this fails
            # (for example due to permissions), keep existing config unchanged.
            try:
                for subdir in ("recordings", "transcripts", "output"):
                    (sp / subdir).mkdir(parents=True, exist_ok=True)
            except Exception as e:
                logger.error(f"Failed to initialize storage path {storage_path}: {e}")
                return False

        self._config["storage_path"] = storage_path
        return self._save()

    def get_model(self) -> str:
        """Get the configured model name."""
        return self._config.get("model", self.DEFAULT_MODEL)

    def set_model(self, model_name: str, *, source: str = "user") -> bool:
        """
        Set the model to use for summarization.

        Args:
            model_name: Name of the model (e.g., "llama3.1:8b" or "apple:system")
            source: "user" (explicit user pick) or "auto" (implicit/system default resolution)

        Returns:
            True if saved successfully, False otherwise
        """
        # Validate model name
        from src.apple_lm import is_apple_system_model
        if model_name not in self.SUPPORTED_MODELS and not is_apple_system_model(model_name):
            logger.warning(f"Model {model_name} not in supported list, but allowing anyway")

        self._config["model"] = model_name
        self._config["summary_model_source"] = source
        return self._save()

    # --- Report templates ---------------------------------------------------
    def _normalize_templates(self) -> None:
        """Coerce persisted template state into the shapes the CRUD/merge code
        assumes — on EVERY load, not gated behind `templates_seeded`.

        A malformed-but-parseable config (`custom_templates` as a non-list or a
        list with non-dict entries, or `template_overrides` as a non-dict) would
        otherwise survive past first-run seeding and crash later template reads
        (`merge_templates`) and writes (`save_template`/`delete_template`). The
        repair is in-memory; it persists on the next `_save()`.
        """
        if self._load_failed:
            return
        custom_raw = self._config.get("custom_templates", [])
        self._config["custom_templates"] = (
            [t for t in custom_raw if isinstance(t, dict)]
            if isinstance(custom_raw, list)
            else []
        )
        overrides_raw = self._config.get("template_overrides")
        self._config["template_overrides"] = (
            {k: v for k, v in overrides_raw.items() if isinstance(v, dict)}
            if isinstance(overrides_raw, dict)
            else {}
        )

    def _seed_sample_template(self) -> None:
        """Seed the editable 'Shareable summary' sample once, on fresh configs.

        Guarded by `templates_seeded` so deleting the sample doesn't re-add it.
        Assumes `_normalize_templates` has already coerced `custom_templates`
        into a list of dicts.
        """
        if self._load_failed:
            return
        if self._config.get("templates_seeded"):
            return
        custom = self._config.setdefault("custom_templates", [])
        if not any(t.get("id") == _templates.SAMPLE_TEMPLATE["id"] for t in custom):
            custom.append(dict(_templates.SAMPLE_TEMPLATE))
        self._config["templates_seeded"] = True
        self._save()

    def get_templates(self) -> list:
        """Merged template list: built-ins (with overrides) then custom."""
        return _templates.merge_templates(
            overrides=self._config.get("template_overrides", {}) or {},
            custom=self._config.get("custom_templates", []) or [],
        )

    def get_template(self, template_id: str) -> Optional[dict]:
        """Return the template with the given id, or None if not found."""
        return next((t for t in self.get_templates() if t["id"] == template_id), None)

    def get_default_template_id(self) -> str:
        return self._config.get("default_template_id", _templates.STANDARD_TEMPLATE_ID)

    def set_default_template(self, template_id: str) -> bool:
        if template_id not in {t["id"] for t in self.get_templates()}:
            logger.error(f"Unknown template id: {template_id}")
            return False
        self._config["default_template_id"] = template_id
        return self._save()

    def save_template(self, t: dict) -> tuple:
        """Upsert a template. Returns (ok, error, saved_template)."""
        if not isinstance(t, dict):
            return False, "Invalid template payload", {}
        valid_langs = set(self.SUPPORTED_LANGUAGES.keys()) | {"auto"}
        ok, err = _templates.validate_template(t, valid_langs)
        if not ok:
            return False, err, {}

        tid = t.get("id")
        # Built-in id -> store as an override (Standard is locked: no prompt edit).
        if tid in _templates.BUILTIN_TEMPLATES:
            if _templates.BUILTIN_TEMPLATES[tid].get("locked"):
                return False, "This template is locked and cannot be edited", {}
            overrides = self._config.setdefault("template_overrides", {})
            overrides[tid] = {k: t[k] for k in ("name", "icon", "prompt", "language") if k in t}
            if not self._save():
                return False, "Failed to save config", {}
            return True, "", {**_templates.BUILTIN_TEMPLATES[tid], **overrides[tid]}

        custom = self._config.setdefault("custom_templates", [])
        existing = next((c for c in custom if c.get("id") == tid), None)
        if existing is not None:
            existing.update({k: t[k] for k in ("name", "icon", "prompt", "language", "format")
                             if k in t})
            saved = dict(existing)
        else:
            new_id = _templates.new_template_id(
                t["name"], {c.get("id") for c in custom} | set(_templates.BUILTIN_TEMPLATES)
            )
            saved = {
                "id": new_id,
                "name": t["name"],
                "icon": t.get("icon", "doc"),
                "prompt": t["prompt"],
                "language": t.get("language", "auto"),
                "format": t.get("format", "markdown"),
            }
            custom.append(saved)
        if not self._save():
            return False, "Failed to save config", {}
        return True, "", dict(saved)

    def delete_template(self, template_id: str) -> bool:
        custom = self._config.get("custom_templates", [])
        remaining = [c for c in custom if c.get("id") != template_id]
        if len(remaining) == len(custom):
            return False  # not a custom template (or doesn't exist)
        self._config["custom_templates"] = remaining
        if self._config.get("default_template_id") == template_id:
            self._config["default_template_id"] = _templates.STANDARD_TEMPLATE_ID
        return self._save()

    def reset_template(self, template_id: str) -> bool:
        overrides = self._config.get("template_overrides", {})
        if template_id not in overrides:
            return True  # already at shipped default — no-op success
        del overrides[template_id]
        return self._save()

    # --- Chat recipes -------------------------------------------------------
    def _normalize_recipes(self) -> None:
        """Coerce persisted chat recipes state into a list of dicts on every load."""
        if self._load_failed:
            return
        recipes_raw = self._config.get("chat_recipes", [])
        self._config["chat_recipes"] = (
            [r for r in recipes_raw if isinstance(r, dict)]
            if isinstance(recipes_raw, list)
            else []
        )

    def get_chat_recipes(self) -> list:
        """Return the list of chat recipes."""
        return [dict(r) for r in self._config.get("chat_recipes", []) or []]

    def get_chat_recipe(self, recipe_id: str) -> Optional[dict]:
        """Return the chat recipe with the given id, or None if not found."""
        return next((r for r in self.get_chat_recipes() if r.get("id") == recipe_id), None)

    def save_chat_recipe(self, r: dict) -> tuple:
        """Upsert a chat recipe. Returns (ok, error, saved_recipe)."""
        if not isinstance(r, dict):
            return False, "Invalid recipe payload", {}
        ok, err = _templates.validate_recipe(r)
        if not ok:
            return False, err, {}

        recipes = self._config.setdefault("chat_recipes", [])
        rid = r.get("id")
        existing = next((item for item in recipes if isinstance(item, dict) and item.get("id") == rid), None) if rid else None
        if existing is not None:
            existing.update({
                "label": r["label"].strip(),
                "prompt": r["prompt"].strip(),
            })
            saved = dict(existing)
        else:
            existing_ids = {item.get("id") for item in recipes if isinstance(item, dict)}
            new_id = _templates.new_template_id(r["label"], existing_ids)
            saved = {
                "id": new_id,
                "label": r["label"].strip(),
                "prompt": r["prompt"].strip(),
            }
            recipes.append(saved)
        if not self._save():
            return False, "Failed to save config", {}
        return True, "", dict(saved)

    def delete_chat_recipe(self, recipe_id: str) -> bool:
        """Delete a chat recipe by id. Returns True if deleted, False if not found."""
        recipes = self._config.get("chat_recipes", [])
        remaining = [item for item in recipes if isinstance(item, dict) and item.get("id") != recipe_id]
        if len(remaining) == len(recipes):
            return False
        self._config["chat_recipes"] = remaining
        return self._save()

    def _normalize_voiceprints(self) -> None:
        """Coerce persisted voiceprint state into a list of dicts on every
        load, mirroring `_normalize_templates` — a malformed-but-parseable
        config must not crash later voiceprint reads/writes."""
        if self._load_failed:
            return
        raw = self._config.get("voiceprints", [])
        self._config["voiceprints"] = (
            [v for v in raw if isinstance(v, dict) and "id" in v and "name" in v]
            if isinstance(raw, list)
            else []
        )

    def get_voiceprints(self) -> list:
        """All stored voiceprints, each `{id, name, embeddings,
        centroid, centroid_sample_count, updated_at, is_self}`.

        Two matching anchors per voiceprint (ported from
        StoredSpeaker/SpeakerMatcher, github.com/pasrom/meeting-transcriber):
        `centroid` is the long-term running mean, the primary anchor;
        `embeddings` is a small recent-samples FIFO that can rescue a
        borderline centroid match. See src.transcriber._voiceprint_distance.
        """
        return list(self._config.get("voiceprints", []))

    def get_voiceprint(self, name: str) -> Optional[dict]:
        return next(
            (v for v in self.get_voiceprints() if v.get("name") == name), None
        )

    # Minimum speaking time (seconds) for an embedding to be folded into a
    # voiceprint's long-term centroid — short/noisy snippets are still kept
    # in the recent-samples FIFO as a fallback anchor but don't pollute the
    # running average. `duration=None` (manual CLI enrollment — a
    # deliberate action, not an automatic per-meeting confirmation) always
    # qualifies. Ported from SpeakerMatcher.minSpeakingTimeForCentroid.
    VOICEPRINT_MIN_DURATION_FOR_CENTROID = 3.0
    # Recent-samples FIFO cap. Ported from SpeakerMatcher.maxRecentSamples.
    VOICEPRINT_MAX_RECENT_SAMPLES = 3

    def save_voiceprint(
        self, name: str, embedding: list, is_self: bool = False,
        duration: Optional[float] = None,
    ) -> Optional[dict]:
        """Upsert a voiceprint by name.

        `duration` is the speaking time (seconds) `embedding` was extracted
        from. When it clears `VOICEPRINT_MIN_DURATION_FOR_CENTROID` (or is
        omitted entirely), the embedding is folded into the long-term
        running-mean `centroid` via `(centroid * count + embedding) /
        (count + 1)`. Every embedding, regardless of duration, is appended
        to the recent-samples FIFO (capped at `VOICEPRINT_MAX_RECENT_SAMPLES`,
        oldest dropped first). At most one `is_self` entry exists — saving a
        new one demotes any previous self voiceprint to a regular (named)
        one. Ported from StoredSpeaker/SpeakerMatcher.applyConfirmation.
        """
        # Persistence is dimension-agnostic so profiles can be migrated to a
        # future embedder. Current diarizer payloads are still pinned to 256
        # at their ingestion boundary in src.transcriber.
        embedding = validate_embedding(embedding, expected_dimension=None)
        before = copy.deepcopy(self._config)
        voiceprints = self._config.setdefault("voiceprints", [])
        if is_self:
            for v in voiceprints:
                v["is_self"] = False

        qualifies = duration is None or duration >= self.VOICEPRINT_MIN_DURATION_FOR_CENTROID

        existing = next((v for v in voiceprints if v.get("name") == name), None)
        if existing is not None:
            samples = list(existing.get("embeddings") or [])
            samples.append(list(embedding))
            if len(samples) > self.VOICEPRINT_MAX_RECENT_SAMPLES:
                samples = samples[-self.VOICEPRINT_MAX_RECENT_SAMPLES:]

            centroid = existing.get("centroid")
            centroid_count = existing.get("centroid_sample_count", 0) or 0
            if qualifies:
                if centroid and len(centroid) == len(embedding):
                    new_count = centroid_count + 1
                    centroid = [
                        (o * centroid_count + n) / new_count
                        for o, n in zip(centroid, embedding)
                    ]
                    centroid_count = new_count
                else:
                    centroid = list(embedding)
                    centroid_count = 1

            existing["embeddings"] = samples
            existing["centroid"] = centroid
            existing["centroid_sample_count"] = centroid_count
            existing["updated_at"] = time.time()
            existing["is_self"] = is_self
            saved = dict(existing)
        else:
            saved = {
                "id": str(uuid.uuid4()),
                "name": name,
                "embeddings": [list(embedding)],
                "centroid": list(embedding) if qualifies else None,
                "centroid_sample_count": 1 if qualifies else 0,
                "updated_at": time.time(),
                "is_self": is_self,
            }
            voiceprints.append(saved)
        if not self._save():
            self._config = before
            return None
        return dict(saved)

    def delete_voiceprint(self, name: str) -> bool:
        voiceprints = self._config.get("voiceprints", [])
        remaining = [v for v in voiceprints if v.get("name") != name]
        if len(remaining) == len(voiceprints):
            return False  # no such voiceprint
        self._config["voiceprints"] = remaining
        return self._save()

    # PersonProfile/SpeakerPrototype: the named (non-self) speaker-identity
    # store, replacing the named-matching half of the old flat `voiceprints`
    # schema (self-match "You" keeps using `voiceprints`/`save_voiceprint`
    # unchanged — it never had the same-room confusable-pair problem this
    # design targets). Unlike a single running-averaged embedding per person,
    # each confirmation is kept as its own `SpeakerPrototype` — separated by
    # `recording_type` since in-person/shared-mic audio and remote/per-device
    # audio are genuinely different-shaped comparisons (see the plan doc for
    # the AMI Meeting Corpus findings that motivated this) — plus a parallel
    # `hard_negatives` list: when a meeting confirms multiple different real
    # people, each one's profile records the others as confirmed-NOT-this-
    # person evidence, not just an in-pass "already assigned" guard.
    VALID_RECORDING_TYPES = {"in_person", "remote", "imported", "unknown"}
    VALID_PROTOTYPE_SOURCES = {"user_confirmed", "user_corrected", "manual_enrollment"}
    # Channels a prototype's cluster can come from -- mirrors the sidecar's
    # per-channel structure (src.speaker_suggestions.write_speakers_sidecar).
    VALID_PROTOTYPE_CHANNELS = {"mic", "system"}
    MAX_PROTOTYPES_PER_CONTEXT = 24
    MAX_HARD_NEGATIVES_PER_CONTEXT = 48

    def get_person_profiles(self) -> list:
        """All stored person profiles, each `{person_id, display_name,
        created_at, updated_at, prototypes, hard_negatives}`. See
        `add_speaker_prototype` for the `SpeakerPrototype` shape."""
        profiles = []
        raw = self._config.get("person_profiles", [])
        if not isinstance(raw, list):
            return []
        for profile in raw:
            if (
                not isinstance(profile, dict)
                or not isinstance(profile.get("person_id"), str)
                or not profile.get("person_id")
                or not isinstance(profile.get("display_name"), str)
                or not profile.get("display_name").strip()
            ):
                continue
            safe = dict(profile)
            safe["prototypes"] = self._usable_speaker_evidence(
                profile.get("prototypes")
            )
            safe["hard_negatives"] = self._usable_speaker_evidence(
                profile.get("hard_negatives")
            )
            profiles.append(safe)
        return profiles

    @staticmethod
    def _usable_speaker_evidence(value) -> list:
        """Return safe copies without deleting malformed persisted evidence."""
        if not isinstance(value, list):
            return []
        usable = []
        for entry in value:
            if not isinstance(entry, dict):
                continue
            embedding = entry.get("embedding_mean")
            if not isinstance(embedding, list) or not embedding:
                continue
            try:
                numbers = [float(item) for item in embedding]
            except (TypeError, ValueError, OverflowError):
                continue
            if not all(math.isfinite(item) for item in numbers):
                continue
            clean = dict(entry)
            clean["embedding_mean"] = numbers
            usable.append(clean)
        return usable

    def _get_person_profile_mutable(self, person_id: str) -> Optional[dict]:
        return next(
            (
                profile
                for profile in (
                    self._config.get("person_profiles", [])
                    if isinstance(self._config.get("person_profiles", []), list)
                    else []
                )
                if isinstance(profile, dict) and profile.get("person_id") == person_id
            ),
            None,
        )

    def get_person_profile(self, person_id: str) -> Optional[dict]:
        return next(
            (p for p in self.get_person_profiles() if p.get("person_id") == person_id),
            None,
        )

    def _person_name_taken(self, display_name: str, *, exclude_person_id: Optional[str] = None) -> bool:
        """Case/whitespace-insensitive collision check -- without this,
        the "New person" flow (both the plain CLI and confirm-speaker
        --new-person) can silently create a second profile for someone who
        already has one, splitting their evidence across two person_ids."""
        normalized = " ".join(
            unicodedata.normalize("NFKC", display_name).split()
        ).casefold()
        return any(
            p.get("person_id") != exclude_person_id
            and " ".join(
                unicodedata.normalize("NFKC", p.get("display_name") or "").split()
            ).casefold() == normalized
            for p in self.get_person_profiles()
        )

    def create_person_profile(self, display_name: str) -> dict:
        """Create a new, empty person profile (no prototypes yet).

        Raises ValueError if a person with this name (case/whitespace
        insensitive) already exists -- names must stay unique so a
        confirmed cluster always resolves to one real person's evidence.
        """
        display_name = validate_display_name(display_name)
        owned_transaction = self._transaction_backup is None
        if owned_transaction and not self.begin_transaction():
            raise OSError("Could not lock the person profile store.")
        try:
            if self._person_name_taken(display_name):
                raise ValueError(f"A person named {display_name!r} already exists")
            profiles = self._config.setdefault("person_profiles", [])
            if not isinstance(profiles, list):
                raise ValueError("The person profile store is malformed and needs repair.")
            now = time.time()
            profile = {
                "person_id": str(uuid.uuid4()),
                "display_name": display_name,
                "created_at": now,
                "updated_at": now,
                "prototypes": [],
                "hard_negatives": [],
            }
            profiles.append(profile)
            if not self._save():
                raise OSError("Could not save the person profile.")
            if owned_transaction and not self.commit_transaction():
                raise OSError("Could not save the person profile.")
            return dict(profile)
        except Exception:
            if owned_transaction and self._transaction_backup is not None:
                self.rollback_transaction()
            raise

    def rename_person_profile(self, person_id: str, display_name: str) -> bool:
        """Raises ValueError if another person already has this name (same
        uniqueness invariant as create_person_profile)."""
        display_name = validate_display_name(display_name)
        owned_transaction = self._transaction_backup is None
        if owned_transaction and not self.begin_transaction():
            return False
        try:
            profile = self._get_person_profile_mutable(person_id)
            if profile is None:
                if owned_transaction:
                    self.rollback_transaction()
                return False
            if self._person_name_taken(display_name, exclude_person_id=person_id):
                raise ValueError(f"A person named {display_name!r} already exists")
            profile["display_name"] = display_name
            profile["updated_at"] = time.time()
            if not self._save():
                raise OSError("Could not save the person profile.")
            return not owned_transaction or self.commit_transaction()
        except Exception:
            if owned_transaction and self._transaction_backup is not None:
                self.rollback_transaction()
            raise

    def delete_person_profile(self, person_id: str) -> bool:
        """Delete a person profile and, critically, the derived evidence of
        them stored in EVERYONE ELSE's profiles.

        `confirm-speaker` creates mutual hard negatives: confirming person A
        next to person B writes a hard-negative entry into B's profile whose
        embedding is literally A's own voice sample, tagged with the
        meeting/channel/diarization_speaker_id A was confirmed under (see
        that command's "Mutual hard negatives" section). Without this
        cleanup, deleting A leaves that sample sitting in B's profile
        indefinitely -- a deleted person's voice would outlive their own
        profile.

        Walks A's own (about-to-be-deleted) `prototypes` -- each already
        carries the exact meeting/channel/sid tuple A was confirmed under --
        and reuses `remove_speaker_evidence` (the same removal primitive the
        correction path already relies on) to strip any hard-negative entry
        in another profile derived from that specific confirmation.

        Each prototype's OWN `diarization_run_id` is the run scope for its
        cleanup, not the meeting's current one: the negatives it produced
        were written by the same confirm and therefore carry the same run
        id, while a later re-diarization's negatives about the same cluster
        id describe a different voice and belong to whoever is still
        confirmed there.
        """
        owned_transaction = self._transaction_backup is None
        if owned_transaction and not self.begin_transaction():
            return False
        profiles = self._config.get("person_profiles", [])
        if not isinstance(profiles, list):
            if owned_transaction:
                self.rollback_transaction()
            return False
        target = next(
            (
                profile
                for profile in profiles
                if isinstance(profile, dict) and profile.get("person_id") == person_id
            ),
            None,
        )
        if target is None:
            if owned_transaction:
                self.rollback_transaction()
            return False

        for proto in target.get("prototypes") or []:
            meeting_id = proto.get("meeting_id")
            sid = proto.get("diarization_speaker_id")
            if not meeting_id or not sid:
                continue
            for other in profiles:
                if not isinstance(other, dict) or other.get("person_id") == person_id:
                    continue
                self.remove_speaker_evidence(
                    other["person_id"], meeting_id=meeting_id,
                    channel=proto.get("channel"),
                    channel_recording_type=proto.get("recording_type"),
                    sids={sid}, negative=True,
                    diarization_run_id=proto.get("diarization_run_id"),
                )

        remaining = [
            profile
            for profile in profiles
            if not isinstance(profile, dict) or profile.get("person_id") != person_id
        ]
        self._config["person_profiles"] = remaining
        if not self._save():
            if owned_transaction:
                self.rollback_transaction()
            return False
        return not owned_transaction or self.commit_transaction()

    @staticmethod
    def _prototype_quality_score(speech_duration_seconds: float, segment_count: int) -> float:
        """Simple, documented heuristic: rewards clearing the same stability
        bar the suggestion service gates suggestions on (>=20s speaking time,
        >=3 agreeing segments) rather than an arbitrary scale."""
        duration_component = min(1.0, speech_duration_seconds / 20.0)
        segment_component = min(1.0, segment_count / 3.0)
        return round(duration_component * segment_component, 4)

    def add_speaker_prototype(
        self,
        person_id: str,
        embedding: list,
        *,
        recording_type: str,
        meeting_id: str,
        diarization_speaker_id: str,
        speech_duration_seconds: float,
        segment_count: int,
        created_from: str,
        channel: Optional[str] = None,
        negative: bool = False,
        diarization_run_id: Optional[str] = None,
    ) -> Optional[dict]:
        """Append a `SpeakerPrototype` to a person's positive `prototypes`
        (default) or `hard_negatives` (`negative=True`) list. Returns None
        if `person_id` doesn't exist. Unlike `save_voiceprint`, this never
        averages into a running centroid — each confirmation is kept as its
        own context-tagged prototype so a same-room-contaminated in-person
        sample never blends into a clean remote-audio sample for the same
        person (see module comment above `VALID_RECORDING_TYPES`).

        `channel` is which sidecar channel ("mic"/"system") the cluster came
        from. It must be stored, not just known at confirm time: mic and
        system channels number their diarizer clusters independently (a mic
        "SPEAKER_0" and a system "SPEAKER_0" are unrelated), so a
        `(meeting_id, diarization_speaker_id)` pair alone is ambiguous and
        cross-channel id collisions once produced hard negatives derived
        from the wrong channel's clusters. `None` is allowed only for
        legacy/enrollment paths with no channel to record — matchers fall
        back to `recording_type` as a channel proxy for those (see
        src.speaker_suggestions.prototype_channel_matches).

        `diarization_run_id` is the sidecar's `diarization_run.run_id` the
        embedding was confirmed from. Same absent-means-legacy convention as
        `channel`: it must be stored so a later run can tell "this evidence
        is from the diarization output currently on disk" from "the
        clusters have since been re-diarized and this entry's ids may not
        mean what they used to" (src.speaker_suggestions.prototype_run_matches).
        `None` for callers with no run to report, e.g. enrollment."""
        if recording_type not in self.VALID_RECORDING_TYPES:
            raise ValueError(f"Invalid recording_type: {recording_type}")
        if created_from not in self.VALID_PROTOTYPE_SOURCES:
            raise ValueError(f"Invalid created_from: {created_from}")
        if channel is not None and channel not in self.VALID_PROTOTYPE_CHANNELS:
            raise ValueError(f"Invalid channel: {channel}")
        # See save_voiceprint: validate numeric/finite/non-zero here, while
        # the active model's exact dimension is enforced at ingestion.
        embedding = validate_embedding(embedding, expected_dimension=None)

        owned_transaction = self._transaction_backup is None
        if owned_transaction and not self.begin_transaction():
            return None
        profile = self._get_person_profile_mutable(person_id)
        if profile is None:
            if owned_transaction:
                self.rollback_transaction()
            return None

        prototype = {
            "prototype_id": str(uuid.uuid4()),
            "person_id": person_id,
            "embedding_mean": embedding,
            "sample_count": 1,
            "quality_score": self._prototype_quality_score(speech_duration_seconds, segment_count),
            "recording_type": recording_type,
            "meeting_id": meeting_id,
            "diarization_speaker_id": diarization_speaker_id,
            "speech_duration_seconds": speech_duration_seconds,
            "segment_count": segment_count,
            "created_from": created_from,
            "created_at": time.time(),
        }
        if channel is not None:
            prototype["channel"] = channel
        if diarization_run_id is not None:
            prototype["diarization_run_id"] = diarization_run_id
        key = "hard_negatives" if negative else "prototypes"
        profile.setdefault(key, []).append(prototype)
        self._prune_speaker_evidence(
            profile[key],
            self.MAX_HARD_NEGATIVES_PER_CONTEXT if negative else self.MAX_PROTOTYPES_PER_CONTEXT,
            preserve_prototype_id=prototype["prototype_id"],
        )
        profile["updated_at"] = time.time()
        if not self._save():
            if owned_transaction:
                self.rollback_transaction()
            return None
        if owned_transaction and not self.commit_transaction():
            return None
        return dict(prototype)

    @staticmethod
    def _prune_speaker_evidence(
        entries: list, cap: int, *, preserve_prototype_id: Optional[str] = None,
    ) -> None:
        """Bound retained evidence per recording context deterministically."""
        preserved = next(
            (
                entry for entry in entries
                if entry.get("prototype_id") == preserve_prototype_id
            ),
            None,
        )
        grouped = {}
        for entry in entries:
            context = (entry.get("recording_type"), entry.get("channel"))
            grouped.setdefault(context, []).append(entry)
        retained = []
        for context_entries in grouped.values():
            if len(context_entries) <= cap:
                retained.extend(context_entries)
                continue
            by_meeting = {}
            for entry in context_entries:
                by_meeting.setdefault(entry.get("meeting_id"), []).append(entry)

            def rank(entry):
                def finite_number(value) -> float:
                    try:
                        number = float(value or 0.0)
                    except (TypeError, ValueError, OverflowError):
                        return float("-inf")
                    return number if math.isfinite(number) else float("-inf")

                return (
                    finite_number(entry.get("quality_score")),
                    finite_number(entry.get("created_at")),
                    str(entry.get("prototype_id") or ""),
                )

            representatives = [max(values, key=rank) for values in by_meeting.values()]
            representatives.sort(key=rank, reverse=True)
            chosen = representatives[:cap]
            chosen_ids = {id(entry) for entry in chosen}
            remaining = [entry for entry in context_entries if id(entry) not in chosen_ids]
            remaining.sort(key=rank, reverse=True)
            chosen.extend(remaining[: max(0, cap - len(chosen))])
            retained.extend(chosen)
        if preserved is not None and all(
            entry.get("prototype_id") != preserve_prototype_id for entry in retained
        ):
            context = (preserved.get("recording_type"), preserved.get("channel"))
            context_retained = [
                entry for entry in retained
                if (entry.get("recording_type"), entry.get("channel")) == context
            ]
            if context_retained:
                retained.remove(min(context_retained, key=rank))
            retained.append(preserved)
        entries[:] = retained

    def remove_speaker_evidence(
        self,
        person_id: str,
        *,
        meeting_id: str,
        channel: Optional[str],
        channel_recording_type: Optional[str],
        sids: Optional[set] = None,
        negative: bool = False,
        diarization_run_id=ANY_DIARIZATION_RUN,
    ) -> int:
        """Remove a person's positive prototypes (or hard negatives, with
        `negative=True`) belonging to one meeting+channel, optionally
        restricted to specific diarization_speaker_ids. Returns the number
        of entries removed (0 when the person doesn't exist or nothing
        matched; saves only when something was removed).

        This is the mutation half of the correction path: confirming a
        cluster that someone ELSE was previously confirmed as (the review
        UI's "Change" flow re-confirms with a different person) must remove
        the superseded evidence, or the wrong person keeps a prototype of a
        voice that isn't theirs and min-distance matching stays poisoned
        forever. Channel matching uses the same channel-or-recording_type
        fallback rule as everything else
        (src.speaker_suggestions.prototype_channel_matches), so legacy
        entries without a channel field are covered too.

        `diarization_run_id` narrows that correction to evidence from ONE
        diarization run (src.speaker_suggestions.prototype_run_matches).
        Callers working from a sidecar must pass its run id, because
        `(meeting_id, channel, sid)` is not stable across runs: a
        re-diarization numbers its clusters from SPEAKER_0 again with no
        memory of who held that id before, so without this scope confirming
        the new run's first cluster deletes the prototype an earlier run's
        confirmation recorded against a genuinely different voice.
        `ANY_DIARIZATION_RUN` (the default) removes regardless of run. Every
        in-repo caller works from a sidecar and passes a scope today, so the
        default carries no traffic; it exists so that a future caller with no
        sidecar in hand gets today's semantics by not knowing about runs,
        rather than silently filtering. Passing `None` is the distinct "the
        sidecar reports no run" scope, not the absence of one.

        The trade this scope accepts, and it is heavier than one stale
        positive prototype: a confirmation made against a superseded run can
        no longer be corrected by re-confirming the same cluster id, since
        the two are no longer recognised as the same cluster. That freezes
        the hard negatives the wrong confirmation minted as well, and those
        can include one built from a person's OWN voice -- confirm-speaker
        records each confirmed cluster as negative evidence against the other
        people confirmed in that channel, so a confirm that got the owner
        wrong hands somebody their own embedding as a reason to refuse a
        match. Re-confirming used to clear it; now it survives every later
        confirm, and self-suppression does not expire on its own. The escape
        hatch is `repair-speaker-profiles`, which drops entries by
        `prototype_id` via `remove_speaker_evidence_by_ids` and is unaffected
        by run scope. Silently destroying genuine evidence is still the worse
        failure of the two, and it is the one happening today.
        """
        from src.speaker_suggestions import prototype_channel_matches, prototype_run_matches

        profile = self._get_person_profile_mutable(person_id)
        if profile is None:
            return 0
        key = "hard_negatives" if negative else "prototypes"
        entries = profile.get(key) or []
        kept = [
            entry for entry in entries
            if not (
                entry.get("meeting_id") == meeting_id
                and prototype_channel_matches(entry, channel, channel_recording_type)
                and (sids is None or entry.get("diarization_speaker_id") in sids)
                and (
                    diarization_run_id is ANY_DIARIZATION_RUN
                    or prototype_run_matches(entry, diarization_run_id)
                )
            )
        ]
        removed = len(entries) - len(kept)
        if removed:
            profile[key] = kept
            profile["updated_at"] = time.time()
            self._save()
        return removed

    def remove_speaker_evidence_by_ids(
        self, person_id: str, entry_ids: set, *, negative: bool = False,
    ) -> int:
        """Remove specific prototypes/hard-negatives by their
        `prototype_id`. The precision counterpart to
        `remove_speaker_evidence`'s meeting+channel matching -- used by the
        repair CLI, which decides exactly which entries to drop during its
        dry-run analysis and must then remove exactly those. Returns the
        count removed; saves only when something was."""
        profile = self._get_person_profile_mutable(person_id)
        if profile is None or not entry_ids:
            return 0
        key = "hard_negatives" if negative else "prototypes"
        entries = profile.get(key) or []
        kept = [e for e in entries if e.get("prototype_id") not in entry_ids]
        removed = len(entries) - len(kept)
        if removed:
            profile[key] = kept
            profile["updated_at"] = time.time()
            self._save()
        return removed

    def set_speaker_evidence_channels(
        self, person_id: str, channels_by_entry_id: dict, *, negative: bool = False,
    ) -> int:
        """Backfill the `channel` field onto existing prototypes/hard-
        negatives (`{prototype_id: "mic" | "system"}`) -- for entries
        written before `add_speaker_prototype` recorded channels, whose
        channel the repair CLI recovered from their meeting's sidecar.
        Returns how many entries were updated; saves only when any were."""
        profile = self._get_person_profile_mutable(person_id)
        if profile is None or not channels_by_entry_id:
            return 0
        for channel in channels_by_entry_id.values():
            if channel not in self.VALID_PROTOTYPE_CHANNELS:
                raise ValueError(f"Invalid channel: {channel}")
        key = "hard_negatives" if negative else "prototypes"
        updated = 0
        for entry in profile.get(key) or []:
            channel = channels_by_entry_id.get(entry.get("prototype_id"))
            if channel is not None and entry.get("channel") != channel:
                entry["channel"] = channel
                updated += 1
        if updated:
            profile["updated_at"] = time.time()
            self._save()
        return updated

    def get_model_info(self, model_name: str) -> Optional[Dict[str, str]]:
        """
        Get metadata about a specific model.

        Args:
            model_name: Name of the model

        Returns:
            Dictionary with model metadata or None if not found
        """
        from src.apple_lm import is_apple_system_model, apple_system_model_info
        if is_apple_system_model(model_name):
            return apple_system_model_info(is_default=self.get_model() == model_name)
        return self.SUPPORTED_MODELS.get(model_name)
    def list_supported_models(self) -> Dict[str, Dict[str, str]]:
        """Get all supported models with their metadata."""
        return self.SUPPORTED_MODELS.copy()

    def get_notifications_enabled(self) -> bool:
        """Get whether desktop notifications are enabled."""
        return self._config.get("notifications_enabled", True)

    def set_notifications_enabled(self, enabled: bool) -> bool:
        """
        Set whether desktop notifications are enabled.

        Args:
            enabled: True to enable notifications, False to disable

        Returns:
            True if saved successfully, False otherwise
        """
        self._config["notifications_enabled"] = enabled
        return self._save()

    def get_record_hotkey_enabled(self) -> bool:
        """Get whether the global record shortcut is registered at startup.

        Absence of the key = ON (back-compat). Only a literal ``False`` disables
        it, matching the Electron-side ``record_hotkey_enabled !== false`` gate,
        so a malformed non-boolean value doesn't diverge between the two reads.
        """
        return self._config.get("record_hotkey_enabled", True) is not False

    def set_record_hotkey_enabled(self, enabled: bool) -> bool:
        """
        Set whether the global record shortcut is enabled.

        Args:
            enabled: True to register the shortcut, False to disable it

        Returns:
            True if saved successfully, False otherwise
        """
        self._config["record_hotkey_enabled"] = enabled
        return self._save()

    def get_premeeting_notifications_enabled(self) -> bool:
        """Get whether the calendar-based pre-meeting heads-up notification
        is enabled. Independent of notifications_enabled (post-meeting)."""
        return self._config.get("premeeting_notifications_enabled", True)

    def set_premeeting_notifications_enabled(self, enabled: bool) -> bool:
        """
        Set whether the calendar-based pre-meeting heads-up notification
        is enabled.

        Args:
            enabled: True to enable the pre-meeting notification, False to disable

        Returns:
            True if saved successfully, False otherwise
        """
        self._config["premeeting_notifications_enabled"] = enabled
        return self._save()

    def get_telemetry_enabled(self) -> bool:
        """Get whether anonymous usage analytics are enabled."""
        return self._config.get("telemetry_enabled", True)

    def set_telemetry_enabled(self, enabled: bool) -> bool:
        """
        Set whether anonymous usage analytics are enabled.

        Args:
            enabled: True to enable telemetry, False to disable

        Returns:
            True if saved successfully, False otherwise
        """
        self._config["telemetry_enabled"] = enabled
        return self._save()

    def get_privacy_notice_seen(self) -> bool:
        """Get whether the one-time privacy notice has been acknowledged."""
        return self._config.get("privacy_notice_seen", True) is True

    def set_privacy_notice_seen(self, seen: bool) -> bool:
        """Set the privacy notice marker and end the migration window."""
        self._config["privacy_notice_seen"] = seen
        return self._save()

    def get_hide_dock_icon(self) -> bool:
        """Get whether the dock icon should be hidden (menu bar only mode)."""
        return self._config.get("hide_dock_icon", False)

    def set_hide_dock_icon(self, enabled: bool) -> bool:
        """
        Set whether the dock icon should be hidden.

        Args:
            enabled: True to hide dock icon (menu bar only), False to show

        Returns:
            True if saved successfully, False otherwise
        """
        self._config["hide_dock_icon"] = enabled
        return self._save()

    def get_show_menu_bar_icon(self) -> bool:
        """Get whether the menu bar / system tray icon should be shown."""
        return self._config.get("show_menu_bar_icon", True)

    def set_show_menu_bar_icon(self, enabled: bool) -> bool:
        """
        Set whether the menu bar / system tray icon should be shown.

        Args:
            enabled: True to show the tray icon, False to hide it

        Returns:
            True if saved successfully, False otherwise
        """
        self._config["show_menu_bar_icon"] = enabled
        return self._save()

    def get_org_auto_backup_enabled(self) -> bool:
        """Get whether new notes should auto-upload to the org adapter (S3)
        once summarization finishes. Only takes effect when the user is signed
        in to the enterprise adapter."""
        return self._config.get("org_auto_backup_enabled", True)

    def set_org_auto_backup_enabled(self, enabled: bool) -> bool:
        self._config["org_auto_backup_enabled"] = enabled
        return self._save()

    def has_org_auto_backup_preference(self) -> bool:
        """Whether a stored auto-backup preference exists yet. Distinguishes
        an unset pref (no key) from an explicit False, so the desktop can skip
        the sign-in `/policy` fetch + seed once a preference exists and only
        pays it in the genuinely-unset sign-in window (see issue #192)."""
        return "org_auto_backup_enabled" in self._config

    def seed_org_auto_backup_default(self, default: bool) -> bool:
        """Seed the auto-backup preference from the enterprise adapter's
        `auto_share_default` policy, but ONLY if the user has no stored
        preference yet. This is the "set the default only" contract: the
        org decides the initial on/off state for a brand-new user, after
        which any explicit toggle by the user wins and is never clobbered
        by a later sign-in. Returns the effective value."""
        if "org_auto_backup_enabled" not in self._config:
            self._config["org_auto_backup_enabled"] = bool(default)
            self._save()
        return self._config["org_auto_backup_enabled"]


    def get_keep_recordings(self) -> bool:
        """Get whether audio recordings should be kept after processing."""
        return self._config.get("keep_recordings", False)

    def set_keep_recordings(self, enabled: bool) -> bool:
        """Set whether audio recordings should be kept after processing."""
        self._config["keep_recordings"] = enabled
        return self._save()

    def get_auto_install_when_idle(self) -> bool:
        """Get whether a downloaded update auto-installs (and relaunches) when
        the app is idle and nothing is in flight. Default on — removes the
        manual "Restart" click; the download/notification behaviour and the
        autoInstallOnAppQuit fallback are unaffected."""
        return self._config.get("auto_install_when_idle", True)

    def set_auto_install_when_idle(self, enabled: bool) -> bool:
        """Set whether idle auto-install is enabled."""
        self._config["auto_install_when_idle"] = enabled
        return self._save()

    def get_identity_matching_enabled(self) -> bool:
        """Get whether cross-recording speaker identification is enabled.
        Default off. Independent of diarization itself -- see the module
        comment above the default-config `identity_matching_enabled` entry
        for what turning this off actually stops."""
        return self._config.get("identity_matching_enabled") is True

    def set_identity_matching_enabled(self, enabled: bool) -> bool:
        """Set whether cross-recording speaker identification is enabled."""
        self._config["identity_matching_enabled"] = enabled
        return self._save()

    def get_auto_summarize_enabled(self) -> bool:
        """Get whether notes (summary/title/template report) are generated
        automatically after transcription. Default OFF — recordings stop at a
        transcript-only note and the user generates notes on demand (the
        meeting-end "Summarise" prompt, or the in-note "Generate notes" CTA).
        Only the fallback default changed; users who previously set this keep
        their stored value."""
        return self._config.get("auto_summarize_enabled", False)

    def set_auto_summarize_enabled(self, enabled: bool) -> bool:
        """Set whether notes are generated automatically after transcription."""
        self._config["auto_summarize_enabled"] = enabled
        return self._save()

    def get_obsidian_sync_enabled(self) -> bool:
        """Whether notes are mirrored to an Obsidian vault folder (#413).
        Default off — the mirror only runs when the user opts in AND has set
        obsidian_vault_path. One-way, local; see app/obsidian-sync.js."""
        return self._config.get("obsidian_sync_enabled", False)

    def set_obsidian_sync_enabled(self, enabled: bool) -> bool:
        """Enable/disable the Obsidian vault mirror."""
        self._config["obsidian_sync_enabled"] = enabled
        return self._save()

    def get_obsidian_vault_path(self) -> str:
        """Absolute path to the vault folder notes are mirrored into. Empty =
        not configured (mirror stays inert even if the toggle is on)."""
        return self._config.get("obsidian_vault_path", "")

    def set_obsidian_vault_path(self, vault_path: str) -> bool:
        """Set the Obsidian vault folder. Must be an absolute path (or empty to
        clear). Mirrors set_storage_path's validation; the directory is created
        if missing so the first sync has somewhere to write."""
        if vault_path is None:
            vault_path = ""
        vault_path = vault_path.strip()

        if vault_path:
            vp = Path(vault_path)
            if not vp.is_absolute():
                logger.error(f"Obsidian vault path must be absolute: {vault_path}")
                return False
            # Ensure the target exists; on failure keep existing config unchanged.
            try:
                vp.mkdir(parents=True, exist_ok=True)
            except Exception as e:
                logger.error(f"Failed to initialize Obsidian vault path {vault_path}: {e}")
                return False

        self._config["obsidian_vault_path"] = vault_path
        return self._save()

    def get_silence_auto_stop_enabled(self) -> bool:
        """Get whether recordings auto-stop after a stretch of silence on
        both the mic and system-audio streams. Default on — the primary
        use case is "I forgot to stop a meeting" where doing nothing
        leaves a multi-hour zombie recording."""
        return self._config.get("silence_auto_stop_enabled", True)

    def set_silence_auto_stop_enabled(self, enabled: bool) -> bool:
        self._config["silence_auto_stop_enabled"] = enabled
        return self._save()

    SUPPORTED_SILENCE_AUTO_STOP_MINUTES = (2, 5, 10, 15, 30)

    def get_silence_auto_stop_minutes(self) -> int:
        """Minutes of bilateral silence before auto-stop fires. Default 5: long
        enough that normal in-meeting pauses (shared reading, breaks, muted
        stretches) don't split a meeting into two notes, short enough to still
        reclaim a forgotten recording. Constrained to the supported set so the
        Settings dropdown stays in sync with persisted values."""
        value = self._config.get("silence_auto_stop_minutes", 5)
        if value in self.SUPPORTED_SILENCE_AUTO_STOP_MINUTES:
            return value
        logger.warning(
            f"Invalid silence_auto_stop_minutes in config: {value}; falling back to 5"
        )
        return 5

    def set_silence_auto_stop_minutes(self, minutes: int) -> bool:
        if minutes not in self.SUPPORTED_SILENCE_AUTO_STOP_MINUTES:
            return False
        self._config["silence_auto_stop_minutes"] = minutes
        return self._save()


    # --- Local MCP Server ---------------------------------------------------
    # Secret-free: the MCP API key is encrypted and stored separately by the
    # Electron main process in .mcp-api-key; config.json NEVER stores secrets.

    def _normalize_mcp_settings(self) -> None:
        """Coerce persisted MCP settings to valid types on load.

        Secret-free: the MCP API key is stored separately (encrypted by Electron)
        and must never be placed in config.json.
        """
        if self._load_failed:
            return
        if "mcp_enabled" in self._config:
            val = self._config["mcp_enabled"]
            if not isinstance(val, bool):
                self._config["mcp_enabled"] = self.DEFAULT_MCP_ENABLED
        if "mcp_port" in self._config:
            val = self._config["mcp_port"]
            if isinstance(val, int) and not isinstance(val, bool) and (self.MIN_MCP_PORT <= val <= self.MAX_MCP_PORT):
                pass
            else:
                self._config["mcp_port"] = self.DEFAULT_MCP_PORT

    def get_mcp_enabled(self) -> bool:
        """Get whether the local MCP server is enabled. Default False."""
        val = self._config.get("mcp_enabled", self.DEFAULT_MCP_ENABLED)
        if isinstance(val, bool):
            return val
        return self.DEFAULT_MCP_ENABLED

    def set_mcp_enabled(self, enabled: bool) -> bool:
        """Set whether the local MCP server is enabled.

        Args:
            enabled: True to enable the local MCP server, False to disable.

        Returns:
            True if saved successfully, False otherwise.
        """
        self._config["mcp_enabled"] = bool(enabled)
        return self._save()

    def get_mcp_port(self) -> int:
        """Get the local MCP server port. Default 27127 (range 1024-65535)."""
        val = self._config.get("mcp_port", self.DEFAULT_MCP_PORT)
        if isinstance(val, int) and not isinstance(val, bool) and (self.MIN_MCP_PORT <= val <= self.MAX_MCP_PORT):
            return val
        return self.DEFAULT_MCP_PORT

    def set_mcp_port(self, port: int) -> bool:
        """Set the local MCP server port.

        Args:
            port: Port number between 1024 and 65535.

        Returns:
            True if valid and saved successfully, False if rejected or save failed.
        """
        if isinstance(port, bool) or not isinstance(port, int):
            return False
        if not (self.MIN_MCP_PORT <= port <= self.MAX_MCP_PORT):
            logger.error(
                f"Invalid MCP port: {port}; expected integer between "
                f"{self.MIN_MCP_PORT} and {self.MAX_MCP_PORT}"
            )
            return False
        self._config["mcp_port"] = port
        return self._save()

    def get_mcp_settings(self) -> Dict[str, Any]:
        """Get the local MCP server settings (secret-free).

        Returns:
            Dictionary with 'mcp_enabled' (bool) and 'mcp_port' (int).
            Note: The API key is stored encrypted separately by the Electron
            main process and is NEVER stored in config.json.
        """
        return {
            "mcp_enabled": self.get_mcp_enabled(),
            "mcp_port": self.get_mcp_port(),
        }

    def set_mcp_settings(
        self,
        enabled: Optional[bool] = None,
        port: Optional[int] = None,
    ) -> bool:
        """Set local MCP settings atomically.

        Args:
            enabled: Optional bool to enable/disable.
            port: Optional int port (1024-65535).

        Returns:
            True if valid and saved, False if rejected or save failed.
        """
        if port is not None:
            if isinstance(port, bool) or not isinstance(port, int) or not (self.MIN_MCP_PORT <= port <= self.MAX_MCP_PORT):
                logger.error(
                    f"Invalid MCP port: {port}; expected integer between "
                    f"{self.MIN_MCP_PORT} and {self.MAX_MCP_PORT}"
                )
                return False
        if enabled is not None:
            self._config["mcp_enabled"] = bool(enabled)
        if port is not None:
            self._config["mcp_port"] = port
        return self._save()

    def get_transcription_engine(self) -> str:
        """Return the active ASR engine ('parakeet' or 'whisper').

        Falls back to 'parakeet' for unknown values. The renderer's
        Settings → Transcribe tab writes this; the live VAD pipeline reads
        it to pick which transcribe_samples() implementation to import.
        """
        value = self._config.get("transcription_engine", "parakeet")
        return value if value in self.VALID_TRANSCRIPTION_ENGINES else "parakeet"

    def set_transcription_engine(self, engine: str) -> bool:
        """Persist the active ASR engine. Validates against
        VALID_TRANSCRIPTION_ENGINES."""
        if engine not in self.VALID_TRANSCRIPTION_ENGINES:
            logger.error(
                f"Invalid transcription engine: {engine}. "
                f"Must be one of {self.VALID_TRANSCRIPTION_ENGINES}"
            )
            return False
        self._config["transcription_engine"] = engine
        return self._save()

    def get_whisper_model(self) -> str:
        """Get the configured Whisper model size."""
        model = self._config.get("whisper_model", "large-v3-turbo")
        if model not in self.SUPPORTED_WHISPER_MODELS:
            logger.warning(f"Invalid Whisper model in config: {model}; falling back to large-v3-turbo")
            return "large-v3-turbo"
        return model

    def set_whisper_model(self, model_size: str) -> bool:
        """Set the Whisper model size."""
        if model_size not in self.SUPPORTED_WHISPER_MODELS:
            logger.error(f"Unsupported Whisper model: {model_size}")
            return False
        self._config["whisper_model"] = model_size
        return self._save()

    def get_system_audio_enabled(self) -> bool:
        """Get whether system audio capture is enabled."""
        return self._config.get("system_audio_enabled", True)

    def set_system_audio_enabled(self, enabled: bool) -> bool:
        """
        Set whether system audio capture is enabled.

        Args:
            enabled: True to enable system audio capture, False to disable

        Returns:
            True if saved successfully, False otherwise
        """
        self._config["system_audio_enabled"] = enabled
        return self._save()

    def get_auto_detect_meetings_enabled(self) -> bool:
        """Get whether auto-detect meetings is enabled."""
        return self._config.get("auto_detect_meetings_enabled", True)

    def set_auto_detect_meetings_enabled(self, enabled: bool) -> bool:
        """Set whether auto-detect meetings is enabled."""
        self._config["auto_detect_meetings_enabled"] = enabled
        return self._save()

    def get_launch_on_login(self) -> bool:
        """Get whether Steno launches automatically on login."""
        # Fall back to True so existing installs whose config predates this
        # key default ON (the feature ships enabled-for-everyone; users opt out
        # in Settings). main.js re-applies the OS login item on every startup.
        return self._config.get("launch_on_login", True)

    def set_launch_on_login(self, enabled: bool) -> bool:
        """Set whether Steno launches automatically on login."""
        self._config["launch_on_login"] = enabled
        return self._save()

    def get_language(self) -> str:
        """Get the configured language code for transcription and summarization."""
        # Fall back to "auto" (not "en") so legacy configs saved before the
        # "language" field existed, or ones missing just that key, agree with
        # the "auto" default in _get_default_config() and auto-detect the
        # transcript's language instead of silently defaulting to English (#281).
        return self._config.get("language", "auto")

    def get_whisper_language(self) -> str:
        """Map the UI language code to the code the ASR engine understands.

        whisper.cpp (and Parakeet's language hint) only know ``"zh"`` for
        Chinese — the Simplified/Traditional distinction is a post-transcription
        conversion, not an ASR mode — so both ``zh-Hans`` and ``zh-Hant`` fold
        to ``zh`` here. Every other code passes through unchanged.
        """
        code = self.get_language()
        if code in ("zh-Hans", "zh-Hant"):
            return "zh"
        return code

    def get_chinese_variant(self) -> Optional[str]:
        """Return the target Chinese script for output conversion.

        ``"traditional"`` for ``zh-Hant``, ``"simplified"`` for ``zh-Hans``,
        and ``None`` for any non-Chinese language (no conversion needed).
        Consumed by ``src.chinese.apply_variant``.
        """
        code = self.get_language()
        if code == "zh-Hant":
            return "traditional"
        if code == "zh-Hans":
            return "simplified"
        return None

    def set_language(self, language_code: str) -> bool:
        """
        Set the language for transcription and summarization.

        Args:
            language_code: Language code (e.g., "en", "de", "auto")

        Returns:
            True if saved successfully, False otherwise
        """
        # Legacy "zh" (pre Simplified/Traditional split) is still accepted and
        # normalised to Simplified, matching the on-load migration.
        if language_code == "zh":
            language_code = "zh-Hans"

        if language_code not in self.SUPPORTED_LANGUAGES:
            logger.error(f"Unsupported language code: {language_code}")
            return False

        self._config["language"] = language_code
        return self._save()

    def get_language_name(self, language_code: Optional[str] = None) -> str:
        """Get the display name for a language code."""
        if language_code is None:
            language_code = self.get_language()
        return (
            self.SUPPORTED_LANGUAGES.get(language_code)
            or self._LANGUAGE_NAMES.get(language_code)
            or (language_code.upper() if language_code else "Unknown")
        )

    def get_microphone_device(self) -> Dict[str, Optional[str]]:
        """Get the selected microphone device (None/None = system default)."""
        return {
            "device_id": self._config.get("microphone_device_id"),
            "label": self._config.get("microphone_device_label"),
        }

    def set_microphone_device(
        self, device_id: Optional[str], label: Optional[str]
    ) -> bool:
        """
        Set the microphone device to record from.

        Args:
            device_id: browser MediaDeviceInfo.deviceId, or None/"default" to
                clear back to the OS system default input device
            label: human-readable device label, stored so Settings can display
                the selection even before enumerateDevices() re-resolves it

        Returns:
            True if saved successfully, False otherwise
        """
        if not device_id or device_id == "default":
            self._config["microphone_device_id"] = None
            self._config["microphone_device_label"] = None
        else:
            self._config["microphone_device_id"] = device_id
            self._config["microphone_device_label"] = label or None
        return self._save()

    # --- AI provider settings ---

    VALID_AI_PROVIDERS = ("local", "remote", "cloud", "adapter")
    VALID_CLOUD_PROVIDERS = ("openai", "anthropic", "bedrock", "custom")

    # AWS Bedrock has ~30 regions; we surface the common ones in the UI but
    # accept any value as set_bedrock_region trusts the caller. Defaulting to
    # us-east-1 because that's where new Bedrock features land first and the
    # widest model selection lives.
    DEFAULT_BEDROCK_REGION = "us-east-1"

    # Claude on Bedrock — curated dropdown for the Settings UI. Bedrock model
    # IDs are versioned (`:0`, `:1`, …) and prefixed with the model provider
    # (`anthropic.`); cross-region inference profiles override these at call
    # time when set. Keep this list small and current; users who want a model
    # not on the list can paste it into the "Custom…" entry.
    SUPPORTED_BEDROCK_MODELS = (
        "anthropic.claude-sonnet-4-5-20250929-v2:0",
        "anthropic.claude-haiku-4-5-20251001-v1:0",
        "anthropic.claude-opus-4-1-20250805-v1:0",
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
        "anthropic.claude-3-5-haiku-20241022-v1:0",
    )

    def get_ai_provider(self) -> str:
        """Get the configured AI provider ('local', 'remote', 'cloud', or
        'adapter'). 'adapter' routes AI requests through a signed-in org's
        adapter so the desktop never sees the provider key — see
        get_adapter_url / get_adapter_token below for how the desktop's
        Electron main passes the session into the Python subprocess."""
        value = self._config.get("ai_provider", "local")
        return value if value in self.VALID_AI_PROVIDERS else "local"

    def set_ai_provider(self, provider: str) -> bool:
        """Set the AI provider mode."""
        if provider not in self.VALID_AI_PROVIDERS:
            logger.error(f"Invalid AI provider: {provider}. Must be one of {self.VALID_AI_PROVIDERS}")
            return False
        self._config["ai_provider"] = provider
        return self._save()

    def get_remote_ollama_url(self) -> str:
        """Get the remote Ollama server URL."""
        return self._config.get("remote_ollama_url", "")

    def set_remote_ollama_url(self, url: str) -> bool:
        """Set the remote Ollama server URL."""
        self._config["remote_ollama_url"] = url.strip()
        return self._save()

    def get_cloud_api_url(self) -> str:
        """Get the cloud API URL."""
        return self._config.get("cloud_api_url", "")

    def set_cloud_api_url(self, url: str) -> bool:
        """Set the cloud API URL."""
        self._config["cloud_api_url"] = url.strip()
        return self._save()

    def get_cloud_api_key(self) -> str:
        """Get the cloud API key from env var (set by Electron via safeStorage)."""
        import os
        return os.environ.get("STENOAI_CLOUD_API_KEY", "")

    def get_adapter_url(self) -> str:
        """Get the org adapter base URL (set by Electron when a session is
        active). The summariser uses this when ai_provider == 'adapter' to
        route AI requests through the customer's adapter instead of touching
        a provider key directly."""
        import os
        return os.environ.get("STENOAI_ADAPTER_URL", "").rstrip("/")

    def get_adapter_token(self) -> str:
        """Get the org adapter JWT (set by Electron from the persisted session)."""
        import os
        return os.environ.get("STENOAI_ADAPTER_TOKEN", "")

    # Per-provider sensible defaults. Used when the user switches provider for
    # the first time and we have no remembered model for that provider yet.
    CLOUD_MODEL_DEFAULTS = {
        "openai": "gpt-4o-mini",
        "anthropic": "claude-haiku-4-5-20251001",
        "bedrock": "anthropic.claude-haiku-4-5-20251001-v1:0",
        "custom": "gpt-4o-mini",
    }

    def get_cloud_provider(self) -> str:
        """Get the cloud provider type. One of VALID_CLOUD_PROVIDERS; falls
        back to 'openai' for unknown values (e.g. config from a future
        version with a provider this build doesn't know about)."""
        value = self._config.get("cloud_provider", "openai")
        return value if value in self.VALID_CLOUD_PROVIDERS else "openai"

    # --- Bedrock-specific knobs ---
    # Stored as plain config (not env-var-secret like the API key) because
    # region + inference profile are not credentials. The API key still
    # flows through STENOAI_CLOUD_API_KEY exactly like the other providers.

    def get_bedrock_region(self) -> str:
        """AWS region used as the Bedrock endpoint host. Defaults to us-east-1
        when unset. Cross-region inference profiles override which regions
        actually serve traffic but the request still has to land somewhere."""
        value = self._config.get("bedrock_region")
        if not isinstance(value, str) or not value.strip():
            return self.DEFAULT_BEDROCK_REGION
        return value.strip()

    def set_bedrock_region(self, region: str) -> bool:
        """Persist the AWS region. A legitimate typo (e.g. "us-eest-1")
        still surfaces as a clear 404 / DNS error at request time rather
        than silently here — but the value must at least be shaped like a
        real AWS region code, so a string crafted to redirect the request
        to a different host (`user@host` URL syntax) can't be saved."""
        cleaned = (region or "").strip()
        if not cleaned:
            logger.error("Bedrock region cannot be empty")
            return False
        if not BEDROCK_REGION_RE.fullmatch(cleaned):
            logger.error(f"Rejected malformed Bedrock region: {cleaned!r}")
            return False
        self._config["bedrock_region"] = cleaned
        return self._save()

    def get_bedrock_inference_profile(self) -> str:
        """Optional cross-region inference profile ID, e.g.
        'us.anthropic.claude-haiku-4-5-20251001-v1:0'. When set this is used
        as the modelId in the Converse URL path so Bedrock routes the
        request across the profile's regions instead of pinning to one.
        Empty means 'use the bare model id'.

        Stripped on read so a whitespace-only stored value (e.g. from a
        hand-edited config.json) doesn't survive the `target = profile or
        model_id` check in _bedrock_chat and produce a URL with `%20`s in
        place of the model id."""
        value = self._config.get("bedrock_inference_profile", "")
        if not isinstance(value, str):
            return ""
        return value.strip()

    def set_bedrock_inference_profile(self, profile: str) -> bool:
        """Persist the inference profile. Empty string clears it — equivalent
        to 'use the bare model id'."""
        self._config["bedrock_inference_profile"] = (profile or "").strip()
        return self._save()

    def set_cloud_provider(self, provider: str) -> bool:
        """Set the cloud provider type."""
        if provider not in self.VALID_CLOUD_PROVIDERS:
            logger.error(f"Invalid cloud provider: {provider}. Must be one of {self.VALID_CLOUD_PROVIDERS}")
            return False
        self._config["cloud_provider"] = provider
        return self._save()

    def _get_cloud_models_map(self) -> dict:
        """Per-provider model store. Migration is handled in __init__ so this
        just returns the dict (or empty)."""
        models = self._config.get("cloud_models")
        if not isinstance(models, dict):
            models = {}
            self._config["cloud_models"] = models
        return models

    def get_cloud_model(self) -> str:
        """Get the cloud model for the currently selected provider. Each
        provider has its own remembered model so switching providers doesn't
        carry an incompatible model name across (e.g. a Claude model into
        OpenAI). Falls back to the per-provider default on first use."""
        provider = self.get_cloud_provider()
        models = self._get_cloud_models_map()
        if provider in models and isinstance(models[provider], str) and models[provider].strip():
            return models[provider]
        return self.CLOUD_MODEL_DEFAULTS.get(provider, "gpt-4o-mini")

    def set_cloud_model(self, model: str) -> bool:
        """Set the cloud model for the currently selected provider."""
        provider = self.get_cloud_provider()
        models = self._get_cloud_models_map()
        models[provider] = model.strip()
        self._config["cloud_models"] = models
        # Mirror to legacy 'cloud_model' so any code still reading the flat
        # field sees the active provider's choice. Safe to remove once no
        # consumers reference it.
        self._config["cloud_model"] = model.strip()
        return self._save()

    def get_user_name(self) -> str:
        """Get the user's first name (for greetings). Empty string when unset."""
        value = self._config.get("user_name")
        if not isinstance(value, str):
            return ""
        return value.strip()

    def set_user_name(self, name: str) -> bool:
        """Persist the user's first name. Trims whitespace; an empty name
        clears the field."""
        cleaned = (name or "").strip()
        # Cap to a sane length so a paste of someone's whole bio doesn't end
        # up in the greeting.
        if len(cleaned) > 60:
            cleaned = cleaned[:60]
        self._config["user_name"] = cleaned
        return self._save()

    def get_anonymous_id(self) -> str:
        """Get the anonymous telemetry ID, generating one if missing."""
        anon_id = self._config.get("anonymous_id")
        if not anon_id:
            anon_id = str(uuid.uuid4())
            self._config["anonymous_id"] = anon_id
            self._save()
        return anon_id

    def get(self, key: str, default: Any = None) -> Any:
        """Get a configuration value."""
        return self._config.get(key, default)

    def set(self, key: str, value: Any) -> bool:
        """Set a configuration value and save."""
        self._config[key] = value
        return self._save()


# Global config instance
_config_instance: Optional[Config] = None


def get_config() -> Config:
    """Get the global config instance (singleton pattern)."""
    global _config_instance
    if _config_instance is None:
        _config_instance = Config()
    return _config_instance


def get_data_dirs() -> Dict[str, Path]:
    """
    Centralised path resolution for recordings, transcripts, and output.

    Returns dict with keys: recordings, transcripts, output.
    Uses custom storage_path from config if set, otherwise falls back to
    the per-OS user data dir (see get_user_data_dir) when bundled, or the
    repo root when running from source.
    """
    config = get_config()
    custom = config.get_storage_path()

    if os.environ.get("STENOAI_USER_DATA_DIR"):
        # Keystone: the e2e isolation dir is the hardest override — it must beat
        # a user's custom storage_path too, so a test can never escape the temp
        # dir to a real configured recordings/transcripts location.
        base = get_user_data_dir()
    elif custom:
        base = Path(custom)
    elif is_bundled():
        base = get_user_data_dir()
    else:
        base = Path(__file__).parent.parent  # project root in dev (source)

    dirs = {
        "recordings": base / "recordings",
        "transcripts": base / "transcripts",
        "output": base / "output",
    }

    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)

    return dirs


def resolve_runtime_tag(model_id: str) -> str:
    """Map a canonical GGUF model id to its NVFP4/MLX-engine tag on Apple
    Silicon; a no-op everywhere else (including for models with no MLX
    equivalent, e.g. llama3.2:3b).

    This is the ONLY place a GGUF id is ever translated to an NVFP4 tag.
    config.json, SUPPORTED_MODELS, and every migration/validation path keep
    using the canonical GGUF id — callers must call this at the point a
    literal Ollama model string is about to be sent, not before.
    """
    if not is_apple_silicon():
        return model_id
    return Config._MLX_EQUIVALENTS.get(model_id, model_id)
