# Speaker Main Hardening Design

## Goal

Make the speaker-diarization code currently on `main` safe to release on macOS without weakening Windows behavior, local-processing guarantees, or existing fallback behavior.

## Scope

This hardening covers every actionable Cubic thread from PRs 482 and 483 plus the independently reproduced review findings.
It includes correctness, persistence, privacy, IPC validation, audio lifecycle, model readiness, CI fidelity, test isolation, documentation consistency, and bounded structural extraction required to make those changes reviewable.
It does not add a new diarization engine, automatic naming, cloud processing, or a broad storage rewrite before release.

## Considered Approaches

### 1. Targeted hardening on the current architecture

Fix each defect in place, add locks and validation, improve tests, and defer all module boundaries.
This is the smallest diff, but it leaves speaker workflows spread across very large files and makes the transaction fixes difficult to review.

### 2. Targeted hardening with bounded extraction

Fix release defects while extracting only stable boundaries needed by the fixes: speaker IPC validation and registration, schema validation, sidecar mutation coordination, audio playback lifecycle, and speaker command orchestration helpers.
Keep `config.json` for this release, but make speaker-profile mutations transactional and prevent unlocked stale writes.
This is the selected approach because it reduces immediate risk without turning the release into a storage migration.

### 3. Full speaker subsystem rewrite

Move profiles to SQLite, replace transcript text as the source of truth, introduce a long-running backend service, and batch both channels through a persistent sidecar.
This is the cleanest long-term destination but too broad for a release-hardening change and would invalidate much of the existing test evidence.

## Architecture

Electron main validates every speaker IPC payload before invoking Python.
Python validates the same identifiers again before resolving filesystem paths.
Speaker suggestions return the current diarization run identifier, and every read or mutation that depends on a displayed cluster supplies it as an expected value.

Sidecar mutations acquire one cross-process lock, reload the document while holding it, compare the expected run identifier, apply one mutation, and atomically replace the file.
Profile changes stay in `config.json` for this release, but speaker operations hold the config lock across reload, mutation, and commit, and they never fall back to an unlocked write.
Cross-file actions are idempotent: a retry derives the desired transcript and participants state from current durable inputs instead of from what happened to be deleted during that attempt.

The Swift sidecar gains an explicit model-readiness contract.
Setup and diagnostics can check or prepare the model before meeting processing.
Normal processing does not silently initiate an undisclosed model download.
The release remains strict about bundling the executable, while a separately named development mode may opt out.

## Data and Privacy Rules

- Cross-meeting identity matching remains off by default and fails closed.
- Named profiles require the existing local Settings opt-in.
- Speaker names, meeting identifiers, paths, and audio-derived content never enter shareable diagnostics.
- Meeting stems resolve to a single basename within Steno-managed directories.
- Embeddings must contain exactly 256 finite numeric values with a non-zero norm.
- Stored booleans are accepted only when their JSON type is boolean.
- Display names are normalized consistently in Python and TypeScript and cannot corrupt transcript serialization.

## Runtime and Performance

Audio samples are capped to the documented duration before ffmpeg runs.
Temporary files use unique names and are cleaned on success, failure, cancellation, and stale-startup recovery.
The parent process terminates the whole sidecar process group on timeout.

Speaker queries do not start for meetings without speaker data.
Profile sample resolution caches sidecars and recording lookups within one command.
Suggestion scoring computes each candidate ranking once.
Prototype and hard-negative retention is bounded per person, recording context, and source meeting without deleting the only evidence for a confirmed meeting.

A future performance PR may batch mic and system channels in one Swift process and migrate profiles to SQLite.
Those migrations require independent benchmarks and are not prerequisites for this release if the current implementation meets the clean-machine acceptance tests.

## UI Behavior

Windows does not offer a speaker-identification control when acoustic diarization is unavailable.
The review panel uses one shared audio-playback hook with cancellation, URL cleanup, and visible errors.
Mutations that fail, including Keep generic and reopen, surface accessible feedback.
Dialogs cannot close while destructive work is pending.
The multi-speaker count compares like-for-like per-channel counts.

## Testing

Every behavior change starts with a failing unit, integration, T1, or T2 test.
Mocks use the complete production response shape including `diarization_run_id`, prototypes, and sample availability.
Tests that invoke the real backend isolate `STENOAI_USER_DATA_DIR`.
Test entry points live at file end, fixtures clean their temporary files, and assertions distinguish handled failures from crashes.

CI restores and asserts the executable bit for `steno-diarize`.
A cheap smoke starts the real bundled executable without replacing it with a fixture.
The model-bearing clean-cache smoke remains macOS-only and explicitly verifies both online preparation and offline reuse.

## Clean-Mac Acceptance

The release candidate is launched with an empty, isolated `STENOAI_USER_DATA_DIR` under `/private/tmp`, so neither Steno nor FluidAudio can see a pre-existing model cache.
The status probe must report every required model missing without creating the model directory.
Model preparation must be visible, complete successfully, and leave the app able to diarize while the network is unavailable afterward.
The test records cache paths, download size, timing, sidecar exit status, transcript output, and fallback behavior.
The isolated model cache and synthetic audio are removed after the test, leaving the user's existing model caches untouched.

## Release Gate

Release requires focused regressions, all Python and desktop unit suites, renderer typecheck and lint, macOS and Windows build validation, T1/T2 coverage, bundled-backend smoke, packaged macOS launch, and the clean-cache model test.
Failures are classified as change-related, pre-existing, environment-related, or flaky before any completion claim.
