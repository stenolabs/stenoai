#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/steno-transcribe-contract.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
xcrun swiftc -parse-as-library -O \
    -o "$TEST_DIR/lexical-contract" \
    "$ROOT/transcribe-sidecar/Lexical.swift" \
    "$ROOT/transcribe-sidecar/LexicalContract.swift"
"$TEST_DIR/lexical-contract"
