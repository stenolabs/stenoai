"""Build-time guard for the optional macOS Apple language-model helper app."""

import os
import sys
from pathlib import Path
from typing import Optional


def resolve_apple_lm_sidecar(
    helper_app_path: Path,
    *,
    platform: str = sys.platform,
    required: bool = False,
) -> Optional[Path]:
    """Validate and return the executable inside the helper app bundle.

    Development builds may omit the helper when their Xcode lacks the macOS 26
    SDK. Release builds pass ``required=True`` so a missing feature cannot ship
    silently. Other platforms never bundle the Darwin-only executable.
    """
    if platform != "darwin":
        return None
    executable = (
        helper_app_path
        / "Contents"
        / "MacOS"
        / "steno-apple-lm"
    )
    info_plist = helper_app_path / "Contents" / "Info.plist"
    if not helper_app_path.is_dir() or not info_plist.is_file():
        if required:
            raise FileNotFoundError(
                f"Missing required Apple LM helper app: {helper_app_path}. "
                "Run scripts/build-apple-lm-sidecar.sh before PyInstaller."
            )
        return None
    if not executable.is_file():
        raise FileNotFoundError(
            f"Apple LM helper executable is missing: {executable}"
        )
    if not os.access(executable, os.X_OK):
        raise PermissionError(
            f"Apple LM helper is not executable: {executable}"
        )
    return executable
