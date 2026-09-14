#!/usr/bin/env bash
# Build the pinned, dependency-free Apple Silicon transfer helper.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || {
  echo 'The native audio helper requires Apple Silicon macOS.' >&2; exit 1;
}
python3 - "$ROOT" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1]) / 'native-audio-helper'
manifest = json.loads((root / 'upstream.json').read_text())
assert set(p.name for p in (root / 'Sources').glob('*.swift')) == set(manifest['files'])
for name, entry in manifest['files'].items():
    assert hashlib.sha256((root / 'Sources' / name).read_bytes()).hexdigest() == entry['sha256'], name
PY
mkdir -p "$ROOT/bin" "$ROOT/build/native-audio-helper/module-cache"
xcrun swiftc -swift-version 6 -O -whole-module-optimization \
  -target arm64-apple-macosx14.4 -D STENO_STANDALONE_HELPER \
  -module-cache-path "$ROOT/build/native-audio-helper/module-cache" \
  "$ROOT"/native-audio-helper/Sources/*.swift -o "$ROOT/bin/steno-audio-encode"
codesign --verify --strict "$ROOT/bin/steno-audio-encode"
"$ROOT/bin/steno-audio-encode" --version
