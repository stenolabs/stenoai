#!/usr/bin/env bash
# Build the Darwin-only sandboxed SystemLanguageModel helper app.
#
# Usage: scripts/build-apple-lm-sidecar.sh [arch]
#   arch defaults to host arch (arm64 / x86_64).
#
# FoundationModels.framework ships with the macOS 26+ SDK. Build against the
# selected Xcode so local verification matches the release runner contract.
set -euo pipefail

ARCH="${1:-$(uname -m)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apple-lm-sidecar/main.swift"
INFO_PLIST="$ROOT/apple-lm-sidecar/Info.plist"
ENTITLEMENTS="$ROOT/apple-lm-sidecar/entitlements.plist"
OUT_APP="$ROOT/bin/Steno Apple LM.app"
OUT="$OUT_APP/Contents/MacOS/steno-apple-lm"
MODULE_CACHE="$ROOT/build/apple-lm-module-cache"

# Never leave a helper from an earlier build available for packaging after the
# current source, SDK, compile, signing, or verification step fails.
rm -rf "$OUT_APP"

if [[ ! -f "$SRC" ]]; then
    echo "missing helper source: $SRC" >&2
    exit 1
fi
if [[ ! -f "$INFO_PLIST" || ! -f "$ENTITLEMENTS" ]]; then
    echo "missing Apple LM helper bundle metadata" >&2
    exit 1
fi

SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"
SDK_MAJOR="${SDK_VERSION%%.*}"
if [[ ! "$SDK_MAJOR" =~ ^[0-9]+$ ]] || (( SDK_MAJOR < 26 )); then
    echo "Apple LM helper requires the macOS 26 SDK or newer; selected SDK is ${SDK_VERSION}" >&2
    exit 1
fi

mkdir -p "$ROOT/bin" "$MODULE_CACHE"

TMP_ROOT="$(mktemp -d "$ROOT/build/apple-lm-helper.XXXXXX")"
TMP_APP="$TMP_ROOT/Steno Apple LM.app"
TMP_OUT="$TMP_APP/Contents/MacOS/steno-apple-lm"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_APP/Contents/MacOS"
cp "$INFO_PLIST" "$TMP_APP/Contents/Info.plist"

xcrun --sdk macosx swiftc \
    -O \
    -parse-as-library \
    -module-cache-path "$MODULE_CACHE" \
    -target "${ARCH}-apple-macos26.0" \
    -framework AppKit \
    -framework FoundationModels \
    "$SRC" \
    -o "$TMP_OUT"

test -x "$TMP_OUT"
CODESIGN_IDENTITY="${APPLE_LM_CODESIGN_IDENTITY:-}"
if [[ -z "$CODESIGN_IDENTITY" ]]; then
    CODESIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk '/\"Apple Development:|\"Developer ID Application:/ {print $2; exit}')"
fi
if [[ -z "$CODESIGN_IDENTITY" ]]; then
    CODESIGN_IDENTITY="-"
    echo "Warning: no Apple signing identity found; the helper is buildable but its App Sandbox requires distribution re-signing before use." >&2
fi
codesign \
    --force \
    --sign "$CODESIGN_IDENTITY" \
    --options runtime \
    --entitlements "$ENTITLEMENTS" \
    "$TMP_APP"
codesign --verify --deep --strict --verbose=2 "$TMP_APP"

mv "$TMP_APP" "$OUT_APP"
trap - EXIT
rm -rf "$TMP_ROOT"
file "$OUT"
