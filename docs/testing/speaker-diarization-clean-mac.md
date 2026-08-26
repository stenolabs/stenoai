# Speaker diarization clean-cache verification

Date: 2026-08-10

This release check used an empty, isolated `STENOAI_USER_DATA_DIR` under `/private/tmp`.
It did not read, move, or delete the existing user or FluidAudio caches.
The audio sample was generated locally with macOS `say` and contained no real meeting or person data.

## Result

- The initial `model-status` call returned exit code 3, reported all four required model artifacts as missing, and did not create the model directory.
- The explicit `prepare-models` call downloaded and compiled all required artifacts into the isolated Steno model cache.
- The prepared cache used approximately 498 MB.
- A second `model-status` call reported the cache as ready.
- The release sidecar processed the synthetic sample while `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` pointed to a closed local port.
- The offline run returned one 15.92-second `SPEAKER_0` segment with a local voiceprint and exit code 0.
- The exact isolated cache directory and synthetic sample were removed after verification.

## Acceptance

The normal diarization command used only the explicitly prepared app-owned cache.
It did not require network access and did not fall back to a hidden FluidAudio cache.
