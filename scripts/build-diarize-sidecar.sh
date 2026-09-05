#!/usr/bin/env bash
# Build the Swift diarize-sidecar helper.
#
# Usage: scripts/build-diarize-sidecar.sh [arch]
#   arch defaults to host arch (arm64 / x86_64).
#
# Requires Xcode Command Line Tools and an internet connection on first run
# (SPM fetches the FluidAudio dependency).
set -euo pipefail

ARCH="${1:-$(uname -m)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/diarize-sidecar"
OUT="$ROOT/bin/steno-diarize"

mkdir -p "$ROOT/bin"

cd "$PKG"

swift build \
    -c release \
    --arch "$ARCH"

BUILD_BIN="$PKG/.build/${ARCH}-apple-macosx/release/diarize-sidecar"
cp "$BUILD_BIN" "$OUT"
test -x "$OUT"

# Ad-hoc signature so the binary runs locally; CI re-signs with the Developer
# ID when packaging the .app bundle.
codesign --sign - "$OUT" 2>/dev/null || true

file "$OUT"
