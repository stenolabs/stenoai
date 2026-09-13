"""
Ollama manager for bundled Ollama binary.

Handles finding and running the bundled Ollama binary that ships with StenoAI,
eliminating the need for users to install Ollama separately.
"""

import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Platform-specific executable suffix (PyInstaller and Ollama both append .exe on Windows).
_EXE_SUFFIX = ".exe" if sys.platform == "win32" else ""

# Ollama download URL for macOS
OLLAMA_DOWNLOAD_URL = "https://github.com/ollama/ollama/releases/download/v0.16.3/ollama-darwin.tgz"


def get_bundled_ollama_dir() -> Optional[Path]:
    """
    Get the path to the bundled Ollama directory.

    Returns:
        Path to the ollama directory, or None if not found
    """
    binary_name = f"ollama{_EXE_SUFFIX}"

    # When running from PyInstaller bundle
    if getattr(sys, 'frozen', False):
        # PyInstaller sets _MEIPASS to the temp directory where files are extracted
        base_path = Path(sys._MEIPASS)
        ollama_dir = base_path / 'ollama'
        if (ollama_dir / binary_name).exists():
            return ollama_dir

        # Also check relative to executable
        exe_dir = Path(sys.executable).parent
        ollama_dir = exe_dir / 'ollama'
        if (ollama_dir / binary_name).exists():
            return ollama_dir

    # Development mode - check bin directory
    dev_ollama_dir = Path(__file__).parent.parent / 'bin'
    if (dev_ollama_dir / binary_name).exists():
        return dev_ollama_dir

    return None


def get_ollama_binary() -> Optional[Path]:
    """
    Get the path to the Ollama binary.

    Checks in order:
    1. Bundled Ollama (in PyInstaller bundle or dev bin/)
    2. System Ollama (in PATH or common locations)

    Returns:
        Path to ollama binary, or None if not found
    """
    binary_name = f"ollama{_EXE_SUFFIX}"

    # Check bundled first
    bundled_dir = get_bundled_ollama_dir()
    if bundled_dir:
        ollama_path = bundled_dir / binary_name
        if ollama_path.exists():
            logger.info(f"Using bundled Ollama: {ollama_path}")
            return ollama_path

    # Check PATH first (shutil.which is cross-platform; honours PATHEXT on Windows)
    on_path = shutil.which("ollama")
    if on_path:
        logger.info(f"Using system Ollama from PATH: {on_path}")
        return Path(on_path)

    # Fall back to common system install locations
    if sys.platform == "win32":
        local_app = os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
        system_paths = [
            Path(local_app) / "Programs" / "Ollama" / "ollama.exe",
            Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Ollama" / "ollama.exe",
        ]
    else:
        system_paths = [
            Path("/opt/homebrew/bin/ollama"),  # Homebrew on Apple Silicon
            Path("/usr/local/bin/ollama"),     # Homebrew on Intel
            Path("/usr/bin/ollama"),           # System installation
        ]

    for path in system_paths:
        if path.exists():
            logger.info(f"Using system Ollama: {path}")
            return path

    logger.warning("No Ollama binary found")
    return None


def get_ollama_env() -> dict:
    """
    Get environment variables needed to run bundled Ollama.

    Sets up library paths for the bundled dylibs.

    Returns:
        Dictionary of environment variables
    """
    env = {
        name: value
        for name, value in os.environ.items()
        if name.upper() not in {
            "STENOAI_OAI_API_KEY",
            "STENOAI_OAI_API_ORIGIN",
            "STENOAI_OAI_API_URL",
        }
    }
    # The cloud-ASR credential is injected only so the short-lived backend can
    # upload audio. Ollama is unrelated to transcription and may outlive that
    # backend process, so never copy the credential into its server or runners.

    bundled_dir = get_bundled_ollama_dir()
    if bundled_dir:
        ollama_dir_str = str(bundled_dir)

        if sys.platform == "darwin":
            # macOS uses DYLD_LIBRARY_PATH for dylib resolution
            existing = env.get('DYLD_LIBRARY_PATH', '')
            env['DYLD_LIBRARY_PATH'] = (
                f"{ollama_dir_str}:{existing}" if existing else ollama_dir_str
            )
            # Do NOT set MLX_METAL_PATH: Ollama (v0.31.1+) ships its Metal
            # library under versioned subdirectories (mlx_metal_v3/,
            # mlx_metal_v4/) selected by its own internal GPU-family
            # detection, not a flat <bundle>/mlx.metallib file. Pointing
            # this at the old flat path (stale since Ollama moved to the
            # versioned layout) makes it point at a file that no longer
            # exists. Leaving it unset matches how a standalone
            # (non-bundled) Ollama install behaves.
            logger.debug(f"Set DYLD_LIBRARY_PATH: {env['DYLD_LIBRARY_PATH']}")
        elif sys.platform == "win32":
            # Windows uses PATH for DLL resolution; ollama's GPU libs live under
            # ollama/lib/ollama/ (preserved by stenoai.spec's recursive walk).
            existing = env.get('PATH', '')
            env['PATH'] = (
                f"{ollama_dir_str};{existing}" if existing else ollama_dir_str
            )
        else:
            # Linux: LD_LIBRARY_PATH for .so resolution
            existing = env.get('LD_LIBRARY_PATH', '')
            env['LD_LIBRARY_PATH'] = (
                f"{ollama_dir_str}:{existing}" if existing else ollama_dir_str
            )

    return env


def is_ollama_running() -> bool:
    """
    Check if Ollama server is running.

    Returns:
        True if Ollama is responding, False otherwise
    """
    try:
        import httpx
        response = httpx.get('http://127.0.0.1:11434/api/tags', timeout=2)
        return response.status_code == 200
    except Exception:
        return False



def _get_pid_file() -> Path:
    """Get the path to the Ollama PID file."""
    if getattr(sys, 'frozen', False):
        return Path(sys._MEIPASS) / 'ollama.pid'
    return Path(__file__).parent.parent / 'ollama.pid'


def _write_pid(pid: int) -> None:
    """Write Ollama's PID to a file so Electron can kill it on quit."""
    try:
        _get_pid_file().write_text(str(pid))
    except Exception as e:
        logger.debug(f"Could not write Ollama PID file: {e}")


def _clear_pid() -> None:
    """Remove the PID file."""
    try:
        _get_pid_file().unlink(missing_ok=True)
    except Exception:
        pass


def start_ollama_server(wait: bool = True, timeout: int = 30) -> bool:
    """
    Start the Ollama server if not already running.

    Args:
        wait: If True, wait for server to be ready
        timeout: Maximum seconds to wait for server

    Returns:
        True if server is running, False if failed to start
    """
    if is_ollama_running():
        logger.info("Ollama server is already running")
        return True

    ollama_binary = get_ollama_binary()
    if not ollama_binary:
        logger.error("Cannot start Ollama - binary not found")
        return False

    try:
        env = get_ollama_env()

        # Start Ollama server in background, detached from this process so it
        # outlives the short-lived CLI invocation that spawns it. start_new_session
        # is POSIX-only; on Windows the equivalent is CREATE_NEW_PROCESS_GROUP.
        logger.info(f"Starting Ollama server: {ollama_binary}")
        popen_kwargs: dict = {
            "env": env,
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
        }
        if sys.platform == "win32":
            popen_kwargs["creationflags"] = (
                subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
                | getattr(subprocess, "DETACHED_PROCESS", 0)
            )
        else:
            popen_kwargs["start_new_session"] = True
        proc = subprocess.Popen([str(ollama_binary), 'serve'], **popen_kwargs)
        _write_pid(proc.pid)

        if not wait:
            return True

        # Wait for server to be ready
        start_time = time.time()
        while time.time() - start_time < timeout:
            if is_ollama_running():
                logger.info("Ollama server is ready")
                return True
            time.sleep(0.5)

        logger.error(f"Ollama server did not start within {timeout} seconds")
        return False

    except Exception as e:
        logger.error(f"Failed to start Ollama server: {e}")
        return False
