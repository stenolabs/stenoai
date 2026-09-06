#!/bin/bash
# Download Ollama and ffmpeg binaries for bundling with PyInstaller
# Supports macOS, Linux, and Windows

set -e

OLLAMA_VERSION="v0.31.1"
# Resolve both paths up front: the script cd's into $BIN_DIR further down, after
# which a relative path no longer resolves. BASH_SOURCE rather than $0 so this
# still points at the script when it is sourced instead of executed.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/bin"

# Assert an extracted artifact exists and is not implausibly small, then report it.
# `curl --fail` only rejects an HTTP error status: a transfer that dies mid-flight
# still exits 200 with a partial file, and `find ... -exec mv` exits 0 even when it
# matched nothing. Both leave a bad or missing binary that only surfaces much later
# in PyInstaller or at runtime. Size is the one post-condition that works on every
# platform -- the Windows binary cannot be executed on the runner that produced it.
assert_binary() {
    local path="$1" min_bytes="$2" size
    if [ ! -f "$path" ]; then
        echo "Expected $path after extract, but it is missing" >&2
        exit 1
    fi
    size=$(wc -c < "$path" | tr -d '[:space:]')
    if [ "$size" -lt "$min_bytes" ]; then
        echo "$path is only ${size} bytes (expected at least ${min_bytes}); download or extract was truncated" >&2
        exit 1
    fi
}

# Conservative floors: the real binaries are tens of MB, while an HTML error page
# or a truncated transfer is orders of magnitude below these.
MIN_FFMPEG_BYTES=5000000
MIN_OLLAMA_BYTES=1000000

# --- Download ffmpeg ---
echo "=== Downloading ffmpeg ==="
case "$(uname -s)" in
    Darwin)
        # ffmpeg must match the BUILD architecture, not just the OS. evermeet.cx
        # (the old URL) ships x86_64-only mac builds, so it bundled an Intel ffmpeg
        # into the arm64 release — which crashes on Apple Silicon without Rosetta
        # (#209). The mac build is Apple-Silicon only (arm64) since v0.4.0, so use
        # osxexperts' arm64 static build (same 7.1.1 as before) and refuse any
        # other arch rather than silently shipping a mismatch.
        if [ "$(uname -m)" != "arm64" ]; then
            echo "macOS build is arm64-only; unsupported arch: $(uname -m)" >&2
            exit 1
        fi
        FFMPEG_URL="https://www.osxexperts.net/ffmpeg711arm.zip"
        mkdir -p "$BIN_DIR"
        curl --fail --retry 3 --retry-delay 2 --retry-all-errors -L "$FFMPEG_URL" -o "$BIN_DIR/ffmpeg.zip"
        cd "$BIN_DIR"
        # Extract only the binary; skip the __MACOSX resource-fork junk in the zip.
        unzip -o ffmpeg.zip ffmpeg
        rm ffmpeg.zip
        chmod +x ffmpeg
        assert_binary ffmpeg "$MIN_FFMPEG_BYTES"
        # Validate the binary before bundling it. Two distinct failure modes:
        #  1. Wrong architecture. An x86_64 ffmpeg runs fine HERE under Rosetta and
        #     would sail through the -version check, then crash on a Rosetta-less
        #     user machine (#209). Assert the Mach-O is arm64 so the script
        #     self-enforces the arch rather than leaning only on the external CI
        #     `file ... arm64` guard.
        #  2. Truncated/corrupt download or wrong-format extract. Run -version and
        #     pin the major; pipefail (scoped to a subshell) makes a non-zero
        #     ffmpeg exit fail loudly instead of being masked by grep's exit.
        # set -e turns either non-zero exit into a loud build failure.
        if ! file ./ffmpeg | grep -q "arm64"; then
            echo "Downloaded ffmpeg is not an arm64 binary: $(file ./ffmpeg)" >&2
            exit 1
        fi
        if ! ( set -o pipefail; ./ffmpeg -version | grep -q "ffmpeg version 7.1" ); then
            echo "Downloaded ffmpeg failed -version or is not 7.1.x" >&2
            exit 1
        fi
        echo "ffmpeg 7.1.1 (arm64) downloaded"
        cd - > /dev/null
        ;;
    Linux)
        # Use static build for Linux
        FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
        mkdir -p "$BIN_DIR"
        # Some upstream/proxy failures return HTTP 200 with an error page,
        # which curl's HTTP retries cannot detect. Retry invalid archives too.
        archive_ready=false
        for attempt in 1 2 3; do
            if curl --fail --retry 3 --retry-delay 2 --retry-all-errors -L "$FFMPEG_URL" -o "$BIN_DIR/ffmpeg.tar.xz" \
                && tar -tJf "$BIN_DIR/ffmpeg.tar.xz" > "$BIN_DIR/ffmpeg-archive-contents.txt" 2>/dev/null \
                && archive_member=$(grep -m 1 -E '^[^/]+/ffmpeg$' "$BIN_DIR/ffmpeg-archive-contents.txt"); then
                archive_ready=true
                break
            fi
            echo "Linux ffmpeg download attempt $attempt/3 failed or returned an invalid archive" >&2
            if [ "$attempt" -lt 3 ]; then sleep 2; fi
        done
        rm -f "$BIN_DIR/ffmpeg-archive-contents.txt"
        if [ "$archive_ready" != true ]; then
            echo "Could not download a valid Linux ffmpeg archive after 3 attempts" >&2
            exit 1
        fi
        cd "$BIN_DIR"
        tar -xf ffmpeg.tar.xz --strip-components=1 "$archive_member"
        rm ffmpeg.tar.xz
        chmod +x ffmpeg
        assert_binary ffmpeg "$MIN_FFMPEG_BYTES"
        echo "ffmpeg downloaded"
        cd - > /dev/null
        ;;
    MINGW*|MSYS*|CYGWIN*)
        # Windows (running under Git Bash on windows-latest CI or MSYS). Use
        # BtbN's static GPL build — one self-contained ffmpeg.exe, no DLLs.
        FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
        mkdir -p "$BIN_DIR"
        curl --fail --retry 3 --retry-delay 2 --retry-all-errors -L "$FFMPEG_URL" -o "$BIN_DIR/ffmpeg.zip"
        cd "$BIN_DIR"
        # Zip nests under a versioned dir; pull just ffmpeg.exe into bin/.
        unzip -o ffmpeg.zip -d ffmpeg-extract > /dev/null
        find ffmpeg-extract -name 'ffmpeg.exe' -exec mv {} . \;
        rm -rf ffmpeg-extract ffmpeg.zip
        assert_binary ffmpeg.exe "$MIN_FFMPEG_BYTES"
        echo "ffmpeg.exe downloaded"
        cd - > /dev/null
        ;;
    *)
        echo "Note: ffmpeg not auto-downloaded for this platform. Please install manually."
        ;;
esac

# --- Download Ollama ---
echo ""
echo "=== Downloading Ollama ==="

# Detect platform
case "$(uname -s)" in
    Darwin)
        OLLAMA_FILE="ollama-darwin.tgz"
        ;;
    Linux)
        # Ollama dropped the .tgz asset; releases now ship .tar.zst (and a
        # separate -rocm variant we don't want).
        OLLAMA_FILE="ollama-linux-amd64.tar.zst"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        OLLAMA_FILE="ollama-windows-amd64.zip"
        ;;
    *)
        echo "Unsupported platform: $(uname -s)"
        exit 1
        ;;
esac

OLLAMA_URL="https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/${OLLAMA_FILE}"

echo "Platform: $(uname -s)"
echo "Downloading Ollama ${OLLAMA_VERSION} (${OLLAMA_FILE})..."

# Create bin directory
mkdir -p "$BIN_DIR"
cd "$BIN_DIR"

# Download
curl --fail --retry 3 --retry-delay 2 --retry-all-errors -L "$OLLAMA_URL" -o "$OLLAMA_FILE"

# Backup existing ollama binaries so the find below only
# matches the freshly extracted download. Same scope as the lookup below
# (-maxdepth 3, both names): any path the lookup can hit is backed up first.
# Using mv instead of delete preserves the last-known-good binary if the new
# download or extraction fails, allowing easy manual recovery.
find . -maxdepth 3 -type f \( -name ollama -o -name ollama.exe \) -exec mv {} {}.bak \;

# Extract based on file type
if [[ "$OLLAMA_FILE" == *.zip ]]; then
    unzip -o "$OLLAMA_FILE"
elif [[ "$OLLAMA_FILE" == *.zst ]]; then
    tar --zstd -xf "$OLLAMA_FILE"
else
    tar -xzf "$OLLAMA_FILE"
fi

rm "$OLLAMA_FILE"

# The new .tar.zst Linux release nests the binary under bin/ (with lib/ as a
# sibling of that bin/, not of the binary itself) — unlike every other archive
# here, which puts the binary and lib/ directly at the archive root as
# siblings. src.ollama_manager.get_bundled_ollama_dir() and stenoai.spec both
# assume that flat sibling layout (already relied on by the Windows zip), so
# flatten bin/* up one level to match it exactly.
if [ -d bin ] && [ -f bin/ollama ]; then
    mv bin/* .
    rmdir bin
fi

# The Ollama archives differ in layout between platforms (some nest the binary under
# bin/), so locate it rather than assuming a path, and fail if the extract produced
# nothing at all.  -print -quit stops at the first match (more efficient than piping
# through head, and deterministic because stale binaries were removed above).
OLLAMA_BIN="$(find . -maxdepth 3 -type f \( -name ollama -o -name ollama.exe \) -print -quit)"
if [ -z "$OLLAMA_BIN" ]; then
    echo "No ollama binary found under $BIN_DIR after extracting $OLLAMA_FILE" >&2
    exit 1
fi
assert_binary "$OLLAMA_BIN" "$MIN_OLLAMA_BYTES"

# Clean up any .bak files from the previous run now that the new binary is verified.
find . -maxdepth 3 -name '*.bak' -delete

echo "Ollama downloaded to $BIN_DIR"

# Ollama's darwin tarball is universal (x86_64 + arm64) and additionally carries
# the x86_64-only llama.cpp CPU runners for Intel Macs. The mac build is arm64-only
# since v0.4.0, so strip both out before bundling (#427) — ~90 MB. No-op on
# non-darwin hosts and on non-arm64 targets.
"$SCRIPT_DIR/thin-macos-bin.sh"

ls -la "$BIN_DIR"
