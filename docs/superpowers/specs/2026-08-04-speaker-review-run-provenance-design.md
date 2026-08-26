# Speaker review: run provenance and persisted review state - design

Date: 2026-08-04.
Branch: `feat/speaker-many-to-one`.
Status: agreed design, pressure-tested by two independent reviews; this document is the build contract for the slice.

This slice is deliberately ADDITIVE.
Today `confirm-speaker` immediately writes a global person profile plus a voiceprint prototype, so the prototype IS the assignment.
A later slice will invert that (assignments as source of truth, evidence derived from them); nothing here anticipates that inversion beyond not blocking it.

## The two defects this slice targets

Both are real in the code today.

1. **"Keep generic" is not persisted.**
   The review panel's "Keep generic" button only adds the row key to the `dismissed` React `useState` set and filters the row out client-side (`app/renderer/src/components/SpeakerReviewPanel.tsx`, the `dismissed` state and the `speaker-keep-generic-*` button).
   A half-finished review starts from zero after an app restart, a navigation away, or even a panel remount.
2. **Nothing notices a new diarization run.**
   `reprocess --retranscribe` (via `_persist_speaker_sidecar`, `simple_recorder.py`), `backfill-speaker-embeddings --force`, and `full-reprocess` each produce a fresh diarization run whose `SPEAKER_N` ids are numbered independently of the previous run, so the same id now means a different voice.
   Old prototypes keep pointing at those ids: the `confirmed_by_user` / `confirmed_person_id` derivation in `suggest-speakers` (`simple_recorder.py`) matches only on `(meeting_id, diarization_speaker_id, channel)`, so a new run's `SPEAKER_0` silently shows up as "Confirmed as X" from a prototype recorded against a different voice.
   `reprocess --retranscribe` even documents the consequence in a code comment ("KNOWN CONSEQUENCE, deliberately not worked around") - this slice is the working-around.

## 1. Run identity

`write_speakers_sidecar` (`src/speaker_suggestions.py`) gains a new optional top-level sidecar key:

```json
"diarization_run": { "run_id": "<uuid4>", "created_at": 1754300000.0 }
```

- A fresh `run_id` (uuid4) is minted inside `write_speakers_sidecar` itself.
  Every fresh diarization run funnels through this one function - the live pipeline and `reprocess --retranscribe` via `_persist_speaker_sidecar`, `full-reprocess` via `process-streaming` and then the same helper, and `backfill-speaker-embeddings` directly - so minting there needs no new plumbing at any call site.
- Read-modify-write paths (`set_cluster_multi_speaker` / `write_sidecar_document`) rewrite the whole document and therefore preserve the block untouched.
  A rewrite is not a new run.
- **No audio fingerprint.**
  `keep_recordings` defaults to false (`src/config.py`), so the source audio is usually gone right after processing; a fingerprint could never be re-verified later, while costing a full file hash on every run.
  The run id identifies the run event, not the audio.
- **No engine / engine_version fields.**
  Cut from this slice by review: they would need new plumbing from the transcriber into the sidecar writer, and nothing in this slice consumes them.

## 2. Evidence remembers its run

`add_speaker_prototype` (`src/config.py`) gains a keyword argument `diarization_run_id: Optional[str] = None`, stored on the entry beside `meeting_id` and `diarization_speaker_id`, and only written when not None - the same absent-means-legacy convention the `channel` field already uses there.
It applies to hard negatives exactly as to positive prototypes: both are built from the current sidecar's clusters, so both carry the run they came from.

`confirm-speaker` (`simple_recorder.py`) reads the sidecar's current run id (`sidecar.get("diarization_run")`, absent on legacy sidecars) and passes it into every `add_speaker_prototype` call it makes, including the mutual-hard-negative writes.

## 3. Persisted review state

One new optional per-cluster sidecar key, written into the cluster entry itself (same placement rationale as `MULTI_SPEAKER_KEY` in `src/speaker_suggestions.py`: it travels with exactly the cluster it describes and cannot be orphaned by an id change):

```json
"review_state": "generic"
```

Exactly one value in this slice, and deliberately so:

- `assigned` is derivable from a matching prototype (that is what `confirmed_by_user` already does).
- `mixed` already exists as `contains_multiple_speakers`.
- `unreviewed` is the absence of everything.

Recording any of those as a second copy would create a consistency obligation with no information gain.
The key is only written when set; absent means "not marked", so every pre-existing sidecar reads correctly.
`review_state` changes no scoring and no suggestion status - it is purely a persisted review-progress marker.

**New CLI `set-cluster-review-state`** (`simple_recorder.py`), mirroring `mark-speaker-cluster`'s shape: positional `meeting_stem channel diarization_speaker_id`, a `--generic/--clear` flag pair, JSON output.
The write helper mirrors `set_cluster_multi_speaker` (re-read the freshest sidecar immediately before writing, apply the one change, replace atomically via `write_sidecar_document`).
Never-raises contract: any failure (missing sidecar, channel, or cluster; unreadable file) prints `{"success": false, "error": ...}` and exits 1 - never a traceback.

**IPC and renderer wiring**, all following the existing `mark-speaker-cluster` pattern:

- `app/main.js`: an `ipcMain.handle('set-cluster-review-state', ...)` that shells out and returns `parsePythonFailureJson` on error, like the `mark-speaker-cluster` handler.
- `app/preload.js`: `speakers.setClusterReviewState(params)` in the existing `speakers` group.
- `app/renderer/src/hooks/useSpeakerSuggestions.ts`: a `useSetClusterReviewState` mutation invalidating `speakersKeys.suggestions(meetingStem)`.
- `SpeakerReviewPanel.tsx`: the existing "Keep generic" button calls the mutation instead of `setDismissed`.
  The `dismissed` local state and its `notDismissed` filtering are removed; the marker is read from the suggestions query (`suggest-speakers` echoes `review_state` per cluster), so it survives remounts and restarts by construction.
- **Behavior change, deliberate:** today the button hides the row for the session.
  Under this design the row stays visible, quietly marked as kept generic, with the undo one click away - a persisted-but-hidden row would make the undo undiscoverable.

## 4. Staleness on the read path

`suggest-speakers` compares each prototype's `diarization_run_id` with the sidecar's current run id.
The rule is deliberately ASYMMETRIC because of how the two ids can come to disagree:

| prototype run id | sidecar run id | verdict | why |
|---|---|---|---|
| absent | absent | current | pure legacy, nothing was ever re-diarized with run stamping |
| present | present, equal | current | confirmed against exactly this run |
| present | present, different | stale | confirmed against a different run's clusters |
| absent | present | stale | a fresh run happened after the confirmation. Note this is the ordinary upgrade path, not an exotic one: confirming against a still-legacy sidecar stores no id even on a stamped build, and the meeting's first re-diarization then stamps the sidecar |
| present | absent | stale | defensive: reachable through a build without run stamping, or through a restored `.bak` sidecar. Either way the sidecar's clusters are not provably the confirm-time run |

The rule lives as one shared predicate in `src/speaker_suggestions.py` (beside `prototype_channel_matches`, which `src/config.py` already imports the same way), so the read path and the write path below cannot drift apart.

Consequences in `suggest-speakers`:

- Only prototypes current under the rule may populate `confirmed_by_user` / `confirmed_person_id` (and thereby the panel's `alreadyInMeeting` set).
- Stale prototypes are collected into a new top-level output field, e.g. `stale_assignments: [{person_id, display_name}]`, and the panel renders one meeting-level notice from it: this meeting was re-diarized, earlier assignments no longer map to the clusters below, re-confirm them.
- **Nothing is deleted.**
  Stale prototypes remain real voice evidence of a real person and keep feeding candidate scoring - `score_candidates` (`src/speaker_suggestions.py`) pools all of a person's prototypes by recording type and is untouched by this slice.

## 5. Run scope on the write path (the central review finding)

`remove_speaker_evidence` (`src/config.py`) matches only on `(meeting_id, channel-or-recording-type, sids)` today.
After a re-diarization the new run's first cluster is called `SPEAKER_0` again, so confirming it as a different person walks the reassignment loop in `confirm-speaker` and deletes the previous person's genuine old-run prototype - the one recorded against a genuinely different voice.
Without run-scoped removal the design contradicts its own promise that nothing is deleted.

- `remove_speaker_evidence` gains a keyword-only run-scope parameter with a distinct "unscoped" sentinel default (so out-of-tree callers keep today's behavior), and every in-repo caller passes a run id, possibly None.
  When scoped, an entry must additionally be run-compatible with the passed id under the shared predicate from section 4 to be removed.
  Note the legacy symmetry this preserves: confirming on a never-restamped legacy sidecar (both ids absent, "current") still removes the superseded legacy prototype, exactly as today.
- Callers and what they pass:
  - `confirm-speaker`'s reassignment loop and all its negative-cleanup and idempotency-rebuild removals: the sidecar's current run id.
  - `mark-speaker-cluster`'s confirmation-withdrawal loop: the sidecar's current run id.
  - `delete_person_profile`'s cross-profile hard-negative cleanup (`src/config.py`): each source prototype's OWN run id, since the derived negatives were created in the same confirm and therefore the same run.
- The same run awareness applies anywhere evidence is READ as a current assignment, all via the shared predicate:
  - `confirm-speaker`'s `still_present` check (does this person still own a cluster in this channel) and its mutual-hard-negative `matches` loop - without scoping, a stale old-run prototype whose sid happens to collide with a new-run sid would be treated as owning the new cluster and would seed wrong negatives from the new run's embeddings.
  - `suggest-speakers`' `confirmed_by_user` / `confirmed_person_id` derivation (section 4).
  - `speaker-naming-status`' named-cluster count (`simple_recorder.py`) - a stale prototype must not make a new, actually-unnamed cluster count as named in the delete-confirmation warning.
- **Participants stay meeting-scoped, and that is the deliberate form of run awareness there.**
  `confirmed_participant_names` (`src/speaker_suggestions.py`) matches on `meeting_id` only.
  Attendance is a property of the meeting, not of a diarization run: a stale prototype still proves that person was confirmed as present in this meeting, and run-filtering the `full-reprocess` participants restore would empty the section on every reprocess, deleting correct information.
  So the participants derivation (restore in `full-reprocess`, upkeep in `confirm-speaker` and `mark-speaker-cluster`) reports the union across runs, deduped per person, and the code says so explicitly so a later reader does not "fix" it into run scoping.
- **Known limitation, stated rather than hidden:** with run-scoped removal, re-confirming a new run's cluster can no longer correct a WRONG old-run confirmation (the old prototype now survives on purpose).
  The remedies are deleting the person, the existing repair CLI's precise `remove_speaker_evidence_by_ids` path, or the future assignment-inversion slice.
  This trade is accepted: silently destroying genuine evidence is the worse failure, and it is the one happening today.

## 6. Merged rows

`review_state` is written on raw cluster ids, while the panel shows rows merged by `merge_same_channel_fragments` (`src/speaker_suggestions.py`).
Two rules, both copied from how `contains_multiple_speakers` already handles the same mismatch:

- `set-cluster-review-state` accepts any raw id and writes to exactly the id it was handed, the same way `mark-speaker-cluster` / `set_cluster_multi_speaker` do, reporting the merged reach (resolved id plus fragment set) in its JSON output.
- The merged view propagates with `any()`: a merged row reads as generic when ANY of its raw members carries the key - the same deliberate choice `merge_same_channel_fragments` makes when it computes the merged context's `contains_multiple_speakers` from its members.
- Clears initiated by transitions (section 7) sweep the full fragment set, so no orphaned key on a non-primary fragment can keep a row generic after a confirm.

## 7. Explicit transitions

`generic` means "a human chose to stop here"; any stronger statement supersedes it.

- `confirm-speaker` clears `review_state` from every fragment id of the confirmed cluster.
- `mark-speaker-cluster --multiple` clears it the same way.
- The "Keep generic" button disappears on confirmed rows and on mixed rows.
  Today it is still rendered there: in `SpeakerReviewPanel.tsx` the button sits outside the `!isMarked` conditional that hides the naming actions, and nothing gates it on `confirmed_by_user` - verified against the component.

## 8. Report the loss

A re-diarization drops review markings (`review_state` and `contains_multiple_speakers` alike): the new run numbers its clusters independently, so the old ids describe nothing, and carrying the markings forward would attach human statements to whichever voices happened to inherit the ids.
Losing them is semantically right; losing them SILENTLY is not.

- `backfill-speaker-embeddings` already reads the previous sidecar before overwriting and reports `lost_multi_speaker_markings` in its JSON result plus a `logger.warning` (`simple_recorder.py`).
  It additionally counts and reports lost `review_state` markings the same way.
- **Pre-existing bug, fixed in this slice because it touches exactly this path:** `reprocess --retranscribe` rewrites the sidecar through `_persist_speaker_sidecar` with no such report - the markings vanish silently.
  It gains the same read-before-overwrite accounting.
  `reprocess` streams line-oriented output rather than one JSON document, so the report there is a `logger.warning` plus a clearly greppable stdout line, mirroring the backfill's wording; surfacing it in the renderer beyond the section 4 stale notice is not part of this slice.
- `full-reprocess` backs the old sidecar up as `.bak-<timestamp>` before overwriting and already prints a note that confirmations were reset, which satisfies the reporting requirement there.

## Backward compatibility

- Both new sidecar keys are optional; `read_speakers_sidecar` and every consumer treat absence as legacy.
- A legacy sidecar (no run block) still supports confirm/suggest/mark/set-review-state; confirms from it store no run id, and the staleness rule's both-absent row keeps everything current.
- Prototypes without `diarization_run_id` behave exactly as today until the first stamped re-diarization of their meeting, at which point the absent-vs-present row correctly reports them stale.
- The e2e fixture `writeSpeakersSidecar` (`e2e/fixtures/user-config.ts`) stays legacy-shaped with no run block on purpose: `speaker-naming.t2.spec.ts` and `speaker-multi-marking.t2.spec.ts` staying green against it IS the backward-compatibility proof.

## Not in scope

Stated as explicitly as what is in scope:

- The assignment/evidence inversion (assignments as source of truth, prototypes derived).
- Meeting-local placeholder people.
- Deliberate over-segmentation of the diarizer.
- Any diarization engine change, and the `engine` / `engine_version` sidecar fields.
- An audio fingerprint in the run block.
- Migrating or backfilling run ids onto existing prototypes or sidecars.
- Any renderer surfacing of the lost-markings report beyond the stale-assignment notice.

## Testing

Python (`tests/`, following the existing `test_speaker_suggestions.py` / `test_confirm_speaker_cli.py` / `test_speaker_multi_marking.py` patterns):

- Sidecar round-trip through `write_speakers_sidecar` / `read_speakers_sidecar` with the new keys present, and a handwritten legacy document without them reading cleanly.
- The staleness matrix from section 4 against the shared predicate - the four reachable cases plus the defensive fifth row.
- Run-scoped removal: an old-run prototype for `(meeting, mic, SPEAKER_0)` survives a re-confirm of the new run's `SPEAKER_0` as a different person, while the new prototype carries the new run id; and the legacy both-absent re-confirm still removes the superseded prototype as today.
- `set-cluster-review-state` end to end, including its never-raises contract: missing sidecar, channel, and cluster each produce JSON `success: false` and exit code 1, no traceback.
- Merged-row propagation: with two raw clusters close enough to merge, `review_state` written on the non-primary fragment marks the merged row, and a confirm clears the whole fragment set.

Renderer (vitest + testing-library, beside `speakerReviewOrdering.test.ts`):

- The generic marking survives a panel remount (it derives from query data, not component state).
- The stale-assignment notice renders when `stale_assignments` is non-empty.
- The "Keep generic" button is absent on confirmed rows and on mixed rows.

e2e:

- `speaker-naming.t2.spec.ts` and `speaker-multi-marking.t2.spec.ts` run unchanged against the legacy-shaped fixture (the compatibility proof above).
- Per the repo's standing e2e rule, the model-free T2 speaker spec gains one minimal review-state round-trip: drive `speakers.setClusterReviewState` through the preload bridge and assert the `review_state` key in the sidecar JSON on disk - the fixture itself stays legacy-shaped.

## Claims checked against the code

Every code reference above was read in this checkout before being cited.
The briefed design matched the code at every load-bearing point; two findings sharpen it rather than contradict it:

- The new-run producers are three, not two: `full-reprocess` also produces a fresh run (via `process-streaming`).
  All three funnel through `write_speakers_sidecar`, which is why minting the run id there covers them without new plumbing.
- The staleness rule as briefed enumerates four cases; the fifth combination (prototype stamped, sidecar unstamped) is unreachable through this slice's own writers but reachable through an older build, so it is pinned defensively as stale above rather than left undefined.
