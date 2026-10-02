# Native transfer audio helper

These MIT-licensed sources are vendored unchanged from the public Swift repository
at the commit and SHA-256 digests in `upstream.json`. They have no model or third-party
runtime dependency. Build with `scripts/build-audio-helper.sh` on Apple Silicon.
The target is macOS 14.4; compile-time targeting does not prove older-OS runtime
acceptance. Update all sources and the manifest together from a reviewed upstream
commit; do not maintain a separate codec implementation here.

The v2 command borrows inherited input/output descriptors 3 and 4 and returns one
JSON object with codec, operation, sample rate, channels, valid frames, hashes and
output byte count. The parent owns temporary output cleanup, including after a
failed or timed-out child. Source files are never output destinations.
