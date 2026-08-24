"""Build-time guard for required macOS native sidecars."""

import os
import sys
from pathlib import Path
from typing import Optional


def require_macos_sidecar(
    sidecar_path: Path,
    *,
    name: str,
    build_script: str,
    platform: str = sys.platform,
) -> Optional[Path]:
    """Require an executable sidecar for macOS bundles.

    Returning ``None`` on other platforms keeps the shared PyInstaller spec
    portable; those builds do not ship or invoke the Swift helpers.
    """
    if platform != "darwin":
        return None
    if not sidecar_path.is_file():
        raise FileNotFoundError(
            f"Missing required macOS {name} sidecar: {sidecar_path}. "
            f"Run {build_script} before PyInstaller."
        )
    if not os.access(sidecar_path, os.X_OK):
        raise PermissionError(
            f"Required macOS {name} sidecar is not executable: {sidecar_path}"
        )
    return sidecar_path
