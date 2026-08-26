# Speaker review: run provenance and persisted review state - implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the speaker review survive being interrupted and stop it from silently attributing a new diarization run's clusters to people confirmed against an older one.

**Architecture:** Purely additive. The sidecar gains a run id and one per-cluster review marker, prototypes record which run they were confirmed against, and one shared predicate decides "is this evidence current" for every reader and writer so the two cannot drift apart. Nothing existing is migrated and nothing is deleted; every new key is optional and its absence means today's behaviour.

**Tech Stack:** Python 3 (`src/`, `simple_recorder.py`, `unittest`), Electron main + preload (`app/`), React + TanStack Query renderer (vitest), Playwright e2e.

**Source spec:** `docs/superpowers/specs/2026-08-04-speaker-review-run-provenance-design.md`. Read it before Task 1. Where this plan and the spec disagree, the spec wins and the plan is wrong.

## Global Constraints

- Every new sidecar key and every new prototype field is **optional**; absent means legacy and must read exactly as today. No migration, no backfill.
- `src/speaker_suggestions.py`'s public helpers keep their **never-raises** contracts. New CLI commands print `{"success": false, "error": ...}` and `sys.exit(1)`; never a traceback, never bare `exit()`.
- The staleness rule exists **once**, as a shared predicate in `src/speaker_suggestions.py`, imported by `src/config.py` and `simple_recorder.py` the same way `prototype_channel_matches` already is. A second copy of the rule is a defect.
- Participants (`confirmed_participant_names`) stay **meeting-scoped, never run-scoped**. This is deliberate and the code must say so.
- The e2e fixture `writeSpeakersSidecar` (`e2e/fixtures/user-config.ts`) stays **legacy-shaped**. Its specs staying green is the backward-compatibility proof; changing it destroys the proof.
- Verification baseline to compare against, measured on this branch before Task 1: **944 Python tests**, ruff **41**, renderer lint **37 warnings / 0 errors**, typecheck clean. `tests/test_bundle_mlx.py` fails only in the full `discover` run and is green in isolation - pre-existing, not caused by this work.
- Diarization is macOS-only, but every file touched here is cross-platform Python or JS. Nothing in this slice may branch on platform.

---

## File structure

| File | Responsibility in this slice |
|---|---|
| `src/speaker_suggestions.py` | Mint the run block; own the shared staleness predicate; own the review-state write helper and its merged-row propagation |
| `src/config.py` | Store `diarization_run_id` on evidence; apply run scope when removing evidence |
| `simple_recorder.py` | Pass run ids through `confirm-speaker` / `mark-speaker-cluster`; apply the predicate in every reader; new `set-cluster-review-state` CLI; report lost markings |
| `app/main.js`, `app/preload.js` | Bridge the new CLI to the renderer, following the `mark-speaker-cluster` handler exactly |
| `app/renderer/src/hooks/useSpeakerSuggestions.ts` | Mutation + cache invalidation for the new state |
| `app/renderer/src/components/SpeakerReviewPanel.tsx` | Persisted marker replaces `dismissed`; button gating; stale notice |
| `tests/test_speaker_suggestions.py` | Sidecar round-trip, predicate matrix, merged propagation |
| `tests/test_confirm_speaker_cli.py` | Run-scoped removal, run stamping, transitions |
| `tests/test_speaker_multi_marking.py` | The new CLI, its never-raises contract, lost-marking reports |
| `app/renderer/src/components/speakerReviewState.test.ts` | Renderer-side derivation of the marker and the notice |
| `e2e/specs/speaker-multi-marking.t2.spec.ts` | One review-state round-trip through the preload bridge |

---

### Task 1: The run block in the sidecar

**Files:**
- Modify: `src/speaker_suggestions.py` (`write_speakers_sidecar`)
- Test: `tests/test_speaker_suggestions.py`

**Interfaces:**
- Consumes: nothing.
- Produces: sidecar documents carrying an optional top-level `diarization_run` object with the string key `run_id` and the float key `created_at`. Every later task reads it via `sidecar.get("diarization_run")` and tolerates `None`.

- [ ] **Step 1: Write the failing tests.** In `tests/test_speaker_suggestions.py`, beside the existing sidecar tests, add three. First: `write_speakers_sidecar` produces a document whose `diarization_run.run_id` is a non-empty string and whose `created_at` is a float. Second: two successive `write_speakers_sidecar` calls for the same meeting produce **different** run ids, because each call is a new run. Third: a handwritten legacy document with no `diarization_run` key round-trips through `read_speakers_sidecar` unchanged and yields `None` for `.get("diarization_run")`.
- [ ] **Step 2: Run them and watch the first two fail.** `python -m unittest tests.test_speaker_suggestions -v`. The legacy test must already pass; if it does not, stop, because the reader is not as tolerant as the spec assumes.
- [ ] **Step 3: Mint the block.** In `write_speakers_sidecar`, add the `diarization_run` key to the payload it builds, with a fresh `uuid4` string and `time.time()`. Document in the docstring why it is minted **here**: all three new-run producers funnel through this function, so no call site needs new plumbing, and the read-modify-write helpers (`write_sidecar_document`, `set_cluster_multi_speaker`) rewrite the whole document and therefore preserve it - a rewrite is not a new run.
- [ ] **Step 4: Add the rewrite-preservation test.** Write a sidecar, call `set_cluster_multi_speaker` on it, and assert the run id is **unchanged**. This is the test that stops someone from later "helpfully" re-minting on every write.
- [ ] **Step 5: Run the module green.** `python -m unittest tests.test_speaker_suggestions`.
- [ ] **Step 6: Commit.** `git add src/speaker_suggestions.py tests/test_speaker_suggestions.py` with a message stating that a rewrite is deliberately not a new run.

---

### Task 2: The shared staleness predicate

**Files:**
- Modify: `src/speaker_suggestions.py`
- Test: `tests/test_speaker_suggestions.py`

**Interfaces:**
- Consumes: Task 1's run block shape.
- Produces: `prototype_run_matches(entry: dict, sidecar_run_id: Optional[str]) -> bool`, a module-level function beside `prototype_channel_matches`. `entry` is a prototype or hard-negative dict; `sidecar_run_id` is the current sidecar's run id or `None`. Every later task imports this one function and never re-implements the comparison.

- [ ] **Step 1: Write the failing test.** One test per row of the spec's section 4 table, named for the row: both absent means current; both present and equal means current; both present and different means stale; entry absent with sidecar present means stale; entry present with sidecar absent means stale. Assert `True` for current and `False` for stale.
- [ ] **Step 2: Run and watch all five fail.** `python -m unittest tests.test_speaker_suggestions -k run_matches -v`. Expected: the name does not exist.
- [ ] **Step 3: Implement the predicate.** Keep it small enough to read in one glance. The docstring carries the reasoning the table encodes, especially the asymmetry: an unstamped entry against a stamped sidecar can only arise if the meeting was re-diarized after the confirmation, which is the exact hazard this slice exists for, and the reverse combination is pinned stale defensively because only an older build could produce it.
- [ ] **Step 4: Run green.** `python -m unittest tests.test_speaker_suggestions -k run_matches`.
- [ ] **Step 5: Commit.**

---

### Task 3: Evidence remembers its run

**Files:**
- Modify: `src/config.py` (`add_speaker_prototype`), `simple_recorder.py` (`confirm-speaker`)
- Test: `tests/test_config.py`, `tests/test_confirm_speaker_cli.py`

**Interfaces:**
- Consumes: Task 1's run block.
- Produces: prototypes and hard negatives that may carry a `diarization_run_id` string. Task 4 and Task 5 read it only through Task 2's predicate.

- [ ] **Step 1: Write the failing tests.** In `tests/test_config.py`: `add_speaker_prototype` called with `diarization_run_id="r1"` stores it on the entry, and called without it stores **no such key at all** (not `None`) - matching how `channel` is handled. In `tests/test_confirm_speaker_cli.py`: confirming against a sidecar that has a run block produces a prototype carrying that exact run id, and confirming against a legacy sidecar produces a prototype with no run id. Both hard negatives and positives must carry it, so use the existing two-cluster fixture and assert on both profiles.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Thread the id.** Add the keyword-only parameter to `add_speaker_prototype` with default `None`, written only when not `None`. In `confirm-speaker`, read the run id once from the loaded sidecar and pass it to every `add_speaker_prototype` call in that command, including the mutual-hard-negative writes in both directions.
- [ ] **Step 4: Run both modules green.**
- [ ] **Step 5: Commit.**

---

### Task 4: Run scope on the write path

**Files:**
- Modify: `src/config.py` (`remove_speaker_evidence`, `delete_person_profile`), `simple_recorder.py` (`confirm-speaker`, `mark-speaker-cluster`)
- Test: `tests/test_config.py`, `tests/test_confirm_speaker_cli.py`

**Interfaces:**
- Consumes: Task 2's predicate, Task 3's stored id.
- Produces: `remove_speaker_evidence` with an added keyword-only run-scope parameter whose default is a distinct **sentinel meaning "unscoped"**, so any caller that does not pass it keeps today's behaviour exactly. Passing `None` explicitly means "scope to a run-less sidecar" and is not the same as not passing it.

- [ ] **Step 1: Write the failing test - the central one.** Two clusters, a legacy-free flow: confirm `SPEAKER_0` as Max against run `r1`; then simulate a re-diarization by writing a fresh sidecar (new run `r2`) whose `SPEAKER_0` is a different voice; then confirm the new `SPEAKER_0` as Sarah. Assert Max **still holds** his `r1` prototype, and Sarah holds one carrying `r2`. This currently deletes Max's prototype, which is the defect.
- [ ] **Step 2: Write the companion legacy test.** The same sequence with no run blocks anywhere must still remove the superseded prototype, exactly as today. Without this test the fix is free to over-correct and break the correction path on legacy libraries.
- [ ] **Step 3: Run and watch the first fail, the second pass.**
- [ ] **Step 4: Add the scope.** Give `remove_speaker_evidence` the sentinel-defaulted parameter; when scoped, an entry must additionally satisfy Task 2's predicate against the passed id to be removed. Then pass the sidecar's current run id from every in-repo caller: `confirm-speaker`'s reassignment loop and its negative-cleanup and idempotency-rebuild removals, and `mark-speaker-cluster`'s confirmation-withdrawal loop. In `delete_person_profile`'s cross-profile hard-negative cleanup, pass **each source prototype's own** run id, because those negatives were created in the same confirm and therefore the same run.
- [ ] **Step 5: Run both modules green, then the whole suite.** `python -m unittest discover tests`. Compare against the 944 baseline; only `test_bundle_mlx` may be red.
- [ ] **Step 6: Commit,** stating in the message the trade the spec accepts: a wrong old-run confirmation can no longer be corrected by re-confirming, because silently destroying genuine evidence is the worse failure and the one happening today.

---

### Task 5: Run awareness on the read path

**Files:**
- Modify: `simple_recorder.py` (`suggest-speakers`, `confirm-speaker`'s `still_present` and mutual-negative `matches` loop, `speaker-naming-status`)
- Test: `tests/test_suggest_speakers_cli.py`, `tests/test_confirm_speaker_cli.py`

**Interfaces:**
- Consumes: Task 2's predicate.
- Produces: `suggest-speakers` gains a top-level `stale_assignments` array of `{person_id, display_name}`. The renderer (Task 7) renders one meeting-level notice from it. Absent or empty means nothing to report.

- [x] **Step 1: Write the failing tests.** A prototype from run `r1` against a sidecar stamped `r2` must **not** produce `confirmed_by_user` or `confirmed_person_id` for that cluster, and must appear once in `stale_assignments`. A prototype from `r2` against `r2` behaves exactly as today. A legacy pair (no ids at all) behaves exactly as today. Add one test that `speaker-naming-status` does not count a stale prototype's cluster as named.
- [x] **Step 2: Run and watch them fail.**
- [x] **Step 3: Apply the predicate at every reader.** The `confirmed_by_user` / `confirmed_person_id` derivation; `still_present`; the mutual-negative `matches` selection - without scoping there, a stale old-run prototype whose sid collides with a new-run sid would be treated as owning the new cluster and would seed negatives built from the new run's embeddings. Then assemble `stale_assignments`, deduped per person.
- [x] **Step 4: Leave participants alone, and say why in the code.** `confirmed_participant_names` stays meeting-scoped. Add the comment: attendance is a property of the meeting, not of a run, and run-filtering the `full-reprocess` restore would empty the section on every reprocess. Without that comment a later reader will "fix" it.
- [x] **Step 5: Run green, then the whole suite.**
- [x] **Step 6: Commit.**

---

### Task 6: Persisted review state, backend

**Files:**
- Modify: `src/speaker_suggestions.py` (write helper, merged propagation), `simple_recorder.py` (new CLI, transitions, `suggest-speakers` echo)
- Test: `tests/test_speaker_multi_marking.py`, `tests/test_speaker_suggestions.py`

**Interfaces:**
- Consumes: the sidecar document helpers.
- Produces: per-cluster optional key `review_state` with the single value `"generic"`; CLI `set-cluster-review-state <meeting_stem> <channel> <diarization_speaker_id> --generic|--clear`; `suggest-speakers` echoes `review_state` per cluster so the renderer can read it.

- [x] **Step 1: Write the failing tests.** The helper sets and clears the key on the exact raw id it was handed. A merged row reads as generic when **any** raw member carries it, mirroring how `merge_same_channel_fragments` already computes `contains_multiple_speakers` with `any()`. `confirm-speaker` clears it from **every fragment id** of the confirmed cluster, and `mark-speaker-cluster --multiple` does the same - so no orphaned key on a non-primary fragment can keep a row generic after a confirm. The CLI's never-raises contract: missing sidecar, missing channel, and missing cluster each produce `success: false` JSON and exit 1, with no traceback.
- [x] **Step 2: Run and watch them fail.**
- [x] **Step 3: Implement the helper and the CLI.** The write helper mirrors `set_cluster_multi_speaker`: re-read the freshest sidecar immediately before writing, apply the one change, replace atomically via `write_sidecar_document`. The CLI mirrors `mark-speaker-cluster`'s argument shape and reports the merged reach (resolved id plus fragment set) in its JSON.
- [x] **Step 4: Wire the transitions and the echo.** Clear on confirm and on mark; echo `review_state` per cluster from `suggest-speakers`.
- [x] **Step 5: Run green, then the whole suite.**
- [x] **Step 6: Commit.**

---

### Task 7: Persisted review state, renderer

**Files:**
- Modify: `app/main.js`, `app/preload.js`, `app/renderer/src/hooks/useSpeakerSuggestions.ts`, `app/renderer/src/components/SpeakerReviewPanel.tsx`, `app/renderer/src/lib/ipc.ts`
- Create: `app/renderer/src/components/speakerReviewState.test.ts`
- Test: the new vitest file, plus `e2e/specs/speaker-review.t1.spec.ts`

**Interfaces:**
- Consumes: Task 6's CLI and echo, Task 5's `stale_assignments`.
- Produces: `speakers.setClusterReviewState({ meetingStem, channel, diarizationSpeakerId, generic })` on the preload bridge, and `useSetClusterReviewState` in the hooks module.

- [x] **Step 1: Write the failing renderer tests.** Beside `speakerReviewOrdering.test.ts`, test the pure derivations rather than the component internals: a row whose suggestion carries `review_state: "generic"` reads as kept-generic; the notice text is produced when `stale_assignments` is non-empty and not when it is empty. Extract the derivations as exported helpers so they are testable without mounting, the same way `orderProfilesForRow` already is.
- [x] **Step 2: Replace the T1 test that pins the old behaviour, deliberately.** `speaker-review.t1.spec.ts` currently holds `'Keep generic dismisses the row locally, no confirm call needed'`, which asserts the row reaches `toHaveCount(0)`. This slice inverts that on purpose, so the test must be **rewritten and renamed** - its present name becomes false. The replacement asserts the new contract: after clicking, the row stays visible, reads as kept generic, and the undo is one click away. Renaming it is the point: a silently adjusted assertion would disguise a product decision as test maintenance. Then add the two new assertions - the button is absent on a confirmed row and on a mixed row - and extend `app/e2e-mock-ipc.js` with the new handler and the `review_state` echo so the mock matches the real contract. Leave the in-flight-disabled assertion around line 253 intact; it covers a different property of the same button.
- [x] **Step 3: Run both and watch them fail.** `npx vitest run` and `npm run test:e2e -- --project=t1 --grep speaker`.
- [x] **Step 4: Bridge and wire.** The `ipcMain.handle` mirrors the `mark-speaker-cluster` handler including `parsePythonFailureJson` on error; the preload entry joins the existing `speakers` group; the hook invalidates `speakersKeys.suggestions(meetingStem)`. In the panel, the button calls the mutation, and the `dismissed` state and its `notDismissed` filtering are **removed** - the marker now comes from query data, which is what makes it survive a remount by construction. Gate the button off on confirmed and mixed rows; today it renders on both because it sits outside the `!isMarked` conditional.
- [x] **Step 5: Run typecheck, lint, vitest, T1.** Compare lint against the 37/0 baseline.
- [x] **Step 6: Commit.**

---

### Task 8: Report the lost markings

**Files:**
- Modify: `simple_recorder.py` (`backfill-speaker-embeddings`, `reprocess --retranscribe` via `_persist_speaker_sidecar`)
- Test: `tests/test_backfill_cli.py`, `tests/test_speaker_multi_marking.py`

**Interfaces:**
- Consumes: Task 6's key.
- Produces: no new public surface; a counted, logged report on both paths.

- [x] **Step 1: Write the failing tests.** `backfill-speaker-embeddings --force` over a sidecar carrying `review_state` markings reports their count alongside the existing `lost_multi_speaker_markings`. The `reprocess --retranscribe` path emits a warning naming both counts where today it emits nothing - this is the pre-existing silent loss, so assert on the current silence first to prove the test bites.
- [x] **Step 2: Run and watch them fail.**
- [x] **Step 3: Implement.** The backfill already reads the previous sidecar before overwriting; extend its accounting. Give `_persist_speaker_sidecar` the same read-before-overwrite accounting, reported as a `logger.warning` plus one greppable stdout line mirroring the backfill's wording, because `reprocess` streams lines rather than one JSON document. Do not surface it in the renderer; that is out of scope.
- [x] **Step 4: Run green.**
- [x] **Step 5: Commit.**

---

### Task 9: The e2e round-trip

**Files:**
- Modify: `e2e/specs/speaker-multi-marking.t2.spec.ts`
- Test: itself

**Interfaces:**
- Consumes: everything above.
- Produces: the standing-rule coverage for a user-facing change.

- [x] **Step 1: Write the failing spec.** Drive `window.stenoai.speakers.setClusterReviewState` through the preload bridge against the real backend, then read the meeting's `_speakers.json` from disk and assert the `review_state` key on the right cluster; clear it and assert it is gone. Model-free, following the existing T2 speaker specs.
- [x] **Step 2: Run and watch it fail.** `npm run test:e2e -- --project=t2 --grep-invert @pipeline`.
- [x] **Step 3: Confirm the compatibility proof still holds.** `speaker-naming.t2` and `speaker-multi-marking.t2` must pass against the **unchanged**, legacy-shaped `writeSpeakersSidecar` fixture. If a change to that fixture was needed to make anything pass, the backward compatibility is broken and the cause is in Tasks 1-6, not in the fixture.
- [x] **Step 4: Full verification.** `ruff check .`, `python -m unittest discover tests`, `npm run typecheck:renderer`, `npm run lint:renderer`, `npx vitest run`, T1 and model-free T2. Compare every number against the baseline in Global Constraints and classify any difference.
- [x] **Step 5: Commit.**

---

## Review gate

This slice changes a persisted format and the evidence-mutation path, so it earns the full loop rather than the light one:

- Run `/codex:review --base origin/feat/speaker-diarization` over the whole branch diff, not per task. The failure mode this slice can produce is silent and cross-file (evidence deleted or wrongly kept), which per-task review does not see.
- Reconcile every finding: adopt it, or reject it with a stated reason. Never drop one silently.
- Then stop. Pushing and opening the PR is the maintainer's call.

## Self-review notes

Checked against the spec: sections 1-8, backward compatibility, and the whole testing section each map to a task above. Section 4's `stale_assignments` output is produced in Task 5 and consumed in Task 7; section 6's merged propagation is in Task 6; section 8's pre-existing `reprocess` bug is in Task 8. The one spec item deliberately without a task is the participants decision, which is a **non**-change plus a comment, and is folded into Task 5 Step 4 where a reader would otherwise be tempted to change it.

Deviation from the writing-plans skill, on the repo owner's standing instruction: the steps carry exact file, function and assertion descriptions rather than finished code blocks. Finished code in a plan switches the implementer's thinking off, and the reasoning in the prose is the part that has to survive.
