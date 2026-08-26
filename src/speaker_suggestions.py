"""Named (non-self) speaker identification: rank known PersonProfiles as
candidates for a diarized cluster, but never auto-assign — a human confirms
via the CLI (`suggest-speakers`) today and the approval UI later (see the
plan doc). This replaces the silent auto-matching that used to live in
src.transcriber._apply_voiceprint_matches's named-matching path, removed
after real-ground-truth validation (AMI Meeting Corpus, individual headset
mics) found people sharing a room/mic score artificially similar to each
other regardless of true identity — a channel/session bias no amount of
threshold/margin tuning fixed. Self-match ("You") is unaffected and stays
in src.transcriber.

Two structural differences from the removed auto-matcher, both aimed
directly at that same-room bias:
- **context-aware prototypes**: a person's evidence is split by
  `recording_type` (in_person/remote/imported/unknown) rather than one
  flat running-averaged embedding, so an in-person (shared-mic, possibly
  contaminated) sample is compared against other in-person samples first,
  not blended into a clean remote-audio sample for the same person.
- **hard negatives**: when a meeting confirms multiple different real
  people, each one's profile records the others as confirmed-NOT-this-
  person evidence (see src.config.Config.add_speaker_prototype), and a
  candidate whose embedding is ALSO suspiciously close to a stored
  hard-negative gets suppressed rather than suggested.

What this module does NOT do: measure "internal cluster consistency" via
per-chunk embedding variance, despite that being part of the original
design spec's stability gate. The Swift sidecar's JSON contract
(diarize-sidecar/Sources/main.swift) only exposes one aggregated centroid
per speaker slot today, not the individual per-chunk embeddings that would
be needed to measure agreement — extending that contract is explicitly out
of scope for this phase (see the plan doc). Stability here is duration +
segment-count + average-turn-length gates, all derivable from diarization
segment timestamps alone. The average-turn-length gate was added after
real-library validation found it's what actually separates genuine sustained
speech from a fragmented echo/crosstalk artifact cluster — duration and
segment count alone can't tell the two apart (see SUGGESTION_MIN_AVG_TURN_SECONDS).
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import subprocess
import tempfile
import time
import uuid
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from src.voiceprint import cosine_distance
from src.speaker_schema import VALID_CHANNELS, validate_embedding, validate_meeting_stem

logger = logging.getLogger(__name__)

# Distance a candidate must clear (lower = more similar; same cosine-distance
# convention as src.transcriber's VOICEPRINT_DISTANCE_THRESHOLD). Illustrative
# starting point, ported from the design spec's similarity-scale numbers
# (best_score > 0.75 similarity ~= distance < 0.25) but kept conservative at
# parity with the existing self-match threshold pending real-data re-tuning
# via the Phase 3 backfill CLI report — see the plan doc's Phase 3 section.
SUGGESTION_DISTANCE_THRESHOLD = 0.40
# The best candidate must beat the runner-up by at least this much distance,
# or the suggestion is withheld even if the best candidate clears the
# threshold on its own — same rationale as VOICEPRINT_CONFIDENCE_MARGIN.
SUGGESTION_CONFIDENCE_MARGIN = 0.10
# Hard-negative suppression is RELATIVE, not a bare cutoff: a candidate is
# suppressed only when its embedding is meaningfully close to one of that
# person's stored hard-negatives (this absolute gate, same scale as
# SUGGESTION_DISTANCE_THRESHOLD) AND that negative evidence is comparable
# to or stronger than the positive evidence (negative distance within
# SUGGESTION_CONFIDENCE_MARGIN of, or below, the best prototype distance).
# An earlier absolute-only rule suppressed genuinely strong matches — a
# candidate at distance 0.15 to its real prototype was discarded because
# some negative sat at 0.39 — which punished exactly the people confirmed
# most often, since every confirmation of a colleague adds negatives that
# sit at ordinary cross-speaker distances (~0.4) from everyone else.
HARD_NEGATIVE_DISTANCE_THRESHOLD = 0.40
# Stability gate: a cluster must clear all three before a suggestion is
# trusted enough to auto-fill as "confirmed" rather than a soft "might be X".
SUGGESTION_MIN_DURATION_SECONDS = 20.0
SUGGESTION_MIN_SEGMENT_COUNT = 3
# Real duration/segment-count alone don't catch a fragmented artifact cluster
# (echo/crosstalk bleed of another real speaker into this channel) racking up
# enough cumulative duration and turn count to look "stable" despite never
# resembling one person actually holding a conversation. Ground-truthed
# against the user's real meeting library: every false-positive suggestion
# found (8 clusters, all confirmed-not-that-person by the user) had an
# average turn of 1.525s or less; the weakest genuine confirmed match (an
# a representative anchor prototype) sits at 1.61s. Set with margin on both
# sides of that gap.
SUGGESTION_MIN_AVG_TURN_SECONDS = 1.55
# A person needs evidence from at least this many DISTINCT meetings -- not
# raw prototype count -- before a suggestion for them is trusted enough to
# auto-fill as "confirmed". Two prototypes confirmed from fragments of the
# SAME meeting (e.g. a diarizer-split voice, see merge_same_channel_fragments)
# is still only one real-world sample of that person's voice/session/room --
# it doesn't demonstrate the profile generalizes across different audio
# conditions the way genuinely independent sessions do. This is a structural
# safeguard (how much independently-verified evidence exists), not a number
# fit to any particular distance distribution -- grounded in the documented
# instability of cosine/PLDA-style scoring under small, undiversified
# enrollment sets. Below this, cap status at "possible" regardless of how
# good distance/margin/stability look.
SUGGESTION_MIN_CONFIRMED_MEETINGS = 2
# Same-channel, same-meeting fragment-merge threshold -- deliberately much
# stricter than SUGGESTION_DISTANCE_THRESHOLD, and safe to be: comparisons
# here are between clusters that already share the same recording's channel
# fingerprint identically, so they can't be pulled artificially close by
# the cross-recording room/mic bias SUGGESTION_DISTANCE_THRESHOLD has to
# stay cautious about. Set with margin below the tightest confirmed-
# different-person distance measured all session (0.11, AMI Meeting Corpus
# testing) -- real same-recording diarizer fragments of one person were
# found at 0.02-0.07, categorically tighter. See the plan doc's Phase 3.6.
SAME_MEETING_MERGE_DISTANCE_THRESHOLD = 0.10


def determine_recording_type(channel: str, has_audio: bool) -> str:
    """Heuristic from the plan doc, refined per-channel during
    implementation: the mic channel always captures whoever is physically
    in the room (regardless of whether a *separate* remote call is ALSO
    happening on the system channel in a hybrid meeting — a two-flag
    combined heuristic would wrongly relabel the mic channel "remote" in
    that case), so `channel="mic"` -> `in_person` whenever it has real
    audio. The system channel is, by construction, other participants'
    own devices/mics captured via loopback — never sharing this room's
    acoustics with each other — so `channel="system"` -> `remote` whenever
    it has real audio. Either channel with no real audio -> `unknown`
    rather than a guess. `imported` isn't derivable from audio content
    alone and isn't set here; callers with a stronger signal (e.g. a
    user-initiated file import) can set it directly."""
    if not has_audio:
        return "unknown"
    return "in_person" if channel == "mic" else "remote"


def prototype_channel_matches(prototype: dict, channel_name: str, channel_recording_type) -> bool:
    """Does a stored prototype/hard-negative belong to this sidecar channel?

    Channel identity matters because mic and system channels number their
    diarizer clusters independently -- a `(meeting_id, diarization_speaker_id)`
    pair alone is ambiguous, and matching on it without the channel once
    recorded hard negatives derived from the wrong channel's clusters
    (the cross-channel id-collision bug this helper exists to prevent).

    Prototypes written since the `channel` field exists match on it exactly.
    Legacy prototypes (no `channel` key) fall back to `recording_type` as a
    channel proxy -- the same mic->in_person / system->remote mapping
    `determine_recording_type` derives, and the check the codebase already
    used where channel scoping mattered. The proxy can't distinguish two
    channels that both recorded as "unknown"; the repair CLI backfills
    `channel` onto legacy entries from their meeting's sidecar so this
    fallback path shrinks over time.
    """
    channel = prototype.get("channel")
    if channel is not None:
        return channel == channel_name
    return prototype.get("recording_type") == channel_recording_type


def prototype_run_matches(entry: dict, sidecar_run_id) -> bool:
    """Is a stored prototype/hard-negative still evidence about the sidecar's
    CURRENT diarization run's clusters?

    Both the read path (which prototypes may populate `confirmed_by_user`)
    and the write path (`remove_speaker_evidence`'s run-scoped removal) call
    this one predicate so they can never drift apart on what "still current"
    means (see docs/superpowers/specs/2026-08-04-speaker-review-run-provenance-design.md
    section 4/5).

    The two mixed absent/present cases are deliberately asymmetric, because
    they arise from different histories rather than a coin flip:
    - entry absent, sidecar present: only reachable if the meeting was
      re-diarized (stamping the sidecar with a run id) AFTER the entry was
      confirmed on a build that predates run stamping. The entry's clusters
      are provably not this run's clusters, so it is stale -- this is the
      exact hazard this slice exists to catch.
    - entry present, sidecar absent: only reachable if a build WITHOUT run
      stamping re-diarized a meeting whose entry was confirmed by a build
      WITH it -- the reverse order from the case above, and not the one this
      slice targets. Nothing proves the now-unstamped sidecar's clusters are
      the confirmed run's clusters, so this is pinned stale defensively too.
    Both absent stays current: pure legacy, nothing here was ever run-stamped.
    """
    entry_run_id = entry.get("diarization_run_id")
    if entry_run_id is None and sidecar_run_id is None:
        return True
    return entry_run_id == sidecar_run_id


def build_clusters_from_diarization(segments: list, embeddings: dict) -> dict:
    """Group one channel's raw diarizer segments + per-speaker embeddings
    into the `clusters` shape `write_speakers_sidecar` expects:
    `{diarization_speaker_id: {"embedding": [...],
    "speech_duration_seconds": float, "segment_count": int,
    "segments": [{"start", "end"}, ...]}}`.

    Shared by both the live pipeline (src.transcriber._tag_channel_segments,
    called once per channel during a normal recording -- no extra
    diarization run, just reshaping the result it already computed) and
    `backfill-speaker-embeddings` (simple_recorder.py, re-diarizing an
    already-processed meeting from its saved audio) -- both start from the
    exact same `(segments, embeddings)` shape `_run_steno_diarize` returns.
    """
    totals: dict = {}
    counts: dict = {}
    timestamps: dict = {}
    for seg in segments:
        sid = seg["speaker"]
        totals[sid] = totals.get(sid, 0.0) + (seg["end"] - seg["start"])
        counts[sid] = counts.get(sid, 0) + 1
        timestamps.setdefault(sid, []).append({"start": seg["start"], "end": seg["end"]})

    return {
        sid: {
            "embedding": embeddings[sid],
            "speech_duration_seconds": totals.get(sid, 0.0),
            "segment_count": counts.get(sid, 0),
            "segments": timestamps.get(sid, []),
        }
        for sid in embeddings
        if sid in totals
    }


@dataclass
class ClusterContext:
    """Everything about one diarized cluster needed to score and persist a
    suggestion — mirrors the fields on SpeakerPrototype (src.config) so a
    confirmed suggestion can be turned directly into one."""

    meeting_id: str
    diarization_speaker_id: str
    recording_type: str
    speech_duration_seconds: float
    segment_count: int
    # Non-primary diarization_speaker_ids folded into this entry by
    # merge_same_channel_fragments; empty for an unmerged cluster. Purely
    # informational (for transparent "merged: X, Y, Z" reporting) — nothing
    # else reads it.
    merged_from: list = field(default_factory=list)
    # A human marked this cluster as holding more than one person (see
    # MULTI_SPEAKER_KEY). Unlike merged_from this IS read: a mixed cluster's
    # centroid is a blend of two people's voices, so both naming it and
    # enrolling it as anyone's voice evidence would poison the profile it
    # was filed under and every future suggestion scored against it.
    contains_multiple_speakers: bool = False
    # How far a human got reviewing this cluster (see REVIEW_STATE_KEY), or
    # None where they have not said. Carried here only so the panel can show
    # it back: unlike contains_multiple_speakers it feeds no score and no
    # gate, because it describes the reviewer's progress and not the voice.
    review_state: Optional[str] = None


@dataclass
class Candidate:
    person_id: str
    display_name: str
    distance: float
    hard_negative_conflict: bool
    # Count of distinct meeting_ids among the prototypes actually used to
    # compute `distance` (the pool _prototype_pool returned) -- see
    # SUGGESTION_MIN_CONFIRMED_MEETINGS.
    confirmed_meeting_count: int = 0
    # Distance to this person's single nearest stored hard-negative, or
    # None when they have none -- the other half of the relative
    # suppression rule (see HARD_NEGATIVE_DISTANCE_THRESHOLD), surfaced so
    # reports/UI can show WHY a candidate was or wasn't suppressed.
    negative_distance: Optional[float] = None


@dataclass
class SuggestionResult:
    diarization_speaker_id: str
    # "confirmed": threshold + margin + stability all clear, safe to
    #   pre-fill as the suggested name.
    # "possible": clears the distance threshold but not margin/stability —
    #   surface as "might be X", never pre-filled.
    # "none": no candidate, or the best one had a hard-negative conflict.
    status: str
    suggested_person_id: Optional[str]
    suggested_name: Optional[str]
    candidates: list = field(default_factory=list)  # ranked list[Candidate], for a "Change" picker
    reasons: list = field(default_factory=list)  # human-readable, for the CLI accuracy report


def _prototype_pool(person: dict, recording_type: str) -> list:
    """Prefer same-recording_type prototypes; fall back to all of a
    person's prototypes only if none match this context."""
    prototypes = person.get("prototypes") or []
    same_context = [p for p in prototypes if p.get("recording_type") == recording_type]
    return same_context if same_context else prototypes


def score_candidates(embedding: list, context: ClusterContext, profiles: list) -> list:
    """Rank every known PersonProfile by distance to `embedding`. Returns
    an empty list if no profile has any usable evidence at all."""
    candidates = []
    for person in profiles:
        pool = _prototype_pool(person, context.recording_type)
        distances = []
        usable_pool = []
        for prototype in pool:
            try:
                distances.append(cosine_distance(embedding, prototype.get("embedding_mean")))
                usable_pool.append(prototype)
            except (TypeError, ValueError):
                continue
        if not distances:
            continue
        distance = min(distances)

        negatives = person.get("hard_negatives") or []
        negative_distances = []
        for negative in negatives:
            try:
                negative_distances.append(
                    cosine_distance(embedding, negative.get("embedding_mean"))
                )
            except (TypeError, ValueError):
                continue
        negative_distance = min(negative_distances) if negative_distances else None
        hard_negative_conflict = (
            negative_distance is not None
            and negative_distance <= HARD_NEGATIVE_DISTANCE_THRESHOLD
            and negative_distance < distance + SUGGESTION_CONFIDENCE_MARGIN
        )

        candidates.append(Candidate(
            person_id=person["person_id"],
            display_name=person["display_name"],
            distance=distance,
            hard_negative_conflict=hard_negative_conflict,
            confirmed_meeting_count=len({
                prototype.get("meeting_id")
                for prototype in usable_pool
                if prototype.get("meeting_id")
            }),
            negative_distance=negative_distance,
        ))
    candidates.sort(key=lambda c: c.distance)
    return candidates


def suggest_speaker(
    embedding: list,
    context: ClusterContext,
    profiles: list,
    *,
    scored_candidates: Optional[list] = None,
) -> SuggestionResult:
    """Score one diarized cluster against all known people. Never raises —
    an empty/malformed `profiles` list just yields status="none", matching
    src.transcriber._apply_voiceprint_matches's "never fail a meeting"
    contract."""
    # A cluster a human marked as mixed is withheld from naming entirely,
    # with NO candidates -- not merely downgraded to "possible". Candidates
    # would be worse than nothing here: the ranking is computed from a
    # centroid blended across two people, so its top entry is not a weak
    # guess about one person, it is a confident guess about a voice that
    # does not exist. Returning none also keeps this cluster from consuming
    # a person via suggest_speakers_for_meeting's used_person_ids, so the
    # cluster that really IS that person can still claim them.
    if context.contains_multiple_speakers:
        return SuggestionResult(
            diarization_speaker_id=context.diarization_speaker_id,
            status="none", suggested_person_id=None, suggested_name=None,
            candidates=[],
            reasons=["marked by a human as containing more than one person"],
        )

    candidates = (
        scored_candidates
        if scored_candidates is not None
        else score_candidates(embedding, context, profiles)
    )
    if not candidates:
        return SuggestionResult(
            diarization_speaker_id=context.diarization_speaker_id,
            status="none", suggested_person_id=None, suggested_name=None,
            candidates=[], reasons=["no known person profiles with usable evidence"],
        )

    best = candidates[0]
    second = candidates[1] if len(candidates) > 1 else None
    margin = (second.distance - best.distance) if second else float("inf")

    reasons = [f"best candidate {best.display_name!r} at distance {best.distance:.4f}"]
    if second:
        reasons.append(f"runner-up {second.display_name!r} at distance {second.distance:.4f} (margin {margin:.4f})")

    if best.hard_negative_conflict:
        reasons.append(
            f"suppressed: hard-negative at distance {best.negative_distance:.4f} "
            f"rivals the positive evidence at {best.distance:.4f}"
        )
        return SuggestionResult(
            diarization_speaker_id=context.diarization_speaker_id,
            status="none", suggested_person_id=None, suggested_name=None,
            candidates=candidates, reasons=reasons,
        )

    clears_threshold = best.distance < SUGGESTION_DISTANCE_THRESHOLD
    if not clears_threshold:
        reasons.append(f"below threshold ({SUGGESTION_DISTANCE_THRESHOLD})")
        return SuggestionResult(
            diarization_speaker_id=context.diarization_speaker_id,
            status="none", suggested_person_id=None, suggested_name=None,
            candidates=candidates, reasons=reasons,
        )

    avg_turn_seconds = (
        context.speech_duration_seconds / context.segment_count
        if context.segment_count else 0.0
    )
    clears_margin = margin >= SUGGESTION_CONFIDENCE_MARGIN
    stability_ok = (
        context.speech_duration_seconds >= SUGGESTION_MIN_DURATION_SECONDS
        and context.segment_count >= SUGGESTION_MIN_SEGMENT_COUNT
        and avg_turn_seconds >= SUGGESTION_MIN_AVG_TURN_SECONDS
    )
    enough_confirmed_meetings = best.confirmed_meeting_count >= SUGGESTION_MIN_CONFIRMED_MEETINGS
    if not clears_margin:
        reasons.append(f"margin below {SUGGESTION_CONFIDENCE_MARGIN} -- ambiguous vs runner-up")
    if not stability_ok:
        reasons.append(
            f"stability gate not cleared (duration={context.speech_duration_seconds:.1f}s, "
            f"segments={context.segment_count}, avg_turn={avg_turn_seconds:.2f}s)"
        )
    if not enough_confirmed_meetings:
        reasons.append(
            f"only {best.confirmed_meeting_count} confirmed meeting(s) for "
            f"{best.display_name!r}, need {SUGGESTION_MIN_CONFIRMED_MEETINGS}"
        )

    if clears_margin and stability_ok and enough_confirmed_meetings:
        status = "confirmed"
    else:
        status = "possible"

    return SuggestionResult(
        diarization_speaker_id=context.diarization_speaker_id,
        status=status,
        suggested_person_id=best.person_id,
        suggested_name=best.display_name,
        candidates=candidates,
        reasons=reasons,
    )


def suggest_speakers_for_meeting(
    channel_clusters: dict, profiles: list,
) -> dict:
    """Suggest names for every diarized cluster of a whole meeting at once,
    enforcing used-name exclusivity ACROSS ALL CHANNELS — one real person
    speaks from one side of a recording, so the same person cannot be the
    confirmed suggestion for a mic cluster and a system cluster of the same
    meeting (a cross-channel double match is echo/bleed, not two people).
    Port of the removed auto-matcher's usedNames tracking (SpeakerMatcher.
    matchVerbose), extended meeting-wide.

    Clusters are assigned in ascending best-candidate-distance order, so
    the cluster with the strongest evidence for a person claims them —
    an earlier version processed each channel independently in sorted-id
    order, which let a worse-matching, earlier-numbered cluster take a
    person away from the cluster that actually matched them best. Only
    "confirmed" results consume a person; "possible" ones don't (they are
    surfaced as hints for a human, who resolves any duplicates).

    `channel_clusters` is `{channel_name: {diarization_speaker_id:
    (embedding, ClusterContext)}}` — per channel, exactly what
    `clusters_from_sidecar_channel` (+ `merge_same_channel_fragments`)
    produces. Returns `{channel_name: {diarization_speaker_id:
    SuggestionResult}}` covering every input cluster.
    """
    flat = [
        (
            channel,
            sid,
            embedding,
            context,
            [] if context.contains_multiple_speakers else score_candidates(
                embedding, context, profiles,
            ),
        )
        for channel, clusters in channel_clusters.items()
        for sid, (embedding, context) in clusters.items()
    ]

    def _best_distance(entry) -> float:
        candidates = entry[4]
        return candidates[0].distance if candidates else float("inf")

    flat.sort(key=lambda e: (_best_distance(e), e[0], e[1]))

    results: dict = {channel: {} for channel in channel_clusters}
    used_person_ids: set = set()
    for channel, sid, embedding, context, candidates in flat:
        available_candidates = [
            candidate
            for candidate in candidates
            if candidate.person_id not in used_person_ids
        ]
        result = suggest_speaker(
            embedding,
            context,
            profiles=[],
            scored_candidates=available_candidates,
        )
        if result.status == "confirmed" and result.suggested_person_id:
            used_person_ids.add(result.suggested_person_id)
        results[channel][sid] = result
    return results


def merge_same_channel_fragments(clusters: dict) -> tuple:
    """clusters: `{sid: (embedding, ClusterContext)}` from ONE channel of
    ONE meeting (i.e. exactly what `clusters_from_sidecar_channel` returns).

    Real diarizers can fragment one continuous real speaker into multiple
    IDs over a long recording (observed: a 109-minute call's single real
    remote speaker split into 3 diarizer identities, pairwise embedding
    distance 0.02-0.07 — see the plan doc's Phase 3.6). Groups clusters via
    connected components over the `SAME_MEETING_MERGE_DISTANCE_THRESHOLD`
    pairwise-distance graph, so transitive chains (A close to B, B close to
    C, even if A and C aren't directly close) still merge into one group.
    Each group collapses into one entry keyed by its highest-duration
    member's id (the "primary"): embedding is the duration-weighted mean of
    the group's embeddings (re-normalized — same principle the Swift
    sidecar already uses to aggregate chunk embeddings into a centroid,
    applied one level up), `speech_duration_seconds`/`segment_count` are
    summed, `merged_from` lists the other member ids.

    This does NOT unify deliberately-different vocal performances by the
    same person (e.g. a joke voice) — those don't land this close and
    shouldn't; that's still a human judgment via repeated `confirm-speaker
    --person-id` calls. This is narrowly about literal diarizer
    fragmentation of one continuous, consistent vocal signal.

    Returns `(merged_clusters, id_resolution)`: `id_resolution` maps EVERY
    original `diarization_speaker_id` (including unmerged ones, which map
    to themselves) to its primary id in `merged_clusters`, so callers that
    look up a cluster by its raw diarizer id (`confirm-speaker`) can
    resolve through this first.
    """
    sids = list(clusters.keys())
    if len(sids) <= 1:
        return dict(clusters), {sid: sid for sid in sids}

    parent = {sid: sid for sid in sids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(len(sids)):
        for j in range(i + 1, len(sids)):
            a, b = sids[i], sids[j]
            try:
                close = (
                    cosine_distance(clusters[a][0], clusters[b][0])
                    <= SAME_MEETING_MERGE_DISTANCE_THRESHOLD
                )
            except (TypeError, ValueError):
                close = False
            if close:
                union(a, b)

    groups: dict = {}
    for sid in sids:
        groups.setdefault(find(sid), []).append(sid)

    merged_clusters = {}
    id_resolution = {}
    for members in groups.values():
        members_sorted = sorted(
            members, key=lambda sid: clusters[sid][1].speech_duration_seconds, reverse=True,
        )
        primary = members_sorted[0]
        others = members_sorted[1:]
        for sid in members:
            id_resolution[sid] = primary

        if not others:
            merged_clusters[primary] = clusters[primary]
            continue

        total_duration = sum(clusters[sid][1].speech_duration_seconds for sid in members)
        total_segments = sum(clusters[sid][1].segment_count for sid in members)

        dim = len(clusters[primary][0])
        weighted = [0.0] * dim
        for sid in members:
            emb, ctx = clusters[sid]
            weight = ctx.speech_duration_seconds if total_duration > 0 else 1.0
            for k in range(dim):
                weighted[k] += emb[k] * weight
        norm = sum(x * x for x in weighted) ** 0.5
        merged_embedding = [x / norm for x in weighted] if norm > 1e-9 else weighted

        primary_context = clusters[primary][1]
        merged_clusters[primary] = (
            merged_embedding,
            ClusterContext(
                meeting_id=primary_context.meeting_id,
                diarization_speaker_id=primary,
                recording_type=primary_context.recording_type,
                speech_duration_seconds=total_duration,
                segment_count=total_segments,
                merged_from=others,
                # Contamination is a property of the AUDIO, so it survives
                # the merge: folding a mixed fragment into a clean one
                # produces a mixed cluster, not a clean one. Marking any
                # fragment therefore withholds the whole merged cluster
                # from naming -- the fail-safe direction, since the
                # alternative is enrolling a blended voice as a person.
                contains_multiple_speakers=any(
                    clusters[sid][1].contains_multiple_speakers for sid in members
                ),
                # Same any() as above, for a different reason: the reviewer
                # marked the ROW they saw, and which raw fragment carried
                # the mark is an implementation detail they never saw. One
                # marked member therefore marks the merged row -- and the
                # transitions clear the whole member set, so a mark cannot
                # survive on a fragment nobody can reach.
                review_state=next(
                    (
                        clusters[sid][1].review_state for sid in members
                        if clusters[sid][1].review_state is not None
                    ),
                    None,
                ),
            ),
        )

    return merged_clusters, id_resolution


# --- output/{stem}_speakers.json sidecar: pending diarization output for a
# meeting, written by the live pipeline and by the Phase 3 backfill command,
# read by suggest-speakers and (later) the approval UI. Per-channel because
# mic and system audio are diarized independently with their own SPEAKER_N
# numbering -- a mic "SPEAKER_0" and a system "SPEAKER_0" are unrelated.

def speakers_sidecar_path(output_dir: Path, meeting_stem: str) -> Path:
    return output_dir / f"{validate_meeting_stem(meeting_stem)}_speakers.json"


def write_speakers_sidecar(
    output_dir: Path,
    meeting_stem: str,
    channels: dict,
    turn_manifest: Optional[list] = None,
) -> Path:
    """`channels` is `{"mic" | "system": {"recording_type": str, "clusters":
    {diarization_speaker_id: {"embedding": [...], "speech_duration_seconds":
    float, "segment_count": int}}}}`. Never touches the meeting's saved
    transcript file -- this is a separate sidecar, not a rewrite.

    `turn_manifest` (optional -- `src.transcriber.transcribe_diarised`/
    `_transcribe_diarised_mono`'s `"turn_manifest"` return value, list of
    `{"start", "channel", "diarization_speaker_id"}`, one per saved-
    transcript turn) is persisted as the `"transcript_lines"` key when
    given, letting a later `confirm-speaker` relabel by EXACT recorded
    provenance (see `relabel_transcript_exact`) instead of reconstructing
    "which line belongs to this cluster" via fuzzy timestamp matching
    after the fact -- see the plan doc's Phase 8. Omitted (not written as
    an empty list) when not given, so older sidecars and this key's
    absence both read the same way via `.get("transcript_lines")`.

    Mints a fresh `diarization_run` (`run_id` + `created_at`) every call,
    minted HERE rather than by each caller: every producer of a new run --
    the live pipeline, the Phase 3 backfill command, and a future
    re-diarize -- funnels through this one function, so stamping it here
    needs no new plumbing at any call site and cannot be forgotten by one.
    The read-modify-write helpers (`write_sidecar_document`,
    `set_cluster_multi_speaker`) rewrite the whole document instead of
    calling back in here, so they carry the existing run id forward
    unchanged -- a rewrite of the same diarization output is not a new
    run, and re-minting on every write would make a stale review-state
    key (added in a later slice) look current when the clusters it was
    reviewed against never changed."""
    if not isinstance(channels, dict) or any(channel not in VALID_CHANNELS for channel in channels):
        raise ValueError("Invalid speaker channel.")
    payload = {
        "meeting_id": meeting_stem,
        "created_at": time.time(),
        "channels": channels,
        "diarization_run": {"run_id": str(uuid.uuid4()), "created_at": time.time()},
    }
    if turn_manifest:
        payload["transcript_lines"] = turn_manifest
    path = speakers_sidecar_path(output_dir, meeting_stem)
    write_sidecar_document(output_dir, meeting_stem, payload)
    return path


# --- "this cluster holds more than one person" marking ------------------
#
# `merge_same_channel_fragments` already models the one direction diarizers
# get wrong -- several clusters that are really ONE person. This is the
# opposite direction, and unlike that one it cannot be derived from the
# data: a cluster contaminated by someone briefly talking over the main
# speaker was measured, against a real 3-person call, at cosine distance
# 0.8270 to the person who contaminated it -- an entirely unremarkable
# cross-speaker distance. There is no signal in a per-speaker centroid that
# separates "one voice" from "one voice plus 4 seconds of another"; the
# per-chunk embeddings that could show it are not in the sidecar's contract
# (see this module's header). A human who was in the meeting is the only
# available source of this fact, so it is recorded as one.
#
# Written into the cluster entry itself rather than a parallel structure,
# so it travels with exactly the cluster it describes and cannot be
# orphaned by an id change. Absent means "not marked" -- the key is only
# written when true, so every pre-existing sidecar reads correctly.
MULTI_SPEAKER_KEY = "contains_multiple_speakers"


# How far a human got reviewing one cluster, for the decisions that produce
# no other trace. Same placement rationale as MULTI_SPEAKER_KEY: written
# into the cluster entry itself so it travels with exactly the cluster it
# describes, only written when set, absent means "not marked".
#
# Exactly one value, deliberately. "Assigned" is already derivable from a
# matching prototype and "mixed" is already MULTI_SPEAKER_KEY; recording
# either here as a second copy would create a consistency obligation with
# no information gain, and the copies would disagree the first time one
# path updated without the other. "Unreviewed" is the absence of
# everything.
#
# It changes no score and no suggestion status. A reviewer saying "leave
# this one generic" is a statement about their own progress, not about the
# voice -- treating it as evidence would let a shrug quietly suppress a
# real match.
REVIEW_STATE_KEY = "review_state"
REVIEW_STATE_GENERIC = "generic"


def cluster_ids_marked_multi_speaker(channel_data: dict) -> set:
    """Every raw diarization_speaker_id in one channel marked as holding
    more than one person."""
    return {
        sid
        for sid, cluster in (channel_data.get("clusters") or {}).items()
        if cluster.get(MULTI_SPEAKER_KEY)
    }


def count_review_markings(sidecar: Optional[dict]) -> dict:
    """How many clusters in a whole sidecar carry each human marking:
    `{"multi_speaker": n, "review_state": n}`.

    Exists once so the two paths that overwrite a sidecar with a fresh
    diarization -- `backfill-speaker-embeddings` and
    `_persist_speaker_sidecar` (reprocess --retranscribe) -- report the same
    thing. Those are the only places a marking is ever lost, and a second
    copy of this counting is how one of them would quietly stop counting the
    newer kind.

    Tolerates any shape, including None: it is called only to build a
    warning, and a warning must never be what fails a re-diarization.
    """
    counts = {"multi_speaker": 0, "review_state": 0}
    if not isinstance(sidecar, dict):
        return counts
    channels = sidecar.get("channels")
    if not isinstance(channels, dict):
        return counts
    for channel_data in channels.values():
        if not isinstance(channel_data, dict):
            continue
        for cluster in _cluster_entries(channel_data).values():
            if not isinstance(cluster, dict):
                continue
            if cluster.get(MULTI_SPEAKER_KEY):
                counts["multi_speaker"] += 1
            if cluster.get(REVIEW_STATE_KEY):
                counts["review_state"] += 1
    return counts


def set_cluster_multi_speaker(
    output_dir: Path, meeting_stem: str, channel: str,
    diarization_speaker_id: str, marked: bool, expected_run_id: Optional[str] = None,
    *, lock_held: bool = False,
) -> Optional[dict]:
    """Set/clear the marking on ONE raw cluster, rewriting the sidecar in
    place (read-modify-write, atomic temp+rename -- the sidecar carries the
    only copy of this meeting's voice embeddings, so a torn write would
    destroy data no re-run can recover once the audio is gone).

    Returns the updated sidecar, or None when the sidecar/channel/cluster
    doesn't exist -- callers report that as an error rather than silently
    marking nothing.
    """
    return _mutate_cluster(
        output_dir,
        meeting_stem,
        channel,
        diarization_speaker_id,
        expected_run_id,
        lambda cluster: (
            cluster.__setitem__(MULTI_SPEAKER_KEY, True)
            if marked
            else cluster.pop(MULTI_SPEAKER_KEY, None)
        ),
        lock_held=lock_held,
    )


def _freshest_channel(output_dir: Path, meeting_stem: str, channel: str) -> tuple:
    """The sidecar as it is on disk RIGHT NOW plus its `channel` entry, for a
    read-modify-write that must not overwrite a concurrent one.

    Callers use it twice: once to validate, and once again immediately
    before writing, applying their change to whatever that second read
    returned. The write is atomic; the read-modify-write around it is not.
    Two overlapping marks that both started from the same in-memory sidecar
    ended with the second writer discarding the first's marking silently,
    along with any confirmation cleanup its caller had already performed
    against it. The second read narrows that window to read-until-rename
    instead of entry-until-rename. It does not make the sequence a
    transaction, and a write landing inside the remaining window is still
    lost; closing it fully needs a lock that works on macOS and Windows
    alike, which is a bigger change than this defect warrants.

    Returns `(None, None)` when the sidecar or the channel is gone.

    Types are checked rather than assumed. This file is JSON on a user's
    disk: a half-written copy, a restored backup or a hand-edit can leave
    any of these keys holding the wrong type, and `.get` on a list raises.
    Every caller owes its own caller a JSON error rather than a traceback,
    so a structurally wrong document has to read the same as a missing one.
    """
    sidecar = read_speakers_sidecar(output_dir, meeting_stem)
    if not isinstance(sidecar, dict):
        return None, None
    channels = sidecar.get("channels")
    if not isinstance(channels, dict):
        return None, None
    channel_data = channels.get(channel)
    if not isinstance(channel_data, dict):
        return None, None
    return sidecar, channel_data


def _cluster_entries(channel_data: dict) -> dict:
    """One channel's `clusters` map, or an empty one when it is missing or
    the wrong type (see _freshest_channel on why that is not assumed)."""
    clusters = channel_data.get("clusters")
    return clusters if isinstance(clusters, dict) else {}


def set_cluster_review_state(
    output_dir: Path, meeting_stem: str, channel: str,
    diarization_speaker_id: str, state: Optional[str], expected_run_id: Optional[str] = None,
) -> Optional[dict]:
    """Set/clear how far the review got on ONE raw cluster.

    Writes to exactly the id it was handed, like set_cluster_multi_speaker:
    the panel shows merged rows, but the sidecar records raw clusters, and
    inventing a write to the merge primary would put the mark on an id the
    caller never named. The merged view resolves it on the way out (see
    merge_same_channel_fragments).

    `state=None` clears. Returns the written sidecar, or None when the
    sidecar, channel or cluster does not exist -- callers report that rather
    than reporting a mark that never happened.
    """
    return _mutate_cluster(
        output_dir,
        meeting_stem,
        channel,
        diarization_speaker_id,
        expected_run_id,
        lambda cluster: (
            cluster.pop(REVIEW_STATE_KEY, None)
            if state is None
            else cluster.__setitem__(REVIEW_STATE_KEY, state)
        ),
    )


def _mutate_cluster(
    output_dir: Path,
    meeting_stem: str,
    channel: str,
    diarization_speaker_id: str,
    expected_run_id: Optional[str],
    mutation,
    *,
    lock_held: bool = False,
) -> Optional[dict]:
    """Mutate one cluster while holding the meeting sidecar lock."""
    from src.speaker_sidecar_store import SpeakerSidecarStore

    store = SpeakerSidecarStore(output_dir)
    if expected_run_id is None:
        initial = store.read(meeting_stem)
        expected_run_id = store.run_token(initial)

    def apply(document):
        channels = document.get("channels")
        channel_data = channels.get(channel) if isinstance(channels, dict) else None
        cluster = _cluster_entries(channel_data).get(diarization_speaker_id) if isinstance(channel_data, dict) else None
        if not isinstance(cluster, dict):
            raise KeyError(diarization_speaker_id)
        mutation(cluster)

    try:
        if lock_held:
            return store.mutate_locked(meeting_stem, expected_run_id, apply)
        return store.mutate(meeting_stem, expected_run_id, apply)
    except (FileNotFoundError, KeyError, ValueError):
        return None


def clear_cluster_review_state(
    output_dir: Path,
    meeting_stem: str,
    channel: str,
    diarization_speaker_ids,
    expected_run_id: Optional[str] = None,
    *,
    lock_held: bool = False,
) -> int:
    """Drop the review marking from a whole set of raw cluster ids in one
    write. Returns how many actually carried it.

    Takes a set because the transitions that call it (a confirm, a mixed
    marking) are about a MERGED row, and the merged view reads generic when
    any member carries the key -- clearing only the primary would leave the
    row marked by a fragment nobody can see or click.

    Never raises and never reports a failure: it runs after the action it
    follows has already succeeded, and a missing sidecar or channel there
    means there is nothing to clear, not that the confirm went wrong.
    """
    from src.speaker_sidecar_store import SpeakerSidecarStore, StaleDiarizationRun

    store = SpeakerSidecarStore(output_dir)
    if expected_run_id is None:
        initial = store.read(meeting_stem)
        expected_run_id = store.run_token(initial)
    cleared = 0

    def apply(document):
        nonlocal cleared
        channels = document.get("channels")
        channel_data = channels.get(channel) if isinstance(channels, dict) else None
        clusters = _cluster_entries(channel_data) if isinstance(channel_data, dict) else {}
        for sid in diarization_speaker_ids:
            cluster = clusters.get(sid)
            if isinstance(cluster, dict) and cluster.pop(REVIEW_STATE_KEY, None) is not None:
                cleared += 1

    document = store.read(meeting_stem)
    if document is None:
        return 0
    try:
        if lock_held:
            store.mutate_locked(meeting_stem, expected_run_id, apply)
        else:
            store.mutate(meeting_stem, expected_run_id, apply)
    except (FileNotFoundError, KeyError, OSError, StaleDiarizationRun):
        return 0
    return cleared


def write_sidecar_document(
    output_dir: Path,
    meeting_stem: str,
    sidecar: dict,
    *,
    acquire_lock: bool = True,
) -> None:
    """Replace a meeting's whole sidecar document atomically.

    A UNIQUE temp name, unlike the fixed "<name>.tmp" the relabel helpers
    in this module use. Those rewrite a transcript, which can be
    regenerated; this rewrites the only copy of a meeting's voice
    embeddings, which cannot be once the source audio is gone. With a
    shared temp name, two concurrent writers race on ONE file: the second
    truncates it while the first is replacing the sidecar with it, and a
    crash or a full disk in that window leaves the real sidecar empty.
    Same directory as the target so the replace stays a rename within one
    filesystem, which is what makes it atomic.
    """
    if acquire_lock:
        from src.speaker_sidecar_store import SpeakerSidecarStore

        store = SpeakerSidecarStore(output_dir)
        with store.lock(meeting_stem):
            write_sidecar_document(
                output_dir,
                meeting_stem,
                sidecar,
                acquire_lock=False,
            )
        return

    path = speakers_sidecar_path(output_dir, meeting_stem)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp",
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(sidecar, fh, indent=2)
            # Flushed to stable storage BEFORE the rename, because atomic
            # and durable are not the same guarantee. The rename makes sure
            # a reader never sees half a document; it says nothing about the
            # bytes having left the page cache. A power cut or kernel panic
            # in that window renames an EMPTY file over the real sidecar --
            # and unlike a transcript, this one cannot be regenerated, since
            # the source audio is deleted by default. Flushing afterwards
            # would protect nothing.
            fh.flush()
            os.fsync(fh.fileno())
        tmp_path.replace(path)
    except OSError:
        # Never leave a half-written temp file behind for someone to find
        # later and mistake for a real sidecar. Covers a failed flush too:
        # a write that could not be made durable must not report success.
        tmp_path.unlink(missing_ok=True)
        raise

    # And the directory entry, so a crash cannot leave it pointing at the
    # old file after the caller was told the sidecar was replaced.
    # Best-effort and deliberately silent: the data itself is already on
    # disk, opening a directory is not portable (Windows refuses it), and
    # failing here would turn a completed write into a reported error.
    if hasattr(os, "O_DIRECTORY"):
        try:
            dir_fd = os.open(str(path.parent), os.O_DIRECTORY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass


def minimum_speaker_count(channels: dict) -> int:
    """The smallest number of real people this meeting's diarization is
    consistent with: every cluster is at least one person, and every
    cluster a human marked as mixed is at least two.

    Exists because the ceiling is REAL and invisible in the output --
    FluidAudio's Sortformer has a hardcoded four-speaker-slot architecture
    per channel (`SortformerConfig.numSpeakers`, see
    diarize-sidecar/Sources/main.swift's header), so a five-person channel
    is silently returned as four clusters with no indication anything was
    lost. Confirmed by ear against a real six-person recording.

    NOTHING DOWNSTREAM CONSUMES THIS NUMBER TODAY, and that is deliberate
    rather than an oversight: Sortformer takes no speaker-count hint at
    all, so there is no re-diarization call to feed it into. It is
    reported so the gap is visible to the person reviewing the meeting
    instead of silent, and so a future diarization path -- windowed
    inference with cross-window clustering, or an engine that does accept
    a count -- has ground truth to be measured against.

    Counted on the MERGED view, and taken as the LARGEST channel rather
    than the sum. Both corrections come from the same demand: a minimum
    that overstates is simply wrong, while one that understates is merely
    weak. Raw clusters overstate because the panel itself collapses
    diarizer fragments of one voice into one row, so the number would
    contradict the list beside it. Summing channels overstates because a
    remote voice coming out of the speakers is picked up by the microphone
    as well -- the module's own excerpt reasoning rests on that -- so a mic
    cluster and a system cluster can be one person, and nothing in the
    sidecar says whether they are.
    """
    largest = 0
    for channel_data in (channels or {}).values():
        raw = channel_data.get("clusters") or {}
        if not raw:
            continue
        try:
            parsed = clusters_from_sidecar_channel("", channel_data)
            merged, _id_resolution = merge_same_channel_fragments(
                parsed
            )
            groups = [[sid, *ctx.merged_from] for sid, (_emb, ctx) in merged.items()]
        except (KeyError, TypeError, ValueError):
            # A sidecar without usable embeddings cannot be merged; count
            # the raw ids rather than reporting nothing at all.
            groups = [[sid] for sid in raw]
        # A group counts as mixed if ANY of its members was marked: the
        # human said two people share that voice, and merging it with a
        # fragment of itself does not make that untrue.
        marked = sum(
            1 for members in groups
            if any(raw.get(member, {}).get(MULTI_SPEAKER_KEY) for member in members)
        )
        largest = max(largest, len(groups) + marked)
    return largest


def read_speakers_sidecar(output_dir: Path, meeting_stem: str) -> Optional[dict]:
    path = speakers_sidecar_path(output_dir, meeting_stem)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Could not read speakers sidecar %s: %s", path, e)
        return None


def clusters_from_sidecar_channel(meeting_id: str, channel: dict) -> dict:
    """Build the `{diarization_speaker_id: (embedding, ClusterContext)}`
    shape `suggest_speakers_for_meeting` expects as each channel's inner
    dict from one channel's sidecar entry (see `write_speakers_sidecar`)."""
    recording_type = channel.get("recording_type", "unknown")
    out = {}
    for sid, cluster in (channel.get("clusters") or {}).items():
        try:
            embedding = validate_embedding(
                cluster["embedding"],
                expected_dimension=None,
            )
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            raise ValueError("Speaker sidecar contains an invalid cluster embedding.") from error
        out[sid] = (
            embedding,
            ClusterContext(
                meeting_id=meeting_id,
                diarization_speaker_id=sid,
                recording_type=recording_type,
                speech_duration_seconds=cluster.get("speech_duration_seconds", 0.0),
                segment_count=cluster.get("segment_count", 0),
                contains_multiple_speakers=bool(cluster.get(MULTI_SPEAKER_KEY)),
                review_state=cluster.get(REVIEW_STATE_KEY),
            ),
        )
    return out


# A saved transcript's diarised lines look like `[MM:SS] [Label] text` or
# `[H:MM:SS] [Label] text` (see src.transcriber._format_timestamp and the
# "\n\n".join(labelled_parts) assembly) -- label is bracketed so it can
# never be confused with a bracketed timestamp elsewhere in a line.
_TRANSCRIPT_LINE_RE = re.compile(r"^\[(\d+(?::\d{2}){1,2})\] \[([^\]]*)\] (.*)$")
# Small slop for float rounding / segment-boundary edge cases when matching
# a transcript line's integer-second timestamp against a sidecar segment's
# float [start, end] range.
RELABEL_TIMESTAMP_TOLERANCE_SECONDS = 0.5


def _safe_transcript_timestamp(timestamp: str) -> Optional[float]:
    """`_parse_transcript_timestamp` for callers that must keep a line's
    position even when its timestamp is malformed -- dropping it would
    shift every later manifest pairing by one."""
    try:
        return _parse_transcript_timestamp(timestamp)
    except ValueError:
        return None


def _parse_transcript_timestamp(timestamp: str) -> float:
    """Inverse of src.transcriber._format_timestamp: "MM:SS" or "H:MM:SS"
    -> seconds. Raises ValueError on malformed input (caller's problem to
    handle, e.g. skip the line)."""
    parts = [int(p) for p in timestamp.split(":")]
    if len(parts) == 2:
        minutes, seconds = parts
        return minutes * 60 + seconds
    hours, minutes, seconds = parts
    return hours * 3600 + minutes * 60 + seconds


def relabel_transcript_speaker(
    transcript_path: Path,
    segments: list,
    display_name: str,
) -> int:
    """Rewrite a saved transcript's diarised `[MM:SS] [Label] text` lines,
    replacing Label with `display_name` for every line whose timestamp
    falls inside one of `segments`' `{"start": float, "end": float}` ranges
    (within RELABEL_TIMESTAMP_TOLERANCE_SECONDS) -- EXCEPT lines labeled
    "You" (self-match is out of scope for this system; never touched here).

    Matches purely by timestamp, never by the line's current label text --
    a live-recorded transcript's placeholder numbering ("Speaker 2") and a
    later independent backfill re-diarization run aren't guaranteed to
    agree on numbering even for the same real speaker, but segment
    boundaries on the same source audio should. This also makes re-running
    after a "Change" correction (a different display_name) safe/idempotent:
    it just re-matches by timestamp and overwrites whatever label was there.

    Never raises and never partially corrupts the file: reads/parses
    defensively, writes back atomically (temp file + rename) only if at
    least one line actually changed, and returns 0 (no-op) rather than
    erroring when the transcript is missing, unreadable, or has no
    diarised `[MM:SS]` lines at all (e.g. a pre-diarization-era transcript,
    or a backfill sidecar whose re-diarization didn't line up with the
    original run) -- relabeling is a best-effort enhancement on top of an
    already-successful confirm, never something that can fail it.
    """
    if not segments or not transcript_path.exists():
        return 0
    try:
        original = transcript_path.read_text(encoding="utf-8")
    except OSError as e:
        logger.warning("Could not read transcript %s for relabeling: %s", transcript_path, e)
        return 0

    lines = original.split("\n")
    new_lines = []
    changed = 0
    for line in lines:
        match = _TRANSCRIPT_LINE_RE.match(line)
        if not match:
            new_lines.append(line)
            continue
        timestamp_str, label, text = match.groups()
        if label == "You":
            new_lines.append(line)
            continue
        try:
            timestamp_seconds = _parse_transcript_timestamp(timestamp_str)
        except ValueError:
            new_lines.append(line)
            continue
        in_range = any(
            seg.get("start", 0) - RELABEL_TIMESTAMP_TOLERANCE_SECONDS
            <= timestamp_seconds
            <= seg.get("end", 0) + RELABEL_TIMESTAMP_TOLERANCE_SECONDS
            for seg in segments
        )
        if in_range and label != display_name:
            new_lines.append(f"[{timestamp_str}] [{display_name}] {text}")
            changed += 1
        else:
            new_lines.append(line)

    if changed:
        tmp_path = transcript_path.with_name(transcript_path.name + ".tmp")
        tmp_path.write_text("\n".join(new_lines), encoding="utf-8")
        tmp_path.replace(transcript_path)
    return changed


def relabel_transcript_multi(transcript_path: Path, assignments: list) -> tuple:
    """Relabel a saved transcript from MULTIPLE (channel, display_name,
    segments) assignments in one pass -- unlike relabel_transcript_speaker,
    which is safe for confirm-speaker's one-cluster-at-a-time call (only
    ever given one channel's segments) but unsafe to call repeatedly for
    every channel/person of a meeting in a bulk backfill.

    Why: a channel's confirmed cluster's segments routinely span almost the
    entire meeting (mic and system channel both do), so two DIFFERENT
    channels' segments can land within RELABEL_TIMESTAMP_TOLERANCE_SECONDS
    of the same transcript line purely from natural conversational timing
    -- relabeling from one channel's assignment in that case would silently
    steal a line that actually belongs to the OTHER channel's speaker. This
    was found for real: running relabel_transcript_speaker once per
    channel/person in a meeting caused writes to thrash between two
    channels' competing claims on the same lines (see the plan doc's
    Phase 7 backfill-participants section).

    `assignments`: list of (channel_name, display_name, segments), ideally
    sorted oldest-confirmed-first (by prototype created_at) so a later
    "Change" correction on the SAME channel correctly wins.

    A line is relabeled only when exactly ONE DISTINCT CHANNEL's
    assignments claim it. When more than one channel's segments both match
    (genuine ambiguity -- can't tell which channel the line really came
    from), the line is left untouched and counted in `skipped_ambiguous`
    rather than guessed. When multiple assignments from the SAME channel
    match (e.g. two people confirmed for the same cluster over time), the
    LAST one in `assignments` order wins -- same "re-matches by timestamp,
    overwrites whatever was there" semantic as relabel_transcript_speaker.

    Returns (changed, skipped_ambiguous). Never raises; same defensive
    read/write behavior as relabel_transcript_speaker.
    """
    if not assignments or not transcript_path.exists():
        return 0, 0
    try:
        original = transcript_path.read_text(encoding="utf-8")
    except OSError as e:
        logger.warning("Could not read transcript %s for relabeling: %s", transcript_path, e)
        return 0, 0

    lines = original.split("\n")
    new_lines = []
    changed = 0
    skipped_ambiguous = 0
    for line in lines:
        match = _TRANSCRIPT_LINE_RE.match(line)
        if not match:
            new_lines.append(line)
            continue
        timestamp_str, label, text = match.groups()
        if label == "You":
            new_lines.append(line)
            continue
        try:
            timestamp_seconds = _parse_transcript_timestamp(timestamp_str)
        except ValueError:
            new_lines.append(line)
            continue

        claiming_channels = set()
        winner_name = None
        for channel_name, display_name, segments in assignments:
            if any(
                seg.get("start", 0) - RELABEL_TIMESTAMP_TOLERANCE_SECONDS
                <= timestamp_seconds
                <= seg.get("end", 0) + RELABEL_TIMESTAMP_TOLERANCE_SECONDS
                for seg in segments
            ):
                claiming_channels.add(channel_name)
                winner_name = display_name  # last match (any channel) wins

        if len(claiming_channels) > 1:
            skipped_ambiguous += 1
            new_lines.append(line)
        elif winner_name is not None and label != winner_name:
            new_lines.append(f"[{timestamp_str}] [{winner_name}] {text}")
            changed += 1
        else:
            new_lines.append(line)

    if changed:
        tmp_path = transcript_path.with_name(transcript_path.name + ".tmp")
        tmp_path.write_text("\n".join(new_lines), encoding="utf-8")
        tmp_path.replace(transcript_path)
    return changed, skipped_ambiguous


def _manifest_describes_lines(line_starts: list, turn_manifest: list) -> bool:
    """Whether this manifest still describes THIS transcript, so its entries
    may be paired with the lines by position.

    Positional pairing is exact only while both sequences come from the same
    `turns` list of the same run -- and an equal length is weak evidence of
    that. A manifest left behind by an earlier transcription of the same
    meeting, or written in a different order, keeps its entry count and then
    silently pairs every line with the wrong cluster: a quote, or a name,
    from one person shown under another's, which is precisely the failure
    the exact-provenance path exists to remove.

    The evidence that the two belong together is already in both of them,
    and it is exact rather than approximate: src.transcriber builds the
    entry's `start` and the line's `[MM:SS]` from the SAME float in the same
    loop, the latter through _format_timestamp, which is `max(0, int(...))`.
    So the check mirrors that formatting instead of allowing slop around it.
    It has to: a window merely a second wide accepts the NEIGHBOURING turn,
    and two turns swapped is exactly what a reordered manifest looks like.

    Also refused: a manifest whose turn starts run backwards. Two turns
    inside ONE second render as the same `[MM:SS]`, so no per-line
    comparison can tell them apart however exactly it is done -- but the
    manifest is built from a list sorted by start, so its starts never
    decrease, and a swap does. That closes the remaining reordering case
    the per-line check cannot see.

    Refused outright: an entry that is not an object at all. The sidecar is
    JSON and every caller then reaches for `entry.get(...)`, so this is both
    the safe answer and the one that keeps their never-raises contract.

    Skipped rather than failed: an entry with no usable `start` (or a
    non-finite one, which _format_timestamp itself renders as 00:00) and a
    line whose timestamp would not parse. Neither is evidence of a mismatch,
    and refusing on missing evidence would take excerpts away from meetings
    that are fine.
    """
    previous = None
    for line_start, entry in zip(line_starts, turn_manifest):
        if not isinstance(entry, dict):
            return False
        start = entry.get("start")
        if not isinstance(start, (int, float)) or not math.isfinite(start):
            continue
        if previous is not None and start < previous:
            return False
        previous = start
        if line_start is None:
            continue
        if max(0, int(start)) != int(line_start):
            return False
    return True


MULTI_SPEAKER_TRANSCRIPT_LABEL = "Multiple speakers"
ORIGINAL_LABEL_KEY = "original_label"
_GENERIC_TRANSCRIPT_LABELS = {"You", "Others", "Together"}


def _is_generic_transcript_label(label: str) -> bool:
    return label in _GENERIC_TRANSCRIPT_LABELS or re.fullmatch(r"Speaker \d+", label) is not None


def record_original_labels(
    output_dir: Path, meeting_stem: str, transcript_path: Path, target_ids: set,
    *, lock_held: bool = False,
) -> int:
    """Remember, per manifest entry, what label a line carried BEFORE a
    confirmation renames it. Returns how many entries were newly recorded.

    Without this, naming a cluster is irreversible in the transcript: the
    original label ("You", "Others", "Speaker 3") is overwritten, and it
    was itself derived at transcription time, so nothing can reconstruct
    it afterwards. Marking that cluster as more than one person later
    withdraws the profile and the participants entry but would leave the
    name standing in the artefact that feeds the summary and every export.

    FIRST WRITE WINS. Confirming the same cluster twice -- the review UI's
    "Change" flow does exactly that -- must not record "Person Alpha" as the
    original, or the restore would put a person's name back on lines the
    app has just decided are not theirs.

    Written into the sidecar's own `transcript_lines` entries, so it
    travels with the manifest it is indexed by and needs no migration: an
    entry without the key simply has nothing recorded, which is the state
    of every meeting confirmed before this existed.
    """
    if not lock_held:
        import filelock
        from src.speaker_sidecar_store import SpeakerSidecarStore

        store = SpeakerSidecarStore(output_dir)
        try:
            with store.lock(meeting_stem):
                return record_original_labels(
                    output_dir,
                    meeting_stem,
                    transcript_path,
                    target_ids,
                    lock_held=True,
                )
        except (filelock.Timeout, OSError):
            return 0

    sidecar = read_speakers_sidecar(output_dir, meeting_stem)
    if not isinstance(sidecar, dict):
        return 0
    manifest = sidecar.get("transcript_lines")
    if not manifest or not target_ids or not transcript_path.exists():
        return 0
    try:
        lines = transcript_path.read_text(encoding="utf-8").split("\n")
    except OSError:
        return 0

    matches = [_TRANSCRIPT_LINE_RE.match(line) for line in lines]
    diarised = [m for m in matches if m]
    if len(diarised) != len(manifest):
        return 0
    if not _manifest_describes_lines(
        [_safe_transcript_timestamp(m.group(1)) for m in diarised], manifest,
    ):
        return 0

    recorded = 0
    for match, entry in zip(diarised, manifest):
        if not isinstance(entry, dict):
            continue
        if (entry.get("channel"), entry.get("diarization_speaker_id")) not in target_ids:
            continue
        if ORIGINAL_LABEL_KEY in entry:
            continue  # first write wins
        entry[ORIGINAL_LABEL_KEY] = match.group(2)
        recorded += 1

    if recorded:
        write_sidecar_document(
            output_dir,
            meeting_stem,
            sidecar,
            acquire_lock=False,
        )
    return recorded


def restore_transcript_labels(
    transcript_path: Path, turn_manifest: list, target_ids: set,
) -> int:
    """Undo a confirmation's rename on ONE cluster's lines, putting back the
    label each line carried before it. Where nothing was recorded, an
    existing generic diarization label remains unchanged and a person name
    is replaced with `MULTI_SPEAKER_TRANSCRIPT_LABEL`.

    The fallback is not a guess: it is the statement the user just made by
    marking the cluster, and it is the honest thing to show for a line the
    app can no longer attribute to one person. Guessing "You" or "Speaker
    3" instead would invent an attribution.

    Same refusals as relabel_transcript_exact -- a manifest that does not
    line up with the transcript, by count or by turn times, is not paired
    at all. Returns the number of lines changed; never raises.
    """
    if not turn_manifest or not target_ids or not transcript_path.exists():
        return 0
    try:
        lines = transcript_path.read_text(encoding="utf-8").split("\n")
    except OSError as e:
        logger.warning("Could not read transcript %s for label restore: %s", transcript_path, e)
        return 0

    indices = [i for i, line in enumerate(lines) if _TRANSCRIPT_LINE_RE.match(line)]
    if len(indices) != len(turn_manifest):
        logger.warning(
            "restore_transcript_labels: %s has %d diarised lines but turn_manifest has %d -- "
            "refusing to guess a pairing, no-op.",
            transcript_path, len(indices), len(turn_manifest),
        )
        return 0
    if not _manifest_describes_lines(
        [_safe_transcript_timestamp(_TRANSCRIPT_LINE_RE.match(lines[i]).group(1)) for i in indices],
        turn_manifest,
    ):
        logger.warning(
            "restore_transcript_labels: %s and its turn_manifest disagree on turn times -- no-op.",
            transcript_path,
        )
        return 0

    changed = 0
    for line_idx, entry in zip(indices, turn_manifest):
        if not isinstance(entry, dict):
            continue
        if (entry.get("channel"), entry.get("diarization_speaker_id")) not in target_ids:
            continue
        timestamp_str, label, text = _TRANSCRIPT_LINE_RE.match(lines[line_idx]).groups()
        restored = entry.get(ORIGINAL_LABEL_KEY)
        if not restored:
            if _is_generic_transcript_label(label):
                continue
            restored = MULTI_SPEAKER_TRANSCRIPT_LABEL
        if label == restored:
            continue
        lines[line_idx] = f"[{timestamp_str}] [{restored}] {text}"
        changed += 1

    if changed:
        tmp_path = transcript_path.with_name(transcript_path.name + ".tmp")
        tmp_path.write_text("\n".join(lines), encoding="utf-8")
        tmp_path.replace(transcript_path)
    return changed


def relabel_transcript_exact(transcript_path: Path, turn_manifest: list, target_ids: set, display_name: str) -> int:
    """Relabel a saved transcript using EXACT recorded speaker provenance,
    instead of relabel_transcript_speaker/relabel_transcript_multi's fuzzy
    timestamp-proximity matching.

    `turn_manifest`: the sidecar's `"transcript_lines"` list (written by
    src.transcriber.transcribe_diarised/_transcribe_diarised_mono) --
    ONE ENTRY PER DIARISED TRANSCRIPT LINE, IN THE SAME ORDER, each
    `{"start", "channel", "diarization_speaker_id"}` recording the EXACT
    diarizer cluster that produced that specific line, known at the
    moment the line was first written, not reconstructed later.
    `target_ids`: a set of `(channel, diarization_speaker_id)` pairs to
    relabel as `display_name` -- callers resolve this the same way
    confirm-speaker/backfill_participants already do, via
    merge_same_channel_fragments' id_resolution, so a person confirmed
    from a diarizer-fragmented voice still matches every fragment.

    Why this replaces fuzzy matching rather than supplementing it: a
    channel's diarizer cluster segments routinely span nearly the whole
    recording, so proximity-based matching can misattribute a line to the
    wrong cluster -- or, worse, to a DIFFERENT CHANNEL's line entirely
    when the rightful channel has its own coverage gap at that exact
    moment (found for real against production data -- see the plan doc's
    Phase 8).

    Matches each transcript line to its OWN manifest entry BY POSITION --
    the i-th diarised transcript line pairs with turn_manifest[i] -- not
    by re-deriving a match from the line's displayed [MM:SS] timestamp.
    This is a real, deliberate correction from an earlier version of this
    function that matched by truncated-integer-second timestamp lookup
    across the WHOLE manifest: that was still vulnerable to the same class
    of cross-channel/cross-line collision as fuzzy matching, just at finer
    (1-second) granularity, since two DIFFERENT lines from DIFFERENT
    channels can trivially share the same displayed second. Positional
    pairing has no such ambiguity: turn_manifest and the transcript's
    diarised lines are built from the exact same `turns` list, in the
    exact same order, at the exact same time -- there is nothing to
    "match" at all, only to look up.

    Never touches "You" (self-match stays out of scope, same as the other
    two relabel functions) -- but "You" lines still consume a manifest
    position, since they're still a real turn in the same `turns` list.

    Meetings recorded before this manifest existed simply have no
    `turn_manifest` at all -- callers should fall back to
    relabel_transcript_speaker/relabel_transcript_multi in that case.
    A manifest whose length doesn't match the transcript's diarised-line
    count (e.g. a transcript hand-edited or relabeled by an older tool
    between writes) is refused outright rather than silently mispairing
    lines -- returns 0.

    Same atomic temp+rename write, same never-raises contract as
    relabel_transcript_speaker.
    """
    if not turn_manifest or not target_ids or not transcript_path.exists():
        return 0
    try:
        original = transcript_path.read_text(encoding="utf-8")
    except OSError as e:
        logger.warning("Could not read transcript %s for relabeling: %s", transcript_path, e)
        return 0

    lines = original.split("\n")
    diarised_line_indices = [i for i, line in enumerate(lines) if _TRANSCRIPT_LINE_RE.match(line)]
    if len(diarised_line_indices) != len(turn_manifest):
        logger.warning(
            "relabel_transcript_exact: %s has %d diarised lines but turn_manifest has %d entries -- "
            "refusing to guess a pairing, no-op.",
            transcript_path, len(diarised_line_indices), len(turn_manifest),
        )
        return 0
    line_starts = []
    for i in diarised_line_indices:
        try:
            line_starts.append(
                _parse_transcript_timestamp(_TRANSCRIPT_LINE_RE.match(lines[i]).group(1))
            )
        except ValueError:
            line_starts.append(None)
    if not _manifest_describes_lines(line_starts, turn_manifest):
        # An equal line count is not enough: a manifest from an earlier
        # transcription of this meeting keeps it and would then rename lines
        # by position that belong to somebody else. See
        # _manifest_describes_lines.
        logger.warning(
            "relabel_transcript_exact: %s and its turn_manifest have %d entries each but their "
            "turn times disagree -- the manifest no longer describes this transcript, no-op.",
            transcript_path, len(turn_manifest),
        )
        return 0

    # Diagnostic trail for a real, unexplained incident: two confirm-speaker
    # calls on the same meeting (different clusters) left one raw cluster's
    # lines scattered across three different labels instead of the uniform
    # result this function's own logic (and a controlled replay of it)
    # produces. Never reproduced from a clean replay, so this call's exact
    # inputs/outcome are logged to give a real trail if it recurs, rather
    # than reconstructing after the fact from the file alone.
    before_labels = Counter(
        _TRANSCRIPT_LINE_RE.match(lines[i]).group(2) for i in diarised_line_indices
    )
    logger.info(
        "relabel_transcript_exact: %s target_ids=%s display_name=%r lines=%d before_labels=%s",
        transcript_path, sorted(target_ids), display_name, len(diarised_line_indices),
        dict(before_labels),
    )

    changed = 0
    for line_idx, entry in zip(diarised_line_indices, turn_manifest):
        match = _TRANSCRIPT_LINE_RE.match(lines[line_idx])
        timestamp_str, label, text = match.groups()
        if label == "You":
            continue
        key = (entry.get("channel"), entry.get("diarization_speaker_id"))
        if key in target_ids and label != display_name:
            lines[line_idx] = f"[{timestamp_str}] [{display_name}] {text}"
            changed += 1

    logger.info("relabel_transcript_exact: %s changed=%d", transcript_path, changed)

    if changed:
        tmp_path = transcript_path.with_name(transcript_path.name + ".tmp")
        tmp_path.write_text("\n".join(lines), encoding="utf-8")
        tmp_path.replace(transcript_path)
    return changed


def confirmed_participant_names(meeting_stem: str, profiles: list) -> list:
    """Display names of every person with at least one CONFIRMED (positive)
    prototype from this meeting.

    No sidecar/cluster loading needed -- each PersonProfile's `prototypes`
    entries (positive evidence only; hard-negatives live in a structurally
    separate `hard_negatives` list, so no extra filtering is required)
    already carry the `meeting_id` they were confirmed from. A person
    counts once even with multiple prototypes from this meeting (e.g.
    merged same-channel fragments, or confirmed on both channels).

    Meeting-scoped and NOT run-scoped, deliberately -- do not "fix" this
    into running prototype_run_matches the way the cluster-level readers
    do. Attendance is a property of the meeting, not of a diarization run:
    a prototype from a superseded run no longer says WHICH cluster this
    person is, but it still says they were confirmed as present here, and
    that stays true however often the audio is re-diarized. Run-filtering
    it would empty the Participants section on every reprocess (the
    `full-reprocess` restore reads exactly this), deleting correct
    information to enforce a scope that answers a question nobody asked
    here.
    """
    names = []
    for person in profiles:
        if any(p.get("meeting_id") == meeting_stem for p in (person.get("prototypes") or [])):
            names.append(person["display_name"])
    return names


SAMPLE_TEXT_MAX_CHARS = 140


def longest_segment(segments: list) -> Optional[dict]:
    """The single longest `{"start": float, "end": float}` entry in
    `segments` -- mirrors the reference project's (pasrom/meeting-transcriber
    SpeakerNamingView.swift) "pick the longest pure segment to avoid
    cross-voice contamination" reasoning: a long continuous turn is far more
    likely to be genuine, uninterrupted speech from one real person than any
    of the short scattered blips this session's echo-artifact investigation
    found. Used as the SAME time range for both the text excerpt and the
    audio sample, so what a human reads matches what they'd hear."""
    if not segments:
        return None
    return max(segments, key=lambda s: s.get("end", 0) - s.get("start", 0))


# How many of a cluster's turns to offer as review samples. One excerpt
# (what `extract_sample_text` alone gave the panel) is a single roll of the
# dice: `longest_segment` picks the longest turn, which is the most likely
# to be uninterrupted speech but says nothing about whether it happens to
# contain anything recognizable -- a long turn can easily be someone
# reading numbers aloud. Several spread across the recording give a human
# a real chance to recognize the voice, and are also what makes a
# contaminated cluster visible: hearing two different voices under one
# cluster IS the evidence for the `MULTI_SPEAKER_KEY` marking.
SAMPLE_SEGMENT_LIMIT = 5


def sample_segments(segments: list, limit: int = SAMPLE_SEGMENT_LIMIT) -> list:
    """The canonical ordered review-sample list for one cluster's pooled
    segments: the `limit` LONGEST turns (same
    avoid-cross-voice-contamination reasoning as `longest_segment`),
    presented in CHRONOLOGICAL order so they read as a walk through the
    recording rather than a duration ranking.

    This ordering is a contract, not an implementation detail: it is what
    an index into this list means. `suggest-speakers` renders the list and
    `get-speaker-sample-audio --segment-index` plays one entry of it, and
    the two must agree on which turn index 2 is, or the play button plays
    audio from a different moment than the text beside it. Both call this
    function on identically-pooled segments rather than each sorting for
    themselves.
    """
    if not segments:
        return []
    longest = sorted(
        segments, key=lambda s: s.get("end", 0) - s.get("start", 0), reverse=True,
    )[:limit]
    return sorted(longest, key=lambda s: s.get("start", 0))


def build_transcript_manifest_index(
    transcript_path: Path,
    turn_manifest: Optional[list],
) -> dict:
    """Parse and validate a transcript manifest once for all clusters.

    The returned mapping is keyed by ``(channel, diarization_speaker_id)``.
    Values retain source-line order plus the global next-line boundary, so
    merged cluster rows can combine several keys without losing chronology.
    An empty mapping means the transcript and manifest cannot be paired
    safely.

    Deliberately does NOT skip lines labeled "You", unlike the relabel
    functions in this module. Not skipping them is the whole point: on the
    MIC channel the device owner's own turns are exactly the lines labeled
    "You", so excluding them left the owner's cluster with none of its own
    speech and filled its excerpts with whatever happened to overlap in
    time on the system channel -- i.e. a different person's words shown
    while a human decides whose voice this is. Found against a real
    three-person call, where all 11 of the owner's lines were dropped this
    way. The exclusion was inherited from `relabel_transcript_speaker`,
    where it IS correct (never rewrite the owner's label); reading and
    rewriting simply want opposite rules.

    `turn_manifest` (the sidecar's "transcript_lines", one entry per
    diarised line in order) is exact recorded provenance, the same
    mechanism confirm-speaker prefers. No ambiguity needs resolving. A
    manifest whose length doesn't match the transcript's diarised-line
    count is refused rather than mispaired, same as
    `relabel_transcript_exact`.

    WITHOUT a manifest this returns NOTHING, deliberately, rather than
    falling back to timestamp proximity. Measured against a real
    three-person call whose sidecar came from `backfill-speaker-embeddings`:

        label      in-mic  in-sys  in-both  in-neither
        You             0       3        7           1
        <other>         4      13        4           0

    Not one of the owner's eleven lines falls inside a mic segment alone,
    while four of the other participants' lines do. Proximity here is not
    merely noisy, it is INVERTED, and no exclusion rule recovers from that.
    Two causes, both structural: a backfill re-diarizes the audio in a
    separate run, so its segment boundaries were never the ones the saved
    transcript's timestamps came from; and on a call taken without
    headphones the mic channel also carries the remote voices through the
    speakers, so mic segments genuinely cover the remote speaker's turns.

    The cost of guessing is not a missing quote. It is a quote from a
    DIFFERENT PERSON displayed under this speaker's name, at the exact
    moment a human is deciding whose voice this is -- the failure that
    prompted this function. The play button is unaffected and stays the
    honest half: it cuts audio at this cluster's own segments, which are
    internally consistent with the run that produced them.
    """
    if not turn_manifest or not transcript_path.exists():
        return {}
    try:
        content = transcript_path.read_text(encoding="utf-8")
    except OSError:
        return {}

    parsed = []
    for line in content.split("\n"):
        match = _TRANSCRIPT_LINE_RE.match(line)
        if not match:
            continue
        timestamp_str, _label, text = match.groups()
        try:
            parsed.append((_parse_transcript_timestamp(timestamp_str), text))
        except ValueError:
            # A line whose timestamp will not parse still occupies a
            # manifest position, so keep it in the sequence rather than
            # silently shifting every later pairing by one.
            parsed.append((None, text))

    if len(turn_manifest) != len(parsed):
        # Same refusal as relabel_transcript_exact: a manifest that does not
        # line up with the transcript cannot be paired by position, and
        # guessing a pairing is how a line ends up under the wrong speaker.
        logger.warning(
            "cluster_transcript_lines: %s has %d diarised lines but turn_manifest has "
            "%d entries -- refusing to guess a pairing, no excerpt text.",
            transcript_path, len(parsed), len(turn_manifest),
        )
        return {}
    if not _manifest_describes_lines([ts for ts, _text in parsed], turn_manifest):
        # Same refusal one step further in: the count survives a manifest
        # left over from an earlier transcription of this meeting, and
        # pairing by position then quotes one person under another's name.
        logger.warning(
            "cluster_transcript_lines: %s and its turn_manifest have %d entries each but their "
            "turn times disagree -- the manifest no longer describes this transcript, "
            "no excerpt text.",
            transcript_path, len(turn_manifest),
        )
        return {}
    # (start, next_line_start, text) per owned line. The third element is
    # what makes a turn bounded at all: a transcript line carries only ONE
    # timestamp, its START, because src.transcriber merges consecutive
    # segments of the same speaker into one turn
    # (`if turns and turns[-1][1] == speaker: turns[-1][2].append(text)`).
    # The next line's start is therefore the only available upper bound on
    # where this turn's speech stops.
    #
    # Take that start from the MANIFEST wherever it offers one, not from the
    # rendered marker. `[MM:SS]` is truncated with int(), so the marker loses
    # up to a second and two turns inside one second become indistinguishable
    # -- measured on real meetings, 18 of 264 and 34 of 643 lines share a
    # displayed second, and only the manifest can tell them apart. The
    # manifest keeps each turn's real start (251 of those 264 entries carry a
    # fractional value), from the same run as the segments, and
    # _manifest_describes_lines has already confirmed the two agree position
    # by position. With the exact values 88.6 % of lines fall straight inside
    # one of their own cluster's segments; with the markers far fewer do, and
    # the difference is what _turn_audio_range then has to guess at.
    starts = []
    for (marker_ts, _text), entry in zip(parsed, turn_manifest):
        manifest_ts = entry.get("start") if isinstance(entry, dict) else None
        if isinstance(manifest_ts, (int, float)) and math.isfinite(manifest_ts):
            starts.append(float(manifest_ts))
        else:
            starts.append(marker_ts)

    next_starts = []
    for index in range(len(starts)):
        following = next(
            (starts[j] for j in range(index + 1, len(starts)) if starts[j] is not None),
            None,
        )
        next_starts.append(following)

    index: dict = {}
    for position, (ts, (_marker, text), next_start, entry) in enumerate(zip(
        starts, parsed, next_starts, turn_manifest,
    )):
        if ts is None or not isinstance(entry, dict):
            continue
        key = (entry.get("channel"), entry.get("diarization_speaker_id"))
        if not all(isinstance(value, str) and value for value in key):
            continue
        index.setdefault(key, []).append((position, ts, next_start, text))
    return index


def _transcript_lines_from_index(transcript_index: dict, target_ids: Optional[set]) -> list:
    if not transcript_index or not target_ids:
        return []
    matched = [
        row
        for target_id in target_ids
        for row in transcript_index.get(target_id, [])
    ]
    matched.sort(key=lambda row: row[0])
    return [(timestamp, next_start, text) for _, timestamp, next_start, text in matched]


def cluster_transcript_lines(
    transcript_path: Path,
    turn_manifest: Optional[list] = None,
    target_ids: Optional[set] = None,
) -> list:
    """Transcript turns belonging to one cluster, using exact provenance.

    This compatibility wrapper builds an index for one caller. Meeting-wide
    callers should build it once with :func:`build_transcript_manifest_index`
    and pass it to ``extract_segment_samples``.
    """
    return _transcript_lines_from_index(
        build_transcript_manifest_index(transcript_path, turn_manifest),
        target_ids,
    )


def _join_texts(texts: list, max_chars: int) -> Optional[str]:
    if not texts:
        return None
    combined = " ".join(texts).strip()
    if len(combined) > max_chars:
        combined = combined[:max_chars].rstrip() + "…"
    return combined or None


# Below this a clip cannot carry a voice, however faithfully its quote
# matches it -- and matching the quote is not the point of the panel,
# recognising a speaker is. Without this floor, preferring turns that
# survive both display caps handed a 0.1 s "Ja" priority over a 19 s turn
# whose quote missed the character cap by one character.
#
# CHOSEN, not measured, unlike SUGGESTION_MIN_AVG_TURN_SECONDS above (which
# is ground-truthed against a real library, but answers a different
# question: whether a cluster's average turn looks like an artifact). Two
# seconds is about the shortest clip a listener can place a voice from; it
# sits just above that measured 1.55 s neighbour, which is the right order
# of magnitude but not evidence for this number.
SAMPLE_MIN_USEFUL_SECONDS = 2.0

# A review clip is never longer than this, even when the next transcript
# line is minutes away (a long pause, or the speaker holding the floor
# uninterrupted). Nobody listens to five minutes to recognise a voice, and
# an unbounded clip would also mean an unbounded ffmpeg extraction.
SAMPLE_MAX_SECONDS = 20.0

# src.transcriber's _format_timestamp renders a turn's start with int(), so
# a transcript marker is truncated to the whole second below it: the speech
# it labels begins somewhere in [marker, marker + 1). Only relevant where the
# manifest carried no exact start to use instead.
TRANSCRIPT_MARKER_TRUNCATION_SECONDS = 1.0

# How far a line's own speech may start AFTER the line before the moment
# counts as unplaceable. Transcript markers render as [MM:SS], truncated to
# whole seconds, so a small positive lead is normal and expected.
#
# Measured across three real meetings and thirteen clusters (37-minute call,
# a 643-line meeting, a five-cluster call): of the lines that do not fall
# inside one of their cluster's own segments, the nearest own segment is at
# most 1.32 s away, with a p90 of ~1.1 s. Nothing legitimate sits further
# out. The clips this guard rejects were 17.8 s and 35.3 s away -- this
# speaker's voice, saying something else entirely, shown under the quoted
# line.
SAMPLE_TURN_MAX_LEAD_SECONDS = 2.0

# How long a hole between two of one cluster's segments may be before the
# clip stops there instead of playing across it. A speaker pausing mid-turn
# leaves gaps of this order; a gap much longer than a second is where the
# diarizer heard somebody, or something, else.
SAMPLE_TURN_GAP_TOLERANCE_SECONDS = 1.0


def _turn_audio_range(segments: list, start: float, next_start: Optional[float]) -> tuple:
    """The time range of ONE turn's speech by this cluster: its own
    diarization segments from this line's start onward, ending at the next
    line, at SAMPLE_MAX_SECONDS, or at the first hole this cluster did not
    fill -- whichever comes first.

    This is the piece that makes a clip and the text beside it describe the
    same thing. Selecting by SEGMENT and then hunting for a line inside it
    -- the earlier design -- cannot: src.transcriber merges consecutive
    segments of one speaker into a single turn carrying only the FIRST
    segment's timestamp, so every later segment of that turn contains no
    line start at all.

    Every fallback here stays inside THIS CLUSTER'S OWN SEGMENTS. There is
    deliberately no "window of N seconds around the timestamp" path, and
    that is a correction: one existed, and a review found it reachable.
    Transcript timestamps render as [MM:SS], so two turns inside the same
    second carry the SAME value; `next_start` then equals `start`, the
    bounded set comes back empty, and the window took over -- playing the
    next speaker under this speaker's name, the exact failure this whole
    function exists to prevent. Audio we cannot place is not played.
    """
    # An upper bound at or before the line itself bounds nothing. Where the
    # manifest supplied no exact start, `start` falls back to the truncated
    # marker, and two turns inside one second then carry the same value.
    # Bounding at `start` would admit only segments overlapping the marker --
    # the previous line's tail -- and exclude this line's own speech a
    # fraction of a second later. Found by review, with segments 9.9-10.2 and
    # 10.8-10.9 at two lines both marked 10.0.
    upper = (
        next_start
        if next_start is not None and next_start > start
        else float("inf")
    )
    # A segment that is ALREADY RUNNING when the line starts counts. One
    # diarization segment routinely spans several transcript lines, so the
    # segment a line belongs to usually began before it: measured on a real
    # 37-minute call, 64 of one cluster's 109 lines start mid-segment.
    # Requiring `seg.start >= line.start` skipped exactly the segment the
    # line sits in and walked the clip forward to the next one -- 35.3 s
    # away in the worst case, off by 0.22 s of tolerance in the mildest.
    #
    # Strictly `end > start`, with no backward tolerance: a segment that has
    # already finished by the line's start is the tail of the PREVIOUS turn.
    # Admitting one cost the line its own audio -- it sorted first, and the
    # gap rule then stopped the range before the real speech began, reporting
    # the moment unplayable. Found by review, with segments 9.0-9.8 and
    # 10.9-11.5 at a line starting 10.0.
    own = [
        seg for seg in segments
        if seg.get("end", 0) > start and seg.get("start", 0) < upper
    ]
    if not own:
        # Bounds hold none of this cluster's segments: same displayed
        # second as the next line, or a manifest that disagrees with the
        # segments. Use this cluster's nearest segment at or after the line
        # instead -- still its own audio, unlike a blind window.
        following = [seg for seg in segments if seg.get("end", 0) > start]
        if not following:
            return start, start
        own = [min(following, key=lambda seg: seg.get("start", 0))]

    # Same cluster is not the same moment. Once the nearest own speech is
    # further out than the truncation of a [MM:SS] marker can explain, there
    # is nothing here this line demonstrably said, and playing the next thing
    # this voice happens to say is the failure this pairing exists to
    # prevent -- made worse by the panel showing the CLIP's timestamp beside
    # the quote, so the mismatch looks like a transcription error.
    if min(seg.get("start", 0) for seg in own) - start > SAMPLE_TURN_MAX_LEAD_SECONDS:
        return start, start

    # From the turn's first own segment onward, and only for as long as this
    # cluster keeps speaking. Taking min(start)/max(end) over the whole set
    # spanned the holes between segments as well, and a hole is by
    # definition time this cluster was NOT speaking -- on a mic channel
    # taken without headphones, exactly where the remote voices sit.
    # `next_start` and SAMPLE_MAX_SECONDS bound how far that can reach; they
    # do not stop it.
    #
    # Pauses shorter than SAMPLE_TURN_GAP_TOLERANCE_SECONDS are still
    # bridged: a turn IS several consecutive segments of one speaker (see
    # src.transcriber's turn merging), separated by that speaker's own
    # breathing, and cutting at every one of those would leave clips too
    # short to recognise a voice from -- the one thing the panel is for.
    # A segment spanning the line is ambiguous: usually it is the one the
    # line sits in, but it can also be the previous turn's tail reaching past
    # it. Where `start` came from a truncated marker rather than the
    # manifest, this line's real speech begins within one second of it, so a
    # segment STARTING in that window is the better opening, and only when
    # none does is the spanning segment the right answer -- the common case,
    # a line well inside a long segment. Found by review, with segments
    # 9.5-10.2 and 10.9-11.5 at a line marked 10.0.
    #
    # This picks only where the range OPENS. Everything from there on stays
    # in play, so a turn made of several segments is still bridged below.
    starting_in_window = [
        seg for seg in own
        if start <= seg.get("start", 0) < min(upper, start + TRANSCRIPT_MARKER_TRUNCATION_SECONDS)
    ]
    #
    # Unless a sibling line shares this displayed second, which only happens
    # on the marker fallback. Then the segment starting later in the window
    # is most likely the SIBLING'S, and the spanning one is ours -- the
    # opposite of the single-line case, and the one piece of evidence that
    # tells the two apart. Found by review, with segments 9.9-10.2 and
    # 10.8-10.9 at two lines both falling back to marker 10.0.
    shares_second_with_next = next_start is not None and next_start <= start
    ordered = sorted(own, key=lambda seg: seg.get("start", 0))
    if starting_in_window and not shares_second_with_next:
        opening = min(seg.get("start", 0) for seg in starting_in_window)
        ordered = [seg for seg in ordered if seg.get("start", 0) >= opening]
    # Never earlier than the line itself: the segment it sits in may have
    # begun long before, and that earlier speech belongs to the PREVIOUS
    # line, which is quoted elsewhere in this same list.
    begin = max(start, ordered[0].get("start", 0))
    end = ordered[0].get("end", 0)
    for seg in ordered[1:]:
        if seg.get("start", 0) - end > SAMPLE_TURN_GAP_TOLERANCE_SECONDS:
            break
        # max(), not the later end: a segment nested inside a longer one
        # must not shorten the turn it sits in.
        end = max(end, seg.get("end", 0))

    # Never run into the next speaker's line. Guarded on `next_start > begin`
    # so a next line sharing this one's displayed second cannot clip the
    # range to nothing and re-open the fallback.
    if next_start is not None and next_start > begin:
        end = min(end, next_start)
    end = min(end, begin + SAMPLE_MAX_SECONDS)
    # No inventing length: a collapsed range means there is nothing this
    # cluster demonstrably said here, and extract_speaker_sample_audio
    # refuses a non-positive duration rather than cutting arbitrary audio.
    return (begin, end) if end > begin else (begin, begin)


def extract_segment_samples(
    transcript_path: Path,
    segments: list,
    limit: int = SAMPLE_SEGMENT_LIMIT,
    max_chars: int = SAMPLE_TEXT_MAX_CHARS,
    turn_manifest: Optional[list] = None,
    target_ids: Optional[set] = None,
    transcript_index: Optional[dict] = None,
) -> list:
    """`[{"start", "end", "text"}]` -- the moments offered for review, in
    chronological order, each independently playable.

    Driven by this cluster's TURNS when the sidecar carries a manifest, and
    only by its segments otherwise. The distinction is the whole point: a
    turn is a unit of speech that has text, a segment is a unit of acoustics
    that usually does not, and pairing a clip with a quote requires the
    former (see `_turn_audio_range`).

    Without a manifest there are no turns to attribute, so the entries carry
    the cluster's longest segments and `text: None`. Those are still worth
    offering -- the audio is this cluster's own, and listening is what
    identifies a voice; a quote was always the lesser half.
    """
    owned = (
        _transcript_lines_from_index(transcript_index, target_ids)
        if transcript_index is not None
        else cluster_transcript_lines(
            transcript_path, turn_manifest=turn_manifest, target_ids=target_ids,
        )
    )

    if not owned:
        return [
            {"start": seg.get("start", 0), "end": seg.get("end", 0), "text": None}
            for seg in sample_segments(segments, limit)
        ]

    candidates = []
    for start, next_start, text in owned:
        begin, end = _turn_audio_range(segments, start, next_start)
        candidates.append({
            "start": begin,
            "end": end,
            "text": _join_texts([text], max_chars),
            # Whether this turn survives BOTH display caps whole. The quote
            # is cut at max_chars and the clip at SAMPLE_MAX_SECONDS, and
            # nothing related the two: measured on a real 9-minute call, a
            # 40.5 s / 742-character turn showed 19 % of its text beside
            # 20 s of audio. Reading one sentence while hearing twenty
            # seconds reads as the wrong clip, even though both start at
            # the same instant.
            # `<=` on both caps: a turn ending exactly at the audio limit
            # survives it whole, exactly as a quote of exactly max_chars
            # does. And a clip too short to place a voice earns no
            # preference, however completely it is quoted.
            "fits": (
                len(text) <= max_chars
                and (end - begin) <= SAMPLE_MAX_SECONDS
                and (end - begin) >= SAMPLE_MIN_USEFUL_SECONDS
            ),
        })

    # Whole turns first, longest among them; overflowing ones only fill the
    # remaining slots. Ranking by raw duration alone preferred precisely the
    # turns that overflow, because overflowing is what being long means here
    # -- the same amplification that made a drifted clip more likely to be
    # shown before _turn_audio_range stopped drifting. A turn that fits is
    # still chosen longest-first, so the clip stays long enough to
    # recognise a voice from.
    chosen = sorted(
        candidates,
        key=lambda c: (c["fits"], c["end"] - c["start"]),
        reverse=True,
    )[:limit]
    return sorted(chosen, key=lambda c: c["start"])


def extract_sample_text(
    transcript_path: Path,
    segments: list,
    max_chars: int = SAMPLE_TEXT_MAX_CHARS,
    turn_manifest: Optional[list] = None,
    target_ids: Optional[set] = None,
) -> Optional[str]:
    """A short quoted excerpt of what this cluster actually said -- the one
    line shown on the collapsed row, so a human scanning the panel has
    something to recognise a voice by without expanding anything.

    Deliberately the SAME text as `extract_segment_samples`' first-ranked
    entry, obtained by asking that function rather than repeating its
    selection: two independent derivations of "the most representative
    thing this speaker said" drift apart, and the visible symptom is a
    collapsed row quoting one moment while expanding it offers five others
    that never include it.

    Ownership comes from the sidecar's turn manifest, never from a line's
    label: an earlier version skipped every line labeled "You", which
    silently guaranteed that the device owner's own mic cluster quoted
    somebody ELSE (see cluster_transcript_lines). Returns None, never
    raises, when there is nothing attributable -- a best-effort aid, not a
    requirement for the row to render.
    """
    return sample_text_from_samples(extract_segment_samples(
        transcript_path, segments, max_chars=max_chars,
        turn_manifest=turn_manifest, target_ids=target_ids,
    ))


def sample_text_from_samples(samples: list) -> Optional[str]:
    """The collapsed row's quote, taken from an ALREADY BUILT excerpt list.

    Split out from extract_sample_text so a caller that needs both -- the
    suggest-speakers CLI builds `samples` for every cluster anyway -- pays
    for the transcript parse and the manifest check once instead of twice
    per cluster. The selection itself is unchanged, and deliberately still
    reads out of the same list the expanded rows show: two independent
    derivations of "the most representative thing this speaker said" drift
    apart, and the visible symptom is a collapsed row quoting a moment that
    expanding never offers.
    """
    longest = max(
        (s for s in samples if s["text"]),
        key=lambda s: s["end"] - s["start"], default=None,
    )
    return longest["text"] if longest else None


# Small buffer around the longest segment's exact boundaries so a clip
# doesn't clip off a word right at the edge -- audio segment boundaries
# from diarization are approximate, unlike a hard cut.
SAMPLE_AUDIO_PADDING_SECONDS = 0.3
SAMPLE_AUDIO_EXTRACTION_TIMEOUT_SECONDS = 30


def extract_speaker_sample_audio(
    audio_filepath: Path,
    channel: str,
    segments: list,
    output_path: Path,
    segment_index=None,
) -> bool:
    """Extract a short audio clip covering this cluster's longest pooled
    segment from the ORIGINAL source recording, for the review UI's play
    button. Mirrors the reference project's (pasrom/meeting-transcriber,
    SpeakerNamingView.swift) "pick the longest pure segment to avoid
    cross-voice contamination" reasoning -- and uses the exact same time
    range `extract_sample_text` quotes, so what a human reads matches what
    they'd hear.

    `channel` is "mic" (source channel 0) or "system" (source channel 1) --
    same mapping as src.transcriber._split_stereo_to_channels, so a mono
    recording (channel index 0 only) also works correctly for "mic".

    `segment_index` selects WHICH moment to cut. It accepts either an
    explicit `{"start", "end"}` range -- what the CLI passes, taken straight
    from the entry the user clicked -- or an integer index into
    `sample_segments` for callers that have only segments. Out-of-range
    integers return False rather than silently falling back to the longest
    segment: a caller asking for excerpt 4 and hearing excerpt 1 would have
    no way to notice, and would reasonably conclude the two speakers sound
    identical.

    Returns True on success (output_path written), False on any failure --
    no ffmpeg, no source recording (the common case for an older backfilled
    meeting with keep_recordings off), a bad time range, or an ffmpeg
    error. Never raises: this is a best-effort UI aid, never something that
    can fail the review panel.
    """
    if isinstance(segment_index, dict):
        # An explicit {"start", "end"} range, which is how the CLI passes the
        # entry the user actually clicked. Re-deriving the list here instead
        # would mean two independent selections of "sample i" that must agree
        # forever -- and they would not, since the list is built from TURNS
        # when a manifest exists and from segments when it does not.
        target = segment_index
    elif segment_index is None:
        target = longest_segment(segments)
    else:
        chosen = sample_segments(segments)
        target = chosen[segment_index] if 0 <= segment_index < len(chosen) else None
    if target is None or not audio_filepath.exists():
        return False

    from src.transcriber import _resolve_ffmpeg

    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        return False

    ch_idx = 0 if channel == "mic" else 1
    # Decided on the UNPADDED range, and that ordering is the whole guard.
    # _turn_audio_range collapses a moment it cannot place to (start, start)
    # precisely so this function refuses it; checking after the two pads
    # were added turned that refusal into a 0.6s clip AROUND the timestamp
    # -- the audio of whoever actually was speaking there, played under this
    # speaker's name. The pads may widen a real clip, never create one.
    # Written as `not span > 0` so a NaN boundary (a backend emitting one,
    # which _format_timestamp already guards against elsewhere) refuses too.
    span = target.get("end", 0) - target.get("start", 0)
    if not span > 0:
        return False
    span = min(span, SAMPLE_MAX_SECONDS)
    start = max(0.0, target.get("start", 0) - SAMPLE_AUDIO_PADDING_SECONDS)
    duration = span + 2 * SAMPLE_AUDIO_PADDING_SECONDS

    try:
        result = subprocess.run(
            [
                ffmpeg, "-y", "-ss", str(start), "-t", str(duration),
                "-i", str(audio_filepath),
                "-af", f"pan=mono|c0=c{ch_idx}",
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
                str(output_path),
            ],
            capture_output=True, timeout=SAMPLE_AUDIO_EXTRACTION_TIMEOUT_SECONDS,
        )
        return (
            result.returncode == 0
            and output_path.exists()
            and output_path.stat().st_size > 0
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        logger.warning("Could not extract speaker sample audio: %s", e)
        return False
