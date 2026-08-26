# PR 484 review follow-up plan

**Goal:** Make the speaker-diarization integration portable, fail-closed, concurrency-safe, and reviewable after the first GitHub review round.

**Scope:** Address every unresolved Cubic finding on PR 484, including the Linux T1 failure, without changing the product contract or adding dependencies.

## Task 1: Portable and meaningful tests

- Gate Darwin-only setup assertions on Darwin and make the renderer-only onboarding test assert the platform-specific UI it can actually render.
- Replace mirror assertions with literal Swift cache-layout expectations.
- Strengthen the retry and persistence tests at the real failure boundary.
- Exercise concurrent sample extraction concurrently instead of only checking two sequential temporary names.
- Remove the redundant backend-build guard after the authoritative sidecar build check.

## Task 2: Boundary validation

- Reuse the shared channel and embedding validators when parsing and persisting speaker data.
- Reject invalid stored self voiceprints without aborting a meeting.
- Reject non-regular model artifacts and control characters in IPC identifiers.
- Align frontend name folding with backend whitespace normalization.
- Make malformed retained evidence and failed voiceprint writes return structured failures.

## Task 3: Sidecar transactions

- Give fresh diarization writers and review mutations the same per-meeting lock.
- Reject structurally invalid documents before mutation.
- Keep the expected diarization run fixed through review-state cleanup.
- Hold the run lock across profile cleanup and sidecar mutation so a re-diarization cannot split the operation.
- Cover stale-run and overlapping-writer behavior with deterministic tests.

## Task 4: Renderer lifecycle

- Coordinate blob playback across hook instances so starting one sample stops the previous sample.
- Make a pending confirmation visibly non-dismissible and ensure externally controlled pending state cannot leave stale local busy state.
- Cover the shared playback and pending-dialog behavior with focused component tests.

## Task 5: Release verification

- Run focused tests after each red-green cycle.
- Run Python, Node, Vitest, Swift, typecheck, lint, T1, and model-free T2 on the consolidated result.
- Build the macOS sidecar, backend, and unsigned release candidate and smoke-test bundled executables.
- Ask Claude Opus for an independent full-diff review and address any release-blocking finding.
- Commit and push the review follow-up, then inspect every GitHub check and unresolved thread.
