# Person Voice Sample Playback Design

**Date:** 2026-08-06

**Branch:** `feat/speaker-people-management`

## Goal

Let someone verify a stored person profile by playing one representative voice sample from the People settings tab.
Keep the feature small enough for the current branch while meeting the existing privacy, accessibility, cross-platform, and end-to-end testing standards.

## Scope

Each person row may show one `Play` button next to `Delete`.
The button is present only when the backend can still produce audio from at least one confirmed positive prototype.
Starting playback changes the control to `Stop`.
Starting a different person's sample stops the current one first.

This feature does not list or manage individual prototypes, expose their source meetings, enroll new samples, rename people, or retain extracted audio after playback.

## Backend contract

`list-person-profiles` adds a `sample_available` boolean to each profile DTO.
The boolean is true only when at least one positive prototype has all of the following:

- A meeting id, channel, and diarization speaker id.
- A source recording that still exists.
- A matching speaker sidecar and cluster.
- A diarization run compatible with the prototype.
- At least one extractable segment with positive duration.

A new read-only command, `get-person-sample-audio PERSON_ID`, resolves the profile again at click time and returns one WAV clip as base64.
Resolving again prevents a stale list response from authorizing playback after a recording or profile has disappeared.
The command returns a fixed structured failure when the person does not exist or no sample remains playable.

The backend ranks playable positive prototypes by stored quality score, then by recency, then by stable provenance fields for deterministic ties.
It uses the existing recording lookup, sidecar validation, cluster resolution, and sample extraction helpers.
Hard negatives are never candidates.

The renderer receives only `person_id`, the existing profile fields, `sample_available`, and the resulting audio payload.
Meeting ids, local paths, cluster ids, embeddings, and raw backend errors do not cross the IPC boundary.

## IPC and renderer behavior

Electron exposes a narrow `get-person-sample-audio` IPC handler and preload method.
The handler invokes the bundled CLI and sanitizes failures into the existing `Result` shape.

The People tab keeps one active audio element for the whole list.
Clicking `Play` fetches the clip on demand, creates a temporary object URL, starts playback, and changes that row's control to `Stop`.
Playback ending, pressing `Stop`, switching people, unmounting the tab, or an error pauses the element and revokes the object URL.

The control uses the visible labels `Play` and `Stop` with person-specific accessible names such as `Play voice sample for Person Alpha`.
While fetching, the clicked control shows a spinner and all sample controls are temporarily disabled so overlapping requests cannot create competing playback.
Delete remains visually separate and destructive.

Profiles with stored embeddings but no remaining source recording keep their existing sample-count description and show no playback control.
A playback failure leaves the row intact and shows the fixed inline message `Could not play this voice sample. Try again.`
No raw backend error is rendered.

## Privacy and safety

Playback is local and user-triggered.
No audio, transcript text, meeting title, file path, embedding, or error body is sent to telemetry or another service.
The temporary WAV payload exists only in renderer memory for the playback session and is released afterward.
The command is read-only and never alters profiles, sidecars, transcripts, recordings, or configuration.

## Cross-platform behavior

Recording lookup and audio extraction reuse the existing Python helpers that already handle macOS and Windows paths and bundled ffmpeg.
The new Electron handler does not construct user-data paths.
Test fixtures continue to set `STENOAI_USER_DATA_DIR` so no real user data is read or changed.

## Verification

Python tests cover candidate eligibility, deterministic ranking, stale diarization runs, missing recordings, missing sidecars, hard-negative exclusion, and successful extraction.
Renderer unit tests cover the playback state transitions and cleanup behavior where those can be isolated without mocking the feature itself.
A T1 Playwright test covers button visibility, Play to Stop transitions, switching people, playback completion, and sanitized failure copy through mock IPC.
A model-free T2 test creates a synthetic WAV file, sidecar, and confirmed profile through the isolated real backend and verifies that People playback returns a valid non-empty WAV payload.

Final verification reruns the affected Python suites, renderer typecheck and lint, unit tests, the full T1 suite, focused speaker T2 suites, the PyInstaller backend build, and unsigned Electron packaging.
