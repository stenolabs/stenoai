# Person Voice Sample Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one local, on-demand Play/Stop control to each People row whose confirmed profile still has an extractable source-audio sample.

**Architecture:** Python remains the authority for sample eligibility and selection because it owns person profiles, sidecars, recording lookup, and extraction. Electron exposes one narrow read-only IPC call, while the People tab owns a single playback session so starting another person always stops and cleans up the current clip.

**Tech Stack:** Python Click and `unittest`, Electron IPC/preload, React 19, TypeScript, TanStack Query, Web Audio via `HTMLAudioElement`, Vitest, Playwright T1/T2, PyInstaller.

## Global Constraints

- Show at most one representative sample per person and no sample-management UI.
- Never expose meeting ids, local paths, cluster ids, embeddings, or raw backend errors to the renderer.
- Consider only positive prototypes, never hard negatives.
- A sample is playable only while its recording, current sidecar run, channel, cluster, and positive-duration segment still exist.
- Rank candidates by `quality_score`, then `created_at`, then stable provenance fields.
- Keep only one active People-tab audio element and revoke every temporary object URL on stop, end, switch, error, and unmount.
- Use visible `Play` and `Stop` labels with person-specific accessible names.
- Do not add dependencies or modify `CHANGELOG.md`.
- Keep macOS and Windows behavior on the existing cross-platform recording and ffmpeg helpers.
- Every T2 fixture must set `STENOAI_USER_DATA_DIR` and must not inspect or change real user data.
- Use plain hyphens, never em dashes, in new text.

---

## File map

- `simple_recorder.py`: Resolve playable positive prototypes, report availability, and extract a selected person's sample.
- `tests/test_person_sample_audio_cli.py`: Pin eligibility, ranking, privacy-safe output, failure behavior, and WAV extraction.
- `app/main.js`: Register the new CLI-backed IPC handler.
- `app/preload.js`: Expose the person-sample call through the existing `speakers` namespace.
- `app/renderer/src/lib/ipc.ts`: Add `sample_available` and the typed person-sample request.
- `app/renderer/src/hooks/useSpeakerSuggestions.ts`: Add the fetch-on-click mutation.
- `app/renderer/src/routes/settings/PeopleTab.tsx`: Render and coordinate Play/Stop, cleanup, and inline failure.
- `app/e2e-mock-ipc.js`: Provide deterministic playable/unplayable profiles and a real-duration silent WAV for T1.
- `e2e/specs/speaker-review.t1.spec.ts`: Cover People playback behavior and sanitized failure copy.
- `e2e/specs/people-management.t2.spec.ts`: Cover the complete isolated real-backend extraction path.

---

### Task 1: Resolve and extract a person's representative sample

**Files:**
- Create: `tests/test_person_sample_audio_cli.py`
- Modify: `simple_recorder.py`

**Interfaces:**
- Produces: `_resolve_person_sample(profile: dict, dirs: dict) -> Optional[dict]`.
- The returned private dict contains `meeting_id`, `channel`, `diarization_speaker_id`, `recording_path`, `pooled_segments`, `quality_score`, and `created_at` only inside Python.
- Produces CLI: `get-person-sample-audio PERSON_ID -> {"success": true, "audio_base64": str}` or a fixed JSON failure.
- Extends CLI: `list-person-profiles` returns `sample_available: bool` for each DTO.

- [ ] **Step 1: Write failing resolver tests**

Create `tests/test_person_sample_audio_cli.py` with temporary `output/`, `recordings/`, and `config.json` directories.
Seed profiles through `Config.add_speaker_prototype`, sidecars through `write_speakers_sidecar`, and small WAV fixtures through Python's `wave` module.
Assert all of these behaviors:

```python
class PersonSampleResolutionTests(unittest.TestCase):
    def test_selects_highest_quality_current_positive_prototype(self): ...
    def test_uses_recency_then_stable_provenance_for_ties(self): ...
    def test_rejects_stale_diarization_run(self): ...
    def test_rejects_missing_recording_sidecar_channel_cluster_and_segments(self): ...
    def test_ignores_hard_negatives(self): ...
```

The test that names the production change is `test_selects_highest_quality_current_positive_prototype`: it fails until `_resolve_person_sample` exists and returns the higher-quality prototype's private provenance.

- [ ] **Step 2: Run the resolver tests and verify RED**

Run:

```bash
venv/bin/python -m unittest tests.test_person_sample_audio_cli.PersonSampleResolutionTests
```

Expected: import or assertion failure because `_resolve_person_sample` is absent.

- [ ] **Step 3: Implement minimal deterministic resolution**

In `simple_recorder.py`, add a private resolver used by both profile listing and extraction.
For every positive prototype:

```python
sidecar = read_speakers_sidecar(dirs["output"], meeting_id)
run_id = (sidecar.get("diarization_run") or {}).get("run_id") if sidecar else None
if not sidecar or not prototype_run_matches(prototype, run_id):
    continue
recording_path = _find_recording_file(dirs["recordings"], meeting_id)
channel_data = (sidecar.get("channels") or {}).get(channel)
raw_clusters = clusters_from_sidecar_channel(meeting_id, channel_data or {})
```

Resolve merged fragments with `merge_same_channel_fragments`, pool segments from the resolved primary and `context.merged_from`, and require at least one segment whose `end` is greater than `start`.
Sort eligible candidates descending by numeric `quality_score`, descending by numeric `created_at`, then ascending by `(meeting_id, channel, diarization_speaker_id)`.
Return the first candidate or `None`.

- [ ] **Step 4: Run resolver tests and verify GREEN**

Run the command from Step 2.
Expected: all resolver tests pass.

- [ ] **Step 5: Write failing CLI contract tests**

Add:

```python
class PersonSampleCliTests(unittest.TestCase):
    def test_list_profiles_reports_only_boolean_availability(self): ...
    def test_get_person_sample_audio_returns_valid_wav_base64(self): ...
    def test_missing_person_returns_fixed_failure_without_provenance(self): ...
    def test_unplayable_person_returns_fixed_failure_without_provenance(self): ...
```

Assert the list DTO contains `sample_available` but does not contain `meeting_id`, `channel`, `diarization_speaker_id`, `recording_path`, `prototypes`, or `embedding`.
Decode successful audio and assert it begins with `RIFF` and contains `WAVE`.
Assert failures contain only `success: false` and `error: "voice sample unavailable"`.

- [ ] **Step 6: Run CLI tests and verify RED**

Run:

```bash
venv/bin/python -m unittest tests.test_person_sample_audio_cli.PersonSampleCliTests
```

Expected: failure because the list field and command do not exist.

- [ ] **Step 7: Implement list availability and person extraction**

Load `get_data_dirs()` once in `list_person_profiles`, call `_resolve_person_sample` per profile, and emit only `sample_available: resolved is not None` in addition to existing fields.

Add the Click command:

```python
@cli.command(name="get-person-sample-audio")
@click.argument("person_id")
def get_person_sample_audio(person_id):
    profile = get_config().get_person_profile(person_id)
    sample = _resolve_person_sample(profile, get_data_dirs()) if profile else None
    if sample is None:
        print(json.dumps({"success": False, "error": "voice sample unavailable"}))
        return
    # Extract into tempfile.gettempdir(), base64 the bytes, and unlink in finally.
```

Use `extract_speaker_sample_audio(recording_path, channel, pooled_segments, output_path)` with no segment index so the existing longest-clean-turn behavior remains authoritative.
Return the same fixed failure for extraction errors and always remove the temporary file in `finally`.

- [ ] **Step 8: Run affected Python tests and quality checks**

Run:

```bash
venv/bin/python -m unittest tests.test_person_sample_audio_cli tests.test_suggest_speakers_cli tests.test_person_profile_cli
venv/bin/ruff check --select E9,F63,F7,F82 simple_recorder.py tests/test_person_sample_audio_cli.py
```

Expected: all tests and runtime-error rules pass.

- [ ] **Step 9: Commit the backend slice**

```bash
git add simple_recorder.py tests/test_person_sample_audio_cli.py
git commit -m "feat(speakers): serve representative person samples"
```

---

### Task 2: Wire playback into the People settings tab

**Files:**
- Modify: `app/main.js`
- Modify: `app/preload.js`
- Modify: `app/renderer/src/lib/ipc.ts`
- Modify: `app/renderer/src/hooks/useSpeakerSuggestions.ts`
- Modify: `app/renderer/src/routes/settings/PeopleTab.tsx`
- Modify: `app/e2e-mock-ipc.js`
- Modify: `e2e/specs/speaker-review.t1.spec.ts`

**Interfaces:**
- Consumes: `get-person-sample-audio PERSON_ID` and `PersonProfile.sample_available` from Task 1.
- Produces preload: `ipc().speakers.getPersonSampleAudio(personId: string)`.
- Produces hook: `useGetPersonSampleAudio()` returning a TanStack mutation whose data is `{ audio_base64: string }`.
- Produces UI test ids: `people-play-${person_id}` and `people-play-error-${person_id}`.

- [ ] **Step 1: Write a failing T1 playback test**

Extend the seeded People mock so Person Alpha has `sample_available: true`, Person Beta has stored prototype counts but `sample_available: false`, and empty profiles remain false.
Add a test that opens People and asserts:

```typescript
await expect(page.getByRole('button', { name: 'Play voice sample for Person Alpha' })).toBeVisible();
await expect(page.getByRole('button', { name: 'Play voice sample for Person Beta' })).toHaveCount(0);
await page.getByTestId('people-play-p-alpha').click();
await expect(page.getByRole('button', { name: 'Stop voice sample for Person Alpha' })).toBeVisible();
await page.getByTestId('people-play-p-alpha').click();
await expect(page.getByRole('button', { name: 'Play voice sample for Person Alpha' })).toBeVisible();
```

- [ ] **Step 2: Run the T1 test and verify RED**

Run:

```bash
cd app
npm run build:renderer
npm run test:e2e -- --project=t1 --grep "People settings plays one representative voice sample"
```

Expected: failure because no People playback control exists.

- [ ] **Step 3: Add the typed IPC path**

In `app/main.js`, register `get-person-sample-audio`, invoke the CLI with only `personId`, parse JSON, and use `parsePythonFailureJson` in the catch path.
In `app/preload.js`, expose `speakers.getPersonSampleAudio(id)`.
In `ipc.ts`, add `sample_available: boolean` to `PersonProfile` and type the method with `GetSpeakerSampleAudioResponse`.
In `useSpeakerSuggestions.ts`, add a fetch-on-click mutation analogous to `useGetSpeakerSampleAudio`:

```typescript
export function useGetPersonSampleAudio() {
  return useMutation({
    mutationFn: async (personId: string) =>
      unwrap(await ipc().speakers.getPersonSampleAudio(personId)),
  });
}
```

- [ ] **Step 4: Implement one coordinated People playback session**

In `PeopleTab`, add `playingPersonId`, `playErrorPersonId`, `audioRef`, and `objectUrlRef` at tab scope.
Implement a stable `stopPlayback` callback that pauses audio, clears handlers, revokes the stored URL, clears refs, and resets the playing id.
Call it before starting another request and from the unmount effect.

For each profile with `sample_available`, render an outline `Play`/`Stop` button before `Delete`.
On play, clear any prior fixed error, fetch base64, create a WAV blob URL, attach `onended` and `onerror` cleanup, call `audio.play()`, and set the active person only after play resolves.
Catch both IPC and media-play failures, clean up, and set only `playErrorPersonId`.
Render `Could not play this voice sample. Try again.` with `role="alert"` below that person's description.

- [ ] **Step 5: Add the deterministic T1 mock**

Reuse `MINIMAL_WAV_BASE64` for `get-person-sample-audio`.
Return `{ success: false, error: 'simulated private backend detail' }` when `STENOAI_E2E_PERSON_SAMPLE_FAIL=1` so the renderer test can prove raw errors never render.

- [ ] **Step 6: Run the playback test and verify GREEN**

Run the commands from Step 2.
Expected: the Play/Stop test passes with real media duration from the mock WAV.

- [ ] **Step 7: Write and run a failing sanitized-error T1 test**

Launch with `STENOAI_E2E_PERSON_SAMPLE_FAIL=1`, click Person Alpha's Play button, and assert the fixed error is visible while `simulated private backend detail` is absent from the page.
Run:

```bash
npm run test:e2e -- --project=t1 --grep "People settings keeps voice sample failures private"
```

Expected before the error-state implementation is complete: failure on the fixed alert assertion.

- [ ] **Step 8: Verify renderer and full People T1 coverage**

Run:

```bash
npm run typecheck:renderer
npm run lint:renderer -- --quiet
npm run test:unit
npm run build:renderer
npm run test:e2e -- --project=t1 --grep "People settings"
```

Expected: all commands pass.

- [ ] **Step 9: Commit the UI slice**

```bash
git add app/main.js app/preload.js app/renderer/src/lib/ipc.ts app/renderer/src/hooks/useSpeakerSuggestions.ts app/renderer/src/routes/settings/PeopleTab.tsx app/e2e-mock-ipc.js e2e/specs/speaker-review.t1.spec.ts
git commit -m "feat(settings): play a person voice sample"
```

---

### Task 3: Prove the real bundled playback path

**Files:**
- Modify: `e2e/specs/people-management.t2.spec.ts`

**Interfaces:**
- Consumes: `speakers.getPersonSampleAudio(personId)` and `PersonProfile.sample_available` from Tasks 1 and 2.
- Produces: one model-free T2 regression that exercises real config, sidecar, recording lookup, ffmpeg extraction, CLI, IPC, preload, and renderer-visible DTO shape.

- [ ] **Step 1: Write the failing T2 test**

In the isolated `userDataDir`, write a short 16 kHz mono synthetic WAV under `recordings/`, a matching current-run speaker sidecar under `output/`, and a config profile whose positive prototype points to the same meeting, channel, cluster, and run id.
Launch the app, call `listProfiles` and `getPersonSampleAudio` through `window.stenoai.speakers`, then assert:

```typescript
expect(profile.sample_available).toBe(true);
expect(Object.keys(profile)).not.toEqual(expect.arrayContaining([
  'meeting_id', 'channel', 'diarization_speaker_id', 'recording_path', 'prototypes', 'embedding',
]));
expect(result.success).toBe(true);
const bytes = Buffer.from(result.audio_base64!, 'base64');
expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
```

Also retain the existing `fileSig(realUserDataDir())` before/after assertion.

- [ ] **Step 2: Build and verify RED against the old bundle**

Run the new test before rebuilding the backend:

```bash
cd app
npm run build:renderer
npm run test:e2e -- --project=t2 ../e2e/specs/people-management.t2.spec.ts --grep "plays a representative sample through the real backend"
```

Expected: failure because the current bundle predates the new CLI command or DTO field.

- [ ] **Step 3: Rebuild the backend and verify GREEN**

Run from repository root:

```bash
venv/bin/pyinstaller stenoai.spec --noconfirm
```

Then rerun the T2 command from Step 2.
Expected: pass with a non-empty valid WAV payload and unchanged real user-data signature.

- [ ] **Step 4: Commit the T2 slice**

```bash
git add e2e/specs/people-management.t2.spec.ts
git commit -m "test(settings): cover person sample playback end to end"
```

---

### Task 4: Final release-readiness gate

**Files:**
- Review only: all files changed since `aed7938`.

**Interfaces:**
- Consumes the complete feature from Tasks 1 through 3.
- Produces a clean local branch with review findings addressed and no push.

- [ ] **Step 1: Review the full feature diff**

Run:

```bash
git diff --check aed7938...HEAD
git diff --stat aed7938...HEAD
git diff aed7938...HEAD
```

Check privacy, cleanup on every playback exit, accessibility, stale provenance, Windows path behavior, raw error leakage, and accidental unrelated changes.

- [ ] **Step 2: Obtain an independent read-only review**

Ask a short-lived reviewer to inspect only `aed7938...HEAD` for correctness, privacy, accessibility, and platform parity.
Do not authorize edits or external actions.
Turn every verified issue into a failing test before changing production code.

- [ ] **Step 3: Run the final verification matrix**

Run:

```bash
venv/bin/python -m unittest tests.test_person_sample_audio_cli tests.test_suggest_speakers_cli tests.test_person_profile_cli tests.test_transcriber_diarisation
venv/bin/ruff check src/transcriber.py tests/test_person_sample_audio_cli.py
cd app
npm run typecheck:renderer
npm run lint:renderer -- --quiet
npm run test:unit
npm run build:renderer
npm run test:e2e -- --project=t1 --grep-invert @perf
npm run test:e2e -- --project=t2 ../e2e/specs/people-management.t2.spec.ts ../e2e/specs/speaker-naming.t2.spec.ts ../e2e/specs/speaker-multi-marking.t2.spec.ts
npm run pack:unsigned
```

Expected: all scoped Python checks, renderer checks, Unit, T1, focused T2, backend build, and unsigned packaging pass.
If the known full Python discovery or project-wide Ruff baselines are checked, classify their pre-existing environment and style failures separately rather than claiming they are green.

- [ ] **Step 4: Confirm clean branch state**

Run:

```bash
git status --short
git log --oneline aed7938..HEAD
```

Expected: no tracked or untracked task changes and no push performed.
