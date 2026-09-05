# Speaker Dominance and People Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve sustained minority speakers, make their sidecar-backed review panel reachable, and complete end-to-end coverage for People management.

**Architecture:** Extend the existing dominance decision with an absolute per-cluster floor and carry its eligible cluster IDs into self-voiceprint matching.
Let the renderer derive review-panel availability from the suggestion payload when the transcript flag is false.
Exercise profile management through the existing IPC bridge and Settings UI without changing the backend contract.

**Tech Stack:** Python `unittest`, React and TypeScript, TanStack Query, Electron mock IPC, Playwright T1 and T2.

## Global Constraints

- Keep `CHANNEL_DOMINANCE_THRESHOLD` at `0.92`.
- Use 15 seconds as the sustained minority floor.
- Reuse `SUGGESTION_MIN_AVG_TURN_SECONDS` as the fragmented-artifact floor.
- Keep short folded clusters in the sidecar for review and provenance, but do not give them a separate transcript label.
- Preserve macOS and Windows shared-code behavior.
- Set `STENOAI_USER_DATA_DIR` through the existing Playwright fixture for every T2 test.
- Do not modify `CHANGELOG.md` or generated files.
- Do not push or open a pull request.

---

### Task 1: Classify sustained minority clusters

**Files:**

- Modify: `src/transcriber.py`
- Test: `tests/test_transcriber_diarisation.py`

**Interfaces:**

- Produces: `_cluster_channel_label_plan(diar_segments, legacy_label) -> tuple[Optional[dict[str, str]], set[str]]`
- Preserves: `_cluster_channel_labels(diar_segments, legacy_label) -> Optional[dict[str, str]]`
- Extends: `_apply_voiceprint_matches(..., eligible_speaker_ids: Optional[set[str]] = None)`

- [ ] **Step 1: Add failing unit tests**

Add literal segment fixtures proving these behaviors:

```python
# 3487.4 / 111.1 / 61.2 / 2.6 seconds.
# The two sustained minority clusters get placeholders.
# The 2.6-second blip inherits the dominant legacy label.

# A normal 1:1 shape with an 11.84-second minority remains collapsed.

# A fragmented 18-second minority whose average turn is 0.6 seconds remains collapsed.

# A self match on a sustained minority re-anchors "You" while the folded
# blip inherits the previous dominant cluster's placeholder.
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
venv/bin/python -m unittest \
  tests.test_transcriber_diarisation.ClusterChannelLabelsTests \
  tests.test_transcriber_diarisation.ApplyVoiceprintMatchesTests
```

Expected: the sustained-minority and eligible-cluster tests fail because the current ratio-only rule returns `None` and voiceprint matching considers every embedding.

- [ ] **Step 3: Implement the label plan**

Add `CHANNEL_DOMINANCE_MIN_MINOR_SPEECH_SECONDS = 15.0`.
Compute total speech per cluster once.
Below the ratio threshold, keep every cluster eligible and preserve current labels.
At or above the ratio threshold, return `None` when no minority cluster reaches both the absolute duration floor and the average-turn floor.
Otherwise label the dominant cluster with the legacy label, give each sustained minority its own placeholder, fold other minorities onto the dominant label, and return only dominant plus sustained minorities as eligible.

Pass eligible IDs into `_apply_voiceprint_matches`.
Limit its distance search to eligible embeddings.
When the self match moves the legacy label, keep folded blips attached to the old dominant label.

- [ ] **Step 4: Run focused and neighboring tests and verify GREEN**

Run the focused command from Step 2 and:

```bash
venv/bin/python -m unittest tests.test_transcriber_diarisation
```

- [ ] **Step 5: Commit Task 1 explicitly**

```bash
git add src/transcriber.py tests/test_transcriber_diarisation.py
git commit -m "fix(speakers): keep sustained minority speakers distinct"
```

### Task 2: Open the panel from sidecar evidence

**Files:**

- Modify: `app/renderer/src/components/SpeakerReviewPanel.tsx`
- Modify: `app/e2e-mock-ipc.js`
- Modify: `app/main.js`
- Test: `e2e/specs/speaker-review.t1.spec.ts`
- Test: `e2e/specs/speaker-naming.t2.spec.ts`

**Interfaces:**

- Consumes: `suggest-speakers` response `channels`
- Preserves: the `isDiarised` prop as the transcript-label signal

- [ ] **Step 1: Add a failing T1 test**

Add a mock mode that returns the existing multi-cluster speaker sidecar payload with `is_diarised: false`.
Assert that navigating to the meeting renders `speaker-review-panel` and at least two speaker rows.

- [ ] **Step 2: Build the renderer and verify RED**

```bash
cd app
npm run build:renderer
npm run test:e2e -- --project=t1 --grep "sidecar has multiple clusters"
```

Expected: the panel never appears because the component currently returns early on `!isDiarised`.

- [ ] **Step 3: Implement payload-based availability**

Enable `useSpeakerSuggestions` whenever `meetingStem` exists.
Treat a missing speaker sidecar as an expected empty CLI result instead of a backend failure, so the query does not retry a failing process.
Return `null` when there is no stem, no suggestion payload, no flattened sidecar rows, or when `isDiarised` is false and the flattened sidecar row count is one.

- [ ] **Step 4: Rebuild and verify GREEN**

Repeat Step 2 and run the complete `speaker-review.t1.spec.ts` file.

- [ ] **Step 5: Commit Task 2 explicitly**

```bash
git add app/renderer/src/components/SpeakerReviewPanel.tsx app/e2e-mock-ipc.js e2e/specs/speaker-review.t1.spec.ts
git commit -m "fix(speakers): open review from sidecar clusters"
```

### Task 3: Cover the large People picker and Settings deletion

**Files:**

- Modify: `app/e2e-mock-ipc.js`
- Test: `e2e/specs/speaker-review.t1.spec.ts`

**Interfaces:**

- Consumes: `PERSON_SEARCH_THRESHOLD = 8`
- Preserves: `delete-person-profile` mock recomputation of suggestions

- [ ] **Step 1: Add a many-profile mock mode and picker assertions**

Seed at least ten complete profile DTOs only when the new environment flag is set.
Open Change, assert the search field appears, filter to one profile, verify `No match` for a missing query, and assert there is no `speaker-delete-person-*` control.

- [ ] **Step 2: Rewrite the existing deletion flow through Settings**

Confirm Person Alpha in the meeting, navigate to `/settings?tab=people`, delete Person Alpha after checking the global warning, navigate back to the meeting, reveal filtered rows, and assert the former row is unidentified and no longer contains Person Alpha.

- [ ] **Step 3: Run the two focused T1 tests**

```bash
cd app
npm run build:renderer
npm run test:e2e -- --project=t1 --grep "searches a large people library|People settings deletion"
```

Expected: both pass against the existing renderer implementation.
Mutation-check the search test by temporarily changing the threshold or filter and confirm it fails before restoring production code.

- [ ] **Step 4: Run the complete speaker-review T1 file**

```bash
cd app
npm run test:e2e -- --project=t1 e2e/specs/speaker-review.t1.spec.ts
```

- [ ] **Step 5: Commit Task 3 explicitly**

```bash
git add app/e2e-mock-ipc.js e2e/specs/speaker-review.t1.spec.ts
git commit -m "test(speakers): cover People picker and deletion"
```

### Task 4: Prove People deletion through the real backend

**Files:**

- Create: `e2e/specs/people-management.t2.spec.ts`

**Interfaces:**

- Consumes: `window.stenoai.speakers.createProfile`, `listProfiles`, and `deleteProfile`
- Verifies: `<STENOAI_USER_DATA_DIR>/config.json` `person_profiles`

- [ ] **Step 1: Write the T2 test**

Create two profiles through the real preload bridge.
Navigate to `/settings?tab=people`.
Assert alphabetical names, the zero-sample explanation, and the People header's global scope.
Open one delete dialog and assert the warning says the profile is removed from every meeting and cannot be restored.
Confirm deletion and poll `config.json` until only the untouched profile remains.
Verify the real user-data directory signature is unchanged.

- [ ] **Step 2: Run the test and verify RED if wiring is incomplete**

Build `dist/stenoai` first because T2 launches the bundled backend.

```bash
venv/bin/pyinstaller stenoai.spec --noconfirm
cd app
npm run build:renderer
npm run test:e2e -- --project=t2 ../e2e/specs/people-management.t2.spec.ts
```

- [ ] **Step 3: Make only the test or existing UI corrections required by the real contract**

Do not add a new backend API.
Keep fixture helpers unchanged unless the real bridge cannot create a profile before navigation.

- [ ] **Step 4: Run the focused T2 and existing speaker compatibility specs**

```bash
cd app
npm run test:e2e -- --project=t2 ../e2e/specs/people-management.t2.spec.ts ../e2e/specs/speaker-naming.t2.spec.ts ../e2e/specs/speaker-multi-marking.t2.spec.ts
```

- [ ] **Step 5: Commit Task 4 explicitly**

```bash
git add e2e/specs/people-management.t2.spec.ts
git commit -m "test(speakers): cover People settings end to end"
```

### Task 5: Verify and review the branch

**Files:**

- Review: all files changed from `1891d8a8`

- [ ] **Step 1: Run code quality checks**

```bash
venv/bin/python -m unittest discover tests
venv/bin/ruff check .
cd app
npm run typecheck:renderer
npm run lint:renderer
npm run test:unit
```

- [ ] **Step 2: Run relevant E2E suites**

Run the full T1 suite and the focused model-free T2 speaker specs.

- [ ] **Step 3: Review the full branch diff**

Inspect `git diff 1891d8a8...HEAD` for correctness, privacy, accessibility, platform parity, and accidental unrelated changes.

- [ ] **Step 4: Obtain a cross-family second opinion**

Ask an Opus or Fable reviewer to analyze the branch diff only.
Do not authorize edits or external actions.
Address verified findings with their own failing tests.

- [ ] **Step 5: Remove this task's handoff only after completion**

Delete `HANDOFF-feat-speaker-people-management.md` from the main checkout only if it still belongs to this completed task and no other session is using it.
Do not commit any handoff file.
