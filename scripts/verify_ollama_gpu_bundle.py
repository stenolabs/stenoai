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
    prune_all: bool = False,
) -> bool:
    """Keep GPU backends on Linux/macOS and prune them on Windows only.

    ``prune_all`` is the CI-only override (``STENOAI_PRUNE_OLLAMA_GPU=1`` in
    stenoai.spec): GitHub-hosted runners have no GPU, and the Linux Ollama
    archive's cuda_v12/cuda_v13/vulkan runners are ~3 GB of dead weight that
    every e2e job would otherwise download. Release builds never set it.
    """
    if ollama_gpu_family(relative_path) is None:
        return False
    return prune_all or platform == "win32"


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


def _payload_problem(path: Path, root: Path) -> Optional[str]:
    try:
        resolved_root = root.resolve(strict=True)
        resolved_path = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return "missing or broken"
    if resolved_root not in resolved_path.parents:
        return "resolves outside the Ollama tree"
    if not resolved_path.is_file():
        return "not a file"
    if resolved_path.stat().st_size == 0:
        return "empty"
    return None


def _verify_source_gpu_payloads(
    source_root: Path,
    *,
    required_families: tuple[str, ...],
) -> tuple[list[Path], set[str]]:
    """Validate the DOWNLOADED Ollama tree's GPU payloads.

    Shared by the release check (payloads must reach the bundle) and the CI
    pruned check (payloads must NOT reach the bundle) so a truncated or
    re-laid-out Ollama download is caught in both lanes.
    """
    if not source_root.is_dir():
        raise FileNotFoundError(f"Ollama source tree not found: {source_root}")

    source_payloads = _payload_files(source_root)
    invalid_source_payloads = [
        f"{path.relative_to(source_root).as_posix()} ({problem})"
        for path in source_payloads
        if (problem := _payload_problem(path, source_root)) is not None
    ]
    if invalid_source_payloads:
        raise FileNotFoundError(
            "Downloaded Ollama GPU payload is invalid: "
            + ", ".join(invalid_source_payloads)
        )

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
    return source_payloads, source_families


def verify_ollama_gpu_pruned(
    source_root: Path,
    bundle_root: Path,
    *,
    required_families: tuple[str, ...] = ("cuda",),
) -> dict[str, object]:
    """CI counterpart of verify_ollama_gpu_bundle for STENOAI_PRUNE_OLLAMA_GPU=1.

    The download half is identical (the source tree must still carry valid GPU
    payloads, so a broken Ollama archive fails here too); the bundle half is
    inverted: no GPU payload may survive, and the CPU runner must be present
    so the e2e summariser still has something to run on.
    """
    target_root = bundle_root / "_internal" / "ollama"
    if not target_root.is_dir():
        raise FileNotFoundError(f"Bundled Ollama tree not found: {target_root}")

    _source_payloads, source_families = _verify_source_gpu_payloads(
        source_root, required_families=required_families
    )

    leaked = sorted(
        path.relative_to(target_root).as_posix() for path in _payload_files(target_root)
    )
    if leaked:
        raise FileNotFoundError(
            "Bundled Ollama tree still carries GPU payloads that CI pruning should "
            "have dropped: " + ", ".join(leaked[:10])
            + (f" (+{len(leaked) - 10} more)" if len(leaked) > 10 else "")
        )

    cpu_runners = [
        path
        for path in _all_files(target_root)
        if path.name.startswith("libggml-cpu") or path.name.startswith("ggml-cpu")
    ]
    if not cpu_runners:
        raise FileNotFoundError(
            "Bundled Ollama tree has no CPU runner (libggml-cpu*): pruning removed too much"
        )

    return {
        "families": tuple(sorted(source_families)),
        "pruned_families": tuple(sorted(source_families)),
        "cpu_runner_count": len(cpu_runners),
        "ollama_logical_bytes": _tree_bytes(_all_files(target_root)),
        "bundle_logical_bytes": _tree_bytes(_all_files(bundle_root)),
    }


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

    source_payloads, source_families = _verify_source_gpu_payloads(
        source_root, required_families=required_families
    )

    invalid_target_payloads: list[str] = []
    target_payloads: list[Path] = []
    for source_path in source_payloads:
        relative_path = source_path.relative_to(source_root)
        target_path = target_root / relative_path
        if (problem := _payload_problem(target_path, target_root)) is not None:
            invalid_target_payloads.append(f"{relative_path.as_posix()} ({problem})")
            continue
        target_payloads.append(target_path)

    if invalid_target_payloads:
        raise FileNotFoundError(
            "Bundled Ollama GPU payload is incomplete: "
            + ", ".join(invalid_target_payloads)
        )

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
    parser.add_argument(
        "--expect-pruned",
        action="store_true",
        help=(
            "CI mode for a bundle built with STENOAI_PRUNE_OLLAMA_GPU=1: the download "
            "must still carry valid GPU payloads, the bundle must carry none."
        ),
    )
    args = parser.parse_args()

    try:
        if args.expect_pruned:
            result = verify_ollama_gpu_pruned(args.source_root, args.bundle_root)
        else:
            result = verify_ollama_gpu_bundle(args.source_root, args.bundle_root)
    except (FileNotFoundError, OSError) as error:
        print(f"verify_ollama_gpu_bundle: FAIL - {error}", file=sys.stderr)
        return 1

    families = ",".join(result["families"])
    if args.expect_pruned:
        print(
            "verify_ollama_gpu_bundle: PASS (pruned) - "
            f"dropped_families={families}; cpu_runners={result['cpu_runner_count']}; "
            f"ollama_logical_bytes={result['ollama_logical_bytes']}; "
            f"bundle_logical_bytes={result['bundle_logical_bytes']}"
        )
        return 0
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
