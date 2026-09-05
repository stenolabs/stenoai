"""Build-time guard for the macOS speaker-diarization sidecar."""

import os
import sys
from pathlib import Path
from typing import Optional


def require_diarize_sidecar(
    sidecar_path: Path,
    *,
    platform: str = sys.platform,
) -> Optional[Path]:
    """Require an executable sidecar for macOS bundles.

    Returning ``None`` on other platforms keeps their existing channel-only
    speaker labeling path unchanged.
    """
    if platform != "darwin":
        return None
    if not sidecar_path.is_file():
        raise FileNotFoundError(
            f"Missing required macOS diarization sidecar: {sidecar_path}. "
            "Run scripts/build-diarize-sidecar.sh before PyInstaller."
        )
    if not os.access(sidecar_path, os.X_OK):
        raise PermissionError(
            f"Required macOS diarization sidecar is not executable: {sidecar_path}"
        )
    return sidecar_path
