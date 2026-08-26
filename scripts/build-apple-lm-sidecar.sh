#!/usr/bin/env bash
# Build the Darwin-only SystemLanguageModel helper.
#
# Usage: scripts/build-apple-lm-sidecar.sh [arch]
#   arch defaults to host arch (arm64 / x86_64).
#
# FoundationModels.framework ships with the macOS 26+ SDK. Prefer Xcode-beta
# when present so Variant inspection (macOS 27) is available.
set -euo pipefail

ARCH="${1:-$(uname -m)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apple-lm-sidecar/main.swift"
OUT="$ROOT/bin/steno-apple-lm"

if [[ ! -f "$SRC" ]]; then
    echo "missing sidecar source: $SRC" >&2
    exit 1
fi

if [[ -d /Applications/Xcode-beta.app ]]; then
    export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
fi

mkdir -p "$ROOT/bin"

TMP_OUT="${OUT}.tmp.$$"
trap 'rm -f "$TMP_OUT"' EXIT

xcrun swiftc \
    -O \
    -parse-as-library \
    -target "${ARCH}-apple-macos26.0" \
    -framework FoundationModels \
    "$SRC" \
    -o "$TMP_OUT"

test -x "$TMP_OUT"
codesign --sign - "$TMP_OUT" 2>/dev/null || true
mv -f "$TMP_OUT" "$OUT"
trap - EXIT
file "$OUT"
