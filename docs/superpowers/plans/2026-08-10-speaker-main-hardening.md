# Speaker Main Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the speaker-diarization code on `main` safe to ship on macOS while preserving Windows fallback behavior and local-processing guarantees.

**Architecture:** Keep the current CLI and JSON storage for this release, but introduce explicit contracts at the Electron/Python boundary, compare-and-swap semantics for diarization runs, locked speaker mutations, and an explicit model-readiness lifecycle. Extract only the helpers needed to make these invariants independently testable.

**Tech Stack:** Python 3, Click, filelock, Electron, Node.js, React, TypeScript, TanStack Query, Swift, FluidAudio, Core ML, PyInstaller, Playwright, GitHub Actions.

## Global Constraints

- Do not add a dependency or perform a major-version upgrade.
- Never send meeting content, names, paths, model output, raw errors, or embeddings to telemetry or diagnostics.
- Cross-meeting identity matching stays off by default and fails closed.
- macOS-specific behavior is gated; Windows retains channel-only fallback behavior.
- Every changed behavior starts with a failing regression test.
- Every real-backend test sets `STENOAI_USER_DATA_DIR` or patches the config path to a temporary directory.
- Do not make the diarization sidecar optional in the normal macOS release build.
- Do not migrate profile storage to SQLite in this release-hardening plan.
- Do not manually modify generated changelog files.

---

### Task 1: Versioned Speaker Contracts and Diagnostic Redaction

**Files:**
- Create: `app/speaker-ipc.js`
- Create: `app/speaker-ipc.test.js`
- Create: `src/speaker_schema.py`
- Create: `tests/test_speaker_schema.py`
- Modify: `app/main.js`
- Modify: `app/diagnostics-filter.js`
- Modify: `app/diagnostics-forward.test.js`
- Modify: `app/preload.js`
- Modify: `app/renderer/src/lib/ipc.ts`
- Modify: `src/speaker_suggestions.py`

**Interfaces:**
- Produces `validateMeetingStem(value): string`, which accepts one non-empty basename and rejects separators, `.` and `..`.
- Produces `parseSpeakerMutation(value): SpeakerMutation`, which validates channel, speaker ID, optional person ID, optional name, booleans, and `expectedRunId`.
- Produces Python `validate_meeting_stem(value: str) -> str` and `validate_embedding(value) -> list[float]`.
- Produces a versioned suggestion response containing `schema_version` and `diarization_run_id`.

- [ ] **Step 1: Write failing Node tests for traversal, type confusion, allowed channels, and command redaction.**

```javascript
test('validateMeetingStem rejects traversal and separators', () => {
  for (const value of ['../meeting', 'folder/meeting', 'folder\\meeting', '.', '..']) {
    assert.throws(() => validateMeetingStem(value));
  }
  assert.strictEqual(validateMeetingStem('2026-08-10_team-call'), '2026-08-10_team-call');
});

test('speaker commands never echo names or meeting identifiers', () => {
  assert.strictEqual(
    sanitizeArgsForLog(['confirm-speaker', 'private-meeting', 'mic', 'SPEAKER_0', '--new-person', 'Alice']),
    'confirm-speaker <redacted>',
  );
});
```

- [ ] **Step 2: Run the Node tests and confirm traversal is accepted and speaker arguments are echoed.**

Run: `cd app && node --test speaker-ipc.test.js diagnostics-forward.test.js`

Expected: failures naming the accepted traversal input and unredacted command.

- [ ] **Step 3: Write failing Python tests for safe path resolution and exact embedding validation.**

```python
def test_validate_embedding_requires_256_finite_nonzero_values():
    with self.assertRaises(ValueError):
        validate_embedding([1.0])
    with self.assertRaises(ValueError):
        validate_embedding([float("nan")] * 256)
    with self.assertRaises(ValueError):
        validate_embedding([0.0] * 256)
    self.assertEqual(len(validate_embedding([1.0] + [0.0] * 255)), 256)
```

- [ ] **Step 4: Run the Python test and confirm the schema module is absent.**

Run: `source venv/bin/activate && python -m unittest tests.test_speaker_schema -v`

Expected: import failure for `src.speaker_schema`.

- [ ] **Step 5: Implement the contract helpers and register speaker handlers through `registerSpeakerIpc`.**

```javascript
function validateMeetingStem(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..') throw new TypeError('Invalid meeting');
  if (path.basename(value) !== value || value.includes('/') || value.includes('\\')) throw new TypeError('Invalid meeting');
  return value;
}
```

```python
EMBEDDING_DIMENSION = 256

def validate_embedding(value):
    if not isinstance(value, list) or len(value) != EMBEDDING_DIMENSION:
        raise ValueError("speaker embedding must contain 256 values")
    embedding = [float(item) for item in value]
    if not all(math.isfinite(item) for item in embedding) or not any(item != 0 for item in embedding):
        raise ValueError("speaker embedding must be finite and non-zero")
    return embedding
```

- [ ] **Step 6: Route every speaker IPC handler through the validator and redact every speaker command.**

```javascript
const ARGS_ECHO_REDACTORS = {
  ...existingRedactors,
  'confirm-speaker': redactRest,
  'create-person-profile': redactRest,
  'rename-person-profile': redactRest,
  'delete-person-profile': redactRest,
  'get-speaker-sample-audio': redactRest,
  'mark-speaker-cluster': redactRest,
  'set-cluster-review-state': redactRest,
  'speaker-naming-status': redactRest,
};
```

- [ ] **Step 7: Run focused Node and Python tests and commit.**

Run: `cd app && node --test speaker-ipc.test.js diagnostics-forward.test.js`

Run: `source venv/bin/activate && python -m unittest tests.test_speaker_schema -v`

Commit: `fix(speakers): validate IPC contracts and redact diagnostics`

### Task 2: Run-Scoped and Locked Sidecar Mutations

**Files:**
- Create: `src/speaker_sidecar_store.py`
- Create: `tests/test_speaker_sidecar_store.py`
- Modify: `src/speaker_suggestions.py`
- Modify: `simple_recorder.py`
- Modify: `app/renderer/src/lib/ipc.ts`
- Modify: `app/renderer/src/hooks/useSpeakerSuggestions.ts`
- Modify: `app/renderer/src/components/SpeakerReviewPanel.tsx`
- Modify: `tests/test_speaker_multi_marking.py`
- Modify: `tests/test_confirm_speaker_cli.py`

**Interfaces:**
- Produces `SpeakerSidecarStore.mutate(meeting_stem, expected_run_id, mutation) -> dict`.
- Raises `StaleDiarizationRun` when the durable run differs from the UI run.
- All cluster-dependent renderer mutations supply `expectedRunId`.

- [ ] **Step 1: Write failing tests for concurrent mutations and stale run rejection.**

```python
def test_mutation_rejects_a_stale_diarization_run(self):
    with self.assertRaises(StaleDiarizationRun):
        self.store.mutate("meeting", "old-run", lambda document: document)

def test_two_locked_mutations_preserve_both_cluster_updates(self):
    run_mutations_concurrently(self.store, first_mark, second_mark)
    document = self.store.read("meeting")
    self.assertTrue(document["channels"]["mic"]["clusters"]["SPEAKER_0"]["contains_multiple_speakers"])
    self.assertEqual(document["channels"]["mic"]["clusters"]["SPEAKER_1"]["review_state"], "generic")
```

- [ ] **Step 2: Run the new store tests and confirm the API is absent.**

Run: `source venv/bin/activate && python -m unittest tests.test_speaker_sidecar_store -v`

Expected: import failure for `SpeakerSidecarStore`.

- [ ] **Step 3: Implement a cross-platform file lock around fresh read, run comparison, mutation, and atomic replace.**

```python
def mutate(self, meeting_stem, expected_run_id, mutation):
    with filelock.FileLock(str(self.path(meeting_stem)) + ".lock", timeout=10):
        document = self.read(meeting_stem)
        actual = ((document or {}).get("diarization_run") or {}).get("run_id")
        if actual != expected_run_id:
            raise StaleDiarizationRun(expected_run_id, actual)
        mutation(document)
        write_sidecar_document(self.output_dir, meeting_stem, document)
        return document
```

- [ ] **Step 4: Return `diarization_run_id` from suggestions and require it for confirm, sample, mark, keep, and reopen.**

```typescript
export interface SpeakerSuggestionsResponse {
  schema_version: 1;
  diarization_run_id: string;
  channels: Record<string, Record<string, SpeakerSuggestion>>;
}
```

- [ ] **Step 5: Add a T1 test that changes the run between render and click and expects a visible stale-view error.**

```typescript
await page.getByRole('button', { name: 'Confirm' }).click();
await expect(page.getByRole('alert')).toContainText('This speaker analysis changed. Reload the meeting.');
```

- [ ] **Step 6: Run focused Python, Vitest, and T1 tests and commit.**

Run: `source venv/bin/activate && python -m unittest tests.test_speaker_sidecar_store tests.test_speaker_multi_marking tests.test_confirm_speaker_cli -v`

Run: `cd app && npx vitest run renderer/src/hooks/useSpeakerSuggestions.test.ts`

Run: `cd app && npm run test:e2e -- --project=t1 --grep "stale speaker analysis"`

Commit: `fix(speakers): scope mutations to locked diarization runs`

### Task 3: Transactional and Validated Profile Persistence

**Files:**
- Create: `src/speaker_profile_store.py`
- Create: `tests/test_speaker_profile_store.py`
- Modify: `src/config.py`
- Modify: `src/voiceprint.py`
- Modify: `simple_recorder.py`
- Modify: `tests/test_config.py`
- Modify: `tests/test_person_profile_cli.py`
- Modify: `tests/test_speaker_suggestions.py`

**Interfaces:**
- Produces `SpeakerProfileStore.transaction(callback) -> T` with reload-under-lock and rollback on failure.
- Produces normalized `PersonProfile` records and rejects malformed evidence independently.
- Keeps the current JSON format so existing profiles remain readable.

- [ ] **Step 1: Write failing tests for false success, non-boolean opt-in, malformed profiles, and concurrent list changes.**

```python
def test_save_voiceprint_reports_write_failure(self):
    with patch.object(self.config, "_save", return_value=False):
        self.assertIsNone(self.config.save_voiceprint("Alice", [1.0] * 256))

def test_string_false_does_not_enable_identity_matching(self):
    self.config._config["identity_matching_enabled"] = "false"
    self.assertFalse(self.config.get_identity_matching_enabled())
```

- [ ] **Step 2: Run focused config tests and verify the expected failures.**

Run: `source venv/bin/activate && python -m unittest tests.test_config tests.test_person_profile_cli -v`

- [ ] **Step 3: Implement strict getters and propagate every save failure.**

```python
def get_identity_matching_enabled(self) -> bool:
    return self._config.get("identity_matching_enabled") is True

def save_voiceprint(...):
    before = copy.deepcopy(self._config)
    if not self._save():
        self._config = before
        return None
    return record
```

- [ ] **Step 4: Make speaker mutations reload and commit under one lock without unlocked timeout fallback.**

```python
with profile_store.transaction() as profiles:
    apply_profile_change(profiles)
```

- [ ] **Step 5: Make delete profile and enrollment one transaction each and bound retained evidence by context and meeting.**

```python
MAX_PROTOTYPES_PER_CONTEXT = 24
MAX_HARD_NEGATIVES_PER_CONTEXT = 48
```

Retention must preserve the highest-quality evidence and at least one positive prototype per distinct confirmed meeting until the cap forces deterministic eviction of the oldest lowest-quality meeting.

- [ ] **Step 6: Reject unequal embedding dimensions in distance math and skip invalid stored entries without crashing suggestions.**

```python
def cosine_similarity(a, b):
    if len(a) != len(b) or len(a) != EMBEDDING_DIMENSION:
        raise ValueError("speaker embeddings must have equal 256-value dimensions")
```

- [ ] **Step 7: Run focused tests and commit.**

Run: `source venv/bin/activate && python -m unittest tests.test_speaker_profile_store tests.test_config tests.test_person_profile_cli tests.test_speaker_suggestions -v`

Commit: `fix(speakers): make profile persistence transactional`

### Task 4: Idempotent Cross-Artifact Workflows and Reprocess Correctness

**Files:**
- Create: `src/speaker_identity_service.py`
- Create: `tests/test_speaker_identity_service.py`
- Modify: `simple_recorder.py`
- Modify: `src/speaker_suggestions.py`
- Modify: `tests/test_full_reprocess_cli.py`
- Modify: `tests/test_speaker_multi_marking.py`
- Modify: `tests/test_confirm_speaker_cli.py`

**Interfaces:**
- Produces `SpeakerIdentityService.confirm`, `mark_multiple`, `keep_generic`, and `delete_person` use cases.
- Each use case returns a typed result only after all durable outputs agree.
- Retrying `mark_multiple` repairs transcript and participants even when profile evidence was removed by the first attempt.

- [ ] **Step 1: Write a failing real-signature test for full reprocess.**

```python
def test_full_reprocess_passes_all_process_streaming_arguments(self):
    with patch.object(process_streaming, "callback", autospec=True) as callback:
        invoke_full_reprocess()
    callback.assert_called_once_with(ANY, ANY, ANY, None, None)
```

- [ ] **Step 2: Write a failing retry test that injects one sidecar write failure.**

```python
def test_retry_after_sidecar_failure_repairs_transcript_and_participants(self):
    first = self.invoke_mark_with_one_failed_sidecar_write()
    self.assertFalse(first["success"])
    second = self.invoke_mark()
    self.assertTrue(second["success"])
    self.assert_generic_transcript_and_participants()
```

- [ ] **Step 3: Run both tests and confirm the wrong callback arity and stale transcript.**

Run: `source venv/bin/activate && python -m unittest tests.test_full_reprocess_cli tests.test_speaker_multi_marking -v`

- [ ] **Step 4: Fix the callback arity and route CLI commands through the identity service.**

```python
process_streaming.callback(str(audio_path), session_name, notes_file, None, None)
```

- [ ] **Step 5: Derive transcript restore and participant rebuild from current sidecar state on every retry.**

```python
result = service.mark_multiple(command)
if not result.success:
    raise SpeakerOperationError(result.error)
```

- [ ] **Step 6: Run focused tests and commit.**

Run: `source venv/bin/activate && python -m unittest tests.test_speaker_identity_service tests.test_full_reprocess_cli tests.test_speaker_multi_marking tests.test_confirm_speaker_cli -v`

Commit: `fix(speakers): make identity workflows retry safe`

### Task 5: Transcription, Process, and Sample-Audio Safety

**Files:**
- Modify: `src/_parakeet_onnx.py`
- Modify: `src/transcriber.py`
- Modify: `src/speaker_suggestions.py`
- Modify: `simple_recorder.py`
- Modify: `tests/test_parakeet_onnx.py`
- Modify: `tests/test_transcriber_diarisation.py`
- Modify: `tests/test_speaker_suggestions.py`
- Modify: `tests/test_person_sample_cli.py`

**Interfaces:**
- Window coverage counts only validated token/timestamp windows.
- `_run_steno_diarize` owns a process group and terminates the full group on timeout.
- Every sample clip is unique, at most `SAMPLE_MAX_SECONDS` plus documented padding, and removed in `finally`.

- [ ] **Step 1: Write failing coverage, process-tree, sample-duration, and temp-collision tests.**

```python
def test_malformed_window_is_not_counted_as_recognized(self):
    result = transcribe_two_windows(one_valid=True, one_mismatched=True)
    self.assertEqual(result.windows_attempted, 2)
    self.assertEqual(result.windows_recognized, 1)
```

```python
def test_sample_duration_is_capped(self):
    extract_speaker_sample_audio(source, "mic", [{"start": 0, "end": 600}], output)
    self.assertLessEqual(float(ffmpeg_args[ffmpeg_args.index("-t") + 1]), SAMPLE_MAX_SECONDS + 2 * SAMPLE_AUDIO_PADDING_SECONDS)
```

- [ ] **Step 2: Run focused tests and confirm all four defects.**

Run: `source venv/bin/activate && python -m unittest tests.test_parakeet_onnx tests.test_transcriber_diarisation tests.test_speaker_suggestions tests.test_person_sample_cli -v`

- [ ] **Step 3: Move the recognized counter after payload validation.**

```python
if len(tokens) != len(timestamps):
    continue
windows_recognized += 1
```

- [ ] **Step 4: Start the sidecar in its own process group and terminate the group on timeout.**

```python
popen_kwargs = {"start_new_session": True} if sys.platform != "win32" else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
```

The Windows termination branch must use the existing platform-specific process-tree helper rather than POSIX signals.

- [ ] **Step 5: Cap ranges and use `NamedTemporaryFile` or `mkstemp` for every sample.**

```python
span = min(span, SAMPLE_MAX_SECONDS)
with tempfile.NamedTemporaryFile(prefix="steno-sample-", suffix=".wav", delete=False) as temporary:
    output_path = Path(temporary.name)
```

- [ ] **Step 6: Add safe stale-temp cleanup for old `steno-diarize-*.f32le` files in Swift startup.**

The cleanup deletes only files with the exact prefix in `FileManager.default.temporaryDirectory` older than 24 hours.

- [ ] **Step 7: Run focused tests and commit.**

Commit: `fix(audio): bound speaker samples and clean process trees`

### Task 6: Renderer Correctness, Accessibility, and Query Economy

**Files:**
- Create: `app/renderer/src/hooks/useBlobAudioPlayback.ts`
- Create: `app/renderer/src/hooks/useBlobAudioPlayback.test.ts`
- Modify: `app/renderer/src/components/SpeakerReviewPanel.tsx`
- Modify: `app/renderer/src/routes/settings/PeopleTab.tsx`
- Modify: `app/renderer/src/routes/settings/AiTab.tsx`
- Modify: `app/renderer/src/routes/Processing.tsx`
- Modify: `app/renderer/src/hooks/useSettings.ts`
- Modify: `app/renderer/src/hooks/useSpeakerSuggestions.ts`
- Modify: `app/renderer/src/routes/MeetingDetail.tsx`
- Modify: `app/e2e-mock-ipc.js`
- Modify: `e2e/specs/speaker-review.t1.spec.ts`
- Modify: `e2e/specs/people-management.t2.spec.ts`

**Interfaces:**
- Produces `useBlobAudioPlayback(fetchAudio)` with `play`, `stop`, `isPlaying`, and `error`.
- Audio generation invalidates stale fetches and revokes every object URL.
- Speaker queries are enabled only when the meeting reports speaker data.

- [ ] **Step 1: Write failing hook tests for stop, unmount, play rejection, and stale fetch completion.**

```typescript
it('does not start audio after stop invalidates an in-flight fetch', async () => {
  const playback = renderPlaybackWithDeferredFetch();
  playback.play();
  playback.stop();
  playback.resolveFetch(validAudio);
  await flushPromises();
  expect(Audio.prototype.play).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run Vitest and confirm the hook does not exist.**

Run: `cd app && npx vitest run renderer/src/hooks/useBlobAudioPlayback.test.ts`

- [ ] **Step 3: Implement the shared hook and use it in People and Speaker Review.**

```typescript
export function useBlobAudioPlayback(fetchAudio: () => Promise<AudioPayload>) {
  const generation = React.useRef(0);
  const audio = React.useRef<HTMLAudioElement | null>(null);
  const url = React.useRef<string | null>(null);
  // cleanup invalidates generation, pauses audio, removes handlers, and revokes url
}
```

- [ ] **Step 4: Add visible `role="alert"` feedback for every mutation failure and prevent pending dialog closure.**

```tsx
{feedback && <p role="alert">{feedback.message}</p>}
```

- [ ] **Step 5: Clear the diarization timer on generation change and use the shared optimistic setting helper.**

```typescript
React.useEffect(() => {
  clearDiarizeTimer();
  diarizeStartedAtRef.current = null;
  diarizeHasPercentRef.current = false;
}, [generation, clearDiarizeTimer]);
```

- [ ] **Step 6: Gate speaker controls on macOS and gate meeting queries on sidecar availability.**

```tsx
const supportsSpeakerDiarization = platform.data?.platform === 'darwin';
```

- [ ] **Step 7: Compare the minimum speaker count with the largest channel row count and align the mock.**

```typescript
const separatedClusterCount = Math.max(0, ...Object.values(channels).map((items) => Object.keys(items).length));
```

- [ ] **Step 8: Add T1/T2 coverage for failures, pending state, Windows visibility, count display, and complete mock response shape.**

- [ ] **Step 9: Run Vitest, focused T1/T2 tests, typecheck, and commit.**

Commit: `fix(ui): make speaker review lifecycle reliable`

### Task 7: Explicit Diarization Model Readiness

**Files:**
- Create: `diarize-sidecar/Sources/DiarizationCore/ModelReadiness.swift`
- Create: `diarize-sidecar/Tests/DiarizationCoreTests/ModelReadinessTests.swift`
- Modify: `diarize-sidecar/Package.swift`
- Modify: `diarize-sidecar/Sources/main.swift`
- Modify: `simple_recorder.py`
- Modify: `app/main.js`
- Modify: `app/preload.js`
- Modify: `app/renderer/src/lib/ipc.ts`
- Modify: `app/renderer/src/routes/Setup.tsx`
- Modify: `tests/test_setup_check.py`
- Modify: `e2e/specs/setup-check.t2.spec.ts`
- Modify: `scripts/build-diarize-sidecar.sh`

**Interfaces:**
- Sidecar supports `model-status`, `prepare-models`, and `diarize <wav>` commands.
- `model-status` never downloads and returns cache presence and required variants.
- `prepare-models` is the only normal-app path allowed to download Sortformer weights.
- `diarize` enforces offline model loading and fails with a machine-readable missing-model status.

- [ ] **Step 1: Extract a Swift library target and write failing model-status tests against a temporary cache.**

```swift
func testMissingCacheReportsNotReadyWithoutCreatingFiles() throws {
    let result = ModelReadiness.status(cacheDirectory: temporaryDirectory)
    XCTAssertFalse(result.ready)
    XCTAssertFalse(FileManager.default.fileExists(atPath: expectedModelPath.path))
}
```

- [ ] **Step 2: Run `swift test` and confirm the target is absent.**

Run: `cd diarize-sidecar && swift test`

- [ ] **Step 3: Implement status and preparation with an explicit cache directory inside Steno user data.**

```swift
enum SidecarCommand {
    case modelStatus
    case prepareModels
    case diarize(URL)
}
```

- [ ] **Step 4: Make normal diarization offline-only after preparation.**

```swift
DownloadUtils.enforceOffline = command.isDiarize
```

- [ ] **Step 5: Surface readiness and preparation progress through setup IPC without sending user content.**

- [ ] **Step 6: Add a model-free T2 status test and a separately tagged clean-cache macOS test.**

```typescript
test('@diarization-model prepares once and works offline afterward', async ({ app }) => {
  await expectModelMissing(app);
  await prepareModel(app);
  await expectModelReady(app);
  await runOfflineSidecarSmoke(app);
});
```

- [ ] **Step 7: Run Swift tests, setup tests, and T2 contract tests and commit.**

Commit: `feat(diarization): manage local model readiness explicitly`

### Task 8: CI Fidelity, Test Isolation, and Cubic Test Cleanup

**Files:**
- Modify: `.github/workflows/e2e.yml`
- Modify: `.github/workflows/build-release.yml`
- Modify: `scripts/build-backend.sh`
- Modify: `stenoai.spec`
- Modify: `CLAUDE.md`
- Modify: `docs/faq.mdx`
- Modify: `e2e/fixtures/say-stereo-wav.ts`
- Modify: `e2e/fixtures/user-config.ts`
- Modify: `e2e/specs/speaker-diarization.t2.spec.ts`
- Modify: `e2e/specs/speaker-multi-marking.t2.spec.ts`
- Modify: `e2e/specs/processing-stages.t1.spec.ts`
- Modify: `tests/test_confirm_speaker_cli.py`
- Modify: `tests/test_speaker_multi_marking.py`
- Modify: `tests/test_speaker_suggestions.py`
- Modify: `tests/test_speaker_timestamps_cli.py`
- Modify: `tests/test_transcriber_diarisation.py`
- Modify: `app/settings-ipc.test.js`

**Interfaces:**
- Downloaded macOS backend artifacts restore and assert the `steno-diarize` execute bit.
- Production-shape fixtures include a run ID and allow an explicit legacy mode.
- Direct unittest entry points occur once at file end.

- [ ] **Step 1: Add behavioral build-guard tests that unpack or inspect an artifact and start the sidecar help/status command.**

```python
def test_packaged_sidecar_is_executable_and_starts(self):
    self.assertTrue(os.access(sidecar, os.X_OK))
    result = subprocess.run([sidecar, "model-status"], capture_output=True, timeout=10)
    self.assertIn(result.returncode, (0, MODEL_NOT_READY_EXIT))
```

- [ ] **Step 2: Fix both chmod jobs and improve build-script diagnostics.**

```bash
chmod +x dist/stenoai/stenoai dist/stenoai/ffmpeg/ffmpeg dist/stenoai/ollama/ollama dist/stenoai/_internal/steno-diarize
```

- [ ] **Step 3: Keep the strict release guard and document a separately named development opt-out if retained.**

- [ ] **Step 4: Repair all Cubic test defects.**

This includes three mid-file `unittest.main()` calls, the overlapping stability-gate fixture, transitive-merge vectors, non-zero-only crash acceptance, the mismatched segment count, the second-prototype test name and setup, the getter-count comment, temp WAV cleanup, nested user-data fingerprinting, explicit `STENOAI_USER_DATA_DIR`, full production mock fields, and the overclaiming processing-stage comment.

- [ ] **Step 5: Add a real Parakeet-MLX sentence/token contract characterization test at the adapter boundary.**

```python
def test_mlx_adapter_accepts_current_sentence_object_contract(self):
    result = adapt_current_library_result(realistic_result_fixture())
    self.assertEqual(result["segments"], [{"start": 0.0, "end": 1.2, "text": "Hello."}])
```

- [ ] **Step 6: Qualify FAQ behavior as macOS-only and align build documentation.**

- [ ] **Step 7: Run Python tests, Node/Vitest, typecheck, lint, build guards, and commit.**

Commit: `test(speakers): make release coverage match production`

### Task 9: Bounded Performance and Reviewability Cleanup

**Files:**
- Modify: `src/speaker_suggestions.py`
- Modify: `simple_recorder.py`
- Modify: `app/renderer/src/components/SpeakerReviewPanel.tsx`
- Modify: `app/renderer/src/hooks/useSpeakerSuggestions.ts`
- Modify: `tests/test_speaker_suggestions.py`
- Modify: `tests/test_person_profile_cli.py`

**Interfaces:**
- Candidate rankings are materialized once per cluster.
- Profile listing memoizes sidecar and recording resolution within one invocation.
- Transcript parsing is performed once per meeting suggestion request.

- [ ] **Step 1: Write call-count tests around real scoring and sidecar readers.**

```python
def test_candidate_scoring_runs_once_per_cluster(self):
    with patch("src.speaker_suggestions.score_candidates", wraps=score_candidates) as score:
        suggest_speakers_for_meeting(self.channels, self.profiles)
    self.assertEqual(score.call_count, self.cluster_count)
```

- [ ] **Step 2: Run tests and confirm duplicate scoring and reads.**

- [ ] **Step 3: Carry the ranking through assignment and add per-command caches keyed by meeting, channel, and run.**

```python
ranked = {cluster_key: score_candidates(embedding, context, profiles) for cluster_key, embedding, context in flat}
```

- [ ] **Step 4: Remove comments that duplicate implementation detail and keep only invariant and rationale comments.**

- [ ] **Step 5: Run focused performance tests and commit.**

Commit: `refactor(speakers): remove duplicate scoring and reads`

### Task 10: Clean-Cache Packaged Verification and Independent Review

**Files:**
- Create: `docs/testing/speaker-diarization-clean-mac.md`
- Modify only files required by defects reproduced during this acceptance task.

**Interfaces:**
- Produces a repeatable clean-cache test record without private meeting content.
- Claude Opus receives only `git diff origin/main...HEAD`, the public Cubic issue list, and verification summaries.

- [x] **Step 1: Run all focused and full automated verification.**

Run: `source venv/bin/activate && ruff check .`

Run: `source venv/bin/activate && python -m unittest discover tests`

Run: `cd app && npm run test:unit`

Run: `cd app && npm run typecheck:renderer`

Run: `cd app && npm run lint:renderer`

Run: `cd diarize-sidecar && swift test`

- [ ] **Step 2: Build the sidecar, backend bundle, renderer, and unsigned packaged app.**

Run: `scripts/build-diarize-sidecar.sh`

Run: `source venv/bin/activate && pyinstaller stenoai.spec --noconfirm`

Run: `cd app && npm run pack:unsigned`

- [x] **Step 3: Create an empty isolated Steno user-data directory under `/private/tmp`.**

```text
STENOAI_USER_DATA_DIR=/private/tmp/steno-clean-model-<random>
```

The override makes the sidecar's model cache empty without moving or deleting any existing user cache.
Verify that `model-status` does not create the model directory.

- [x] **Step 4: Run the release sidecar with isolated Steno user data, prepare models, and process synthetic speech.**

The sample contains only generated `say` speech and no real meeting or person data.

- [x] **Step 5: Point every proxy variable at a closed local port and repeat the smoke using the newly prepared cache.**

- [x] **Step 6: Remove the exact isolated cache directory and synthetic sample after verification.**

- [ ] **Step 7: Run T1 and model-free T2 suites without foreground focus.**

Run: `cd app && npm run test:e2e -- --project=t1`

Run: `cd app && npm run test:e2e -- --project=t2 --grep-invert @pipeline`

- [ ] **Step 8: Scan the complete diff for secrets, private names, local paths, meeting text, generated files, and unintended changes.**

```bash
git diff --check origin/main...HEAD
git status --short
```

- [ ] **Step 9: Ask Claude Opus for an analysis-only review of the complete diff and address every Critical or Important finding through another TDD cycle.**

- [ ] **Step 10: Run the full final verification again and create the final local commit.**

Commit: `fix(speakers): make main release ready`

## Cubic Coverage Map

- Task 1 covers diagnostic PII, path validation, profile type normalization, and transcript-safe names.
- Task 2 covers stale runs, lost sidecar updates, async sample scope, and review-state durability.
- Task 3 covers ignored save results, delete atomicity, strict booleans, malformed embeddings, and name normalization.
- Task 4 covers the full-reprocess callback and retry after partial multi-speaker marking.
- Task 5 covers ONNX window coverage, child-process cleanup, sample URL/temp lifecycle, and sample duration.
- Task 6 covers Windows gating, stale timers, shared optimistic settings, pending dialogs, keep-generic feedback, count semantics, and accessibility.
- Task 7 covers first-use model download, offline behavior, and a testable Swift target.
- Task 8 covers execute bits, strict bundle behavior, all test fixture defects, user-data isolation, documentation mismatches, and direct-run test entry points.
- Task 9 covers duplicated turn/scoring work, repeated disk reads, unconditional process starts, and reviewability.
- Task 10 covers the real binary, clean cache, packaged app, private-data scan, and Claude Opus review.
