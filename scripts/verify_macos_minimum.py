"""Build-time guard for the app's macOS floor and one OS-gated opt-in helper.

The DMG advertises `build.mac.minimumSystemVersion` from app/package.json
(14.4). pip, however, installs the newest wheel the *build host* accepts, so on
the macos-15 release runner it picked mlx's macosx_15_0 build. Its libmlx.dylib
then refused to load on macOS 14.x and Parakeet, the default engine, failed at
model load (#531). This script reads the minimum OS (LC_BUILD_VERSION minos, or
the older LC_VERSION_MIN_MACOSX) of every Mach-O file under the given paths and
fails if any is above the app's minimum. The optional, runtime-gated
``_internal/steno-transcribe`` helper alone may require macOS 26.

Run it after `pyinstaller stenoai.spec --noconfirm`:

    python scripts/verify_macos_minimum.py            # checks dist/stenoai
    python scripts/verify_macos_minimum.py PATH ...   # checks other trees

darwin-only; on any other platform it exits 0. Exit code 1 lists every
offending file.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_TARGET = os.path.join(_REPO_ROOT, 'dist', 'stenoai')
_PACKAGE_JSON = os.path.join(_REPO_ROOT, 'app', 'package.json')

# Thin (32/64-bit) and fat (32/64-bit offsets) Mach-O magics, both byte orders.
_MACHO_MAGICS = {
    b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe',
    b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe',
    b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca',
    b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca',
}


class InspectionError(Exception):
    """otool could not read a file that looks like Mach-O."""


def parse_version(text: str) -> tuple[int, ...]:
    """'14.4.0' -> (14, 4): trailing zeros are dropped so 14.4.0 equals 14.4."""
    parts = [int(p) for p in text.strip().split('.') if p != '']
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def app_minimum(package_json: str = _PACKAGE_JSON) -> tuple[int, ...]:
    with open(package_json, encoding='utf-8') as fh:
        data = json.load(fh)
    return parse_version(data['build']['mac']['minimumSystemVersion'])


def is_macho(path: str) -> bool:
    """Whether path starts with a Mach-O magic.

    Raises InspectionError if the file cannot be read: an unreadable binary must
    fail the guard, not be skipped as "not Mach-O".
    """
    try:
        with open(path, 'rb') as fh:
            return fh.read(4) in _MACHO_MAGICS
    except OSError as exc:
        raise InspectionError(f'cannot read: {exc}') from exc


def minimum_os_from_otool(output: str) -> tuple[int, ...] | None:
    """Highest minimum OS named in `otool -l` output, or None if absent.

    A fat binary lists one load-command block per slice; the highest one is
    what decides whether the file loads on an older system.
    """
    found: list[tuple[int, ...]] = []
    command = None
    for raw in output.splitlines():
        line = raw.strip()
        if line.startswith('cmd '):
            command = line.split(None, 1)[1]
        elif command == 'LC_BUILD_VERSION' and line.startswith('minos '):
            found.append(parse_version(line.split()[1]))
        elif command == 'LC_VERSION_MIN_MACOSX' and line.startswith('version '):
            found.append(parse_version(line.split()[1]))
    return max(found) if found else None


def minimum_os(path: str) -> tuple[int, ...] | None:
    """Minimum OS of a Mach-O file, None if it declares none.

    Raises InspectionError when otool fails: an unreadable binary must fail the
    guard, not pass it silently.
    """
    try:
        result = subprocess.run(
            ['otool', '-l', path], capture_output=True, text=True, check=False
        )
    except OSError as exc:
        raise InspectionError(f'otool could not run: {exc}') from exc
    if result.returncode != 0:
        raise InspectionError(result.stderr.strip() or f'otool exited {result.returncode}')
    # otool reports a truncated or malformed file on stdout and still exits 0,
    # so a readable Mach-O is recognised by its load commands.
    if 'Load command' not in result.stdout:
        lines = (result.stderr or result.stdout).strip().splitlines()
        raise InspectionError(lines[-1] if lines else 'no load commands')
    return minimum_os_from_otool(result.stdout)


def find_violations(roots, limit, read_minimum=minimum_os, errors=None,
                    allowed_newer=None):
    """(path, version) for every Mach-O under roots that needs more than limit.

    Symlinked files and directories are followed and each real file is checked
    once, so a Mach-O shipped behind a link is not skipped. Files that cannot be
    read or inspected are appended to `errors` as (path, message).
    """
    violations = []
    checked = 0
    seen_files: set[str] = set()
    seen_dirs: set[str] = set()

    def record_walk_error(exc: OSError) -> None:
        # os.walk skips an unreadable directory silently; its binaries would
        # then go unchecked, so the scan must count as failed.
        if errors is not None:
            errors.append((exc.filename or '?', f'cannot list directory: {exc.strerror or exc}'))

    for root in roots:
        for dirpath, dirs, files in os.walk(root, followlinks=True, onerror=record_walk_error):
            real_dir = os.path.realpath(dirpath)
            if real_dir in seen_dirs:
                dirs[:] = []  # symlink cycle or a tree already walked
                continue
            seen_dirs.add(real_dir)
            for name in files:
                path = os.path.join(dirpath, name)
                real = os.path.realpath(path)
                if real in seen_files or not os.path.isfile(real):
                    continue
                seen_files.add(real)
                try:
                    if not is_macho(real):
                        continue
                    checked += 1
                    version = read_minimum(real)
                except InspectionError as exc:
                    if errors is not None:
                        errors.append((path, str(exc)))
                    continue
                permitted = allowed_newer(path) if allowed_newer else limit
                if version is not None and version > permitted:
                    violations.append((path, version))
    return checked, violations


def _fmt(version: tuple[int, ...]) -> str:
    return '.'.join(str(p) for p in version)


def _allowed_minimum(path: str, roots, app_floor: tuple[int, ...]) -> tuple[int, ...]:
    """Only the macOS 26 opt-in helper may exceed the 14.4 app floor.

    The Python bridge checks the host OS before every sidecar spawn. Keep this
    exception tied to its exact bundled path; every other Mach-O still has to
    load on the oldest supported Mac.
    """
    for root in roots:
        if os.path.relpath(path, root) == os.path.join('_internal', 'steno-transcribe'):
            return (26,)
    return app_floor


def main(argv: list[str]) -> int:
    if sys.platform != 'darwin':
        print('verify_macos_minimum: not macOS, nothing to check')
        return 0
    roots = argv or [_DEFAULT_TARGET]
    missing = [r for r in roots if not os.path.isdir(r)]
    if missing:
        print(f"verify_macos_minimum: not a directory: {', '.join(missing)}", file=sys.stderr)
        return 1
    limit = app_minimum()
    errors: list[tuple[str, str]] = []
    checked, violations = find_violations(
        roots, limit, errors=errors,
        allowed_newer=lambda path: _allowed_minimum(path, roots, limit),
    )
    if checked == 0:
        print('verify_macos_minimum: no Mach-O files found', file=sys.stderr)
        return 1
    if errors:
        print(f'verify_macos_minimum: could not inspect {len(errors)} Mach-O files:', file=sys.stderr)
        for path, message in sorted(errors):
            print(f'  {path}: {message}', file=sys.stderr)
    if violations:
        print(
            f"verify_macos_minimum: {len(violations)} of {checked} Mach-O files "
            f"require a newer macOS than the app's minimum {_fmt(limit)}:",
            file=sys.stderr,
        )
        for path, version in sorted(violations):
            root = next(r for r in roots if os.path.abspath(path).startswith(os.path.abspath(r)))
            print(f"  {_fmt(version)}  {os.path.relpath(path, root)}", file=sys.stderr)
        return 1
    if errors:
        return 1
    print(f"verify_macos_minimum: {checked} Mach-O files, app floor {_fmt(limit)}; "
          "only steno-transcribe may require macOS 26")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
