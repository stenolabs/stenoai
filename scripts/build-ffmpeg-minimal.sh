#!/bin/bash
# Build a minimal, audio-only ffmpeg for the macOS bundle.
#
# The prebuilt static ffmpeg we used to download is a full build (~48 MB):
# every video codec, scaler and device. Steno only ever uses ffmpeg to decode
# the import/recording formats below, run a few audio filters (pan, highpass,
# loudnorm, volume, resampling) and write PCM to wav/raw/caf. Building just
# that from source gives a ~3 MB binary with no third-party download in the
# supply chain beyond ffmpeg.org's own release tarball.
#
# If you add an ffmpeg invocation that needs another demuxer, decoder, filter
# or muxer, add it here -- a missing component fails at runtime with
# "Unknown decoder/filter", and scripts/test-ffmpeg-minimal.sh checks the
# formats the app accepts.
#
# Usage: scripts/build-ffmpeg-minimal.sh [output-path]   (default: bin/ffmpeg)

set -euo pipefail

FFMPEG_VERSION="7.1.1"
FFMPEG_SHA256="733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT="${1:-$ROOT_DIR/bin/ffmpeg}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "build-ffmpeg-minimal.sh targets macOS arm64 only (got $(uname -s) $(uname -m))" >&2
    exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== Building minimal ffmpeg $FFMPEG_VERSION ==="
curl --fail --retry 3 --retry-delay 2 --retry-all-errors -L \
    "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$WORK/ffmpeg.tar.xz"
echo "$FFMPEG_SHA256  $WORK/ffmpeg.tar.xz" | shasum -a 256 -c -
tar -xJf "$WORK/ffmpeg.tar.xz" -C "$WORK"
cd "$WORK/ffmpeg-$FFMPEG_VERSION"

# Containers the app imports (app/main.js IMPORT_AUDIO_EXTENSIONS) plus the
# raw PCM formats the pipeline round-trips through.
DEMUXERS="wav,w64,aiff,caf,mp3,aac,mov,matroska,ogg,flac,pcm_s16le,pcm_f32le"
# Audio codecs those containers carry. aac_at/alac_at use macOS AudioToolbox.
DECODERS="pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_u8,pcm_alaw,pcm_mulaw,mp3,mp3float,aac,aac_at,alac,flac,opus,vorbis,adpcm_ima_qt"
PARSERS="aac,mpegaudio,opus,vorbis,flac"
ENCODERS="pcm_s16le,pcm_f32le"
MUXERS="wav,caf,pcm_s16le,pcm_f32le,null"
# Filters invoked explicitly, plus the ones ffmpeg inserts on its own to
# convert formats/rates between them.
FILTERS="pan,highpass,loudnorm,volume,aresample,aformat,anull,atrim,asetpts,abuffer,abuffersink"

./configure \
    --prefix="$WORK/out" \
    --disable-everything \
    --disable-autodetect \
    --enable-audiotoolbox \
    --disable-network \
    --disable-doc \
    --disable-debug \
    --disable-ffplay \
    --disable-ffprobe \
    --disable-avdevice \
    --disable-swscale \
    --disable-x86asm \
    --enable-small \
    --enable-static \
    --disable-shared \
    --enable-protocol=file,pipe \
    --enable-demuxer="$DEMUXERS" \
    --enable-decoder="$DECODERS" \
    --enable-parser="$PARSERS" \
    --enable-encoder="$ENCODERS" \
    --enable-muxer="$MUXERS" \
    --enable-filter="$FILTERS" \
    --extra-cflags="-mmacosx-version-min=13.0" \
    --extra-ldflags="-mmacosx-version-min=13.0" \
    >/dev/null

make -j"$(sysctl -n hw.ncpu)" ffmpeg >/dev/null
strip ffmpeg

mkdir -p "$(dirname "$OUTPUT")"
cp ffmpeg "$OUTPUT"
chmod +x "$OUTPUT"
echo "Built $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
