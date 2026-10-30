#!/usr/bin/env bash
# Build the macOS SpeechTranscriber helper used for Apple on-device ASR.
#
# Usage: scripts/build-transcribe-sidecar.sh [arch]
#   arch defaults to the host architecture (arm64 / x86_64).
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
    echo "steno-transcribe is macOS-only" >&2
    exit 1
fi

# The binary itself targets macOS 26; the enclosing app still supports 14.4.
MACOS_MAJOR="$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)"
if [ -n "${MACOS_MAJOR:-}" ] && [ "$MACOS_MAJOR" -lt 26 ] 2>/dev/null; then
    echo "Error: steno-transcribe requires a macOS 26+ build host (host is macOS $MACOS_MAJOR.x)" >&2
    exit 1
fi
SDK_MAJOR="$(xcrun --sdk macosx --show-sdk-version 2>/dev/null | cut -d. -f1 || true)"
if [ -z "$SDK_MAJOR" ] || [ "$SDK_MAJOR" -lt 26 ] 2>/dev/null; then
    echo "Error: steno-transcribe requires the macOS 26+ SDK" >&2
    exit 1
fi

ARCH="${1:-$(uname -m)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/transcribe-sidecar/main.swift"
LEXICAL_SRC="$ROOT/transcribe-sidecar/Lexical.swift"
OUT="$ROOT/bin/steno-transcribe"

mkdir -p "$ROOT/bin"

xcrun swiftc \
    -parse-as-library \
    -O \
    -target "${ARCH}-apple-macos26.0" \
    -framework Speech \
    -framework AVFAudio \
    -framework CoreMedia \
    -o "$OUT" \
    "$SRC" "$LEXICAL_SRC"

# Local builds use an ad-hoc signature. electron-builder re-signs the helper
# when it signs the containing app bundle.
if ! codesign --sign - "$OUT"; then
    echo "Error: failed to ad-hoc sign steno-transcribe at $OUT" >&2
    exit 1
fi

if [ ! -x "$OUT" ]; then
    echo "Error: Apple transcription sidecar was not built at $OUT" >&2
    exit 1
fi
# Architecture assertion — mirrors build-diarize-sidecar.sh's `test -x` + file check
if ! file "$OUT" | grep -q "$ARCH"; then
    echo "Error: steno-transcribe architecture mismatch (expected $ARCH): $(file "$OUT")" >&2
    exit 1
fi

file "$OUT"
