"""Build-time guard for the Ollama/pip-mlx libmlx.dylib ABI collision (darwin).

Ollama and the pip `mlx` package each ship their OWN, ABI-incompatible build of
`libmlx.dylib`. Ollama's copies live beside `libmlxc.dylib` in `mlx_metal_v*/`
runner dirs with an `@loader_path` rpath, so each resolves `@rpath/libmlx.dylib`
to its own co-located sibling. If PyInstaller's Analysis binary-dependency walk
touches Ollama's tree, it rewrites those rpaths and dedups `libmlx.dylib` by
basename onto ONE shared `_internal/libmlx.dylib` (the pip build) - after which
every MLX-tagged Ollama model call dies at runtime with a missing-symbol error
(`mlx::core::astype`). `stenoai.spec` prevents this by routing Ollama's runner
tree through a COLLECT-stage DATA TOC (copied verbatim). This script is the
canary that the fix is still in force: it fails loudly if a future PyInstaller
upgrade or spec refactor starts processing the tree again.

Run it right after `pyinstaller stenoai.spec --noconfirm`, before building the
DMG:

    python scripts/verify_mlx_bundle.py

darwin-only. On any other platform it exits 0 (no-op) - the collision only
exists in the macOS bundle. The dlopen probes additionally require an arm64
host; on Intel macOS they're skipped (noted, not failed).

Exit code: 0 if every applicable check passes, 1 if any fails (all failures are
accumulated and reported together, so one run surfaces the full picture).
"""

import ctypes
import filecmp
import glob
import os
import platform
import re
import subprocess
import sys

# Bundle layout (relative to repo root):
#   dist/stenoai/_internal/ollama/...   <- Ollama runner tree (verbatim copy)
#   bin/...                             <- the source it was copied from
#   dist/stenoai/_internal/mlx/lib/...  <- the pip mlx build (Analysis-collected)
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_BIN_DIR = os.path.join(_REPO_ROOT, 'bin')
_INTERNAL = os.path.join(_REPO_ROOT, 'dist', 'stenoai', '_internal')
_BUNDLE_OLLAMA = os.path.join(_INTERNAL, 'ollama')
_MLX_SIBLINGS = ('libmlx.dylib', 'libmlxc.dylib', 'mlx.metallib')

_failures: list[str] = []
_passes: list[str] = []


def _fail(check: str, detail: str) -> None:
    _failures.append(f"{check}: {detail}")


def _ok(check: str, detail: str = "") -> None:
    _passes.append(f"{check}{': ' + detail if detail else ''}")


def _otool(flag: str, path: str) -> str:
    """Return `otool <flag> <path>` stdout, or '' if otool is unavailable/errors."""
    try:
        return subprocess.run(
            ['otool', flag, path],
            capture_output=True, text=True, check=True,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        return f"__OTOOL_ERROR__ {exc}"


def check_bit_identity() -> None:
    """Every file under _internal/ollama/** must byte-equal its bin/** source.

    This is the canary for the whole bug class: if PyInstaller ever rewrites a
    file (rpath edit, re-sign, strip), the bytes diverge and this trips.
    """
    check = "bit-identity (_internal/ollama/** == bin/**)"
    if not os.path.isdir(_BUNDLE_OLLAMA):
        _fail(check, f"missing bundle dir {_BUNDLE_OLLAMA}")
        return
    mismatches: list[str] = []
    checked = 0
    for root, _dirs, files in os.walk(_BUNDLE_OLLAMA):
        for name in files:
            dest = os.path.join(root, name)
            rel = os.path.relpath(dest, _BUNDLE_OLLAMA)
            src = os.path.join(_BIN_DIR, rel)
            if not os.path.exists(src):
                # Ollama's tree is copied 1:1 from bin/; a bundle file with no
                # bin/ source means something injected/rewrote the layout.
                mismatches.append(f"{rel}: no source at bin/{rel}")
                continue
            # filecmp.cmp(shallow=False) reads content; follows symlinks on both
            # sides (COLLECT copies symlink targets as real files).
            if not filecmp.cmp(src, dest, shallow=False):
                mismatches.append(f"{rel}: bytes differ from bin/{rel}")
            checked += 1
    if mismatches:
        _fail(check, f"{len(mismatches)} mismatch(es): " + "; ".join(mismatches[:8]))
    else:
        _ok(check, f"{checked} files byte-identical")


def _mlx_metal_dirs() -> list[str]:
    return sorted(glob.glob(os.path.join(_BUNDLE_OLLAMA, 'mlx_metal_v*')))


def check_layout_contract() -> None:
    """ollama binary is present+executable; every mlx_metal_v*/ has the full sibling set."""
    check = "layout contract"
    ollama_bin = os.path.join(_BUNDLE_OLLAMA, 'ollama')
    if not os.path.isfile(ollama_bin):
        _fail(check, f"missing {ollama_bin}")
    elif not os.access(ollama_bin, os.X_OK):
        _fail(check, f"{ollama_bin} is not executable")
    else:
        _ok("layout: ollama binary present + executable")

    metal_dirs = _mlx_metal_dirs()
    if not metal_dirs:
        _fail(check, f"no mlx_metal_v*/ dir under {_BUNDLE_OLLAMA}")
        return
    for d in metal_dirs:
        missing = [s for s in _MLX_SIBLINGS if not os.path.isfile(os.path.join(d, s))]
        rel = os.path.relpath(d, _INTERNAL)
        if missing:
            _fail(check, f"{rel} missing sibling(s): {', '.join(missing)}")
        else:
            _ok(f"layout: {rel} has full sibling set")


def check_rpath_contract() -> None:
    """Each mlx_metal_v*/libmlxc.dylib keeps @loader_path rpath + @rpath/libmlx.dylib dep."""
    check = "rpath contract"
    metal_dirs = _mlx_metal_dirs()
    if not metal_dirs:
        # Already reported by the layout check; nothing to inspect here.
        return
    for d in metal_dirs:
        libmlxc = os.path.join(d, 'libmlxc.dylib')
        rel = os.path.relpath(libmlxc, _INTERNAL)
        if not os.path.isfile(libmlxc):
            _fail(check, f"missing {rel}")
            continue
        load_cmds = _otool('-l', libmlxc)
        libs = _otool('-L', libmlxc)
        if load_cmds.startswith('__OTOOL_ERROR__') or libs.startswith('__OTOOL_ERROR__'):
            _fail(check, f"otool failed on {rel}: {load_cmds or libs}")
            continue
        # LC_RPATH load command with path @loader_path. otool -l prints the
        # rpath on a `path @loader_path (offset N)` line under an LC_RPATH cmd.
        # Anchored (not a plain substring): PyInstaller's Analysis rewrite
        # produces `@loader_path/..`-style paths, which a bare `'path
        # @loader_path' in load_cmds` substring check would also match.
        has_loader_rpath = bool(
            re.search(r'path @loader_path \(offset \d+\)', load_cmds)
        )
        has_rpath_dep = '@rpath/libmlx.dylib' in libs
        if not has_loader_rpath:
            _fail(check, f"{rel}: no LC_RPATH @loader_path (Analysis rewrote it?)")
        if not has_rpath_dep:
            _fail(check, f"{rel}: does not reference @rpath/libmlx.dylib")
        if has_loader_rpath and has_rpath_dep:
            _ok(f"rpath: {rel} keeps @loader_path + @rpath/libmlx.dylib")


def check_collision_canary() -> None:
    """_internal/libmlx.dylib must resolve into .../mlx/lib/, never into .../ollama/.

    This is the exact symptom of the collapse: the shared root-level
    libmlx.dylib should be the pip mlx build, symlinked into the mlx package
    dir - NOT Ollama's copy.
    """
    check = "collision canary (_internal/libmlx.dylib -> mlx/lib)"
    root_libmlx = os.path.join(_INTERNAL, 'libmlx.dylib')
    if not os.path.exists(root_libmlx):
        _fail(check, f"missing {root_libmlx}")
        return
    if not os.path.islink(root_libmlx):
        _fail(check, f"{root_libmlx} is not a symlink (expected a symlink into mlx/lib/)")
        return
    real = os.path.realpath(root_libmlx)
    # Compare path *components* relative to _internal/, not a substring match
    # on the absolute path - a checkout rooted under a directory that happens
    # to contain "mlx/lib" or "ollama" elsewhere in its path would otherwise
    # false-pass/false-fail.
    rel_parts = os.path.relpath(real, _INTERNAL).replace(os.sep, '/').split('/')
    if rel_parts[:2] != ['mlx', 'lib']:
        _fail(check, f"resolves to {os.path.relpath(real, _INTERNAL)} (expected inside mlx/lib/)")
    else:
        _ok(check, f"-> {os.path.relpath(real, _INTERNAL)}")


def check_dlopen_probes() -> None:
    """dlopen every mlx_metal_v*/libmlxc.dylib + the pip mlx/lib/libmlx.dylib.

    This is the operation that failed 100% of the time on real M1 hardware
    before the fix. dlopen only needs symbol resolution (no Metal GPU), so it
    runs on GPU-less arm64 macOS runners. arm64-gated: the shipped darwin build
    targets Apple Silicon.
    """
    check = "dlopen probes"
    if platform.machine() != 'arm64':
        _ok(check, f"SKIPPED (host arch {platform.machine()}, not arm64)")
        return
    targets: list[str] = []
    for d in _mlx_metal_dirs():
        libmlxc = os.path.join(d, 'libmlxc.dylib')
        if os.path.isfile(libmlxc):
            targets.append(libmlxc)
    pip_libmlx = os.path.join(_INTERNAL, 'mlx', 'lib', 'libmlx.dylib')
    if os.path.isfile(pip_libmlx):
        targets.append(pip_libmlx)
    else:
        _fail(check, f"missing {pip_libmlx}")
    if not targets:
        _fail(check, "no dylibs found to dlopen")
        return
    for path in targets:
        rel = os.path.relpath(path, _INTERNAL)
        try:
            ctypes.CDLL(path)
        except OSError as exc:
            _fail(check, f"dlopen {rel} failed: {exc}")
        else:
            _ok(f"dlopen: {rel}")


_VERSION_H = os.path.join(_INTERNAL, 'mlx', 'include', 'mlx', 'version.h')
_REQUIREMENTS = os.path.join(_REPO_ROOT, 'requirements.txt')
_PIN_RE = re.compile(r"^mlx==([0-9][^\s;]*)", re.MULTILINE)
_VERSION_RE = re.compile(
    r"#define\s+MLX_VERSION_MAJOR\s+(\d+).*?"
    r"#define\s+MLX_VERSION_MINOR\s+(\d+).*?"
    r"#define\s+MLX_VERSION_PATCH\s+(\d+)",
    re.DOTALL,
)


def check_pinned_version() -> None:
    """The bundled mlx must be exactly the version requirements.txt pins.

    This is a PROVENANCE check, not a behaviour one, and that distinction is the
    whole point. Whether mlx works is decided by whether it can load its Metal
    shader library, and no GitHub runner has a Metal device to find out: the
    macOS @pipeline job runs whisper, and the parakeet jobs are Windows/onnx.
    So the bundled mlx build is never actually exercised anywhere in CI.

    What CI *can* do is refuse to ship a version nobody verified. mlx is a
    transitive dep of parakeet-mlx with only a `>=0.22.1` floor, so before the
    pin an ordinary rebuild silently upgraded it — that is exactly how 0.32.x,
    which cannot find its metallib inside the bundle, reached a build and
    killed Parakeet (the default macOS engine) with no test going red.
    """
    if not os.path.exists(_REQUIREMENTS):
        _fail('pinned-version', f'requirements.txt not found at {_REQUIREMENTS}')
        return
    with open(_REQUIREMENTS, encoding='utf-8') as fh:
        pin_match = _PIN_RE.search(fh.read())
    if not pin_match:
        _fail(
            'pinned-version',
            'requirements.txt no longer pins mlx (expected a line like '
            "`mlx==X.Y.Z; sys_platform == 'darwin'`). Without the pin an "
            'ordinary rebuild can ship an unverified mlx.',
        )
        return
    pinned = pin_match.group(1)

    if not os.path.exists(_VERSION_H):
        _fail('pinned-version', f'bundled mlx version.h not found at {_VERSION_H}')
        return
    with open(_VERSION_H, encoding='utf-8') as fh:
        ver_match = _VERSION_RE.search(fh.read())
    if not ver_match:
        _fail('pinned-version', f'could not parse MLX_VERSION_* from {_VERSION_H}')
        return
    bundled = '.'.join(ver_match.groups())

    if bundled != pinned:
        _fail(
            'pinned-version',
            f'bundle ships mlx {bundled} but requirements.txt pins {pinned}. '
            'Parakeet is the default macOS engine and no CI job can load Metal '
            'to test it, so an unverified mlx must not ship. Rebuild against '
            'the pin, or move the pin deliberately after running '
            '`dist/stenoai/stenoai spike-parakeet` on real Apple Silicon.',
        )
        return
    _ok('pinned-version', f'bundled mlx {bundled} matches the requirements.txt pin')


def main() -> int:
    if sys.platform != 'darwin':
        print(f"verify_mlx_bundle: no-op on {sys.platform} (darwin-only check). PASS.")
        return 0

    if not os.path.isdir(_INTERNAL):
        print(
            f"verify_mlx_bundle: FAIL - bundle not found at {_INTERNAL}. "
            "Run `pyinstaller stenoai.spec --noconfirm` first.",
            file=sys.stderr,
        )
        return 1

    check_pinned_version()
    check_bit_identity()
    check_layout_contract()
    check_rpath_contract()
    check_collision_canary()
    check_dlopen_probes()

    print("verify_mlx_bundle: check results")
    for line in _passes:
        print(f"  PASS  {line}")
    for line in _failures:
        print(f"  FAIL  {line}", file=sys.stderr)

    if _failures:
        print(
            f"\nverify_mlx_bundle: FAIL - {len(_failures)} check(s) failed "
            "(libmlx ABI-collision / mlx provenance guard tripped).",
            file=sys.stderr,
        )
        return 1
    print(f"\nverify_mlx_bundle: PASS - all {len(_passes)} checks passed.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
