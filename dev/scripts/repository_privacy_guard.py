#!/usr/bin/env python3
"""Reject known private fixtures and user-data artifacts before they ship."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import subprocess
import sys
from typing import Iterable, NamedTuple
import unicodedata


class Violation(NamedTuple):
    path: Path
    line: int
    rule: str


# SHA-256 fingerprints avoid storing the private values in plaintext. They are
# identifiers for known values, not encryption or protection against guessing.
# Candidates are normalized with normalize_candidate() before hashing.
KNOWN_PRIVATE_FINGERPRINTS = frozenset(
    {
        "f581c2b4a491aee6c5c33c25269ef97d2c95e966d009d1ebd0b9642fddaaddd6",
        "a2f8195ccb3f9ac75ca87e31f1cf4beb7e262e11104ff1172b1310cc40492e85",
        "f0a846cf3d6368a62379133cc59ee226b3bb67f4267e36cf095d755afee3c09b",
        "1865a50263d12cb136d9a7232d7d0eb51ec68f91fd9e4c711d3eaf948f772f22",
        "a3bc853dc02e537734bc949513db6b5d778b4a8b12a41755adaae38e01eb79e8",
        "4e853a5a42976d41debcb88c5fac405f90f5e9a952c21398bf0466e31b685b21",
        "a5bd4dc3c27e9db6adabfa8ae120a8ebc404c9e1b8e24a6c14725c8a8fe77565",
        "2dae4daafe11454b1914913740e7d8300d1e1efa5b496f7cc0f1d9c564f864a3",
        "62a5894934fec87caf6731e8bacb92b87b9fa179575cc88e63c3a5d231150848",
    }
)

# Single names may be legitimate public maintainer attribution. They are only
# forbidden in tests, fixtures, and internal implementation-plan artifacts.
KNOWN_PRIVATE_FIXTURE_FINGERPRINTS = frozenset(
    {
        "6700869c8ff7480e34a70a708b028700dbaa3a033b5652b903afe89f49a31456",
        "806c70034ebdfa7840d483758862e01ddcb16fa4507d427bea1964c6c5afe29a",
        "bfb301b26ca5590c4cd741bea37c36d5b4e5fb92dc4880e8c89448bf82b2b94c",
        "c6d17a3613b9914e68707fcfac8410f097643bc5840681bb533030d73cbb18f8",
        "ff38d2567b8123d1144a15ea77d969f1e742a8bdcd7f31c48a7cfdf4c4037663",
        "006bc948c3e7b00fdcc6eb4b29f4933ab83d239fcf101756f71056258583cd95",
        "85f5e10431f69bc2a14046a13aabaefc660103b6de7a84f75c4b96181d03f0b5",
        "443721509b79d08a341b7591ad6d7543807f4a581594895f9e2ff9089cdf72c9",
        "bf1b4854e41c18b05927d994e4cecabf7b60bd8bd7e9571f8e0662fb7cba6e7b",
        "946c9356890e2774b75416f4f2c70673cdd9c8d0f05374459bd60e9696fcd146",
    }
)

KNOWN_PRIVATE_PATH_FINGERPRINTS = frozenset(
    {"6700869c8ff7480e34a70a708b028700dbaa3a033b5652b903afe89f49a31456"}
)

_WORD_RE = re.compile(r"[^\W\d_]+(?:[-'’][^\W\d_]+)*", re.UNICODE)
_LOCAL_PATH_PATTERNS = (
    re.compile(r"/Users/([A-Za-z0-9._-]+)", re.IGNORECASE),
    re.compile(r"/home/([A-Za-z0-9._-]+)", re.IGNORECASE),
    # Match both a runtime path and the doubled backslashes used in source.
    re.compile(r"[A-Za-z]:\\+Users\\+([A-Za-z0-9._-]+)", re.IGNORECASE),
)
_MEDIA_SUFFIXES = frozenset(
    {".aac", ".flac", ".m4a", ".mov", ".mp3", ".mp4", ".ogg", ".opus", ".srt", ".vtt", ".wav", ".webm"}
)


def normalize_candidate(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(normalized.split())


def _fingerprint(value: str) -> str:
    return hashlib.sha256(normalize_candidate(value).encode("utf-8")).hexdigest()


def _candidate_phrases(line: str) -> Iterable[str]:
    words = [re.sub(r"['’]s$", "", word, flags=re.IGNORECASE) for word in _WORD_RE.findall(line)]
    variants = (
        words,
        [part for word in words for part in re.split(r"[-'’]+", word) if part],
        [
            part
            for word in words
            for part in re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])", word)
        ],
    )
    seen: set[str] = set()
    for tokens in variants:
        for width in range(1, min(3, len(tokens)) + 1):
            for start in range(0, len(tokens) - width + 1):
                candidate = " ".join(tokens[start : start + width])
                if candidate not in seen:
                    seen.add(candidate)
                    yield candidate


def _contains_blocked_user_path(
    line: str, blocked_path_fingerprints: set[str] | frozenset[str]
) -> bool:
    for pattern in _LOCAL_PATH_PATTERNS:
        for match in pattern.finditer(line):
            if _fingerprint(match.group(1)) in blocked_path_fingerprints:
                return True
    return False


def _is_fixture_context(path: Path) -> bool:
    lowered_parts = {part.casefold() for part in path.parts}
    name = path.name.casefold()
    return (
        bool(lowered_parts.intersection({"tests", "test", "__tests__", "e2e", "fixtures"}))
        or ".test." in name
        or ".spec." in name
        or name.startswith(("test_", "e2e-"))
        or "_test." in name
        or name == "conftest.py"
        or tuple(part.casefold() for part in path.parts[:2]) == ("docs", "superpowers")
    )


def scan_text(
    path: Path,
    text: str,
    *,
    blocked_fingerprints: set[str] | frozenset[str] = KNOWN_PRIVATE_FINGERPRINTS,
    fixture_only_fingerprints: set[str] | frozenset[str] = KNOWN_PRIVATE_FIXTURE_FINGERPRINTS,
    blocked_path_fingerprints: set[str] | frozenset[str] = KNOWN_PRIVATE_PATH_FINGERPRINTS,
) -> list[Violation]:
    violations: list[Violation] = []
    fingerprints = set(blocked_fingerprints)
    if _is_fixture_context(path):
        fingerprints.update(fixture_only_fingerprints)
    for line_number, line in enumerate(text.splitlines(), start=1):
        if _contains_blocked_user_path(line, blocked_path_fingerprints):
            violations.append(Violation(path, line_number, "local-user-path"))

        if any(_fingerprint(candidate) in fingerprints for candidate in _candidate_phrases(line)):
            violations.append(Violation(path, line_number, "blocked-value"))
    return violations


def scan_path(
    path: Path,
    *,
    blocked_fingerprints: set[str] | frozenset[str] = KNOWN_PRIVATE_FINGERPRINTS,
    fixture_only_fingerprints: set[str] | frozenset[str] = KNOWN_PRIVATE_FIXTURE_FINGERPRINTS,
) -> list[Violation]:
    violations: list[Violation] = []
    lowered_parts = {part.casefold() for part in path.parts}
    if lowered_parts.intersection({"recordings", "transcripts"}):
        violations.append(Violation(path, 0, "user-data-artifact"))
    if path.suffix.casefold() in _MEDIA_SUFFIXES:
        violations.append(Violation(path, 0, "media-artifact"))

    path_matches = scan_text(
        path,
        path.as_posix(),
        blocked_fingerprints=blocked_fingerprints,
        fixture_only_fingerprints=fixture_only_fingerprints,
        blocked_path_fingerprints=frozenset(),
    )
    if path_matches:
        violations.append(Violation(path, 0, "blocked-path-value"))
    return violations


def _tracked_paths(root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return [Path(value.decode("utf-8")) for value in result.stdout.split(b"\0") if value]


def scan_repository(root: Path) -> list[Violation]:
    violations: list[Violation] = []
    for relative_path in _tracked_paths(root):
        path_violations = scan_path(relative_path)
        violations.extend(path_violations)
        if any(item.rule in {"user-data-artifact", "media-artifact"} for item in path_violations):
            continue

        absolute_path = root / relative_path
        if absolute_path.is_symlink():
            content = str(absolute_path.readlink()).encode("utf-8")
        elif not absolute_path.is_file():
            continue
        else:
            content = absolute_path.read_bytes()
        if b"\0" in content:
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        violations.extend(scan_text(relative_path, text))
    return violations


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)

    root = args.root.resolve()
    violations = scan_repository(root)
    for violation in violations:
        location = f"{violation.path}:{violation.line}" if violation.line else str(violation.path)
        print(f"{location}: repository privacy check failed ({violation.rule})", file=sys.stderr)
    if violations:
        print(f"Privacy guard found {len(violations)} violation(s).", file=sys.stderr)
        return 1
    print("Repository privacy guard passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
