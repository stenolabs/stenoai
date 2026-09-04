"""Verify that Linux bundles preserve Ollama's GPU backends."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path, PurePosixPath
from typing import Iterable, Optional


_GPU_FAMILIES = ("cuda", "rocm", "vulkan")
_GPU_LIBRARY_PREFIXES = {
    "cuda": "libggml-cuda.so",
    "rocm": "libggml-hip.so",
    "vulkan": "libggml-vulkan.so",
}


def ollama_gpu_family(relative_path: os.PathLike[str] | str) -> Optional[str]:
    """Return the Ollama GPU family represented by a relative payload path."""
    parts = PurePosixPath(str(relative_path).replace("\\", "/").lower()).parts
    for index in range(len(parts) - 2):
        if parts[index : index + 2] != ("lib", "ollama"):
            continue
        runner_dir = parts[index + 2]
        for family in _GPU_FAMILIES:
            if runner_dir == family or runner_dir.startswith(f"{family}_"):
                return family
    return None


def should_prune_ollama_gpu_path(
    relative_path: os.PathLike[str] | str,
    *,
    platform: str = sys.platform,
) -> bool:
    """Keep GPU backends on Linux/macOS and prune them on Windows only."""
    return platform == "win32" and ollama_gpu_family(relative_path) is not None


def _payload_files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if (path.is_file() or path.is_symlink())
        and ollama_gpu_family(path.relative_to(root)) is not None
    )


def _tree_bytes(paths: Iterable[Path]) -> int:
    """Return logical bytes, following valid symlinks like the loader does."""
    return sum(path.stat().st_size for path in paths)


def _all_files(root: Path) -> list[Path]:
    return [path for path in root.rglob("*") if path.is_file()]


def verify_ollama_gpu_bundle(
    source_root: Path,
    bundle_root: Path,
    *,
    required_families: tuple[str, ...] = ("cuda",),
) -> dict[str, object]:
    """Require every source GPU payload in a PyInstaller bundle."""
    target_root = bundle_root / "_internal" / "ollama"
    if not source_root.is_dir():
        raise FileNotFoundError(f"Ollama source tree not found: {source_root}")
    if not target_root.is_dir():
        raise FileNotFoundError(f"Bundled Ollama tree not found: {target_root}")

    source_payloads = _payload_files(source_root)
    source_families = {
        family
        for path in source_payloads
        if (family := ollama_gpu_family(path.relative_to(source_root))) is not None
    }
    source_backend_families = {
        family
        for path in source_payloads
        if (family := ollama_gpu_family(path.relative_to(source_root))) is not None
        and path.name.startswith(_GPU_LIBRARY_PREFIXES[family])
    }
    missing_families = sorted(set(required_families) - source_backend_families)
    if missing_families:
        raise FileNotFoundError(
            "Downloaded Ollama tree has no payload for required GPU families: "
            + ", ".join(missing_families)
        )

    missing_payloads: list[str] = []
    empty_payloads: list[str] = []
    target_payloads: list[Path] = []
    for source_path in source_payloads:
        relative_path = source_path.relative_to(source_root)
        target_path = target_root / relative_path
        if not target_path.exists():
            missing_payloads.append(relative_path.as_posix())
            continue
        if not target_path.is_file() or target_path.stat().st_size == 0:
            empty_payloads.append(relative_path.as_posix())
            continue
        target_payloads.append(target_path)

    if missing_payloads or empty_payloads:
        details = []
        if missing_payloads:
            details.append("missing or broken: " + ", ".join(missing_payloads))
        if empty_payloads:
            details.append("empty or not a file: " + ", ".join(empty_payloads))
        raise FileNotFoundError("Bundled Ollama GPU payload is incomplete; " + "; ".join(details))

    return {
        "families": tuple(sorted(source_families)),
        "payload_count": len(target_payloads),
        "gpu_logical_bytes": _tree_bytes(target_payloads),
        "ollama_logical_bytes": _tree_bytes(_all_files(target_root)),
        "bundle_logical_bytes": _tree_bytes(_all_files(bundle_root)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_root", type=Path, help="Downloaded Ollama tree, normally bin/")
    parser.add_argument("bundle_root", type=Path, help="PyInstaller bundle root")
    args = parser.parse_args()

    try:
        result = verify_ollama_gpu_bundle(args.source_root, args.bundle_root)
    except (FileNotFoundError, OSError) as error:
        print(f"verify_ollama_gpu_bundle: FAIL - {error}", file=sys.stderr)
        return 1

    families = ",".join(result["families"])
    print(
        "verify_ollama_gpu_bundle: PASS - "
        f"families={families}; payloads={result['payload_count']}; "
        f"gpu_logical_bytes={result['gpu_logical_bytes']}; "
        f"ollama_logical_bytes={result['ollama_logical_bytes']}; "
        f"bundle_logical_bytes={result['bundle_logical_bytes']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
