import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src.speaker_sidecar_store import SpeakerSidecarStore
from src.speaker_suggestions import (
    ClusterContext,
    REVIEW_STATE_GENERIC,
    REVIEW_STATE_KEY,
    SAMPLE_AUDIO_PADDING_SECONDS,
    SAMPLE_MAX_SECONDS,
    SAME_MEETING_MERGE_DISTANCE_THRESHOLD,
    SUGGESTION_MIN_AVG_TURN_SECONDS,
    SUGGESTION_MIN_DURATION_SECONDS,
    SUGGESTION_MIN_SEGMENT_COUNT,
    build_clusters_from_diarization,
    build_transcript_manifest_index,
    clear_cluster_review_state,
    clusters_from_sidecar_channel,
    confirmed_participant_names,
    determine_recording_type,
    extract_sample_text,
    extract_segment_samples,
    extract_speaker_sample_audio,
    longest_segment,
    merge_same_channel_fragments,
    prototype_channel_matches,
    prototype_run_matches,
    read_speakers_sidecar,
    relabel_transcript_exact,
    relabel_transcript_multi,
    relabel_transcript_speaker,
    score_candidates,
    set_cluster_multi_speaker,
    set_cluster_review_state,
    suggest_speaker,
    suggest_speakers_for_meeting,
    write_sidecar_document,
    write_speakers_sidecar,
)
from src.voiceprint import cosine_distance


def _profile(person_id, display_name, prototypes=None, hard_negatives=None):
    return {
        "person_id": person_id,
        "display_name": display_name,
        "prototypes": prototypes or [],
        "hard_negatives": hard_negatives or [],
    }


_prototype_counter = [0]


def _prototype(embedding, recording_type="in_person", meeting_id=None):
    # Auto-incrementing default meeting_id -- most tests don't care about
    # the confirmed-meetings gate, so each call looks like a distinct
    # meeting by default. Tests specifically exercising
    # SUGGESTION_MIN_CONFIRMED_MEETINGS pass an explicit meeting_id to
    # simulate multiple prototypes confirmed within the SAME meeting.
    if meeting_id is None:
        _prototype_counter[0] += 1
        meeting_id = f"auto_mtg_{_prototype_counter[0]}"
    return {"embedding_mean": embedding, "recording_type": recording_type, "meeting_id": meeting_id}


def _multi_meeting_prototypes(*embeddings, recording_type="in_person"):
    """N prototypes, each from a distinct auto-generated meeting -- the
    common case for a "confirmed" test that needs to clear
    SUGGESTION_MIN_CONFIRMED_MEETINGS."""
    return [_prototype(e, recording_type=recording_type) for e in embeddings]


def _stable_context(sid="SPEAKER_0", recording_type="in_person"):
    return ClusterContext(
        meeting_id="mtg001", diarization_speaker_id=sid,
        recording_type=recording_type,
        speech_duration_seconds=SUGGESTION_MIN_DURATION_SECONDS,
        segment_count=SUGGESTION_MIN_SEGMENT_COUNT,
    )


class DetermineRecordingTypeTests(unittest.TestCase):
    def test_mic_with_audio_is_in_person(self):
        self.assertEqual(determine_recording_type("mic", has_audio=True), "in_person")

    def test_system_with_audio_is_remote(self):
        self.assertEqual(determine_recording_type("system", has_audio=True), "remote")

    def test_mic_without_audio_is_unknown(self):
        self.assertEqual(determine_recording_type("mic", has_audio=False), "unknown")

    def test_system_without_audio_is_unknown(self):
        self.assertEqual(determine_recording_type("system", has_audio=False), "unknown")

    def test_hybrid_meeting_mic_stays_in_person_even_with_remote_system_audio(self):
        # A hybrid meeting (some people in-room, some remote) must not
        # relabel the mic channel "remote" just because the system channel
        # also has real audio -- each channel's type depends only on its
        # own audio presence.
        self.assertEqual(determine_recording_type("mic", has_audio=True), "in_person")
        self.assertEqual(determine_recording_type("system", has_audio=True), "remote")


class BuildClustersFromDiarizationTests(unittest.TestCase):
    """Shared by both the live pipeline (src.transcriber._tag_channel_segments)
    and backfill-speaker-embeddings -- both start from the exact
    (segments, embeddings) shape _run_steno_diarize returns."""

    def test_groups_segments_by_speaker_with_aggregates(self):
        segments = [
            {"start": 0.0, "end": 1.0, "speaker": "SPEAKER_0"},
            {"start": 1.0, "end": 3.5, "speaker": "SPEAKER_1"},
            {"start": 3.5, "end": 4.5, "speaker": "SPEAKER_0"},
        ]
        embeddings = {"SPEAKER_0": [0.1, 0.2], "SPEAKER_1": [0.3, 0.4]}
        clusters = build_clusters_from_diarization(segments, embeddings)
        self.assertEqual(clusters["SPEAKER_0"]["embedding"], [0.1, 0.2])
        self.assertAlmostEqual(clusters["SPEAKER_0"]["speech_duration_seconds"], 2.0)
        self.assertEqual(clusters["SPEAKER_0"]["segment_count"], 2)
        self.assertEqual(
            clusters["SPEAKER_0"]["segments"],
            [{"start": 0.0, "end": 1.0}, {"start": 3.5, "end": 4.5}],
        )
        self.assertEqual(clusters["SPEAKER_1"]["segment_count"], 1)
        self.assertAlmostEqual(clusters["SPEAKER_1"]["speech_duration_seconds"], 2.5)

    def test_speaker_with_embedding_but_no_segments_is_excluded(self):
        # A speaker slot the sidecar reports an embedding for but that never
        # actually appears in the segment list -- shouldn't happen, but
        # must not produce a cluster with no real evidence.
        segments = [{"start": 0.0, "end": 1.0, "speaker": "SPEAKER_0"}]
        embeddings = {"SPEAKER_0": [0.1, 0.2], "SPEAKER_1": [0.3, 0.4]}
        clusters = build_clusters_from_diarization(segments, embeddings)
        self.assertEqual(list(clusters.keys()), ["SPEAKER_0"])

    def test_empty_segments_returns_empty_clusters(self):
        self.assertEqual(build_clusters_from_diarization([], {}), {})


class ScoreCandidatesTests(unittest.TestCase):
    def test_prefers_same_context_prototypes(self):
        profiles = [_profile("p1", "Person Gamma", prototypes=[
            _prototype([1.0, 0.0], recording_type="remote"),   # far from query, wrong context
            _prototype([0.0, 1.0], recording_type="in_person"),  # close to query, right context
        ])]
        context = _stable_context(recording_type="in_person")
        candidates = score_candidates([0.0, 1.0], context, profiles)
        self.assertAlmostEqual(candidates[0].distance, 0.0, places=6)

    def test_falls_back_to_cross_context_when_none_match(self):
        profiles = [_profile("p1", "Person Gamma", prototypes=[
            _prototype([0.0, 1.0], recording_type="remote"),
        ])]
        context = _stable_context(recording_type="in_person")
        candidates = score_candidates([0.0, 1.0], context, profiles)
        self.assertEqual(len(candidates), 1)
        self.assertAlmostEqual(candidates[0].distance, 0.0, places=6)

    def test_person_with_no_prototypes_at_all_is_skipped(self):
        profiles = [_profile("p1", "Person Gamma", prototypes=[])]
        candidates = score_candidates([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(candidates, [])

    def test_flags_hard_negative_conflict(self):
        profiles = [_profile(
            "p1", "Person Gamma",
            prototypes=[_prototype([1.0, 0.0])],
            hard_negatives=[_prototype([1.0, 0.0])],  # query will land right on this too
        )]
        candidates = score_candidates([1.0, 0.0], _stable_context(), profiles)
        self.assertTrue(candidates[0].hard_negative_conflict)

    def test_no_hard_negative_conflict_when_query_far_from_negatives(self):
        profiles = [_profile(
            "p1", "Person Gamma",
            prototypes=[_prototype([1.0, 0.0])],
            hard_negatives=[_prototype([0.0, 1.0])],  # orthogonal, far
        )]
        candidates = score_candidates([1.0, 0.0], _stable_context(), profiles)
        self.assertFalse(candidates[0].hard_negative_conflict)

    def test_no_conflict_when_positive_clearly_beats_negative(self):
        # Suppression is relative: a negative at ~0.3 must not kill an
        # exact-match positive (distance 0) -- that negative just sits at
        # an ordinary cross-speaker distance, which every colleague's
        # confirm adds. The old absolute rule suppressed exactly these.
        profiles = [_profile(
            "p1", "Person Gamma",
            prototypes=[_prototype([1.0, 0.0])],
            hard_negatives=[_prototype([0.7, 0.714])],  # distance ~0.3 from query
        )]
        candidates = score_candidates([1.0, 0.0], _stable_context(), profiles)
        self.assertFalse(candidates[0].hard_negative_conflict)
        self.assertAlmostEqual(candidates[0].negative_distance, 0.3, places=2)

    def test_conflict_when_negative_within_margin_of_positive(self):
        # Positive at ~0.25, negative at ~0.3: the negative evidence rivals
        # the positive (within SUGGESTION_CONFIDENCE_MARGIN), so suppress.
        profiles = [_profile(
            "p1", "Person Gamma",
            prototypes=[_prototype([0.75, 0.661])],   # distance ~0.25 from query
            hard_negatives=[_prototype([0.7, 0.714])],  # distance ~0.3 from query
        )]
        candidates = score_candidates([1.0, 0.0], _stable_context(), profiles)
        self.assertTrue(candidates[0].hard_negative_conflict)

    def test_no_conflict_when_negative_beyond_absolute_threshold(self):
        # A negative past HARD_NEGATIVE_DISTANCE_THRESHOLD is not
        # meaningful evidence at all, however weak the positive is.
        profiles = [_profile(
            "p1", "Person Gamma",
            prototypes=[_prototype([0.75, 0.661])],  # distance ~0.25
            hard_negatives=[_prototype([0.5, 0.866])],  # distance ~0.5, beyond 0.40
        )]
        candidates = score_candidates([1.0, 0.0], _stable_context(), profiles)
        self.assertFalse(candidates[0].hard_negative_conflict)

    def test_negative_distance_is_none_without_negatives(self):
        profiles = [_profile("p1", "Person Gamma", prototypes=[_prototype([1.0, 0.0])])]
        candidates = score_candidates([1.0, 0.0], _stable_context(), profiles)
        self.assertIsNone(candidates[0].negative_distance)

    def test_results_sorted_ascending_by_distance(self):
        profiles = [
            _profile("p1", "Far", prototypes=[_prototype([0.0, 1.0])]),
            _profile("p2", "Close", prototypes=[_prototype([1.0, 0.0])]),
        ]
        candidates = score_candidates([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual([c.display_name for c in candidates], ["Close", "Far"])

    def test_confirmed_meeting_count_counts_distinct_meeting_ids_in_pool(self):
        profiles = [_profile("p1", "Person Gamma", prototypes=[
            _prototype([1.0, 0.0], meeting_id="mtg_a"),
            _prototype([0.9, 0.1], meeting_id="mtg_a"),  # same meeting again
            _prototype([0.8, 0.2], meeting_id="mtg_b"),
        ])]
        candidates = score_candidates([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(candidates[0].confirmed_meeting_count, 2)


class SuggestSpeakerTests(unittest.TestCase):
    def test_confirmed_when_threshold_margin_and_stability_all_clear(self):
        profiles = [_profile("p1", "Person Gamma", prototypes=_multi_meeting_prototypes([1.0, 0.0], [0.98, 0.01]))]
        result = suggest_speaker([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(result.status, "confirmed")
        self.assertEqual(result.suggested_name, "Person Gamma")
        self.assertEqual(result.suggested_person_id, "p1")

    def test_possible_when_duration_is_below_stability_gate(self):
        profiles = [_profile(
            "p1", "Person Gamma",
            prototypes=_multi_meeting_prototypes([1.0, 0.0], [0.98, 0.01]),
        )]
        weak_context = ClusterContext(
            meeting_id="mtg001", diarization_speaker_id="SPEAKER_0",
            recording_type="in_person",
            speech_duration_seconds=SUGGESTION_MIN_DURATION_SECONDS - 0.1,
            segment_count=SUGGESTION_MIN_SEGMENT_COUNT,
        )
        result = suggest_speaker([1.0, 0.0], weak_context, profiles)
        self.assertEqual(result.status, "possible")
        self.assertEqual(result.suggested_name, "Person Gamma")

    def test_possible_when_segment_count_is_below_stability_gate(self):
        profiles = [_profile(
            "p1", "Person Gamma",
            prototypes=_multi_meeting_prototypes([1.0, 0.0], [0.98, 0.01]),
        )]
        weak_context = ClusterContext(
            meeting_id="mtg001", diarization_speaker_id="SPEAKER_0",
            recording_type="in_person",
            speech_duration_seconds=SUGGESTION_MIN_DURATION_SECONDS,
            segment_count=SUGGESTION_MIN_SEGMENT_COUNT - 1,
        )
        result = suggest_speaker([1.0, 0.0], weak_context, profiles)
        self.assertEqual(result.status, "possible")
        self.assertEqual(result.suggested_name, "Person Gamma")

    def test_possible_when_margin_too_close(self):
        profiles = [
            _profile("p1", "Person Gamma", prototypes=[_prototype([1.0, 0.0])]),
            _profile("p2", "Sam", prototypes=[_prototype([0.99, 0.02])]),  # near-tie
        ]
        result = suggest_speaker([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(result.status, "possible")

    def test_none_when_below_distance_threshold(self):
        profiles = [_profile("p1", "Person Gamma", prototypes=[_prototype([-1.0, 0.0])])]  # orthogonal/opposite
        result = suggest_speaker([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(result.status, "none")
        self.assertIsNone(result.suggested_name)

    def test_none_when_no_profiles(self):
        result = suggest_speaker([1.0, 0.0], _stable_context(), [])
        self.assertEqual(result.status, "none")
        self.assertEqual(result.candidates, [])

    def test_hard_negative_conflict_suppresses_even_strong_match(self):
        profiles = [_profile(
            "p1", "Person Gamma",
            prototypes=[_prototype([1.0, 0.0])],
            hard_negatives=[_prototype([1.0, 0.0])],
        )]
        result = suggest_speaker([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(result.status, "none")
        self.assertIsNone(result.suggested_name)

    def test_strong_match_survives_a_moderate_hard_negative(self):
        # The relative rule's recall half: an exact-match cluster stays
        # "confirmed" even though a stored negative sits at ~0.3 (an
        # ordinary cross-speaker distance).
        profiles = [_profile(
            "p1", "Person Gamma",
            prototypes=_multi_meeting_prototypes([1.0, 0.0], [0.98, 0.01]),
            hard_negatives=[_prototype([0.7, 0.714])],  # distance ~0.3 from query
        )]
        result = suggest_speaker([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(result.status, "confirmed")
        self.assertEqual(result.suggested_name, "Person Gamma")

    def test_never_raises_on_malformed_profile(self):
        # Missing "prototypes" key entirely shouldn't crash scoring.
        profiles = [{"person_id": "p1", "display_name": "Person Gamma"}]
        result = suggest_speaker([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(result.status, "none")

    def test_possible_when_avg_turn_too_short_despite_duration_and_segment_count(self):
        # Real-library finding: a fragmented echo/crosstalk artifact cluster
        # (many short scattered blips) can rack up plenty of cumulative
        # duration and segment count without ever looking like sustained
        # real speech -- duration/segment-count gates alone don't catch it.
        # Reproduces the exact shape of a confirmed false positive found
        # this session: 56 turns, 85.4s total, ~1.53s/turn average.
        profiles = [_profile(
            "p1", "Person Gamma",
            prototypes=_multi_meeting_prototypes([1.0, 0.0], [0.98, 0.01]),
        )]
        fragmented_context = ClusterContext(
            meeting_id="mtg001", diarization_speaker_id="SPEAKER_0",
            recording_type="in_person",
            speech_duration_seconds=85.4,  # well above SUGGESTION_MIN_DURATION_SECONDS
            segment_count=56,  # well above SUGGESTION_MIN_SEGMENT_COUNT
        )
        result = suggest_speaker([1.0, 0.0], fragmented_context, profiles)
        self.assertEqual(result.status, "possible")
        self.assertEqual(result.suggested_name, "Person Gamma")

    def test_confirmed_when_avg_turn_clears_threshold_even_with_many_short_turns(self):
        # A real conversation can have many short turns (quick back-and-forth)
        # -- this must still confirm as long as the average clears the bar,
        # not just when turns happen to be long. Segment count kept well
        # above SUGGESTION_MIN_SEGMENT_COUNT and total duration well above
        # SUGGESTION_MIN_DURATION_SECONDS so only the avg-turn gate is
        # actually under test here.
        profiles = [_profile("p1", "Person Gamma", prototypes=_multi_meeting_prototypes([1.0, 0.0], [0.98, 0.01]))]
        context = ClusterContext(
            meeting_id="mtg001", diarization_speaker_id="SPEAKER_0",
            recording_type="in_person",
            speech_duration_seconds=SUGGESTION_MIN_AVG_TURN_SECONDS * 20,
            segment_count=20,
        )
        result = suggest_speaker([1.0, 0.0], context, profiles)
        self.assertEqual(result.status, "confirmed")

    def test_possible_when_only_one_confirmed_meeting_despite_clearing_all_other_gates(self):
        # Even with a perfect distance/margin/duration/avg-turn, a person
        # with evidence from only ONE meeting must not auto-fill -- their
        # profile hasn't demonstrated it generalizes across sessions yet.
        profiles = [_profile("p1", "Person Gamma", prototypes=[_prototype([1.0, 0.0], meeting_id="mtg_only")])]
        result = suggest_speaker([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(result.status, "possible")
        self.assertEqual(result.suggested_name, "Person Gamma")

    def test_possible_when_two_prototypes_are_from_the_same_meeting(self):
        # Two prototypes confirmed from fragments of the SAME meeting (the
        # exact real-world shape found this session: a diarizer-split voice
        # confirmed twice within one call) must NOT count as two distinct
        # confirmed meetings.
        profiles = [_profile("p1", "Person Gamma", prototypes=[
            _prototype([1.0, 0.0], meeting_id="mtg_shared"),
            _prototype([0.99, 0.02], meeting_id="mtg_shared"),
        ])]
        result = suggest_speaker([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(result.status, "possible")

    def test_confirmed_when_two_distinct_meetings_confirmed(self):
        profiles = [_profile("p1", "Person Gamma", prototypes=[
            _prototype([1.0, 0.0], meeting_id="mtg_a"),
            _prototype([0.99, 0.02], meeting_id="mtg_b"),
        ])]
        result = suggest_speaker([1.0, 0.0], _stable_context(), profiles)
        self.assertEqual(result.status, "confirmed")


class PrototypeChannelMatchesTests(unittest.TestCase):
    def test_channel_field_matches_exactly(self):
        self.assertTrue(prototype_channel_matches({"channel": "mic"}, "mic", "in_person"))
        self.assertFalse(prototype_channel_matches({"channel": "system"}, "mic", "in_person"))

    def test_channel_field_wins_over_recording_type(self):
        # A prototype WITH a channel never falls back -- even when the
        # recording_type proxy would have said otherwise.
        prototype = {"channel": "system", "recording_type": "in_person"}
        self.assertFalse(prototype_channel_matches(prototype, "mic", "in_person"))

    def test_legacy_prototype_falls_back_to_recording_type(self):
        legacy = {"recording_type": "in_person"}
        self.assertTrue(prototype_channel_matches(legacy, "mic", "in_person"))
        self.assertFalse(prototype_channel_matches(legacy, "system", "remote"))


class PrototypeRunMatchesTests(unittest.TestCase):
    def test_both_absent_is_current(self):
        self.assertTrue(prototype_run_matches({}, None))

    def test_both_present_and_equal_is_current(self):
        self.assertTrue(prototype_run_matches({"diarization_run_id": "run-a"}, "run-a"))

    def test_both_present_and_different_is_stale(self):
        self.assertFalse(prototype_run_matches({"diarization_run_id": "run-a"}, "run-b"))

    def test_entry_absent_sidecar_present_is_stale(self):
        self.assertFalse(prototype_run_matches({}, "run-a"))

    def test_entry_present_sidecar_absent_is_stale(self):
        self.assertFalse(prototype_run_matches({"diarization_run_id": "run-a"}, None))


class SuggestSpeakersForMeetingTests(unittest.TestCase):
    def test_same_person_not_suggested_for_two_clusters(self):
        # Two clusters both plausibly Person Gamma; only the closer one should claim
        # the confirmed match — port of the removed auto-matcher's
        # usedNames behaviour.
        profiles = [_profile("p1", "Person Gamma", prototypes=_multi_meeting_prototypes([1.0, 0.0], [0.97, 0.03]))]
        channel_clusters = {"mic": {
            "SPEAKER_0": ([1.0, 0.0], _stable_context(sid="SPEAKER_0")),  # exact match
            "SPEAKER_1": ([0.95, 0.05], _stable_context(sid="SPEAKER_1")),  # also plausible
        }}
        results = suggest_speakers_for_meeting(channel_clusters, profiles)["mic"]
        statuses = {sid: r.status for sid, r in results.items()}
        names = {sid: r.suggested_name for sid, r in results.items()}
        self.assertEqual(statuses["SPEAKER_0"], "confirmed")
        self.assertEqual(names["SPEAKER_0"], "Person Gamma")
        # SPEAKER_1 can't also claim Person Gamma -- no profiles left to match.
        self.assertNotEqual(names.get("SPEAKER_1"), "Person Gamma")

    def test_independent_clusters_each_get_their_own_person(self):
        profiles = [
            _profile("p1", "Person Gamma", prototypes=[_prototype([1.0, 0.0])]),
            _profile("p2", "Sarah", prototypes=[_prototype([0.0, 1.0])]),
        ]
        channel_clusters = {"mic": {
            "SPEAKER_0": ([1.0, 0.0], _stable_context(sid="SPEAKER_0")),
            "SPEAKER_1": ([0.0, 1.0], _stable_context(sid="SPEAKER_1")),
        }}
        results = suggest_speakers_for_meeting(channel_clusters, profiles)["mic"]
        self.assertEqual(results["SPEAKER_0"].suggested_name, "Person Gamma")
        self.assertEqual(results["SPEAKER_1"].suggested_name, "Sarah")

    def test_person_cannot_be_confirmed_on_both_channels(self):
        # Exclusivity is meeting-wide, not per-channel: a cross-channel
        # double match is echo/bleed, not the same person twice. The closer
        # (system) cluster claims Person Gamma; the mic one must not also get him.
        profiles = [_profile("p1", "Person Gamma", prototypes=_multi_meeting_prototypes([1.0, 0.0], [0.97, 0.03]))]
        channel_clusters = {
            "mic": {"SPEAKER_0": ([0.95, 0.05], _stable_context(sid="SPEAKER_0"))},
            "system": {"SPEAKER_0": ([1.0, 0.0], _stable_context(sid="SPEAKER_0", recording_type="remote"))},
        }
        results = suggest_speakers_for_meeting(channel_clusters, profiles)
        self.assertEqual(results["system"]["SPEAKER_0"].status, "confirmed")
        self.assertEqual(results["system"]["SPEAKER_0"].suggested_name, "Person Gamma")
        self.assertNotEqual(results["mic"]["SPEAKER_0"].suggested_name, "Person Gamma")

    def test_better_matching_later_cluster_wins_the_person(self):
        # Clusters are assigned in best-distance order, not sorted-id
        # order: SPEAKER_1 matches Person Gamma exactly, so a merely-plausible
        # SPEAKER_0 must not claim him first just by sorting earlier
        # (the old per-channel sorted-sid behaviour).
        profiles = [_profile("p1", "Person Gamma", prototypes=_multi_meeting_prototypes([1.0, 0.0], [0.97, 0.03]))]
        channel_clusters = {"mic": {
            "SPEAKER_0": ([0.8, 0.6], _stable_context(sid="SPEAKER_0")),  # distance ~0.2, would confirm alone
            "SPEAKER_1": ([1.0, 0.0], _stable_context(sid="SPEAKER_1")),  # exact match
        }}
        results = suggest_speakers_for_meeting(channel_clusters, profiles)["mic"]
        self.assertEqual(results["SPEAKER_1"].status, "confirmed")
        self.assertEqual(results["SPEAKER_1"].suggested_name, "Person Gamma")
        self.assertNotEqual(results["SPEAKER_0"].suggested_name, "Person Gamma")

    def test_every_input_cluster_appears_in_results(self):
        channel_clusters = {
            "mic": {"SPEAKER_0": ([1.0, 0.0], _stable_context(sid="SPEAKER_0"))},
            "system": {},
        }
        results = suggest_speakers_for_meeting(channel_clusters, [])
        self.assertEqual(set(results), {"mic", "system"})
        self.assertEqual(results["mic"]["SPEAKER_0"].status, "none")
        self.assertEqual(results["system"], {})

    def test_each_cluster_is_scored_only_once(self):
        profiles = [
            _profile(
                "p1",
                "Person Gamma",
                prototypes=_multi_meeting_prototypes([1.0, 0.0], [0.97, 0.03]),
            )
        ]
        channel_clusters = {"mic": {
            "SPEAKER_0": ([1.0, 0.0], _stable_context(sid="SPEAKER_0")),
            "SPEAKER_1": ([0.0, 1.0], _stable_context(sid="SPEAKER_1")),
        }}

        with mock.patch(
            "src.speaker_suggestions.score_candidates",
            wraps=score_candidates,
        ) as scorer:
            suggest_speakers_for_meeting(channel_clusters, profiles)

        self.assertEqual(scorer.call_count, 2)


def _ctx(sid, duration, segments=5):
    return ClusterContext(
        meeting_id="mtg001", diarization_speaker_id=sid,
        recording_type="remote", speech_duration_seconds=duration, segment_count=segments,
    )


class MergeSameChannelFragmentsTests(unittest.TestCase):
    def test_single_cluster_returns_unchanged(self):
        clusters = {"SPEAKER_0": ([1.0, 0.0], _ctx("SPEAKER_0", 100))}
        merged, resolution = merge_same_channel_fragments(clusters)
        self.assertEqual(merged, clusters)
        self.assertEqual(resolution, {"SPEAKER_0": "SPEAKER_0"})

    def test_merges_clusters_below_threshold(self):
        # distance([1,0], [0.995,0.0999]) ~= 0.005, well under 0.10.
        clusters = {
            "SPEAKER_0": ([1.0, 0.0], _ctx("SPEAKER_0", 1600)),
            "SPEAKER_2": ([0.995, 0.0999], _ctx("SPEAKER_2", 1538)),
        }
        merged, resolution = merge_same_channel_fragments(clusters)
        self.assertEqual(len(merged), 1)
        self.assertIn("SPEAKER_0", merged)  # higher duration -> primary
        self.assertEqual(resolution["SPEAKER_0"], "SPEAKER_0")
        self.assertEqual(resolution["SPEAKER_2"], "SPEAKER_0")
        merged_context = merged["SPEAKER_0"][1]
        self.assertEqual(merged_context.merged_from, ["SPEAKER_2"])
        self.assertAlmostEqual(merged_context.speech_duration_seconds, 1600 + 1538)

    def test_does_not_merge_clusters_above_threshold(self):
        clusters = {
            "SPEAKER_0": ([1.0, 0.0], _ctx("SPEAKER_0", 100)),
            "SPEAKER_1": ([0.0, 1.0], _ctx("SPEAKER_1", 50)),  # distance 1.0
        }
        merged, resolution = merge_same_channel_fragments(clusters)
        self.assertEqual(len(merged), 2)
        self.assertEqual(resolution["SPEAKER_0"], "SPEAKER_0")
        self.assertEqual(resolution["SPEAKER_1"], "SPEAKER_1")
        self.assertEqual(merged["SPEAKER_0"][1].merged_from, [])

    def test_transitive_merge_via_connected_components(self):
        # Adjacent pairs clear the merge threshold, while the endpoints do
        # not. The only way all three can merge is the A-B-C connection.
        a = [1.0, 0.0]
        b = [0.9396926, 0.3420201]  # 20 degrees from A
        c = [0.7660444, 0.6427876]  # 20 degrees from B, 40 from A
        self.assertLessEqual(cosine_distance(a, b), SAME_MEETING_MERGE_DISTANCE_THRESHOLD)
        self.assertLessEqual(cosine_distance(b, c), SAME_MEETING_MERGE_DISTANCE_THRESHOLD)
        self.assertGreater(cosine_distance(a, c), SAME_MEETING_MERGE_DISTANCE_THRESHOLD)
        clusters = {
            "SPEAKER_0": (a, _ctx("SPEAKER_0", 300)),
            "SPEAKER_1": (b, _ctx("SPEAKER_1", 200)),
            "SPEAKER_2": (c, _ctx("SPEAKER_2", 100)),
        }
        merged, resolution = merge_same_channel_fragments(clusters)
        self.assertEqual(len(merged), 1)
        self.assertEqual(len(set(resolution.values())), 1)
        primary = resolution["SPEAKER_0"]
        self.assertEqual(primary, "SPEAKER_0")  # highest duration
        self.assertEqual(sorted(merged[primary][1].merged_from), ["SPEAKER_1", "SPEAKER_2"])
        self.assertAlmostEqual(merged[primary][1].speech_duration_seconds, 600)
        self.assertEqual(merged[primary][1].segment_count, 15)

    def test_merged_embedding_weighted_toward_higher_duration_member(self):
        a = [1.0, 0.0]
        b = [0.995, 0.0999]  # slightly off-axis, dist(a,b) ~= 0.005
        clusters = {
            "SPEAKER_0": (a, _ctx("SPEAKER_0", 900)),  # 9x the weight of B
            "SPEAKER_1": (b, _ctx("SPEAKER_1", 100)),
        }
        merged, _ = merge_same_channel_fragments(clusters)
        merged_embedding = merged["SPEAKER_0"][0]
        # A dominant-weighted merge should land closer to A than to B.
        self.assertLess(cosine_distance(merged_embedding, a), cosine_distance(merged_embedding, b))

    def test_does_not_merge_deliberately_different_voices(self):
        # Same real person, deliberately different vocal performance --
        # should NOT collapse (that's a human judgment call, not automatic).
        # Three distinct voices must not collapse into one person's profile:
        # enough acoustically to sit outside the strict merge threshold.
        clusters = {
            "SPEAKER_0": ([1.0, 0.0], _ctx("SPEAKER_0", 300)),
            "SPEAKER_1": ([0.7, 0.7], _ctx("SPEAKER_1", 30)),  # distance ~0.29, above 0.10
        }
        merged, resolution = merge_same_channel_fragments(clusters)
        self.assertEqual(len(merged), 2)
        self.assertNotEqual(resolution["SPEAKER_0"], resolution["SPEAKER_1"])


class SpeakersSidecarTests(unittest.TestCase):
    def test_write_then_read_round_trips(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            output_dir = Path(tmp_dir)
            channels = {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                    },
                },
            }
            path = write_speakers_sidecar(output_dir, "mtg001", channels)
            self.assertTrue(path.exists())
            loaded = read_speakers_sidecar(output_dir, "mtg001")
            self.assertEqual(loaded["meeting_id"], "mtg001")
            self.assertEqual(
                loaded["channels"]["mic"]["clusters"]["SPEAKER_0"]["embedding"], [1.0, 0.0],
            )

    def test_read_missing_sidecar_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            self.assertIsNone(read_speakers_sidecar(Path(tmp_dir), "nonexistent"))

    def test_read_corrupt_sidecar_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            output_dir = Path(tmp_dir)
            (output_dir / "mtg001_speakers.json").write_text("{not json")
            self.assertIsNone(read_speakers_sidecar(output_dir, "mtg001"))

    def test_write_stamps_a_diarization_run(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            output_dir = Path(tmp_dir)
            channels = {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                    },
                },
            }
            write_speakers_sidecar(output_dir, "mtg001", channels)
            loaded = read_speakers_sidecar(output_dir, "mtg001")
            run = loaded["diarization_run"]
            self.assertIsInstance(run["run_id"], str)
            self.assertTrue(run["run_id"])
            self.assertIsInstance(run["created_at"], float)

    def test_successive_writes_mint_different_run_ids(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            output_dir = Path(tmp_dir)
            channels = {
                "mic": {
                    "recording_type": "in_person",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                    },
                },
            }
            write_speakers_sidecar(output_dir, "mtg001", channels)
            first_run_id = read_speakers_sidecar(output_dir, "mtg001")["diarization_run"]["run_id"]
            write_speakers_sidecar(output_dir, "mtg001", channels)
            second_run_id = read_speakers_sidecar(output_dir, "mtg001")["diarization_run"]["run_id"]
            self.assertNotEqual(first_run_id, second_run_id)

    def test_failed_replacement_preserves_the_previous_sidecar(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            output_dir = Path(tmp_dir)
            path = output_dir / "mtg001_speakers.json"
            path.write_text('{"old": true}')

            with mock.patch(
                "src.speaker_suggestions.os.fsync",
                side_effect=OSError("disk full"),
            ):
                with self.assertRaises(OSError):
                    write_speakers_sidecar(output_dir, "mtg001", {"mic": {}})

            self.assertEqual(path.read_text(), '{"old": true}')
            self.assertEqual(
                {p.name for p in output_dir.iterdir()},
                {path.name, SpeakerSidecarStore(output_dir).lock_path("mtg001").name},
            )

    def test_legacy_sidecar_without_diarization_run_round_trips_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            output_dir = Path(tmp_dir)
            legacy = {
                "meeting_id": "mtg001",
                "created_at": 100.0,
                "channels": {
                    "mic": {
                        "recording_type": "in_person",
                        "clusters": {
                            "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                        },
                    },
                },
            }
            (output_dir / "mtg001_speakers.json").write_text(json.dumps(legacy))
            loaded = read_speakers_sidecar(output_dir, "mtg001")
            self.assertEqual(loaded, legacy)
            self.assertIsNone(loaded.get("diarization_run"))

    def test_rewrite_via_set_cluster_multi_speaker_preserves_run_id(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            output_dir = Path(tmp_dir)
            channels = {
                "system": {
                    "recording_type": "remote",
                    "clusters": {
                        "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0, "segment_count": 5},
                    },
                },
            }
            write_speakers_sidecar(output_dir, "mtg001", channels)
            run_id_before = read_speakers_sidecar(output_dir, "mtg001")["diarization_run"]["run_id"]
            set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_0", True)
            run_id_after = read_speakers_sidecar(output_dir, "mtg001")["diarization_run"]["run_id"]
            self.assertEqual(run_id_before, run_id_after)

    def test_clusters_from_sidecar_channel_builds_expected_shape(self):
        channel = {
            "recording_type": "remote",
            "clusters": {
                "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 40.0, "segment_count": 6},
            },
        }
        clusters = clusters_from_sidecar_channel("mtg001", channel)
        embedding, context = clusters["SPEAKER_0"]
        self.assertEqual(embedding, [1.0, 0.0])
        self.assertEqual(context.recording_type, "remote")
        self.assertEqual(context.meeting_id, "mtg001")
        self.assertEqual(context.speech_duration_seconds, 40.0)
        self.assertEqual(context.segment_count, 6)


class ConfirmedParticipantNamesTests(unittest.TestCase):
    def test_empty_profiles_returns_empty(self):
        self.assertEqual(confirmed_participant_names("mtg001", []), [])

    def test_person_with_prototype_for_meeting_is_included(self):
        profiles = [_profile("p1", "Person Alpha", prototypes=[_prototype([1.0, 0.0], meeting_id="mtg001")])]
        self.assertEqual(confirmed_participant_names("mtg001", profiles), ["Person Alpha"])

    def test_person_with_prototype_for_different_meeting_is_excluded(self):
        profiles = [_profile("p1", "Person Alpha", prototypes=[_prototype([1.0, 0.0], meeting_id="mtg002")])]
        self.assertEqual(confirmed_participant_names("mtg001", profiles), [])

    def test_hard_negative_only_is_excluded(self):
        # A hard-negative for this meeting (confirmed as NOT this person,
        # via the mutual-hard-negative wiring in confirm-speaker) must
        # never count as a confirmed participant -- hard_negatives is a
        # structurally separate list from prototypes.
        profiles = [_profile(
            "p1", "Person Alpha",
            prototypes=[],
            hard_negatives=[_prototype([1.0, 0.0], meeting_id="mtg001")],
        )]
        self.assertEqual(confirmed_participant_names("mtg001", profiles), [])

    def test_two_people_confirmed_in_same_meeting_both_included_in_order(self):
        profiles = [
            _profile("p1", "Person Alpha", prototypes=[_prototype([1.0, 0.0], meeting_id="mtg001")]),
            _profile("p2", "Person Beta", prototypes=[_prototype([0.0, 1.0], meeting_id="mtg001")]),
        ]
        self.assertEqual(confirmed_participant_names("mtg001", profiles), ["Person Alpha", "Person Beta"])

    def test_multiple_prototypes_same_meeting_counts_person_once(self):
        profiles = [_profile("p1", "Person Alpha", prototypes=[
            _prototype([1.0, 0.0], meeting_id="mtg001"),
            _prototype([0.9, 0.1], meeting_id="mtg001"),
        ])]
        self.assertEqual(confirmed_participant_names("mtg001", profiles), ["Person Alpha"])


class RelabelTranscriptSpeakerTests(unittest.TestCase):
    def _write_transcript(self, tmp, body):
        path = Path(tmp) / "mtg001_transcript.txt"
        path.write_text(
            "Session: mtg001\nFile: mtg001.webm\nDate: x\n\n" + "=" * 60 + "\n\n" + body,
            encoding="utf-8",
        )
        return path

    def test_relabels_line_within_segment_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            changed = relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Alpha")
            self.assertEqual(changed, 1)
            self.assertIn("[00:05] [Person Alpha] hello there", path.read_text())

    def test_does_not_relabel_line_outside_segment_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:50] [Speaker 2] hello there")
            changed = relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Alpha")
            self.assertEqual(changed, 0)
            self.assertIn("[00:50] [Speaker 2] hello there", path.read_text())

    def test_never_relabels_you(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [You] hello there")
            changed = relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Alpha")
            self.assertEqual(changed, 0)
            self.assertIn("[00:05] [You] hello there", path.read_text())

    def test_relabels_others_label_not_just_speaker_n(self):
        # The dominant system-channel cluster keeps the legacy "Others"
        # label, not a "Speaker N" placeholder -- that's exactly the
        # common real case (the one real remote party on a call) and must
        # be relabelable, not skipped like "You" is.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Others] hello there")
            changed = relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Alpha")
            self.assertEqual(changed, 1)
            self.assertIn("[00:05] [Person Alpha] hello there", path.read_text())

    def test_tolerance_allows_slight_boundary_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:04] [Speaker 2] hello there")
            # Line timestamp (4.0s, from integer-second [MM:SS] truncation)
            # is just outside [4.3, 6.0] but within the 0.5s tolerance.
            changed = relabel_transcript_speaker(path, [{"start": 4.3, "end": 6.0}], "Person Alpha")
            self.assertEqual(changed, 1)

    def test_idempotent_rerun_with_different_name_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Alpha")
            changed = relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Gamma")
            self.assertEqual(changed, 1)
            self.assertIn("[00:05] [Person Gamma] hello there", path.read_text())

    def test_rerun_with_same_name_is_a_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Alpha")
            changed = relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Alpha")
            self.assertEqual(changed, 0)

    def test_multiple_pooled_segments_from_merged_fragments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(
                tmp,
                "[00:05] [Speaker 2] first fragment\n\n[05:00] [Speaker 3] second fragment",
            )
            changed = relabel_transcript_speaker(
                path, [{"start": 4.0, "end": 6.0}, {"start": 299.0, "end": 301.0}], "Person Alpha",
            )
            self.assertEqual(changed, 2)
            text = path.read_text()
            self.assertIn("[00:05] [Person Alpha] first fragment", text)
            self.assertIn("[05:00] [Person Alpha] second fragment", text)

    def test_untouched_lines_and_header_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(
                tmp, "[00:05] [Speaker 2] hello\n\n[00:10] [You] hi back",
            )
            before = path.read_text()
            relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Alpha")
            after = path.read_text()
            self.assertIn("Session: mtg001", after)
            self.assertIn("[00:10] [You] hi back", after)
            self.assertNotEqual(before, after)  # sanity: something did change

    def test_returns_zero_when_transcript_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nonexistent_transcript.txt"
            changed = relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Alpha")
            self.assertEqual(changed, 0)

    def test_returns_zero_when_no_segments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            changed = relabel_transcript_speaker(path, [], "Person Alpha")
            self.assertEqual(changed, 0)

    def test_handles_hour_scale_timestamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[1:02:33] [Speaker 2] hello there")
            changed = relabel_transcript_speaker(
                path, [{"start": 3752.0, "end": 3754.0}], "Person Alpha",
            )
            self.assertEqual(changed, 1)
            self.assertIn("[1:02:33] [Person Alpha] hello there", path.read_text())

    def test_malformed_line_does_not_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "not a diarised line at all")
            changed = relabel_transcript_speaker(path, [{"start": 4.0, "end": 6.0}], "Person Alpha")
            self.assertEqual(changed, 0)


class RelabelTranscriptMultiTests(unittest.TestCase):
    """relabel_transcript_multi: the bulk-backfill-safe counterpart to
    relabel_transcript_speaker -- must apply same-channel corrections but
    skip genuinely cross-channel-ambiguous lines rather than let iteration
    order silently steal a line from the wrong channel's speaker (a real
    bug found running backfill-participants --relabel-transcripts against
    production data -- see the plan doc's Phase 7)."""

    def _write_transcript(self, tmp, body):
        path = Path(tmp) / "mtg001_transcript.txt"
        path.write_text(
            "Session: mtg001\nFile: mtg001.webm\nDate: x\n\n" + "=" * 60 + "\n\n" + body,
            encoding="utf-8",
        )
        return path

    def test_relabels_line_claimed_by_exactly_one_channel(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            changed, skipped = relabel_transcript_multi(
                path, [("mic", "Person Alpha", [{"start": 4.0, "end": 6.0}])],
            )
            self.assertEqual((changed, skipped), (1, 0))
            self.assertIn("[00:05] [Person Alpha] hello there", path.read_text())

    def test_skips_line_claimed_by_two_different_channels(self):
        # A mic-channel assignment and a system-channel assignment both
        # claim the same timestamp -- exactly the real collision found in
        # production (both channels' clusters routinely span nearly the
        # whole meeting). Must leave the line untouched, not guess.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            changed, skipped = relabel_transcript_multi(path, [
                ("mic", "Person Alpha", [{"start": 4.0, "end": 6.0}]),
                ("system", "Person Beta", [{"start": 4.5, "end": 5.5}]),
            ])
            self.assertEqual((changed, skipped), (0, 1))
            self.assertIn("[00:05] [Speaker 2] hello there", path.read_text())

    def test_same_channel_later_assignment_wins_correction(self):
        # Two DIFFERENT people confirmed for the same cluster over time on
        # the SAME channel (a "Change" correction) -- legitimate, not
        # ambiguous, since there's only one real channel of origin. The
        # later assignment (by position in `assignments`, expected to be
        # sorted oldest-first by the caller) must win.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Person Alpha] hello there")
            changed, skipped = relabel_transcript_multi(path, [
                ("system", "Person Alpha", [{"start": 4.0, "end": 6.0}]),
                ("system", "Person Gamma", [{"start": 4.0, "end": 6.0}]),
            ])
            self.assertEqual((changed, skipped), (1, 0))
            self.assertIn("[00:05] [Person Gamma] hello there", path.read_text())

    def test_never_relabels_you_even_when_claimed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [You] hello there")
            changed, skipped = relabel_transcript_multi(
                path, [("mic", "Person Alpha", [{"start": 4.0, "end": 6.0}])],
            )
            self.assertEqual((changed, skipped), (0, 0))
            self.assertIn("[00:05] [You] hello there", path.read_text())

    def test_returns_zero_when_no_assignments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            changed, skipped = relabel_transcript_multi(path, [])
            self.assertEqual((changed, skipped), (0, 0))

    def test_returns_zero_when_transcript_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nonexistent_transcript.txt"
            changed, skipped = relabel_transcript_multi(
                path, [("mic", "Person Alpha", [{"start": 4.0, "end": 6.0}])],
            )
            self.assertEqual((changed, skipped), (0, 0))

    def test_out_of_range_line_untouched_and_not_ambiguous(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:50] [Speaker 2] hello there")
            changed, skipped = relabel_transcript_multi(path, [
                ("mic", "Person Alpha", [{"start": 4.0, "end": 6.0}]),
                ("system", "Person Beta", [{"start": 4.0, "end": 6.0}]),
            ])
            self.assertEqual((changed, skipped), (0, 0))
            self.assertIn("[00:50] [Speaker 2] hello there", path.read_text())


class RelabelTranscriptExactTests(unittest.TestCase):
    """relabel_transcript_exact: matches by EXACT recorded (channel, sid)
    provenance from a turn_manifest, not fuzzy timestamp proximity --
    see the plan doc's Phase 8. Immune to both the cross-channel and
    same-channel mislabeling relabel_transcript_speaker/_multi can hit."""

    def _write_transcript(self, tmp, body):
        path = Path(tmp) / "mtg001_transcript.txt"
        path.write_text(
            "Session: mtg001\nFile: mtg001.webm\nDate: x\n\n" + "=" * 60 + "\n\n" + body,
            encoding="utf-8",
        )
        return path

    def test_relabels_line_with_matching_manifest_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            manifest = [{"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_1"}]
            changed = relabel_transcript_exact(path, manifest, {("mic", "SPEAKER_1")}, "Person Alpha")
            self.assertEqual(changed, 1)
            self.assertIn("[00:05] [Person Alpha] hello there", path.read_text())

    def test_does_not_relabel_line_whose_manifest_entry_is_a_different_cluster(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            manifest = [{"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"}]
            changed = relabel_transcript_exact(path, manifest, {("mic", "SPEAKER_1")}, "Person Alpha")
            self.assertEqual(changed, 0)
            self.assertIn("[00:05] [Speaker 2] hello there", path.read_text())

    def test_does_not_relabel_line_whose_manifest_entry_is_a_different_channel(self):
        # The exact real bug this replaces: a mic-channel cluster's fuzzy
        # timestamp match could steal a system-channel line. With exact
        # provenance, a line recorded as "system" is NEVER touched by a
        # "mic" target, regardless of timestamp closeness.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            manifest = [{"start": 5.2, "channel": "system", "diarization_speaker_id": "SPEAKER_1"}]
            changed = relabel_transcript_exact(path, manifest, {("mic", "SPEAKER_1")}, "Person Alpha")
            self.assertEqual(changed, 0)
            self.assertIn("[00:05] [Speaker 2] hello there", path.read_text())

    def test_never_relabels_you(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [You] hello there")
            manifest = [{"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_1"}]
            changed = relabel_transcript_exact(path, manifest, {("mic", "SPEAKER_1")}, "Person Alpha")
            self.assertEqual(changed, 0)
            self.assertIn("[00:05] [You] hello there", path.read_text())

    def test_matches_across_fragment_ids_via_target_ids_set(self):
        # Mirrors merge_same_channel_fragments' resolved_id + merged_from
        # -- a person confirmed from a diarizer-fragmented voice should
        # match every fragment's manifest entries.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(
                tmp, "[00:05] [Speaker 2] first fragment\n\n[00:20] [Speaker 3] second fragment",
            )
            manifest = [
                {"start": 5.2, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 20.4, "channel": "system", "diarization_speaker_id": "SPEAKER_2"},
            ]
            changed = relabel_transcript_exact(
                path, manifest, {("system", "SPEAKER_0"), ("system", "SPEAKER_2")}, "Person Alpha",
            )
            self.assertEqual(changed, 2)
            text = path.read_text()
            self.assertIn("[00:05] [Person Alpha] first fragment", text)
            self.assertIn("[00:20] [Person Alpha] second fragment", text)

    def test_returns_zero_when_manifest_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            self.assertEqual(relabel_transcript_exact(path, [], {("mic", "SPEAKER_1")}, "Person Alpha"), 0)

    def test_returns_zero_when_target_ids_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            manifest = [{"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_1"}]
            self.assertEqual(relabel_transcript_exact(path, manifest, set(), "Person Alpha"), 0)

    def test_returns_zero_when_transcript_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nonexistent_transcript.txt"
            manifest = [{"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_1"}]
            self.assertEqual(relabel_transcript_exact(path, manifest, {("mic", "SPEAKER_1")}, "Person Alpha"), 0)

    def test_idempotent_rerun_with_same_name_is_a_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Person Alpha] hello there")
            manifest = [{"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_1"}]
            changed = relabel_transcript_exact(path, manifest, {("mic", "SPEAKER_1")}, "Person Alpha")
            self.assertEqual(changed, 0)

    def test_rerun_with_different_name_overwrites_a_change_correction(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Person Alpha] hello there")
            manifest = [{"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_1"}]
            changed = relabel_transcript_exact(path, manifest, {("mic", "SPEAKER_1")}, "Person Gamma")
            self.assertEqual(changed, 1)
            self.assertIn("[00:05] [Person Gamma] hello there", path.read_text())

    def test_matches_by_position_not_by_timestamp_collision(self):
        # The real bug found this session in an EARLIER version of this
        # function: it matched by truncated-integer-second timestamp
        # lookup across the whole manifest, so two DIFFERENT lines from
        # DIFFERENT channels sharing the same displayed second could still
        # collide -- the same class of bug as fuzzy matching, just finer
        # grained. Two lines here display the SAME [00:05] timestamp (a
        # real, if rare, possibility -- e.g. two very short adjacent
        # turns), but their manifest entries (by POSITION) are genuinely
        # different clusters -- only the second line's cluster is targeted,
        # and only IT must be relabeled.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(
                tmp, "[00:05] [Speaker 2] first\n\n[00:05] [Speaker 3] second",
            )
            manifest = [
                {"start": 5.1, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 5.9, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
            ]
            changed = relabel_transcript_exact(path, manifest, {("system", "SPEAKER_0")}, "Person Beta")
            self.assertEqual(changed, 1)
            text = path.read_text()
            self.assertIn("[00:05] [Speaker 2] first", text)  # untouched -- position 0, mic
            self.assertIn("[00:05] [Person Beta] second", text)  # relabeled -- position 1, system

    def test_a_stale_manifest_of_the_same_length_refuses_and_returns_zero(self):
        # The length check was the only check, so a manifest describing a
        # DIFFERENT transcription of this meeting -- a re-transcription, or
        # a reordered write -- passed whenever the line count survived, and
        # positional pairing then wrote a name onto lines that belong to
        # someone else. Positional pairing is only sound while the two
        # sequences still come from the same run, and the manifest's own
        # `start` is the evidence for that: the transcript's [MM:SS] is that
        # float truncated to the second.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(
                tmp, "[00:05] [Speaker 2] first\n\n[00:10] [Speaker 3] second",
            )
            manifest = [
                {"start": 5.1, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 42.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
            ]
            changed = relabel_transcript_exact(path, manifest, {("mic", "SPEAKER_0")}, "Person Alpha")
            self.assertEqual(changed, 0)
            text = path.read_text()
            self.assertIn("[00:05] [Speaker 2] first", text)
            self.assertIn("[00:10] [Speaker 3] second", text)

    def test_a_manifest_entry_that_is_not_an_object_is_refused_not_raised(self):
        # This function documents the same never-raises contract as
        # relabel_transcript_speaker, and the manifest comes out of a JSON
        # sidecar, so an entry can be anything -- while the pairing loop
        # reaches straight for entry.get(...).
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            changed = relabel_transcript_exact(path, [None], {("mic", "SPEAKER_0")}, "Person Alpha")
            self.assertEqual(changed, 0)
            self.assertIn("[00:05] [Speaker 2] hello there", path.read_text())

    def test_length_mismatch_refuses_to_guess_and_returns_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(
                tmp, "[00:05] [Speaker 2] first\n\n[00:10] [Speaker 3] second",
            )
            manifest = [{"start": 5.1, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"}]
            changed = relabel_transcript_exact(path, manifest, {("mic", "SPEAKER_0")}, "Person Alpha")
            self.assertEqual(changed, 0)
            text = path.read_text()
            self.assertIn("[00:05] [Speaker 2] first", text)
            self.assertIn("[00:10] [Speaker 3] second", text)


class LongestSegmentTests(unittest.TestCase):
    def test_returns_the_longest_by_duration(self):
        segments = [
            {"start": 0.0, "end": 1.0},
            {"start": 10.0, "end": 15.0},
            {"start": 20.0, "end": 21.5},
        ]
        self.assertEqual(longest_segment(segments), {"start": 10.0, "end": 15.0})

    def test_empty_list_returns_none(self):
        self.assertIsNone(longest_segment([]))


class ExtractSampleTextTests(unittest.TestCase):
    """Excerpt text is attributed by the sidecar's turn manifest ONLY.

    This class used to assert timestamp-proximity matching plus a blanket
    "never quote a line labeled You" rule. Both were changed after a real
    three-person call showed what they produce together: the device owner's
    own mic cluster quoted ANOTHER participant's sentences. The owner's
    turns are exactly the lines labeled "You", so skipping them left that
    cluster with none of its own speech, and proximity then supplied
    whatever overlapped in time on the other channel.

    Measured on that recording, label against which channel's segments
    covered the line's timestamp:

        label      in-mic  in-sys  in-both  in-neither
        You             0       3        7           1
        <other>         4      13        4           0

    Not one owner line in a mic segment alone; four of the other
    participants' lines in one. Proximity was inverted, not noisy -- a
    backfilled sidecar re-diarizes in its own run, so its boundaries were
    never the ones the saved transcript's timestamps came from, and a call
    taken without headphones puts the remote voices into the mic channel
    too. See cluster_transcript_lines.
    """

    def _write_transcript(self, tmp, body):
        path = Path(tmp) / "mtg001_transcript.txt"
        path.write_text(
            "Session: mtg001\nFile: mtg001.webm\nDate: x\n\n" + "=" * 60 + "\n\n" + body,
            encoding="utf-8",
        )
        return path

    @staticmethod
    def _manifest(*entries):
        return [
            {"start": start, "channel": channel, "diarization_speaker_id": sid}
            for start, channel, sid in entries
        ]

    def test_extracts_text_at_the_longest_segment(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(
                tmp, "[00:05] [Speaker 2] hello there, how are you doing today",
            )
            text = extract_sample_text(
                path, [{"start": 4.0, "end": 6.0}],
                turn_manifest=self._manifest((5.0, "system", "SPEAKER_0")),
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(text, "hello there, how are you doing today")

    def test_picks_the_longest_segment_when_several_given(self):
        # A brief 2s blip earlier in the recording must not be quoted over
        # the substantial 40s turn -- matches longest_segment's own
        # cross-voice-contamination-avoidance reasoning.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(
                tmp,
                "[00:05] [Speaker 2] a brief interjection\n\n"
                "[05:00] [Speaker 2] this is the real substantial turn that should be quoted",
            )
            text = extract_sample_text(
                path, [{"start": 4.0, "end": 6.0}, {"start": 299.0, "end": 339.0}],
                turn_manifest=self._manifest(
                    (5.0, "system", "SPEAKER_0"), (300.0, "system", "SPEAKER_0"),
                ),
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(text, "this is the real substantial turn that should be quoted")

    def test_the_owners_own_line_IS_quoted_for_the_owners_own_cluster(self):
        # The correction. A "You" line is the owner speaking, so it is
        # exactly what the mic cluster should quote -- refusing it is what
        # made the owner's row show someone else's words.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [You] this is the device owner talking")
            text = extract_sample_text(
                path, [{"start": 4.0, "end": 6.0}],
                turn_manifest=self._manifest((5.0, "mic", "SPEAKER_0")),
                target_ids={("mic", "SPEAKER_0")},
            )
            self.assertEqual(text, "this is the device owner talking")

    def test_another_channels_line_is_never_quoted_for_this_cluster(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] someone else entirely")
            text = extract_sample_text(
                path, [{"start": 4.0, "end": 6.0}],
                turn_manifest=self._manifest((5.0, "system", "SPEAKER_0")),
                target_ids={("mic", "SPEAKER_0")},
            )
            self.assertIsNone(text)

    def test_no_manifest_means_no_text_rather_than_a_guess(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello there")
            self.assertIsNone(extract_sample_text(path, [{"start": 4.0, "end": 6.0}]))

    def test_truncates_long_text_with_ellipsis(self):
        with tempfile.TemporaryDirectory() as tmp:
            long_text = "word " * 60
            path = self._write_transcript(tmp, f"[00:05] [Speaker 2] {long_text.strip()}")
            text = extract_sample_text(
                path, [{"start": 4.0, "end": 6.0}], max_chars=20,
                turn_manifest=self._manifest((5.0, "system", "SPEAKER_0")),
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertLessEqual(len(text), 21)  # 20 + ellipsis char
            self.assertTrue(text.endswith("…"))

    def test_returns_none_when_no_segments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:05] [Speaker 2] hello")
            self.assertIsNone(extract_sample_text(path, []))

    def test_returns_none_when_transcript_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "nonexistent.txt"
            self.assertIsNone(extract_sample_text(path, [{"start": 4.0, "end": 6.0}]))

    def test_the_manifest_wins_when_the_segments_disagree_with_it(self):
        # The manifest records which cluster produced each line at the
        # moment the line was written; the segments are the same run's
        # acoustics. When they disagree -- here the only segment sits at
        # 4-6s while the owned line is at 50s -- the manifest is the more
        # precise record, so the quote stands and the clip falls back to a
        # window at the line's own timestamp. Withholding the text instead
        # would drop a line this cluster demonstrably spoke.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(tmp, "[00:50] [Speaker 2] hello there")
            self.assertEqual(
                extract_sample_text(
                    path, [{"start": 4.0, "end": 6.0}],
                    turn_manifest=self._manifest((50.0, "system", "SPEAKER_0")),
                    target_ids={("system", "SPEAKER_0")},
                ),
                "hello there",
            )

    def test_prebuilt_manifest_index_avoids_reparsing_per_cluster(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write_transcript(
                tmp,
                "[00:05] [Speaker 2] first voice\n"
                "[00:10] [Speaker 3] second voice",
            )
            manifest = self._manifest(
                (5.0, "system", "SPEAKER_0"),
                (10.0, "system", "SPEAKER_1"),
            )
            index = build_transcript_manifest_index(path, manifest)

            with mock.patch(
                "src.speaker_suggestions.cluster_transcript_lines",
                side_effect=AssertionError("must use the prebuilt index"),
            ):
                samples = extract_segment_samples(
                    path,
                    [{"start": 4.0, "end": 8.0}],
                    turn_manifest=manifest,
                    target_ids={("system", "SPEAKER_0")},
                    transcript_index=index,
                )

            self.assertEqual(samples[0]["text"], "first voice")


class ExtractSpeakerSampleAudioTests(unittest.TestCase):
    def test_returns_false_when_no_segments(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "mtg001.wav"
            audio_path.write_bytes(b"stub")
            ok = extract_speaker_sample_audio(audio_path, "mic", [], Path(tmp) / "out.wav")
            self.assertFalse(ok)

    def test_returns_false_when_source_audio_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "does_not_exist.wav"
            ok = extract_speaker_sample_audio(
                audio_path, "mic", [{"start": 4.0, "end": 6.0}], Path(tmp) / "out.wav",
            )
            self.assertFalse(ok)

    def test_returns_false_when_ffmpeg_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "mtg001.wav"
            audio_path.write_bytes(b"stub")
            with mock.patch("src.transcriber._resolve_ffmpeg", return_value=None):
                ok = extract_speaker_sample_audio(
                    audio_path, "mic", [{"start": 4.0, "end": 6.0}], Path(tmp) / "out.wav",
                )
            self.assertFalse(ok)

    def test_success_calls_ffmpeg_with_correct_time_range_and_channel(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "mtg001.wav"
            audio_path.write_bytes(b"stub")
            out_path = Path(tmp) / "out.wav"

            def fake_run(cmd, **kwargs):
                # Simulate ffmpeg actually writing the output file.
                out_path.write_bytes(b"wav-stub")
                return mock.Mock(returncode=0)

            with mock.patch("src.transcriber._resolve_ffmpeg", return_value="/usr/bin/ffmpeg"), \
                 mock.patch("src.speaker_suggestions.subprocess.run", side_effect=fake_run) as run_mock:
                ok = extract_speaker_sample_audio(
                    audio_path, "system", [{"start": 10.0, "end": 15.0}], out_path,
                )
            self.assertTrue(ok)
            self.assertTrue(out_path.exists())
            cmd = run_mock.call_args[0][0]
            self.assertIn("-ss", cmd)
            self.assertIn(str(max(0.0, 10.0 - 0.3)), cmd)
            self.assertIn("pan=mono|c0=c1", cmd)  # "system" -> channel index 1

    def test_audio_extraction_caps_an_untrusted_long_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "mtg001.wav"
            audio_path.write_bytes(b"stub")
            out_path = Path(tmp) / "out.wav"

            def fake_run(cmd, **kwargs):
                out_path.write_bytes(b"wav-stub")
                return mock.Mock(returncode=0)

            with mock.patch("src.transcriber._resolve_ffmpeg", return_value="/usr/bin/ffmpeg"), \
                 mock.patch("src.speaker_suggestions.subprocess.run", side_effect=fake_run) as run_mock:
                ok = extract_speaker_sample_audio(
                    audio_path,
                    "mic",
                    [{"start": 10.0, "end": 610.0}],
                    out_path,
                )

            self.assertTrue(ok)
            cmd = run_mock.call_args.args[0]
            duration = float(cmd[cmd.index("-t") + 1])
            self.assertLessEqual(duration, SAMPLE_MAX_SECONDS + 2 * SAMPLE_AUDIO_PADDING_SECONDS)

    def test_mic_channel_uses_channel_index_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "mtg001.wav"
            audio_path.write_bytes(b"stub")
            out_path = Path(tmp) / "out.wav"

            def fake_run(cmd, **kwargs):
                out_path.write_bytes(b"wav-stub")
                return mock.Mock(returncode=0)

            with mock.patch("src.transcriber._resolve_ffmpeg", return_value="/usr/bin/ffmpeg"), \
                 mock.patch("src.speaker_suggestions.subprocess.run", side_effect=fake_run) as run_mock:
                extract_speaker_sample_audio(
                    audio_path, "mic", [{"start": 10.0, "end": 15.0}], out_path,
                )
            cmd = run_mock.call_args[0][0]
            self.assertIn("pan=mono|c0=c0", cmd)

    def test_padding_never_turns_a_zero_length_range_into_a_clip(self):
        # _turn_audio_range returns (start, start) when this cluster has no
        # segment of its own at or after the line, and its docstring says
        # this function then refuses. It did not: the duration check ran
        # AFTER the two 0.3s pads were added, so a range meaning "we cannot
        # place this moment" still cut 0.6s of audio around the timestamp --
        # i.e. potentially the voice of whoever WAS speaking there, played
        # under this speaker's name.
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "mtg001.wav"
            audio_path.write_bytes(b"stub")
            with mock.patch("src.transcriber._resolve_ffmpeg", return_value="/usr/bin/ffmpeg"), \
                 mock.patch("src.speaker_suggestions.subprocess.run") as run_mock:
                ok = extract_speaker_sample_audio(
                    audio_path, "mic", [{"start": 4.0, "end": 6.0}], Path(tmp) / "out.wav",
                    segment_index={"start": 60.0, "end": 60.0},
                )
            self.assertFalse(ok)
            run_mock.assert_not_called()

    def test_returns_false_when_ffmpeg_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "mtg001.wav"
            audio_path.write_bytes(b"stub")
            out_path = Path(tmp) / "out.wav"
            with mock.patch("src.transcriber._resolve_ffmpeg", return_value="/usr/bin/ffmpeg"), \
                 mock.patch("src.speaker_suggestions.subprocess.run", return_value=mock.Mock(returncode=1)):
                ok = extract_speaker_sample_audio(
                    audio_path, "mic", [{"start": 4.0, "end": 6.0}], out_path,
                )
            self.assertFalse(ok)

    def test_returns_false_on_timeout(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = Path(tmp) / "mtg001.wav"
            audio_path.write_bytes(b"stub")
            with mock.patch("src.transcriber._resolve_ffmpeg", return_value="/usr/bin/ffmpeg"), \
                 mock.patch(
                     "src.speaker_suggestions.subprocess.run",
                     side_effect=subprocess.TimeoutExpired(cmd="ffmpeg", timeout=30),
                 ):
                ok = extract_speaker_sample_audio(
                    audio_path, "mic", [{"start": 4.0, "end": 6.0}], Path(tmp) / "out.wav",
                )
            self.assertFalse(ok)


class ReviewStateTests(unittest.TestCase):
    """"Keep generic" as a persisted fact rather than a React state set.

    The button exists for the row a reviewer looked at and decided to leave
    alone. Held only in the component, that decision dies on a remount --
    navigating away and back re-presents every row they already dealt with,
    which is exactly the work the button was meant to save. Persisting it
    also makes it survivable in the other direction: a half-finished review
    can be picked up tomorrow.
    """

    def _seed(self, tmp, clusters=None):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, "mtg001", {
            "system": {
                "recording_type": "remote",
                "clusters": clusters or {
                    "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 60.0,
                                  "segment_count": 10},
                    "SPEAKER_1": {"embedding": [0.0, 1.0], "speech_duration_seconds": 40.0,
                                  "segment_count": 8},
                },
            },
        })
        return output_dir

    def _stored(self, output_dir, sid):
        sidecar = read_speakers_sidecar(output_dir, "mtg001")
        return sidecar["channels"]["system"]["clusters"][sid]

    def test_marking_writes_the_key_on_the_exact_cluster_it_was_handed(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            result = set_cluster_review_state(
                output_dir, "mtg001", "system", "SPEAKER_0", REVIEW_STATE_GENERIC,
            )
            self.assertIsNotNone(result)
            self.assertEqual(self._stored(output_dir, "SPEAKER_0")[REVIEW_STATE_KEY],
                             REVIEW_STATE_GENERIC)
            self.assertNotIn(REVIEW_STATE_KEY, self._stored(output_dir, "SPEAKER_1"))

    def test_clearing_removes_the_key_rather_than_storing_a_null(self):
        # Absent means "not marked" everywhere in this sidecar, so a stored
        # null would be a third state no reader knows about.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            set_cluster_review_state(output_dir, "mtg001", "system", "SPEAKER_0",
                                     REVIEW_STATE_GENERIC)
            set_cluster_review_state(output_dir, "mtg001", "system", "SPEAKER_0", None)
            self.assertNotIn(REVIEW_STATE_KEY, self._stored(output_dir, "SPEAKER_0"))

    def test_a_missing_sidecar_channel_or_cluster_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            self.assertIsNone(set_cluster_review_state(
                output_dir, "never-diarised", "system", "SPEAKER_0", REVIEW_STATE_GENERIC))
            self.assertIsNone(set_cluster_review_state(
                output_dir, "mtg001", "mic", "SPEAKER_0", REVIEW_STATE_GENERIC))
            self.assertIsNone(set_cluster_review_state(
                output_dir, "mtg001", "system", "SPEAKER_99", REVIEW_STATE_GENERIC))

    def test_a_rewrite_preserves_the_marking(self):
        # set_cluster_multi_speaker rewrites the whole document; the two
        # markings are independent facts about the same cluster and neither
        # may drop the other.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            set_cluster_review_state(output_dir, "mtg001", "system", "SPEAKER_0",
                                     REVIEW_STATE_GENERIC)
            set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_1", True)
            self.assertEqual(self._stored(output_dir, "SPEAKER_0")[REVIEW_STATE_KEY],
                             REVIEW_STATE_GENERIC)

    def test_a_merged_row_reads_generic_when_any_fragment_carries_it(self):
        # Mirrors how contains_multiple_speakers merges: the marking is
        # written on a raw id, the panel shows the merged row, and the
        # reviewer's decision was about the row they saw.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp, clusters={
                "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 1600.0,
                              "segment_count": 580},
                "SPEAKER_2": {"embedding": [0.995, 0.0999], "speech_duration_seconds": 1538.0,
                              "segment_count": 552},
            })
            # The NON-primary fragment: SPEAKER_0 wins the merge on duration.
            set_cluster_review_state(output_dir, "mtg001", "system", "SPEAKER_2",
                                     REVIEW_STATE_GENERIC)
            sidecar = read_speakers_sidecar(output_dir, "mtg001")
            merged, _ = merge_same_channel_fragments(
                clusters_from_sidecar_channel("mtg001", sidecar["channels"]["system"])
            )
            self.assertEqual(merged["SPEAKER_0"][1].merged_from, ["SPEAKER_2"])
            self.assertEqual(merged["SPEAKER_0"][1].review_state, REVIEW_STATE_GENERIC)

    def test_a_legacy_cluster_without_the_key_reads_as_unmarked(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            sidecar = read_speakers_sidecar(output_dir, "mtg001")
            clusters = clusters_from_sidecar_channel("mtg001", sidecar["channels"]["system"])
            self.assertIsNone(clusters["SPEAKER_0"][1].review_state)

    def test_an_invalid_cluster_rejects_the_whole_channel(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp, clusters={
                "SPEAKER_0": {"embedding": [1.0, 0.0]},
                "SPEAKER_1": {"embedding": [0.0, 0.0]},
            })
            sidecar = read_speakers_sidecar(output_dir, "mtg001")
            with self.assertRaisesRegex(ValueError, "invalid cluster embedding"):
                clusters_from_sidecar_channel("mtg001", sidecar["channels"]["system"])

    def test_clearing_sweeps_every_fragment_of_a_merged_row(self):
        # A key left on a non-primary fragment would keep the merged row
        # reading generic after a confirm, because the merged view is an
        # any() over the members.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            for sid in ("SPEAKER_0", "SPEAKER_1"):
                set_cluster_review_state(output_dir, "mtg001", "system", sid,
                                         REVIEW_STATE_GENERIC)
            cleared = clear_cluster_review_state(
                output_dir, "mtg001", "system", {"SPEAKER_0", "SPEAKER_1"},
            )
            self.assertEqual(cleared, 2)
            for sid in ("SPEAKER_0", "SPEAKER_1"):
                self.assertNotIn(REVIEW_STATE_KEY, self._stored(output_dir, sid))

    def test_clearing_what_was_never_marked_reports_nothing_and_raises_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            self.assertEqual(
                clear_cluster_review_state(output_dir, "mtg001", "system", {"SPEAKER_0"}), 0)
            self.assertEqual(
                clear_cluster_review_state(output_dir, "gone", "system", {"SPEAKER_0"}), 0)
            self.assertEqual(
                clear_cluster_review_state(output_dir, "mtg001", "mic", {"SPEAKER_0"}), 0)


class SidecarDurabilityTests(unittest.TestCase):
    """The rename is atomic; that is not the same as durable.

    This file holds the ONLY copy of a meeting's voice embeddings, and the
    source audio is deleted by default -- so unlike a transcript, it cannot
    be regenerated. An atomic rename guarantees a reader never sees a half
    document; it guarantees nothing about the bytes having reached stable
    storage. Without a flush, a power cut or kernel panic in the window
    between the write and the disk can leave the renamed file empty, which
    is exactly the unrecoverable outcome the atomic rename was chosen to
    prevent.
    """

    def _seed(self, tmp):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        return output_dir, {
            "meeting_id": "mtg001",
            "channels": {"system": {"recording_type": "remote", "clusters": {}}},
        }

    def test_the_bytes_are_flushed_to_disk_before_the_rename(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, doc = self._seed(tmp)
            calls = []
            real_fsync = os.fsync
            real_replace = Path.replace

            def spy_fsync(fd):
                calls.append("fsync")
                return real_fsync(fd)

            def spy_replace(self, target):
                calls.append("replace")
                return real_replace(self, target)

            with mock.patch("src.speaker_suggestions.os.fsync", side_effect=spy_fsync), \
                 mock.patch.object(Path, "replace", spy_replace):
                write_sidecar_document(output_dir, "mtg001", doc)

            self.assertIn("fsync", calls, "the temp file was renamed into place unflushed")
            self.assertLess(
                calls.index("fsync"), calls.index("replace"),
                "flushing after the rename protects nothing",
            )
            self.assertEqual(read_speakers_sidecar(output_dir, "mtg001"), doc)

            if hasattr(os, "O_DIRECTORY"):
                # The directory entry too, and necessarily AFTER the rename:
                # otherwise a crash can leave it pointing at the old file
                # even though the caller was told the sidecar was replaced.
                self.assertGreater(
                    calls.count("fsync"), 1, "the rename itself was never flushed",
                )
                last_fsync = len(calls) - 1 - calls[::-1].index("fsync")
                self.assertGreater(last_fsync, calls.index("replace"))

    def test_a_failed_flush_leaves_no_temp_file_and_does_not_claim_success(self):
        # Same contract the write already had: a failure must not leave a
        # half-written temp file behind for someone to mistake for a real
        # sidecar, and must not return as if the sidecar had been replaced.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir, doc = self._seed(tmp)
            with mock.patch("src.speaker_suggestions.os.fsync", side_effect=OSError("disk gone")):
                with self.assertRaises(OSError):
                    write_sidecar_document(output_dir, "mtg001", doc)
            # The shared FileLock deliberately keeps its stable lock path.
            # Deleting it after release could split waiters across two
            # different inodes. Only unique write-temporary files are leaks.
            leftovers = [p.name for p in output_dir.iterdir() if p.suffix == ".tmp"]
            self.assertEqual(leftovers, [], f"temp file left behind: {leftovers}")


if __name__ == "__main__":
    unittest.main()
