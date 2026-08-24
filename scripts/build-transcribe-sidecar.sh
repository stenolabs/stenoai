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

file "$OUT"
