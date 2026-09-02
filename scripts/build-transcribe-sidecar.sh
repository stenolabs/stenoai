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

# Require macOS 26 SDK: -target apple-macos26.0 fails on older SDKs with a
# cryptic swiftc error; report the real cause instead.
MACOS_MAJOR="$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)"
if [ -n "${MACOS_MAJOR:-}" ] && [ "$MACOS_MAJOR" -lt 26 ] 2>/dev/null; then
    echo "Error: steno-transcribe requires macOS 26 SDK (host is macOS $MACOS_MAJOR.x)" >&2
    echo "Skipping Apple transcription sidecar — build the remaining bundle on this host without it." >&2
    exit 1
fi

ARCH="${1:-$(uname -m)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/transcribe-sidecar/main.swift"
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
    "$SRC"

# Local builds use an ad-hoc signature. electron-builder re-signs the helper
# when it signs the containing app bundle.
codesign --sign - "$OUT" 2>/dev/null || true

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
