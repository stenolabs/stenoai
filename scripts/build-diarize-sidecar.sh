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

# Ask SPM for the real product directory instead of hardcoding the legacy
# .build/<triple>/release layout -- Swift 6.4's build system moved products
# (e.g. .build/out/Products/Release, with .build/release as a symlink), and
# a stale hardcoded path silently copied a months-old binary into bin/.
BIN_DIR="$(swift build -c release --arch "$ARCH" --show-bin-path)"
BUILD_BIN="$BIN_DIR/diarize-sidecar"
test -x "$BUILD_BIN"
cp "$BUILD_BIN" "$OUT"
# cp onto an existing file keeps the destination's mode, so check the copy
# too -- the release workflow ships $OUT, not the build product.
test -x "$OUT"

# Ad-hoc signature so the binary runs locally; CI re-signs with the Developer
# ID when packaging the .app bundle.
codesign --sign - "$OUT" 2>/dev/null || true

file "$OUT"
