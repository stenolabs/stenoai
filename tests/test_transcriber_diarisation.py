"""Tests for the diarisation-related helpers added in the system-audio branch.

Covers:
 - `_token_jaccard`: similarity should cleanly separate "true bleed"
   transcripts (identical or near-identical) from real two-party content.
 - `_parse_channels_from_ffmpeg_stderr` / `_parse_duration_from_ffmpeg_stderr`:
   regex parsers against representative ffmpeg `-i` stderr fixtures.
 - `_check_rms_energy`: scans the whole file (not just the first 5 seconds)
   so a recording where speech starts mid-stream isn't classified as silent.
"""

import io
import json
import math
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import Mock, patch

from src.transcriber import (
    BLEED_JACCARD_THRESHOLD,
    CHANNEL_DOMINANCE_THRESHOLD,
    DIAR_LABEL_FALLBACK_TOLERANCE_S,
    DIARISED_SPLIT_TIMEOUT_S,
    MIN_RMS_THRESHOLD,
    STENO_DIARIZE_MERGE_GAP_S,
    WhisperTranscriber,
    _assemble_diarised_turns,
    _apply_voiceprint_matches,
    _assign_asr_segments_to_diar_segments,
    _clamp_overlapping_diar_segments,
    _cluster_channel_labels,
    _cluster_channel_label_plan,
    _diarised_split_timeout,
    _format_timestamp,
    _identity_matching_enabled,
    _merge_close_diar_segments,
    _parse_channels_from_ffmpeg_stderr,
    _parse_duration_from_ffmpeg_stderr,
    _reconcile_cross_channel_speakers,
    _resolve_speaker_placeholders,
    _run_steno_diarize,
    _terminate_process_tree,
    _tag_channel_segments,
    _token_jaccard,
    _voiceprint_distance,
    _worst_window_coverage,
)


class IdentityMatchingSettingTests(unittest.TestCase):
    def test_config_read_failure_disables_identity_matching(self):
        with patch("src.config.get_config", side_effect=OSError("unreadable config")):
            self.assertFalse(_identity_matching_enabled())


class FormatTimestampTests(unittest.TestCase):
    def test_zero(self):
        self.assertEqual(_format_timestamp(0), "00:00")

    def test_under_a_minute_pads_seconds(self):
        self.assertEqual(_format_timestamp(5), "00:05")

    def test_minutes_and_seconds(self):
        self.assertEqual(_format_timestamp(65), "01:05")

    def test_floors_fractional_seconds(self):
        self.assertEqual(_format_timestamp(1.8), "00:01")

    def test_hour_switches_to_h_mm_ss(self):
        self.assertEqual(_format_timestamp(3661), "1:01:01")

    def test_exactly_one_hour(self):
        self.assertEqual(_format_timestamp(3600), "1:00:00")

    def test_negative_clamps_to_zero(self):
        self.assertEqual(_format_timestamp(-5), "00:00")

    def test_non_finite_falls_back_to_zero(self):
        # A backend emitting NaN/inf in a segment's start must not crash the
        # diarised assembly (int(NaN) raises ValueError, int(inf) OverflowError).
        self.assertEqual(_format_timestamp(float("nan")), "00:00")
        self.assertEqual(_format_timestamp(float("inf")), "00:00")
        self.assertEqual(_format_timestamp(float("-inf")), "00:00")


class TranscribeDiarisedTimestampTests(unittest.TestCase):
    """The diarised transcript prefixes each turn with an [MM:SS] timestamp
    from the turn's first segment. Mocks the per-channel transcription so no
    model/audio is needed. Disjoint mock text avoids the bleed-correction RMS
    read (which would need real WAVs)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = Path(self._tmp.name)
        self.audio_path = d / "source.wav"
        self.mic_path = d / "mic.wav"
        self.system_path = d / "system.wav"
        for p in (self.audio_path, self.mic_path, self.system_path):
            p.write_bytes(b"stub")
        self.transcriber = WhisperTranscriber.__new__(WhisperTranscriber)
        self.transcriber.backend = "parakeet"
        self.transcriber._split_stereo_to_channels = Mock(
            return_value=(self.mic_path, self.system_path, 3.0)
        )
        self.transcriber._check_rms_energy = Mock(return_value=True)
        # These are pinned-contract tests for the legacy You/Others-only
        # behaviour, so the sidecar must be explicitly forced off — without
        # this they'd pass by accident on a clean checkout (no binary) and
        # break the moment a contributor has one built locally (see
        # TranscribeDiarisedMultiSpeakerTests for the sidecar-present cases).
        self._diar_patcher = patch("src.transcriber._run_steno_diarize", return_value=None)
        self._diar_patcher.start()

    def tearDown(self):
        self._diar_patcher.stop()
        self._tmp.cleanup()

    def test_interleaves_diarised_segments_with_timestamps(self):
        self.transcriber.transcribe_audio = Mock(side_effect=[
            {"text": "Hello. Later.", "segments": [
                {"text": "Hello.", "start": 1.2, "end": 1.8},
                {"text": "Later.", "start": 4.0, "end": 4.5},
            ]},
            {"text": "Reply.", "segments": [{"text": "Reply.", "start": 2.1, "end": 2.8}]},
        ])
        result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertTrue(result["is_diarised"])
        self.assertEqual(
            result["diarised_text"],
            "[00:01] [You] Hello.\n\n[00:02] [Others] Reply.\n\n[00:04] [You] Later.",
        )
        # The plain text field stays timestamp- and label-free.
        self.assertNotIn("[00:0", result["text"])
        self.assertNotIn("[You]", result["text"])

    def test_single_source_is_not_timestamped_or_diarised(self):
        self.transcriber.transcribe_audio = Mock(side_effect=[
            {"text": "Only mic.", "segments": [{"text": "Only mic.", "start": 0.4, "end": 1.0}]},
            {"text": "", "segments": []},
        ])
        result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertFalse(result["is_diarised"])
        self.assertIsNone(result["diarised_text"])

    def test_discarded_bleed_does_not_lower_retained_channel_coverage(self):
        for dropped in ("mic", "system"):
            with self.subTest(dropped=dropped):
                segment = {"text": "The budget is approved.", "start": 0.0, "end": 1.0}
                self.transcriber.transcribe_audio = Mock(side_effect=[
                    {"text": segment["text"], "segments": [dict(segment)],
                     "window_coverage": 0.2 if dropped == "mic" else 1.0},
                    {"text": segment["text"], "segments": [dict(segment)],
                     "window_coverage": 0.2 if dropped == "system" else 1.0},
                ])
                with patch("src.transcriber._segment_rms", side_effect=[
                    0.1 if dropped == "mic" else 1.0,
                    0.1 if dropped == "system" else 1.0,
                ]):
                    result = self.transcriber.transcribe_diarised(self.audio_path)
                self.assertEqual(result["window_coverage"], 1.0)
                self.assertFalse(result["is_diarised"])

    def test_retained_channel_still_contributes_low_coverage(self):
        self.transcriber.transcribe_audio = Mock(side_effect=[
            {"text": "The budget is approved.", "segments": [
                {"text": "The budget is approved.", "start": 0.0, "end": 1.0},
            ], "window_coverage": 1.0},
            {"text": "Deployment starts tomorrow.", "segments": [
                {"text": "Deployment starts tomorrow.", "start": 2.0, "end": 3.0},
            ], "window_coverage": 0.2},
        ])
        result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertEqual(result["window_coverage"], 0.2)
        self.assertTrue(result["is_diarised"])


class TranscribeDiarisedMultiSpeakerTests(unittest.TestCase):
    """Acoustic per-channel diarization (steno-diarize sidecar) layered on
    top of the legacy You/Others channel split. Mocks _run_steno_diarize
    directly (module-level, not an instance method) since transcribe_diarised
    calls it as a free function via _tag_channel_segments."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = Path(self._tmp.name)
        self.audio_path = d / "source.wav"
        self.mic_path = d / "mic.wav"
        self.system_path = d / "system.wav"
        for p in (self.audio_path, self.mic_path, self.system_path):
            p.write_bytes(b"stub")
        self.transcriber = WhisperTranscriber.__new__(WhisperTranscriber)
        self.transcriber.backend = "parakeet"
        self.transcriber._split_stereo_to_channels = Mock(
            return_value=(self.mic_path, self.system_path, 10.0)
        )
        self.transcriber._check_rms_energy = Mock(return_value=True)

    def tearDown(self):
        self._tmp.cleanup()

    def test_two_speakers_on_mic_channel_become_you_and_speaker_two(self):
        # Mic channel has two acoustic clusters (SPEAKER_0 dominant at 5s
        # total, SPEAKER_1 minor at 2s total); system channel has a single
        # trivial cluster so is_diarised (which requires both channels to
        # contribute) stays True.
        mic_diar = [
            {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"},
            {"start": 2.5, "end": 4.5, "speaker": "SPEAKER_1"},
            {"start": 5.0, "end": 8.0, "speaker": "SPEAKER_0"},
        ]
        system_diar = [{"start": 9.0, "end": 9.5, "speaker": "SPEAKER_0"}]
        with patch("src.transcriber._run_steno_diarize", side_effect=[(mic_diar, {}), (system_diar, {})]):
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Hi there. Not bad. Great.", "segments": [
                    {"text": "Hi there.", "start": 0.5, "end": 1.5},
                    {"text": "Not bad.", "start": 3.0, "end": 3.8},
                    {"text": "Great.", "start": 6.0, "end": 6.8},
                ]},
                {"text": "Ok.", "segments": [{"text": "Ok.", "start": 9.2, "end": 9.4}]},
            ])
            result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertTrue(result["is_diarised"])
        self.assertIn("[You] Hi there.", result["diarised_text"])
        self.assertIn("[Speaker 2] Not bad.", result["diarised_text"])
        self.assertIn("[You] Great.", result["diarised_text"])
        self.assertIn("[Others] Ok.", result["diarised_text"])

    def test_speaker_clusters_populated_from_the_same_diarization_pass(self):
        # The live pipeline must be able to write a {stem}_speakers.json
        # sidecar from data this SAME call already computed -- no second,
        # separate diarization run (previously only the manual
        # backfill-speaker-embeddings CLI command ever produced this data;
        # a normal recording never did, so it never got a Speakers panel).
        mic_diar = [
            {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"},
            {"start": 2.5, "end": 4.5, "speaker": "SPEAKER_1"},
            {"start": 5.0, "end": 8.0, "speaker": "SPEAKER_0"},
        ]
        system_diar = [{"start": 9.0, "end": 9.5, "speaker": "SPEAKER_0"}]
        mic_embeddings = {"SPEAKER_0": [0.1, 0.2], "SPEAKER_1": [0.3, 0.4]}
        system_embeddings = {"SPEAKER_0": [0.5, 0.6]}
        with patch("src.transcriber._identity_matching_enabled", return_value=True), \
             patch("src.config.get_config") as mock_get_config, \
             patch(
                "src.transcriber._run_steno_diarize",
                side_effect=[(mic_diar, mic_embeddings), (system_diar, system_embeddings)],
             ):
            mock_get_config.return_value.get_voiceprints.return_value = []
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Hi there. Not bad. Great.", "segments": [
                    {"text": "Hi there.", "start": 0.5, "end": 1.5},
                    {"text": "Not bad.", "start": 3.0, "end": 3.8},
                    {"text": "Great.", "start": 6.0, "end": 6.8},
                ]},
                {"text": "Ok.", "segments": [{"text": "Ok.", "start": 9.2, "end": 9.4}]},
            ])
            result = self.transcriber.transcribe_diarised(self.audio_path)
        clusters = result["speaker_clusters"]
        self.assertEqual(clusters["mic"]["recording_type"], "in_person")
        self.assertEqual(set(clusters["mic"]["clusters"].keys()), {"SPEAKER_0", "SPEAKER_1"})
        self.assertEqual(clusters["mic"]["clusters"]["SPEAKER_1"]["embedding"], [0.3, 0.4])
        # The system channel's diarization result here is a single trivial
        # cluster (see the sibling test above) -- _cluster_channel_labels
        # correctly treats that as "no real second speaker" and the
        # TRANSCRIPT falls back to legacy labeling (no [Speaker N] split).
        # But a single-dominant-speaker channel is still real, usable
        # voiceprint data (see TagChannelSegmentsTests'
        # test_single_dominant_speaker_still_populates_clusters_out) -- a
        # normal call's "Others" side is very often exactly this shape, so
        # it must still show up here even without a transcript-level split.
        self.assertEqual(clusters["system"]["recording_type"], "remote")
        self.assertEqual(clusters["system"]["clusters"]["SPEAKER_0"]["embedding"], [0.5, 0.6])

    def test_enabled_pipeline_reconciles_sidecar_and_turn_manifest_together(self):
        mic_diar = [
            {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"},
            {"start": 2.5, "end": 4.5, "speaker": "SPEAKER_1"},
        ]
        system_diar = [
            {"start": 5.0, "end": 7.0, "speaker": "SPEAKER_0"},
            {"start": 7.5, "end": 9.5, "speaker": "SPEAKER_1"},
        ]
        mic_embeddings = {
            "SPEAKER_0": [1.0, 0.0, 0.0],
            "SPEAKER_1": [0.0, 1.0, 0.0],
        }
        system_embeddings = {
            "SPEAKER_0": [0.0, 0.0, 1.0],
            "SPEAKER_1": [0.0, 1.0, 0.0],
        }
        with patch("src.transcriber._identity_matching_enabled", return_value=True), \
             patch("src.config.get_config") as mock_get_config, \
             patch(
                "src.transcriber._run_steno_diarize",
                side_effect=[(mic_diar, mic_embeddings), (system_diar, system_embeddings)],
             ):
            mock_get_config.return_value.get_voiceprints.return_value = []
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Local. Echo.", "segments": [
                    {"text": "Local.", "start": 0.5, "end": 1.5},
                    {"text": "Echo.", "start": 3.0, "end": 4.0},
                ]},
                {"text": "Remote one. Remote participant speaking.", "segments": [
                    {"text": "Remote one.", "start": 5.5, "end": 6.5},
                    {"text": "Remote participant speaking.", "start": 8.0, "end": 9.0},
                ]},
            ])

            result = self.transcriber.transcribe_diarised(self.audio_path)

        self.assertEqual(set(result["speaker_clusters"]["mic"]["clusters"]), {"SPEAKER_0"})
        self.assertEqual(
            set(result["speaker_clusters"]["system"]["clusters"]),
            {"SPEAKER_0", "SPEAKER_1"},
        )
        self.assertIn(
            {"start": 2.5, "channel": "system", "diarization_speaker_id": "SPEAKER_1"},
            result["turn_manifest"],
        )

    def test_speaker_clusters_empty_and_no_self_match_when_identity_matching_disabled(self):
        # identity_matching_enabled=False must stop per-meeting speaker
        # embeddings from ever reaching speaker_clusters (so nothing is
        # persisted to a {stem}_speakers.json sidecar) and stop
        # self-voiceprint matching -- but "Speaker N" splitting itself only
        # depends on segments, not embeddings, so it must be unaffected.
        # Sets up a mic embedding closer to "self" than the threshold, so if
        # allow_self_match were (wrongly) still True, the dominant mic
        # cluster would get re-anchored -- asserting the ORIGINAL dominant-
        # by-duration label survives is what actually proves self-matching
        # never ran, not just that it no-op'd by coincidence.
        mic_diar = [
            {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"},
            {"start": 2.5, "end": 4.5, "speaker": "SPEAKER_1"},
            {"start": 5.0, "end": 8.0, "speaker": "SPEAKER_0"},
        ]
        system_diar = [{"start": 9.0, "end": 9.5, "speaker": "SPEAKER_0"}]
        mic_embeddings = {"SPEAKER_0": [0.1, 0.2], "SPEAKER_1": [0.3, 0.4]}
        system_embeddings = {"SPEAKER_0": [0.5, 0.6]}
        self_voiceprint = {"is_self": True, "centroid": [0.3, 0.4]}  # matches SPEAKER_1
        with patch("src.transcriber._identity_matching_enabled", return_value=False), \
             patch("src.transcriber._reconcile_cross_channel_speakers") as reconcile, \
             patch(
                "src.transcriber._run_steno_diarize",
                side_effect=[(mic_diar, mic_embeddings), (system_diar, system_embeddings)],
             ), \
             patch("src.config.get_config") as mock_get_config:
            mock_get_config.return_value.get_voiceprints.return_value = [self_voiceprint]
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Hi there. Not bad. Great.", "segments": [
                    {"text": "Hi there.", "start": 0.5, "end": 1.5},
                    {"text": "Not bad.", "start": 3.0, "end": 3.8},
                    {"text": "Great.", "start": 6.0, "end": 6.8},
                ]},
                {"text": "Ok.", "segments": [{"text": "Ok.", "start": 9.2, "end": 9.4}]},
            ])
            result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertEqual(result["speaker_clusters"], {})
        reconcile.assert_not_called()
        # Dominant-by-duration labeling survives untouched: SPEAKER_1 stays
        # "Speaker 2", it is NOT re-anchored to "You" despite matching the
        # self voiceprint above -- proving self-matching never ran.
        self.assertTrue(result["is_diarised"])
        self.assertIn("[You] Hi there.", result["diarised_text"])
        self.assertIn("[Speaker 2] Not bad.", result["diarised_text"])

    def test_speaker_clusters_empty_when_diarization_falls_back_to_legacy(self):
        # No embeddings means no diarization cluster to persist -- must not
        # produce a bogus/empty sidecar entry for a channel that fell back.
        with patch("src.transcriber._run_steno_diarize", return_value=None):
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Hi.", "segments": [{"text": "Hi.", "start": 0.5, "end": 1.5}]},
                {"text": "Ok.", "segments": [{"text": "Ok.", "start": 9.2, "end": 9.4}]},
            ])
            result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertEqual(result["speaker_clusters"], {})

    def test_turn_manifest_records_exact_channel_and_raw_sid_per_turn(self):
        # See the plan doc's Phase 8: this is the data a later confirm-
        # speaker call uses for EXACT (not fuzzy-timestamp) relabeling.
        # One manifest entry per merged turn, in the same order as
        # diarised_text's turns, each carrying the channel it actually
        # came from and its raw (pre-"Speaker N"-resolution) cluster id.
        mic_diar = [
            {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"},
            {"start": 2.5, "end": 4.5, "speaker": "SPEAKER_1"},
            {"start": 5.0, "end": 8.0, "speaker": "SPEAKER_0"},
        ]
        system_diar = [{"start": 9.0, "end": 9.5, "speaker": "SPEAKER_0"}]
        with patch("src.transcriber._run_steno_diarize", side_effect=[(mic_diar, {}), (system_diar, {})]):
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Hi there. Not bad. Great.", "segments": [
                    {"text": "Hi there.", "start": 0.5, "end": 1.5},
                    {"text": "Not bad.", "start": 3.0, "end": 3.8},
                    {"text": "Great.", "start": 6.0, "end": 6.8},
                ]},
                {"text": "Ok.", "segments": [{"text": "Ok.", "start": 9.2, "end": 9.4}]},
            ])
            result = self.transcriber.transcribe_diarised(self.audio_path)
        manifest = result["turn_manifest"]
        # 4 turns: [You/mic/SPEAKER_0, Speaker2/mic/SPEAKER_1, You/mic/SPEAKER_0, Others/system/SPEAKER_0]
        self.assertEqual(len(manifest), 4)
        self.assertEqual(
            [(m["channel"], m["diarization_speaker_id"]) for m in manifest],
            [("mic", "SPEAKER_0"), ("mic", "SPEAKER_1"), ("mic", "SPEAKER_0"), ("system", "SPEAKER_0")],
        )
        # Turn 0 (multi-cluster mic path, diar_tagged) starts from the DIAR
        # segment's own start (0.0, not the ASR segment's 0.5). Turn 3
        # (system's single-dominant-speaker fallback, legacy_tagged) is
        # built from asr_segments instead, so it keeps the ASR start (9.2)
        # -- both are exactly what each path already fed into the saved
        # transcript's own [MM:SS] markers, so the manifest and the visible
        # transcript timestamps always agree.
        self.assertEqual(manifest[0]["start"], 0.0)
        self.assertEqual(manifest[3]["start"], 9.2)

    def test_unplaceable_text_never_inherits_a_neighbouring_clusters_provenance(self):
        # Found by review. Text the diarizer could not place is appended
        # under the CHANNEL's own label -- and _cluster_channel_labels gives
        # the channel's dominant cluster that exact same label. The turn
        # loop coalesced on the label alone and kept the FIRST entry's
        # raw_sid, so an unplaceable sentence landing after a dominant-
        # cluster turn was silently recorded as that cluster's own speech.
        #
        # It would then reach a human twice: quoted under that speaker in
        # the review panel, and rewritten to that person's name by
        # confirm-speaker's relabel. Keeping the text while withholding the
        # cluster id is the entire point of that fallback, and merging by
        # label alone handed the id back.
        mic_diar = [
            {"start": 0.0, "end": 8.0, "speaker": "SPEAKER_1"},
            {"start": 10.0, "end": 20.0, "speaker": "SPEAKER_0"},  # dominant -> labelled "You"
        ]
        # The system channel speaks EARLY, so nothing sits between the mic's
        # dominant-cluster turn and the unplaceable sentence -- otherwise
        # the other channel's turn breaks the run and hides the defect.
        system_diar = [{"start": 5.0, "end": 5.5, "speaker": "SPEAKER_0"}]
        with patch("src.transcriber._run_steno_diarize", side_effect=[(mic_diar, {}), (system_diar, {})]):
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Someone else. The owner. A stray sentence.", "segments": [
                    {"text": "Someone else.", "start": 1.0, "end": 2.0},
                    {"text": "The owner.", "start": 11.0, "end": 12.0},
                    # Forty seconds from any mic segment: unplaceable, and it
                    # sorts directly after the dominant cluster's turn.
                    {"text": "A stray sentence.", "start": 60.0, "end": 61.0},
                ]},
                {"text": "Ok.", "segments": [{"text": "Ok.", "start": 5.2, "end": 5.4}]},
            ])
            result = self.transcriber.transcribe_diarised(self.audio_path)

        mic_entries = [m for m in result["turn_manifest"] if m["channel"] == "mic"]
        self.assertEqual(
            [m["diarization_speaker_id"] for m in mic_entries],
            ["SPEAKER_1", "SPEAKER_0", None],
            "the unplaceable sentence must stay its own turn, with no cluster id",
        )
        # And it must not have been folded into the owner's line, which is
        # what would put it under the owner's name on a relabel.
        owner_line = [
            line for line in result["diarised_text"].split("\n\n") if "The owner." in line
        ][0]
        self.assertNotIn("A stray sentence.", owner_line)

    def test_turn_manifest_has_none_raw_sid_entries_when_diarization_totally_fails(self):
        # is_diarised is about cross-channel label distinctness (You vs
        # Others), not per-channel diarization success -- a total
        # diarization failure on BOTH channels still produces a "diarised"
        # (You/Others-split) transcript, so turn_manifest still gets one
        # entry per turn (matching the transcript's own line count/order,
        # required for relabel_transcript_exact's positional pairing) --
        # just with diarization_speaker_id: None, since there's genuinely
        # no raw cluster id to report.
        with patch("src.transcriber._run_steno_diarize", return_value=None):
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Hi.", "segments": [{"text": "Hi.", "start": 0.5, "end": 1.5}]},
                {"text": "Ok.", "segments": [{"text": "Ok.", "start": 9.2, "end": 9.4}]},
            ])
            result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertEqual(result["turn_manifest"], [
            {"start": 0.5, "channel": "mic", "diarization_speaker_id": None},
            {"start": 9.2, "channel": "system", "diarization_speaker_id": None},
        ])

    def test_mic_only_multi_speaker_is_diarised_even_with_system_silent(self):
        # Regression: an in-person conversation with no computer audio
        # playing at all (system channel genuinely silent, not bled/dropped)
        # must still produce a labelled transcript from the mic channel's
        # own acoustic diarization. The old is_diarised computation
        # (bool(mic_segments) and bool(system_segments)) discarded the
        # whole labelled transcript whenever system was empty, even though
        # _tag_channel_segments had already split mic into You + Speaker 2.
        mic_diar = [
            {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"},
            {"start": 2.5, "end": 4.5, "speaker": "SPEAKER_1"},
            {"start": 5.0, "end": 8.0, "speaker": "SPEAKER_0"},
        ]
        with patch("src.transcriber._run_steno_diarize", return_value=(mic_diar, {})):
            self.transcriber._check_rms_energy = Mock(side_effect=[True, False])
            self.transcriber.transcribe_audio = Mock(return_value={
                "text": "Hi there. Not bad. Great.", "segments": [
                    {"text": "Hi there.", "start": 0.5, "end": 1.5},
                    {"text": "Not bad.", "start": 3.0, "end": 3.8},
                    {"text": "Great.", "start": 6.0, "end": 6.8},
                ],
            })
            result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertTrue(result["is_diarised"])
        self.assertIsNotNone(result["diarised_text"])
        self.assertIn("[You] Hi there.", result["diarised_text"])
        self.assertIn("[Speaker 2] Not bad.", result["diarised_text"])
        self.assertIn("[You] Great.", result["diarised_text"])

    def test_speaker_numbering_is_chronological_across_both_channels(self):
        # System's placeholder speaker turns up chronologically before
        # mic's placeholder speaker, so it must be numbered "Speaker 2"
        # even though the mic channel's diarization result is processed
        # first in transcribe_diarised. Dominant/minor durations are
        # clearly unequal (4s vs 1s) so cluster dominance is unambiguous.
        system_diar = [
            {"start": 0.0, "end": 1.0, "speaker": "SPEAKER_1"},    # minor, first chronologically
            {"start": 10.0, "end": 14.0, "speaker": "SPEAKER_0"},  # dominant -> "Others"
        ]
        mic_diar = [
            {"start": 15.0, "end": 16.0, "speaker": "SPEAKER_1"},  # minor
            {"start": 20.0, "end": 24.0, "speaker": "SPEAKER_0"},  # dominant -> "You"
        ]
        with patch("src.transcriber._run_steno_diarize", side_effect=[(mic_diar, {}), (system_diar, {})]):
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Mic minor. Mic dominant.", "segments": [
                    {"text": "Mic minor.", "start": 15.2, "end": 15.8},
                    {"text": "Mic dominant.", "start": 21.0, "end": 21.5},
                ]},
                {"text": "Sys minor. Sys dominant.", "segments": [
                    {"text": "Sys minor.", "start": 0.2, "end": 0.8},
                    {"text": "Sys dominant.", "start": 11.0, "end": 11.5},
                ]},
            ])
            result = self.transcriber.transcribe_diarised(self.audio_path)
        # System's minority cluster appears first chronologically (t=0.0)
        # so it gets "Speaker 2"; mic's minority cluster (t=15.0) gets
        # "Speaker 3" even though mic is diarized first in the pipeline.
        # Each turn is timestamped by the diarizer's own segment boundary
        # (not the ASR sentence start) — see _tag_channel_segments.
        self.assertEqual(
            result["diarised_text"],
            "[00:00] [Speaker 2] Sys minor."
            "\n\n[00:10] [Others] Sys dominant."
            "\n\n[00:15] [Speaker 3] Mic minor."
            "\n\n[00:20] [You] Mic dominant.",
        )

    def test_single_cluster_per_channel_is_byte_identical_to_legacy(self):
        # Sidecar runs successfully but finds only one speaker per channel —
        # must fall back to plain You/Others, not "Speaker 1" everywhere.
        mic_diar = [{"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"}]
        system_diar = [{"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"}]
        with patch("src.transcriber._run_steno_diarize", side_effect=[(mic_diar, {}), (system_diar, {})]):
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Hello.", "segments": [{"text": "Hello.", "start": 1.0, "end": 1.5}]},
                {"text": "Reply.", "segments": [{"text": "Reply.", "start": 2.0, "end": 2.5}]},
            ])
            result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertEqual(
            result["diarised_text"],
            "[00:01] [You] Hello.\n\n[00:02] [Others] Reply.",
        )

    def test_sidecar_failure_falls_back_without_failing_meeting(self):
        # Missing binary / timeout / bad JSON all surface as None from
        # _run_steno_diarize — transcribe_diarised must never fail the
        # meeting because of it.
        with patch("src.transcriber._run_steno_diarize", return_value=None):
            self.transcriber.transcribe_audio = Mock(side_effect=[
                {"text": "Hello.", "segments": [{"text": "Hello.", "start": 1.0, "end": 1.5}]},
                {"text": "Reply.", "segments": [{"text": "Reply.", "start": 2.0, "end": 2.5}]},
            ])
            result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertNotIn("transcription_failed", result)
        self.assertEqual(
            result["diarised_text"],
            "[00:01] [You] Hello.\n\n[00:02] [Others] Reply.",
        )


class TranscribeDiarisedMonoTests(unittest.TestCase):
    """Mono audio has no mic/system channel split to lean on, but a single
    track can still contain multiple speakers (e.g. an imported in-person
    recording). transcribe_diarised must run acoustic diarization directly
    against the whole file in that case, instead of unconditionally skipping
    diarization the way the pre-diarization mono fallback did."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        d = Path(self._tmp.name)
        self.audio_path = d / "mono.wav"
        self.audio_path.write_bytes(b"stub")
        self.transcriber = WhisperTranscriber.__new__(WhisperTranscriber)
        self.transcriber.backend = "parakeet"
        self.transcriber._split_stereo_to_channels = Mock(return_value=(None, None, None))

    def tearDown(self):
        self._tmp.cleanup()

    def test_two_speakers_in_mono_file_become_you_and_speaker_two(self):
        diar_segments = [
            {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"},
            {"start": 2.5, "end": 4.5, "speaker": "SPEAKER_1"},
            {"start": 5.0, "end": 8.0, "speaker": "SPEAKER_0"},
        ]
        with patch("src.transcriber._run_steno_diarize", return_value=(diar_segments, {})):
            self.transcriber.transcribe_audio = Mock(return_value={
                "text": "Hi there. Not bad. Great.",
                "segments": [
                    {"text": "Hi there.", "start": 0.5, "end": 1.5},
                    {"text": "Not bad.", "start": 3.0, "end": 3.8},
                    {"text": "Great.", "start": 6.0, "end": 6.8},
                ],
                "duration_seconds": 8.0,
            })
            result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertTrue(result["is_diarised"])
        self.assertIn("[You] Hi there.", result["diarised_text"])
        self.assertIn("[Speaker 2] Not bad.", result["diarised_text"])
        self.assertIn("[You] Great.", result["diarised_text"])
        # The plain text field is untouched by diarisation.
        self.assertEqual(result["text"], "Hi there. Not bad. Great.")

    def test_unplaceable_text_never_inherits_a_neighbouring_clusters_provenance(self):
        # The mono path builds its turns with its own copy of the same loop,
        # so it needs its own assertion -- this file's history is that a fix
        # applied to one path and not the other is how the defect comes back.
        # See the stereo test of the same name for what is at stake.
        diar_segments = [
            {"start": 0.0, "end": 8.0, "speaker": "SPEAKER_1"},
            {"start": 10.0, "end": 20.0, "speaker": "SPEAKER_0"},  # dominant -> labelled "You"
        ]
        with patch("src.transcriber._run_steno_diarize", return_value=(diar_segments, {})):
            self.transcriber.transcribe_audio = Mock(return_value={
                "text": "Someone else. The owner. A stray sentence.",
                "segments": [
                    {"text": "Someone else.", "start": 1.0, "end": 2.0},
                    {"text": "The owner.", "start": 11.0, "end": 12.0},
                    {"text": "A stray sentence.", "start": 60.0, "end": 61.0},
                ],
                "duration_seconds": 61.0,
            })
            result = self.transcriber.transcribe_diarised(self.audio_path)

        self.assertEqual(
            [m["diarization_speaker_id"] for m in result["turn_manifest"]],
            ["SPEAKER_1", "SPEAKER_0", None],
            "the unplaceable sentence must stay its own turn, with no cluster id",
        )
        owner_line = [
            line for line in result["diarised_text"].split("\n\n") if "The owner." in line
        ][0]
        self.assertNotIn("A stray sentence.", owner_line)

    def test_single_speaker_mono_is_not_diarised(self):
        # Byte-identical-to-legacy fast path: one real cluster means nothing
        # to disambiguate, matching the pre-diarization mono behaviour.
        diar_segments = [{"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"}]
        with patch("src.transcriber._run_steno_diarize", return_value=(diar_segments, {})):
            self.transcriber.transcribe_audio = Mock(return_value={
                "text": "Just me talking.",
                "segments": [{"text": "Just me talking.", "start": 0.5, "end": 1.5}],
                "duration_seconds": 5.0,
            })
            result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertFalse(result["is_diarised"])
        self.assertIsNone(result["diarised_text"])

    def test_sidecar_failure_falls_back_without_diarisation(self):
        with patch("src.transcriber._run_steno_diarize", return_value=None):
            self.transcriber.transcribe_audio = Mock(return_value={
                "text": "Hello world.",
                "segments": [{"text": "Hello world.", "start": 0.5, "end": 1.5}],
                "duration_seconds": 2.0,
            })
            result = self.transcriber.transcribe_diarised(self.audio_path)
        self.assertFalse(result["is_diarised"])
        self.assertIsNone(result["diarised_text"])
        self.assertEqual(result["text"], "Hello world.")

    def test_transcription_failure_propagates_without_diarizing(self):
        with patch("src.transcriber._run_steno_diarize") as mock_diarize:
            self.transcriber.transcribe_audio = Mock(return_value={
                "text": None,
                "segments": [],
                "transcription_failed": True,
                "error": "boom",
            })
            result = self.transcriber.transcribe_diarised(self.audio_path)
        mock_diarize.assert_not_called()
        self.assertTrue(result["transcription_failed"])
        self.assertFalse(result["is_diarised"])
        self.assertIsNone(result["diarised_text"])

    def test_empty_transcription_does_not_attempt_diarization(self):
        with patch("src.transcriber._run_steno_diarize") as mock_diarize:
            self.transcriber.transcribe_audio = Mock(return_value={
                "text": "No speech detected in audio",
                "segments": [],
                "transcription_empty": True,
            })
            result = self.transcriber.transcribe_diarised(self.audio_path)
        mock_diarize.assert_not_called()
        self.assertFalse(result["is_diarised"])


class TokenJaccardTests(unittest.TestCase):
    def test_identical_strings_score_one(self):
        self.assertEqual(_token_jaccard("hello world", "hello world"), 1.0)

    def test_disjoint_strings_score_zero(self):
        self.assertEqual(
            _token_jaccard("hi can you hear me", "trump has said many outrageous things"),
            0.0,
        )

    def test_empty_inputs_return_zero(self):
        self.assertEqual(_token_jaccard("", "anything"), 0.0)
        self.assertEqual(_token_jaccard("anything", ""), 0.0)
        self.assertEqual(_token_jaccard("", ""), 0.0)

    def test_case_and_whitespace_insensitive(self):
        self.assertEqual(
            _token_jaccard("Hello, World!", "hello world"),
            1.0,
        )

    def test_real_bleed_sample_crosses_threshold(self):
        # Lifted from the actual recording that triggered this fix: the
        # mic captures the user plus YouTube echo, the system loopback
        # captures the same YouTube cleanly. Sets share most words.
        mic = (
            "popping up I think it was originally Alexandria of liberal groups "
            "liberal opponents to the Muslim Brother liberal secular Egyptians "
            "we opposed the Morsi government as much as we opposed the Mubarak"
        )
        system = (
            "popping up I think it was originally Alexandria of liberal groups "
            "liberal opponents to the Muslim Brother liberal secular Egyptians "
            "We opposed the Morsi government as much as we opposed the Mubarak"
        )
        similarity = _token_jaccard(mic, system)
        self.assertGreaterEqual(similarity, BLEED_JACCARD_THRESHOLD)

    def test_real_two_party_sample_below_threshold(self):
        mic = "hi can you hear me okay let me share my screen now"
        system = "yes I can hear you fine please go ahead with the demo"
        similarity = _token_jaccard(mic, system)
        self.assertLess(similarity, BLEED_JACCARD_THRESHOLD)


class FfmpegStderrParseTests(unittest.TestCase):
    STEREO_OPUS = """\
Input #0, matroska,webm, from '/tmp/sample.webm':
  Metadata:
    encoder         : Chrome
  Duration: 00:00:28.62, start: -0.007000, bitrate: 128 kb/s
  Stream #0:0(eng): Audio: opus, 48000 Hz, stereo, fltp (default)
"""

    MONO_WAV = """\
Input #0, wav, from '/tmp/sample.wav':
  Duration: 00:01:05.40, bitrate: 256 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 16000 Hz, mono, s16, 256 kb/s
"""

    SIX_CHANNEL = """\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/tmp/sample.m4a':
  Duration: 02:34:12.10, start: 0.000000, bitrate: 384 kb/s
  Stream #0:0: Audio: aac (LC), 48000 Hz, 6 channels, fltp, 384 kb/s
"""

    GIBBERISH = "ffmpeg version 7.1.1\nbuilt with Apple clang...\n"

    def test_parses_stereo(self):
        self.assertEqual(_parse_channels_from_ffmpeg_stderr(self.STEREO_OPUS), 2)

    def test_parses_mono(self):
        self.assertEqual(_parse_channels_from_ffmpeg_stderr(self.MONO_WAV), 1)

    def test_parses_six_channel(self):
        self.assertEqual(_parse_channels_from_ffmpeg_stderr(self.SIX_CHANNEL), 6)

    def test_returns_none_on_no_audio_stream(self):
        self.assertIsNone(_parse_channels_from_ffmpeg_stderr(self.GIBBERISH))

    def test_parses_short_duration(self):
        self.assertAlmostEqual(
            _parse_duration_from_ffmpeg_stderr(self.STEREO_OPUS),
            28.62,
            places=2,
        )

    def test_parses_long_duration(self):
        # 2h 34m 12.10s
        self.assertAlmostEqual(
            _parse_duration_from_ffmpeg_stderr(self.SIX_CHANNEL),
            2 * 3600 + 34 * 60 + 12.10,
            places=2,
        )

    def test_returns_none_when_no_duration(self):
        self.assertIsNone(_parse_duration_from_ffmpeg_stderr(self.GIBBERISH))


def _write_wav_with_segments(path: Path, segments) -> None:
    """Write a 16 kHz mono WAV. `segments` is [(seconds_silent_or_loud, kind), ...]
    where kind is 'silent' or 'loud'. 'loud' fills with a low-amplitude tone
    well above MIN_RMS_THRESHOLD; 'silent' fills with zeros.
    """
    sr = 16000
    frames = bytearray()
    for seconds, kind in segments:
        n = int(seconds * sr)
        if kind == 'silent':
            frames.extend(struct.pack(f'<{n}h', *([0] * n)))
        elif kind == 'loud':
            # Sine wave at amplitude 0.05 (-26 dB) — well above the gate.
            samples = [
                int(0.05 * 32767 * math.sin(2 * math.pi * 440 * i / sr))
                for i in range(n)
            ]
            frames.extend(struct.pack(f'<{n}h', *samples))
        else:
            raise ValueError(kind)
    with wave.open(str(path), 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(bytes(frames))


class CheckRmsEnergyTests(unittest.TestCase):
    """The whole-file scan is the *point* of this function. Confirm it
    catches audio that the old "first 5 seconds only" implementation would
    have missed."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self._tmp.name)
        self.transcriber = WhisperTranscriber.__new__(WhisperTranscriber)

    def tearDown(self):
        self._tmp.cleanup()

    def test_all_silent_returns_false(self):
        path = self.tmpdir / 'silent.wav'
        _write_wav_with_segments(path, [(10, 'silent')])
        self.assertFalse(self.transcriber._check_rms_energy(path))

    def test_loud_throughout_returns_true(self):
        path = self.tmpdir / 'loud.wav'
        _write_wav_with_segments(path, [(10, 'loud')])
        self.assertTrue(self.transcriber._check_rms_energy(path))

    def test_speech_starting_after_5s_is_caught(self):
        # The pre-fix implementation read only the first 5 seconds; this
        # file has 10 s of silence then 5 s of audio. New scan should
        # surface the late-arriving energy and return True.
        path = self.tmpdir / 'late_speech.wav'
        _write_wav_with_segments(path, [(10, 'silent'), (5, 'loud')])
        self.assertTrue(self.transcriber._check_rms_energy(path))

    def test_zero_frame_file_returns_false(self):
        path = self.tmpdir / 'empty.wav'
        # Wave file with header but no frames.
        with wave.open(str(path), 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b'')
        self.assertFalse(self.transcriber._check_rms_energy(path))

    def test_sub_one_second_clip_with_audio_is_not_silent(self):
        # Regression: the windowed scan used to require a full 1 s window
        # before it would compute any RMS. A 0.4 s loud clip would never
        # enter the loop and was falsely returned as silent — disabling
        # diarisation on short recordings.
        path = self.tmpdir / 'short_loud.wav'
        _write_wav_with_segments(path, [(0.4, 'loud')])
        self.assertTrue(self.transcriber._check_rms_energy(path))

    def test_sub_one_second_silent_clip_is_silent(self):
        path = self.tmpdir / 'short_silent.wav'
        _write_wav_with_segments(path, [(0.4, 'silent')])
        self.assertFalse(self.transcriber._check_rms_energy(path))

    def test_explicit_high_threshold_skips_quiet_audio(self):
        path = self.tmpdir / 'loud.wav'
        _write_wav_with_segments(path, [(5, 'loud')])
        # Loud test fixture is at ~-26 dB RMS; threshold 0.5 (~ -6 dB)
        # is well above and should not match.
        self.assertFalse(self.transcriber._check_rms_energy(path, threshold=0.5))

    def test_default_threshold_matches_constant(self):
        # Guards against accidental drift between the default arg and the
        # exported constant — they're meant to be the same thing.
        import inspect
        sig = inspect.signature(self.transcriber._check_rms_energy)
        self.assertEqual(sig.parameters['threshold'].default, MIN_RMS_THRESHOLD)


class ResolveFfmpegTests(unittest.TestCase):
    """Sanity check that the resolver runs and returns a string when ffmpeg
    is available on the test machine (CI runs on macOS with homebrew). If
    none of the candidate paths work this returns None, which is also a
    valid outcome — we just don't assert non-None to keep the test
    portable."""

    def test_resolve_returns_str_or_none(self):
        from src.transcriber import _resolve_ffmpeg
        result = _resolve_ffmpeg()
        self.assertTrue(result is None or isinstance(result, str))


class DiarisedSplitTimeoutTests(unittest.TestCase):
    """The per-channel split timeout must scale with recording length so a
    multi-hour stereo meeting isn't cut off mid-decode and silently dropped
    to a mono transcript (the old fixed 120 s did exactly that)."""

    def test_long_meeting_scales_well_above_old_fixed_cap(self):
        # A 4-hour file would never decode in the old 120 s on CPU.
        four_hours = 4 * 3600
        timeout = _diarised_split_timeout(four_hours)
        self.assertGreater(timeout, 120)
        self.assertEqual(timeout, four_hours * 2)

    def test_unknown_and_short_durations_fall_back_to_floor(self):
        self.assertEqual(_diarised_split_timeout(None), DIARISED_SPLIT_TIMEOUT_S)
        self.assertEqual(_diarised_split_timeout(0), DIARISED_SPLIT_TIMEOUT_S)
        # A short clip whose 2x is under the floor still gets the full floor.
        self.assertEqual(_diarised_split_timeout(30), DIARISED_SPLIT_TIMEOUT_S)

    def test_returns_int(self):
        self.assertIsInstance(_diarised_split_timeout(1234.5), int)


class MergeCloseDiarSegmentsTests(unittest.TestCase):
    def test_empty_input_returns_empty(self):
        self.assertEqual(_merge_close_diar_segments([], 0.3), [])

    def test_merges_same_speaker_within_gap(self):
        segments = [
            {"start": 0.0, "end": 1.0, "speaker": "SPEAKER_0"},
            {"start": 1.2, "end": 2.0, "speaker": "SPEAKER_0"},
        ]
        merged = _merge_close_diar_segments(segments, 0.3)
        self.assertEqual(merged, [{"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"}])

    def test_does_not_merge_across_gap_larger_than_threshold(self):
        segments = [
            {"start": 0.0, "end": 1.0, "speaker": "SPEAKER_0"},
            {"start": 2.0, "end": 3.0, "speaker": "SPEAKER_0"},
        ]
        merged = _merge_close_diar_segments(segments, 0.3)
        self.assertEqual(len(merged), 2)

    def test_does_not_merge_different_speakers(self):
        segments = [
            {"start": 0.0, "end": 1.0, "speaker": "SPEAKER_0"},
            {"start": 1.1, "end": 2.0, "speaker": "SPEAKER_1"},
        ]
        merged = _merge_close_diar_segments(segments, 0.3)
        self.assertEqual(len(merged), 2)

    def test_nested_same_speaker_segment_does_not_shorten_the_turn(self):
        # Sorted by start does not mean each segment ends later than the
        # one before. A nested same-speaker segment used to pull the merged
        # end backwards, deleting speaking time that was really there --
        # and that time feeds the dominance share deciding the speaker count.
        segments = [
            {"start": 0.0, "end": 4.0, "speaker": "SPEAKER_0"},
            {"start": 2.0, "end": 3.0, "speaker": "SPEAKER_0"},
        ]
        merged = _merge_close_diar_segments(segments, 0.3)
        self.assertEqual(merged, [{"start": 0.0, "end": 4.0, "speaker": "SPEAKER_0"}])

    def test_does_not_mutate_input(self):
        segments = [{"start": 0.0, "end": 1.0, "speaker": "SPEAKER_0"}]
        _merge_close_diar_segments(segments, STENO_DIARIZE_MERGE_GAP_S)
        self.assertEqual(segments, [{"start": 0.0, "end": 1.0, "speaker": "SPEAKER_0"}])


class WorstWindowCoverageTests(unittest.TestCase):
    def test_takes_the_worst_reporting_channel(self):
        self.assertEqual(
            _worst_window_coverage({"window_coverage": 1.0}, {"window_coverage": 0.4}), 0.4
        )

    def test_ignores_channels_that_report_nothing(self):
        # A silent channel never runs and never reports. It must not drag the
        # meeting's figure down, and it must not stand in for the other one.
        self.assertEqual(_worst_window_coverage(None, {"window_coverage": 0.6}), 0.6)
        self.assertEqual(_worst_window_coverage({}, {"window_coverage": 0.6}), 0.6)

    def test_nothing_reported_is_unknown_not_complete(self):
        # whisper.cpp and parakeet-mlx do no windowing of their own. Absence
        # of a figure must never read as a clean bill of health.
        self.assertIsNone(_worst_window_coverage(None, None))
        self.assertIsNone(_worst_window_coverage({"window_coverage": None}, {}))

    def test_zero_coverage_is_kept_not_treated_as_missing(self):
        self.assertEqual(_worst_window_coverage({"window_coverage": 0.0}, None), 0.0)


class ClampOverlappingDiarSegmentsTests(unittest.TestCase):
    def test_empty_input_returns_empty(self):
        self.assertEqual(_clamp_overlapping_diar_segments([]), [])

    def test_partial_overlap_is_given_to_the_earlier_speaker(self):
        segments = [
            {"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"},
            {"start": 3.0, "end": 8.0, "speaker": "SPEAKER_1"},
        ]
        self.assertEqual(_clamp_overlapping_diar_segments(segments), [
            {"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"},
            {"start": 5.0, "end": 8.0, "speaker": "SPEAKER_1"},
        ])

    def test_untouched_when_nothing_overlaps(self):
        segments = [
            {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"},
            {"start": 2.5, "end": 4.0, "speaker": "SPEAKER_1"},
        ]
        self.assertEqual(_clamp_overlapping_diar_segments(segments), segments)

    def test_fully_contained_segment_survives_instead_of_being_clamped_away(self):
        # Clamping this one leaves nothing of it, and a cluster that only
        # ever speaks inside someone else's turn would disappear from the
        # channel entirely. Double-counted time is the cheaper mistake.
        segments = [
            {"start": 0.0, "end": 10.0, "speaker": "SPEAKER_0"},
            {"start": 3.0, "end": 4.0, "speaker": "SPEAKER_1"},
        ]
        self.assertEqual(_clamp_overlapping_diar_segments(segments), segments)

    def test_clamps_against_the_furthest_end_seen_not_just_the_previous(self):
        # A long segment followed by a short nested one must not let the
        # next real turn start back inside the long one.
        segments = [
            {"start": 0.0, "end": 10.0, "speaker": "SPEAKER_0"},
            {"start": 3.0, "end": 4.0, "speaker": "SPEAKER_1"},
            {"start": 8.0, "end": 12.0, "speaker": "SPEAKER_1"},
        ]
        self.assertEqual(_clamp_overlapping_diar_segments(segments)[2], {
            "start": 10.0, "end": 12.0, "speaker": "SPEAKER_1",
        })

    def test_does_not_mutate_input(self):
        segments = [
            {"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"},
            {"start": 3.0, "end": 8.0, "speaker": "SPEAKER_1"},
        ]
        _clamp_overlapping_diar_segments(segments)
        self.assertEqual(segments[1]["start"], 3.0)

    def test_a_nested_same_speaker_segment_survives_the_whole_pipeline(self):
        # A[0,4] B[1,5] A[2,3]: clamping moves B behind A, which leaves the
        # nested A next to the outer one and used to truncate the outer A
        # from 4 to 3 in the second merge. A must keep every second it held.
        payload = json.dumps({
            "segments": [
                {"speakerId": "SPEAKER_0", "start": 0.0, "end": 4.0},
                {"speakerId": "SPEAKER_1", "start": 1.0, "end": 5.0},
                {"speakerId": "SPEAKER_0", "start": 2.0, "end": 3.0},
            ],
            "speakers": {},
        }).encode()
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=payload, stderr=b"", returncode=0):
            segments, _ = _run_steno_diarize(Path("/fake/mic.wav"), 60)
        self.assertEqual(segments, [
            {"start": 0.0, "end": 4.0, "speaker": "SPEAKER_0"},
            {"start": 4.0, "end": 5.0, "speaker": "SPEAKER_1"},
        ])


class AssignAsrSegmentsToDiarSegmentsTests(unittest.TestCase):
    def test_empty_diar_segments_is_a_no_op(self):
        diar_segments = []
        _assign_asr_segments_to_diar_segments(
            [{"text": "Hello", "start": 0.0, "end": 1.0}], diar_segments
        )
        self.assertEqual(diar_segments, [])

    def test_assigns_sentence_within_segment_bounds(self):
        diar_segments = [{"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"}]
        _assign_asr_segments_to_diar_segments(
            [{"text": "Hello there", "start": 1.0, "end": 2.0}], diar_segments
        )
        self.assertEqual(diar_segments[0]["text"], "Hello there")

    def test_assigns_multiple_sentences_to_nearest_segment(self):
        diar_segments = [
            {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"},
            {"start": 3.0, "end": 5.0, "speaker": "SPEAKER_1"},
        ]
        _assign_asr_segments_to_diar_segments(
            [
                {"text": "First.", "start": 0.5, "end": 1.0},
                {"text": "Second.", "start": 3.5, "end": 4.0},
                # Falls in the gap between segments (2.0-3.0) but its
                # midpoint (2.6) is closer to the second segment's start.
                {"text": "Gap.", "start": 2.4, "end": 2.8},
            ],
            diar_segments,
        )
        self.assertEqual(diar_segments[0]["text"], "First.")
        self.assertEqual(diar_segments[1]["text"], "Second. Gap.")

    def test_blank_sentences_are_skipped(self):
        diar_segments = [{"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"}]
        _assign_asr_segments_to_diar_segments(
            [{"text": "  ", "start": 1.0, "end": 2.0}], diar_segments
        )
        self.assertEqual(diar_segments[0]["text"], "")

    def test_long_sentence_spanning_multiple_speakers_splits_by_word(self):
        # Regression for a real observed failure: a single mic capturing two
        # people can produce one long Parakeet "sentence" (no punctuation
        # break) that actually spans a genuine back-and-forth. Whole-block
        # midpoint assignment forced the entire run onto one speaker;
        # word-level splitting should recover the real turn boundaries.
        diar_segments = [
            {"start": 0.0, "end": 3.0, "speaker": "SPEAKER_0"},
            {"start": 3.0, "end": 6.0, "speaker": "SPEAKER_1"},
        ]
        tokens = [
            {"text": " one", "start": 0.5, "end": 1.0},
            {"text": " two", "start": 1.0, "end": 1.5},
            {"text": " three", "start": 4.5, "end": 5.0},
            {"text": " four", "start": 5.0, "end": 5.5},
        ]
        _assign_asr_segments_to_diar_segments(
            [{"text": "one two three four", "start": 0.5, "end": 5.5, "tokens": tokens}],
            diar_segments,
        )
        self.assertEqual(diar_segments[0]["text"], "one two")
        self.assertEqual(diar_segments[1]["text"], "three four")

    def test_long_sentence_within_single_speaker_is_not_split(self):
        # Long duration alone isn't enough to trigger splitting — the
        # diarizer segments it overlaps must belong to more than one
        # distinct speaker. Fragmented same-speaker segments (diarizer
        # flicker) should still be treated as one block.
        diar_segments = [
            {"start": 0.0, "end": 3.0, "speaker": "SPEAKER_0"},
            {"start": 3.0, "end": 6.0, "speaker": "SPEAKER_0"},
        ]
        tokens = [
            {"text": " one", "start": 0.5, "end": 1.0},
            {"text": " two", "start": 5.0, "end": 5.5},
        ]
        _assign_asr_segments_to_diar_segments(
            [{"text": "one two", "start": 0.5, "end": 5.5, "tokens": tokens}],
            diar_segments,
        )
        self.assertEqual(diar_segments[0]["text"], "one two")
        self.assertEqual(diar_segments[1]["text"], "")

    def test_short_sentence_not_split_even_across_speakers(self):
        # Below LONG_SENTENCE_SPLIT_THRESHOLD_S — must stay whole-block
        # (matching the historical short-sentence behaviour) even though it
        # technically overlaps two different speakers, to avoid tearing
        # short utterances apart on noisy diarizer boundaries.
        diar_segments = [
            {"start": 0.0, "end": 1.0, "speaker": "SPEAKER_0"},
            {"start": 1.0, "end": 2.0, "speaker": "SPEAKER_1"},
        ]
        tokens = [
            {"text": " hi", "start": 0.8, "end": 1.0},
            {"text": " there", "start": 1.0, "end": 1.2},
        ]
        _assign_asr_segments_to_diar_segments(
            [{"text": "hi there", "start": 0.8, "end": 1.2, "tokens": tokens}],
            diar_segments,
        )
        texts = [d["text"] for d in diar_segments]
        self.assertEqual(texts.count("hi there"), 1)

    def test_long_sentence_without_tokens_falls_back_to_whole_block(self):
        # No word-level timing (e.g. the whisper.cpp backend never
        # populates "tokens") must never crash — falls back to the same
        # whole-block nearest assignment as a normal sentence.
        diar_segments = [
            {"start": 0.0, "end": 3.0, "speaker": "SPEAKER_0"},
            {"start": 3.0, "end": 6.0, "speaker": "SPEAKER_1"},
        ]
        _assign_asr_segments_to_diar_segments(
            [{"text": "one two three four", "start": 0.5, "end": 5.5}],
            diar_segments,
        )
        texts = [d["text"] for d in diar_segments]
        self.assertEqual(texts.count("one two three four"), 1)

    def test_sentence_far_from_every_segment_is_returned_not_attributed(self):
        # Regression for an unconditional "nearest" fallback: with the
        # channel's only diarizer segment at 2-3s, text at 0-1s was
        # attributed in full to a speaker the diarizer never heard there.
        # It must come back unplaceable instead -- and the text must
        # survive, so the caller can keep it under the channel's own label.
        diar_segments = [{"start": 2.0, "end": 3.0, "speaker": "SPEAKER_0"}]
        asr_segment = {"text": "Nobody was speaking here.", "start": 0.0, "end": 1.0}
        unplaceable = _assign_asr_segments_to_diar_segments([asr_segment], diar_segments)
        self.assertEqual(diar_segments[0]["text"], "")
        self.assertEqual(unplaceable, [asr_segment])

    def test_sentence_just_inside_the_tolerance_still_attaches(self):
        # The bound only rejects text with no plausible turn nearby --
        # ordinary boundary slop (a clipped onset, breath before a turn)
        # must still land on the adjacent speaker, as it always has.
        gap = DIAR_LABEL_FALLBACK_TOLERANCE_S / 2
        diar_segments = [{"start": 2.0, "end": 3.0, "speaker": "SPEAKER_0"}]
        unplaceable = _assign_asr_segments_to_diar_segments(
            [{"text": "Just before the turn.", "start": 2.0 - gap - 0.2, "end": 2.0 - gap + 0.2}],
            diar_segments,
        )
        self.assertEqual(diar_segments[0]["text"], "Just before the turn.")
        self.assertEqual(unplaceable, [])

    def test_unplaceable_word_stays_with_the_current_turn(self):
        # Word-level splitting must not invent a turn for a word that
        # carries no speaker evidence, and must not drop it either -- it
        # belongs to whichever turn it is already inside.
        diar_segments = [
            {"start": 0.0, "end": 3.0, "speaker": "SPEAKER_0"},
            {"start": 20.0, "end": 23.0, "speaker": "SPEAKER_1"},
        ]
        tokens = [
            {"text": " one", "start": 0.5, "end": 1.0},
            # Sits in the long uncovered gap, far from both speakers.
            {"text": " two", "start": 10.0, "end": 10.5},
            {"text": " three", "start": 21.0, "end": 21.5},
        ]
        unplaceable = _assign_asr_segments_to_diar_segments(
            [{"text": "one two three", "start": 0.5, "end": 21.5, "tokens": tokens}],
            diar_segments,
        )
        self.assertEqual(diar_segments[0]["text"], "one two")
        self.assertEqual(diar_segments[1]["text"], "three")
        self.assertEqual(unplaceable, [])

    def test_unplaceable_word_stays_put_even_when_the_next_turn_is_nearer(self):
        # Deliberate behaviour change, not a side effect: this word used to
        # go to whichever segment was nearest, so being closer to the NEXT
        # speaker moved it there. Out of tolerance, "nearest" is not
        # evidence -- continuing the turn the word is already in beats
        # opening one for a speaker who starts five seconds later.
        diar_segments = [
            {"start": 0.0, "end": 3.0, "speaker": "SPEAKER_0"},
            {"start": 20.0, "end": 23.0, "speaker": "SPEAKER_1"},
        ]
        tokens = [
            {"text": " one", "start": 1.0, "end": 1.5},
            # Nearer to SPEAKER_1 (5s) than to SPEAKER_0 (12s), but far
            # outside both.
            {"text": " two", "start": 15.0, "end": 15.5},
            {"text": " three", "start": 21.0, "end": 21.5},
        ]
        unplaceable = _assign_asr_segments_to_diar_segments(
            [{"text": "one two three", "start": 1.0, "end": 21.5, "tokens": tokens}],
            diar_segments,
        )
        self.assertEqual(diar_segments[0]["text"], "one two")
        self.assertEqual(diar_segments[1]["text"], "three")
        self.assertEqual(unplaceable, [])

    def test_leading_unplaceable_words_lead_the_first_real_turn(self):
        # Words before the first placeable one have no turn to stay with
        # yet -- they must still keep their position in the sentence.
        diar_segments = [
            {"start": 12.0, "end": 14.0, "speaker": "SPEAKER_0"},
            {"start": 20.0, "end": 23.0, "speaker": "SPEAKER_1"},
        ]
        tokens = [
            # Ahead of every segment, so no turn is open yet.
            {"text": " one", "start": 0.5, "end": 1.0},
            {"text": " two", "start": 13.0, "end": 13.5},
            {"text": " three", "start": 21.0, "end": 21.5},
        ]
        unplaceable = _assign_asr_segments_to_diar_segments(
            [{"text": "one two three", "start": 0.5, "end": 21.5, "tokens": tokens}],
            diar_segments,
        )
        self.assertEqual(diar_segments[0]["text"], "one two")
        self.assertEqual(diar_segments[1]["text"], "three")
        self.assertEqual(unplaceable, [])

    def test_sentence_with_no_placeable_word_is_returned_whole(self):
        diar_segments = [
            {"start": 40.0, "end": 43.0, "speaker": "SPEAKER_0"},
            {"start": 50.0, "end": 53.0, "speaker": "SPEAKER_1"},
        ]
        tokens = [
            {"text": " one", "start": 0.5, "end": 1.0},
            {"text": " two", "start": 5.0, "end": 5.5},
        ]
        asr_segment = {"text": "one two", "start": 0.5, "end": 5.5, "tokens": tokens}
        unplaceable = _assign_asr_segments_to_diar_segments([asr_segment], diar_segments)
        self.assertEqual([d["text"] for d in diar_segments], ["", ""])
        self.assertEqual(unplaceable, [asr_segment])

    def test_long_sentence_whose_tokens_carry_no_text_is_not_dropped(self):
        # Word-level splitting reached on a token list with nothing usable
        # in it used to leave the sentence in no segment at all -- the text
        # simply disappeared from the transcript.
        diar_segments = [
            {"start": 0.0, "end": 3.0, "speaker": "SPEAKER_0"},
            {"start": 3.0, "end": 6.0, "speaker": "SPEAKER_1"},
        ]
        tokens = [{"text": "  ", "start": 0.5, "end": 1.0}, {"text": "", "start": 5.0, "end": 5.5}]
        asr_segment = {"text": "one two", "start": 0.5, "end": 5.5, "tokens": tokens}
        unplaceable = _assign_asr_segments_to_diar_segments([asr_segment], diar_segments)
        self.assertEqual([d["text"] for d in diar_segments], ["", ""])
        self.assertEqual(unplaceable, [asr_segment])

    def test_empty_diar_segments_reports_everything_unplaceable(self):
        # Nothing to place text against -- the caller must hear about it
        # rather than the text quietly disappearing.
        asr_segment = {"text": "Hello", "start": 0.0, "end": 1.0}
        self.assertEqual(
            _assign_asr_segments_to_diar_segments([asr_segment], []), [asr_segment]
        )


class ClusterChannelLabelsTests(unittest.TestCase):
    def test_single_speaker_returns_none(self):
        segments = [{"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"}]
        self.assertIsNone(_cluster_channel_labels(segments, "You"))

    def test_empty_segments_returns_none(self):
        self.assertIsNone(_cluster_channel_labels([], "You"))

    def test_dominant_speaker_by_total_duration_keeps_legacy_label(self):
        segments = [
            {"start": 0.0, "end": 1.0, "speaker": "SPEAKER_0"},   # 1s
            {"start": 1.0, "end": 6.0, "speaker": "SPEAKER_1"},   # 5s, dominant
        ]
        labels = _cluster_channel_labels(segments, "You")
        self.assertEqual(labels["SPEAKER_1"], "You")
        self.assertEqual(labels["SPEAKER_0"], "__diar__You__SPEAKER_0")

    def test_overwhelmingly_dominant_speaker_returns_none(self):
        # A tiny misdiarization blip (e.g. a ~0.3s noise artifact) must not
        # spawn a phantom second speaker — regression for the real-world
        # oversplitting issue observed on single-mic multi-person audio.
        segments = [
            {"start": 0.0, "end": 59.7, "speaker": "SPEAKER_0"},
            {"start": 59.7, "end": 60.0, "speaker": "SPEAKER_1"},  # 0.5% of total
        ]
        self.assertIsNone(_cluster_channel_labels(segments, "You"))

    def test_dominance_ratio_just_under_threshold_still_clusters(self):
        total = 100.0
        minor = total * (1 - CHANNEL_DOMINANCE_THRESHOLD) + 0.5  # comfortably above the gate
        segments = [
            {"start": 0.0, "end": total - minor, "speaker": "SPEAKER_0"},
            {"start": total - minor, "end": total, "speaker": "SPEAKER_1"},
        ]
        self.assertIsNotNone(_cluster_channel_labels(segments, "You"))

    def test_sustained_minorities_stay_distinct_while_short_blip_folds_to_dominant(self):
        # A long channel with 95.2% dominant speech can still contain two
        # speakers with enough speech to deserve their own transcript labels.
        segments = [
            {"start": 0.0, "end": 3487.4, "speaker": "SPEAKER_0"},
            {"start": 3487.4, "end": 3598.5, "speaker": "SPEAKER_1"},
            {"start": 3598.5, "end": 3659.7, "speaker": "SPEAKER_2"},
            {"start": 3659.7, "end": 3662.3, "speaker": "SPEAKER_3"},
        ]
        expected_labels = {
            "SPEAKER_0": "You",
            "SPEAKER_1": "__diar__You__SPEAKER_1",
            "SPEAKER_2": "__diar__You__SPEAKER_2",
            "SPEAKER_3": "You",
        }

        labels, eligible_speaker_ids = _cluster_channel_label_plan(segments, "You")

        self.assertEqual(labels, expected_labels)
        self.assertEqual(eligible_speaker_ids, {"SPEAKER_0", "SPEAKER_1", "SPEAKER_2"})
        self.assertEqual(_cluster_channel_labels(segments, "You"), expected_labels)

    def test_dominant_channel_with_11_84_second_minority_remains_collapsed(self):
        segments = [
            {"start": 0.0, "end": 180.0, "speaker": "SPEAKER_0"},
            {"start": 180.0, "end": 191.84, "speaker": "SPEAKER_1"},
        ]

        labels, _eligible_speaker_ids = _cluster_channel_label_plan(segments, "Others")

        self.assertIsNone(labels)
        self.assertIsNone(_cluster_channel_labels(segments, "Others"))

    def test_fragmented_minority_above_duration_floor_remains_collapsed(self):
        segments = [{"start": 0.0, "end": 300.0, "speaker": "SPEAKER_0"}]
        segments.extend(
            {
                "start": 300.0 + index * 0.6,
                "end": 300.6 + index * 0.6,
                "speaker": "SPEAKER_1",
            }
            for index in range(30)
        )

        labels, eligible_speaker_ids = _cluster_channel_label_plan(segments, "You")

        self.assertIsNone(labels)
        self.assertEqual(eligible_speaker_ids, set())


class ResolveSpeakerPlaceholdersTests(unittest.TestCase):
    def test_legacy_labels_are_untouched(self):
        tagged = [(0.0, "You", "hi", "mic", "SPEAKER_0"), (1.0, "Others", "hey", "system", "SPEAKER_0")]
        self.assertEqual(_resolve_speaker_placeholders(tagged), tagged)

    def test_placeholders_numbered_from_two_by_first_appearance(self):
        tagged = [
            (0.0, "You", "a", "mic", "SPEAKER_0"),
            (1.0, "__diar__You__SPEAKER_1", "b", "mic", "SPEAKER_1"),
            (2.0, "__diar__Others__SPEAKER_1", "c", "system", "SPEAKER_1"),
            (3.0, "__diar__You__SPEAKER_1", "d", "mic", "SPEAKER_1"),
        ]
        resolved = _resolve_speaker_placeholders(tagged)
        self.assertEqual(resolved[0], (0.0, "You", "a", "mic", "SPEAKER_0"))
        self.assertEqual(resolved[1], (1.0, "Speaker 2", "b", "mic", "SPEAKER_1"))
        self.assertEqual(resolved[2], (2.0, "Speaker 3", "c", "system", "SPEAKER_1"))
        # Same placeholder key reuses the same number on a later turn.
        self.assertEqual(resolved[3], (3.0, "Speaker 2", "d", "mic", "SPEAKER_1"))
        # channel/raw_sid pass through untouched -- only label is rewritten.


class ReconcileCrossChannelSpeakersTests(unittest.TestCase):
    @staticmethod
    def _cluster(embedding):
        return {
            "embedding": embedding,
            "speech_duration_seconds": 10.0,
            "segment_count": 2,
        }

    def test_merges_unambiguous_echo_pairs_but_keeps_dominant_legacy_pair(self):
        mic_clusters = {
            "SPEAKER_0": self._cluster([1.0, 0.0, 0.0]),
            "SPEAKER_1": self._cluster([0.0, 1.0, 0.0]),
            "SPEAKER_2": self._cluster([0.0, 0.0, 1.0]),
        }
        system_clusters = {
            "SPEAKER_0": self._cluster([1.0, 0.0, 0.0]),
            "SPEAKER_1": self._cluster([0.0, 0.0, 1.0]),
            "SPEAKER_2": self._cluster([0.0, 1.0, 0.0]),
        }
        tagged = [
            (0.0, "You", "the longer direct local turn", "mic", "SPEAKER_0"),
            (1.0, "Others", "echo", "system", "SPEAKER_0"),
            (2.0, "__diar__You__SPEAKER_1", "echo", "mic", "SPEAKER_1"),
            (3.0, "__diar__Others__SPEAKER_2", "the longer direct remote turn", "system", "SPEAKER_2"),
            (4.0, "__diar__You__SPEAKER_2", "small", "mic", "SPEAKER_2"),
            (5.0, "__diar__Others__SPEAKER_1", "another longer remote turn", "system", "SPEAKER_1"),
        ]

        reconciled, mic_out, system_out = _reconcile_cross_channel_speakers(
            tagged, mic_clusters, system_clusters,
        )

        self.assertEqual(
            reconciled,
            [
                (0.0, "You", "the longer direct local turn", "mic", "SPEAKER_0"),
                (1.0, "Others", "echo", "system", "SPEAKER_0"),
                (2.0, "__diar__Others__SPEAKER_2", "echo", "system", "SPEAKER_2"),
                (3.0, "__diar__Others__SPEAKER_2", "the longer direct remote turn", "system", "SPEAKER_2"),
                (4.0, "__diar__Others__SPEAKER_1", "small", "system", "SPEAKER_1"),
                (5.0, "__diar__Others__SPEAKER_1", "another longer remote turn", "system", "SPEAKER_1"),
            ],
        )
        self.assertEqual(set(mic_out), {"SPEAKER_0"})
        self.assertEqual(set(system_out), {"SPEAKER_0", "SPEAKER_1", "SPEAKER_2"})
        resolved = _resolve_speaker_placeholders(reconciled)
        self.assertEqual(
            {turn[1] for turn in resolved},
            {"You", "Others", "Speaker 2", "Speaker 3"},
        )

    def test_ambiguous_near_ties_are_not_merged(self):
        mic_clusters = {"SPEAKER_0": self._cluster([1.0, 0.0])}
        system_clusters = {
            "SPEAKER_0": self._cluster([1.0, 0.0]),
            "SPEAKER_1": self._cluster([1.0, 0.0]),
        }
        tagged = [
            (0.0, "You", "mic", "mic", "SPEAKER_0"),
            (1.0, "Others", "system a", "system", "SPEAKER_0"),
            (2.0, "__diar__Others__SPEAKER_1", "system b", "system", "SPEAKER_1"),
        ]

        result = _reconcile_cross_channel_speakers(tagged, mic_clusters, system_clusters)

        self.assertEqual(result, (tagged, mic_clusters, system_clusters))

    def test_unrelated_cross_channel_clusters_are_not_merged(self):
        mic_clusters = {"SPEAKER_0": self._cluster([1.0, 0.0])}
        system_clusters = {"SPEAKER_0": self._cluster([0.0, 1.0])}
        tagged = [
            (0.0, "You", "mic", "mic", "SPEAKER_0"),
            (1.0, "Others", "system", "system", "SPEAKER_0"),
        ]

        result = _reconcile_cross_channel_speakers(tagged, mic_clusters, system_clusters)

        self.assertEqual(result, (tagged, mic_clusters, system_clusters))

    def test_dominant_legacy_pair_is_not_merged(self):
        mic_clusters = {"SPEAKER_0": self._cluster([1.0, 0.0])}
        system_clusters = {"SPEAKER_0": self._cluster([1.0, 0.0])}
        tagged = [
            (0.0, "You", "local speaker", "mic", "SPEAKER_0"),
            (1.0, "Others", "remote speaker", "system", "SPEAKER_0"),
        ]

        result = _reconcile_cross_channel_speakers(tagged, mic_clusters, system_clusters)

        self.assertEqual(result, (tagged, mic_clusters, system_clusters))

    def test_placeholder_pair_is_not_merged_when_it_would_erase_speaker_split(self):
        mic_clusters = {"SPEAKER_0": self._cluster([1.0, 0.0])}
        system_clusters = {"SPEAKER_0": self._cluster([1.0, 0.0])}
        tagged = [
            (0.0, "__diar__You__SPEAKER_0", "first", "mic", "SPEAKER_0"),
            (1.0, "__diar__Others__SPEAKER_0", "second", "system", "SPEAKER_0"),
        ]

        result = _reconcile_cross_channel_speakers(tagged, mic_clusters, system_clusters)

        self.assertEqual(result, (tagged, mic_clusters, system_clusters))

    def test_post_bleed_text_weight_beats_folded_legacy_label(self):
        mic_clusters = {
            "SPEAKER_0": self._cluster([1.0, 0.0]),
            "SPEAKER_1": self._cluster([0.0, 1.0]),
        }
        system_clusters = {
            "SPEAKER_0": self._cluster([0.0, 1.0]),
            "SPEAKER_1": self._cluster([1.0, 0.0]),
        }
        tagged = [
            (0.0, "You", "short", "mic", "SPEAKER_0"),
            (1.0, "__diar__Others__SPEAKER_1", "a much longer echo turn", "system", "SPEAKER_1"),
            (2.0, "__diar__You__SPEAKER_1", "echo", "mic", "SPEAKER_1"),
            (3.0, "Others", "remote speaker", "system", "SPEAKER_0"),
        ]

        reconciled, mic_out, system_out = _reconcile_cross_channel_speakers(
            tagged, mic_clusters, system_clusters,
        )

        self.assertEqual(
            reconciled[0][1:],
            ("__diar__Others__SPEAKER_1", "short", "system", "SPEAKER_1"),
        )
        self.assertEqual(set(mic_out), set())
        self.assertEqual(set(system_out), {"SPEAKER_0", "SPEAKER_1"})

    def test_merge_preserves_union_of_segment_ranges(self):
        mic_clusters = {
            "SPEAKER_0": {
                **self._cluster([1.0, 0.0]),
                "segments": [{"start": 0.0, "end": 2.0}],
            },
            "SPEAKER_1": self._cluster([0.0, 1.0]),
        }
        system_clusters = {
            "SPEAKER_0": self._cluster([0.0, 1.0]),
            "SPEAKER_1": {
                **self._cluster([1.0, 0.0]),
                "segments": [{"start": 1.5, "end": 3.0}],
            },
        }
        tagged = [
            (0.0, "You", "direct local", "mic", "SPEAKER_0"),
            (1.5, "__diar__Others__SPEAKER_1", "echo", "system", "SPEAKER_1"),
            (4.0, "__diar__You__SPEAKER_1", "echo", "mic", "SPEAKER_1"),
            (5.0, "Others", "direct remote", "system", "SPEAKER_0"),
        ]

        _reconciled, mic_out, _system_out = _reconcile_cross_channel_speakers(
            tagged, mic_clusters, system_clusters,
        )

        self.assertEqual(mic_out["SPEAKER_0"]["segments"], [{"start": 0.0, "end": 3.0}])
        self.assertEqual(mic_out["SPEAKER_0"]["speech_duration_seconds"], 3.0)
        self.assertEqual(mic_out["SPEAKER_0"]["segment_count"], 4)


class AssembleDiarisedTurnsTests(unittest.TestCase):
    def test_merges_only_adjacent_segments_with_the_same_label_and_provenance(self):
        assembled = _assemble_diarised_turns([
            (1.0, "You", "first", "mic", "SPEAKER_0"),
            (2.0, "You", "second", "mic", "SPEAKER_0"),
            (3.0, "You", "unplaced", "mic", None),
            (4.0, "Speaker 2", "guest", "mic", "SPEAKER_1"),
        ])

        self.assertEqual(assembled.plain_parts, ["first second", "unplaced", "guest"])
        self.assertTrue(assembled.is_diarised)
        self.assertEqual(
            assembled.diarised_text,
            "[00:01] [You] first second\n\n[00:03] [You] unplaced\n\n[00:04] [Speaker 2] guest",
        )
        self.assertEqual(assembled.turn_manifest, [
            {"start": 1.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
            {"start": 3.0, "channel": "mic", "diarization_speaker_id": None},
            {"start": 4.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_1"},
        ])

    def test_one_visible_label_keeps_plain_text_without_diarised_metadata(self):
        assembled = _assemble_diarised_turns([
            (1.0, "You", "first", "mic", "SPEAKER_0"),
            (2.0, "You", "second", "mic", "SPEAKER_1"),
        ])

        self.assertEqual(assembled.plain_parts, ["first", "second"])
        self.assertFalse(assembled.is_diarised)
        self.assertIsNone(assembled.diarised_text)
        self.assertEqual(assembled.turn_manifest, [])


class TagChannelSegmentsTests(unittest.TestCase):
    def test_empty_asr_segments_returns_empty_without_diarizing(self):
        with patch("src.transcriber._run_steno_diarize") as mock_run:
            result = _tag_channel_segments([], Path("/fake/mic.wav"), 5.0, "You")
        mock_run.assert_not_called()
        self.assertEqual(result, [])

    def test_no_channel_path_uses_legacy_labeling(self):
        asr_segments = [{"text": "Hi.", "start": 0.0, "end": 1.0}]
        result = _tag_channel_segments(asr_segments, None, 5.0, "You")
        # No diarization at all -> no raw cluster id to record.
        self.assertEqual(result, [(0.0, "You", "Hi.", None)])

    def test_punctuation_only_asr_segment_does_not_create_a_speaker_turn(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        channel_path = Path(d.name) / "system.wav"
        channel_path.write_bytes(b"stub")

        diar_segments = [
            {"start": 0.0, "end": 4.0, "speaker": "SPEAKER_0"},
            {"start": 4.0, "end": 6.0, "speaker": "SPEAKER_1"},
        ]
        # Parakeet can return the spoken word and a silence-tail full stop as
        # one ASR segment. Speaker-boundary assignment then splits that input,
        # so filtering only the original segment is too early.
        asr_segments = [
            {
                "text": "Thanks .",
                "start": 0.2,
                "end": 5.2,
                "tokens": [
                    {"text": " Thanks", "start": 0.2, "end": 1.0},
                    {"text": ".", "start": 5.0, "end": 5.1},
                ],
            },
        ]

        with patch("src.transcriber._run_steno_diarize", return_value=(diar_segments, {})):
            result = _tag_channel_segments(asr_segments, channel_path, 6.0, "Others")

        self.assertEqual(result, [(0.0, "Others", "Thanks", "SPEAKER_0")])

    def test_single_dominant_speaker_still_populates_clusters_out(self):
        # _cluster_channel_labels returns None for a single real speaker
        # (or one that overwhelmingly dominates) -- correctly NOT a
        # diarization failure, just nothing to split in the transcript.
        # But this is the cleanest possible case for a voiceprint (one
        # continuous real voice) -- a normal 1:1 call's remote side is
        # very often exactly this shape, and previously could NEVER
        # contribute a named-speaker candidate because it never reached
        # the multi-cluster branch that populated clusters_out.
        import tempfile
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        channel_path = Path(d.name) / "system.wav"
        channel_path.write_bytes(b"stub")

        diar_segments = [
            {"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"},
            {"start": 3.0, "end": 5.0, "speaker": "SPEAKER_0"},
        ]
        embeddings = {"SPEAKER_0": [0.7, 0.1]}
        asr_segments = [
            {"text": "Hello there.", "start": 0.5, "end": 1.5},
            {"text": "Sounds good.", "start": 3.5, "end": 4.5},
        ]
        clusters_out: dict = {}
        with patch("src.transcriber._run_steno_diarize", return_value=(diar_segments, embeddings)):
            result = _tag_channel_segments(
                asr_segments, channel_path, 5.0, "Others", clusters_out=clusters_out,
            )
        # Transcript labeling is unaffected -- plain legacy label, no split.
        # This falls through to the legacy_tagged path (built from
        # asr_segments, not diar_segments), but raw_sid is now the single
        # genuinely-distinct diarizer id (SPEAKER_0) -- exactly one real
        # speaker was found, safe to record as exact provenance even
        # though the transcript itself stays unsplit (see the plan doc's
        # Phase 8: this is what lets a 1:1 call's dominant-speaker channel
        # still support exact-match relabeling).
        self.assertEqual(result, [
            (0.5, "Others", "Hello there.", "SPEAKER_0"), (3.5, "Others", "Sounds good.", "SPEAKER_0"),
        ])
        # But the sidecar-bound clusters_out now has the real embedding.
        self.assertEqual(set(clusters_out.keys()), {"SPEAKER_0"})
        self.assertEqual(clusters_out["SPEAKER_0"]["embedding"], [0.7, 0.1])

    def test_unplaceable_text_keeps_the_channel_label_and_no_raw_sid(self):
        # A sentence the diarizer left no segment anywhere near must stay in
        # the transcript, but under the channel's own label and with no raw
        # cluster id -- so it reads as "someone on this side", can never feed
        # a voiceprint, and still sorts into place chronologically.
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        channel_path = Path(d.name) / "system.wav"
        channel_path.write_bytes(b"stub")

        diar_segments = [
            {"start": 10.0, "end": 14.0, "speaker": "SPEAKER_0"},
            {"start": 14.5, "end": 18.0, "speaker": "SPEAKER_1"},
        ]
        embeddings = {"SPEAKER_0": [0.7, 0.1], "SPEAKER_1": [0.1, 0.7]}
        asr_segments = [
            # Sits in a stretch the diarizer reported nobody speaking in.
            {"text": "Orphan line.", "start": 0.5, "end": 1.5},
            {"text": "Hello there.", "start": 11.0, "end": 12.0},
            {"text": "Sounds good.", "start": 15.0, "end": 16.0},
        ]
        with patch("src.transcriber._run_steno_diarize", return_value=(diar_segments, embeddings)):
            result = _tag_channel_segments(asr_segments, channel_path, 20.0, "Others")

        self.assertEqual(result[0], (0.5, "Others", "Orphan line.", None))
        self.assertEqual([turn[0] for turn in result], sorted(turn[0] for turn in result))
        # The two placeable lines still get their exact cluster provenance.
        self.assertEqual([turn[3] for turn in result[1:]], ["SPEAKER_0", "SPEAKER_1"])

    def test_single_cluster_does_not_claim_provenance_for_a_far_away_line(self):
        # A single distinct cluster leaves no OTHER speaker to borrow, but
        # raw_sid still claims this cluster produced this line. A line far
        # outside every segment the diarizer emitted has nothing behind
        # that claim -- it may be someone the diarizer never segmented --
        # and a later rename would put a name on words that were never
        # that person's. The text still ships under the channel label.
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        channel_path = Path(d.name) / "system.wav"
        channel_path.write_bytes(b"stub")

        diar_segments = [{"start": 100.0, "end": 101.0, "speaker": "SPEAKER_0"}]
        with patch("src.transcriber._run_steno_diarize", return_value=(diar_segments, {})):
            result = _tag_channel_segments(
                [
                    {"text": "Miles away.", "start": 0.0, "end": 1.0},
                    {"text": "Right here.", "start": 100.2, "end": 100.8},
                ],
                channel_path, 120.0, "Others",
            )
        self.assertEqual(result, [
            (0.0, "Others", "Miles away.", None),
            (100.2, "Others", "Right here.", "SPEAKER_0"),
        ])

    def test_prints_progress_diarize_start_and_done_around_a_successful_run(self):
        # Processing.tsx (the renderer) drives its 'diarizing' stage/sub-label
        # entirely off these two lines -- they must bracket the call
        # regardless of which internal branch (multi-cluster, single-
        # dominant-speaker, or legacy fallback) the result takes.
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        channel_path = Path(d.name) / "mic.wav"
        channel_path.write_bytes(b"stub")

        diar_segments = [{"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"}]
        embeddings = {"SPEAKER_0": [0.7, 0.1]}
        asr_segments = [{"text": "Hello there.", "start": 0.5, "end": 1.5}]

        buf = io.StringIO()
        with patch("sys.stdout", buf), \
             patch("src.transcriber._run_steno_diarize", return_value=(diar_segments, embeddings)):
            _tag_channel_segments(asr_segments, channel_path, 5.0, "You")
        lines = [line for line in buf.getvalue().splitlines() if line.startswith("PROGRESS:diarize:")]
        self.assertEqual(lines, ["PROGRESS:diarize:You:start", "PROGRESS:diarize:You:done"])

    def test_prints_progress_diarize_done_even_when_diarization_fails(self):
        # The bracket is a try/finally around the whole call -- :done must
        # still fire on the legacy-fallback path (steno-diarize unavailable
        # or unusable), not just the success path.
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        channel_path = Path(d.name) / "mic.wav"
        channel_path.write_bytes(b"stub")
        asr_segments = [{"text": "Hello there.", "start": 0.5, "end": 1.5}]

        buf = io.StringIO()
        with patch("sys.stdout", buf), \
             patch("src.transcriber._run_steno_diarize", return_value=None):
            result = _tag_channel_segments(asr_segments, channel_path, 5.0, "You")
        lines = [line for line in buf.getvalue().splitlines() if line.startswith("PROGRESS:diarize:")]
        self.assertEqual(lines, ["PROGRESS:diarize:You:start", "PROGRESS:diarize:You:done"])
        self.assertEqual(result, [(0.5, "You", "Hello there.", None)])

    def test_progress_sink_passed_to_run_steno_diarize_emits_embedding_lines(self):
        # _run_steno_diarize's progress_sink is exactly the closure that
        # turns real Swift-side chunk progress into PROGRESS:diarize:
        # {label}:embedding:i/n on Python's own stdout -- verify the
        # closure _tag_channel_segments builds actually does that, since
        # RunStenoDiarizeTests only proves the sink gets CALLED correctly,
        # not what this call site's specific sink does with it.
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        channel_path = Path(d.name) / "mic.wav"
        channel_path.write_bytes(b"stub")
        asr_segments = [{"text": "Hello there.", "start": 0.5, "end": 1.5}]
        diar_segments = [{"start": 0.0, "end": 2.0, "speaker": "SPEAKER_0"}]
        embeddings = {"SPEAKER_0": [0.7, 0.1]}

        def _fake_run_steno_diarize(channel_path, timeout, progress_sink=None):
            if progress_sink:
                progress_sink(1, 2)
                progress_sink(2, 2)
            return diar_segments, embeddings

        buf = io.StringIO()
        with patch("sys.stdout", buf), \
             patch("src.transcriber._run_steno_diarize", side_effect=_fake_run_steno_diarize):
            _tag_channel_segments(asr_segments, channel_path, 5.0, "You")
        lines = [line for line in buf.getvalue().splitlines() if line.startswith("PROGRESS:diarize:")]
        self.assertEqual(
            lines,
            [
                "PROGRESS:diarize:You:start",
                "PROGRESS:diarize:You:embedding:1/2",
                "PROGRESS:diarize:You:embedding:2/2",
                "PROGRESS:diarize:You:done",
            ],
        )


class HeartbeatWhileWaitingTests(unittest.TestCase):
    """A real ~3.5h recording measured steno-diarize taking longer than
    Electron's 8-minute inactivity watchdog, which killed a healthy process
    mid-run because nothing was printed to stdout while it waited (unlike
    Parakeet/Whisper's chunk-progress heartbeat, steno-diarize is an opaque
    external binary with no per-chunk checkpoint). This is the fix: a
    background thread prints HEARTBEAT: lines for the duration of the
    wrapped call, regardless of how long it blocks."""

    def test_prints_heartbeat_lines_while_waiting(self):
        import io
        from src.transcriber import _heartbeat_while_waiting

        # Waits for the beats instead of sleeping a fixed 0.09s and hoping
        # four 0.02s ticks fit inside it. On a loaded CI runner they did
        # not, and the job failed on timing rather than on behaviour -- seen
        # on this branch, green on the same commit locally. The wait exits
        # as soon as the second beat lands, so the fast path stays fast.
        buf = io.StringIO()
        deadline = time.monotonic() + 5.0
        with patch("sys.stdout", buf):
            with _heartbeat_while_waiting("diarize:You", interval_s=0.02):
                while time.monotonic() < deadline:
                    if buf.getvalue().count("HEARTBEAT:diarize:You") >= 2:
                        break
                    time.sleep(0.01)
        lines = [line for line in buf.getvalue().splitlines() if line == "HEARTBEAT:diarize:You"]
        self.assertGreaterEqual(len(lines), 2)

    def test_background_thread_stops_when_context_exits(self):
        from src.transcriber import _heartbeat_while_waiting

        with _heartbeat_while_waiting("diarize:You", interval_s=0.02) as _:
            threads_during = threading.active_count()
        time.sleep(0.05)
        self.assertLess(threading.active_count(), threads_during)

    def test_does_not_swallow_exceptions_from_wrapped_block(self):
        from src.transcriber import _heartbeat_while_waiting

        with self.assertRaises(ValueError):
            with _heartbeat_while_waiting("diarize:You", interval_s=10.0):
                raise ValueError("real failure")

    def test_return_value_of_wrapped_call_is_unaffected(self):
        from src.transcriber import _heartbeat_while_waiting

        with _heartbeat_while_waiting("diarize:You", interval_s=10.0):
            result = {"ok": True}
        self.assertEqual(result, {"ok": True})


class VoiceprintDistanceTests(unittest.TestCase):
    """_voiceprint_distance takes the minimum distance over BOTH a stored
    voiceprint's long-term centroid and its recent-samples FIFO (either
    anchor can rescue a borderline match) — port of SpeakerMatcher.distance."""

    def test_distance_to_centroid_only(self):
        vp = {"centroid": [1.0, 0.0], "embeddings": []}
        self.assertAlmostEqual(_voiceprint_distance([1.0, 0.0], vp), 0.0, places=6)
        self.assertAlmostEqual(_voiceprint_distance([0.0, 1.0], vp), 1.0, places=6)

    def test_takes_minimum_over_recent_samples_and_centroid(self):
        # Centroid is far (orthogonal); one recent sample is an exact match.
        vp = {"centroid": [0.0, 1.0], "embeddings": [[5.0, 0.0], [1.0, 0.0]]}
        self.assertAlmostEqual(_voiceprint_distance([1.0, 0.0], vp), 0.0, places=6)

    def test_no_anchors_returns_infinity(self):
        vp = {"centroid": None, "embeddings": []}
        self.assertEqual(_voiceprint_distance([1.0, 0.0], vp), float("inf"))


class ApplyVoiceprintMatchesTests(unittest.TestCase):
    """_apply_voiceprint_matches must never raise or fail a meeting — any
    problem (no embeddings, no self voiceprint stored) leaves cluster_labels
    exactly as _cluster_channel_labels produced them.

    NAMED (non-self) matching used to be covered here too, but that path
    was removed — validating it against real ground truth (AMI Meeting
    Corpus) found same-room speakers score artificially similar to each
    other, so silent automatic named matching isn't safe. Named
    identification is now a human-confirmed suggestion via
    src.speaker_suggestions (see the plan doc), not an automatic relabel."""

    def setUp(self):
        self.cluster_labels = {
            "SPEAKER_0": "You",
            "SPEAKER_1": "__diar__You__SPEAKER_1",
        }

    def test_self_match_relabels_and_demotes_previous_you(self):
        # The device owner talked less than a guest on the mic channel —
        # self-match must re-anchor "You" onto the correct cluster and
        # demote the dominant-by-duration cluster back to a placeholder.
        speaker_embeddings = {
            "SPEAKER_0": [1.0, 0.0],  # guest, currently "You"
            "SPEAKER_1": [0.0, 1.0],  # actually the device owner
        }
        voiceprints = [
            {"name": "ignored", "centroid": [0.0, 1.0], "embeddings": [], "is_self": True},
        ]
        with patch("src.config.get_config") as mock_get_config:
            mock_get_config.return_value.get_voiceprints.return_value = voiceprints
            result = _apply_voiceprint_matches(
                speaker_embeddings, self.cluster_labels, "You", allow_self_match=True,
            )
        self.assertEqual(result["SPEAKER_1"], "You")
        self.assertEqual(result["SPEAKER_0"], "__diar__You__SPEAKER_0")

    def test_self_match_reanchors_sustained_minority_without_promoting_folded_blip(self):
        # SPEAKER_3 is a short folded blip with the closest owner embedding.
        # It must be excluded from matching, so SPEAKER_1 becomes "You" and
        # the blip stays attached to SPEAKER_0's replacement placeholder,
        # even though the blip appears first in the label mapping.
        cluster_labels = {
            "SPEAKER_3": "You",
            "SPEAKER_0": "You",
            "SPEAKER_1": "__diar__You__SPEAKER_1",
            "SPEAKER_2": "__diar__You__SPEAKER_2",
        }
        speaker_embeddings = {
            "SPEAKER_3": [0.0, 1.0],
            "SPEAKER_0": [1.0, 0.0],
            "SPEAKER_1": [0.1, 0.995],
            "SPEAKER_2": [-1.0, 0.0],
        }
        voiceprints = [
            {"name": "ignored", "centroid": [0.0, 1.0], "embeddings": [], "is_self": True},
        ]
        with patch("src.config.get_config") as mock_get_config:
            mock_get_config.return_value.get_voiceprints.return_value = voiceprints
            result = _apply_voiceprint_matches(
                speaker_embeddings,
                cluster_labels,
                "You",
                allow_self_match=True,
                eligible_speaker_ids={"SPEAKER_0", "SPEAKER_1", "SPEAKER_2"},
            )

        self.assertEqual(result["SPEAKER_1"], "You")
        self.assertEqual(result["SPEAKER_0"], "__diar__You__SPEAKER_0")
        self.assertEqual(result["SPEAKER_2"], "__diar__You__SPEAKER_2")
        self.assertEqual(result["SPEAKER_3"], "__diar__You__SPEAKER_0")

    def test_self_match_on_dominant_keeps_folded_blip_folded(self):
        # A sustained minority keeps the channel split, while SPEAKER_2 is
        # a short blip folded into SPEAKER_0. A self match already on that
        # dominant cluster must leave both of their labels untouched.
        segments = [
            {"start": 0.0, "end": 300.0, "speaker": "SPEAKER_0"},
            {"start": 300.0, "end": 320.0, "speaker": "SPEAKER_1"},
            {"start": 320.0, "end": 322.0, "speaker": "SPEAKER_2"},
        ]
        cluster_labels, eligible_speaker_ids = _cluster_channel_label_plan(segments, "You")
        expected_labels = {
            "SPEAKER_0": "You",
            "SPEAKER_1": "__diar__You__SPEAKER_1",
            "SPEAKER_2": "You",
        }
        speaker_embeddings = {
            "SPEAKER_0": [0.0, 1.0],
            "SPEAKER_1": [1.0, 0.0],
            "SPEAKER_2": [0.0, 1.0],
        }
        voiceprints = [
            {"name": "ignored", "centroid": [0.0, 1.0], "embeddings": [], "is_self": True},
        ]
        with patch("src.config.get_config") as mock_get_config:
            mock_get_config.return_value.get_voiceprints.return_value = voiceprints
            result = _apply_voiceprint_matches(
                speaker_embeddings,
                cluster_labels,
                "You",
                allow_self_match=True,
                eligible_speaker_ids=eligible_speaker_ids,
            )

        self.assertEqual(cluster_labels, expected_labels)
        self.assertEqual(result, expected_labels)

    def test_self_match_ignored_when_not_allowed(self):
        # System-audio channel (allow_self_match=False): matching is skipped
        # entirely — config isn't even loaded, since there's nothing left
        # for this function to do without self-match (named matching moved
        # to src.speaker_suggestions).
        speaker_embeddings = {
            "SPEAKER_0": [1.0, 0.0],
            "SPEAKER_1": [0.0, 1.0],
        }
        with patch("src.config.get_config") as mock_get_config:
            result = _apply_voiceprint_matches(
                speaker_embeddings, self.cluster_labels, "Others", allow_self_match=False,
            )
        mock_get_config.assert_not_called()
        self.assertEqual(result, self.cluster_labels)

    def test_no_self_match_above_threshold_leaves_labels_unchanged(self):
        speaker_embeddings = {
            "SPEAKER_0": [1.0, 0.0],
            "SPEAKER_1": [0.0, 1.0],
        }
        # Orthogonal to both cluster embeddings -> distance 1.0, well above
        # VOICEPRINT_DISTANCE_THRESHOLD, so no self-match is found.
        voiceprints = [{"name": "ignored", "centroid": [-1.0, 0.0], "embeddings": [], "is_self": True}]
        with patch("src.config.get_config") as mock_get_config:
            mock_get_config.return_value.get_voiceprints.return_value = voiceprints
            result = _apply_voiceprint_matches(
                speaker_embeddings, self.cluster_labels, "You", allow_self_match=True,
            )
        self.assertEqual(result, self.cluster_labels)

    def test_no_embeddings_skips_config_entirely(self):
        with patch("src.config.get_config") as mock_get_config:
            result = _apply_voiceprint_matches(
                {}, self.cluster_labels, "You", allow_self_match=True,
            )
        mock_get_config.assert_not_called()
        self.assertEqual(result, self.cluster_labels)

    def test_no_stored_voiceprints_leaves_labels_unchanged(self):
        speaker_embeddings = {
            "SPEAKER_0": [1.0, 0.0],
            "SPEAKER_1": [0.0, 1.0],
        }
        with patch("src.config.get_config") as mock_get_config:
            mock_get_config.return_value.get_voiceprints.return_value = []
            result = _apply_voiceprint_matches(
                speaker_embeddings, self.cluster_labels, "You", allow_self_match=True,
            )
        self.assertEqual(result, self.cluster_labels)

    def test_malformed_self_voiceprint_never_aborts_a_meeting(self):
        speaker_embeddings = {
            "SPEAKER_0": [1.0, 0.0],
            "SPEAKER_1": [0.0, 1.0],
        }
        voiceprints = [
            {
                "name": "damaged",
                "centroid": [1.0],
                "embeddings": [["not-a-number", 0.0]],
                "is_self": True,
            },
        ]
        with patch("src.config.get_config") as mock_get_config:
            mock_get_config.return_value.get_voiceprints.return_value = voiceprints
            result = _apply_voiceprint_matches(
                speaker_embeddings, self.cluster_labels, "You", allow_self_match=True,
            )
        self.assertEqual(result, self.cluster_labels)


class _FakePopen:
    """Stand-in for subprocess.Popen, matching only the surface
    _run_steno_diarize actually uses: .stdout/.stderr as readable byte
    streams (plain io.BytesIO works fine -- the two reader threads each
    only ever touch their own stream, so there's no real cross-thread
    contention to simulate), .wait(timeout=...), .kill(), .returncode.
    """

    def __init__(self, stdout=b"", stderr=b"", returncode=0, raise_timeout_once=False):
        self.stdout = io.BytesIO(stdout)
        self.stderr = io.BytesIO(stderr)
        self._final_returncode = returncode
        self._raise_timeout_once = raise_timeout_once
        self.returncode = None
        self.killed = False
        self.pid = 12345

    def wait(self, timeout=None):
        if self._raise_timeout_once and timeout is not None:
            self._raise_timeout_once = False
            raise subprocess.TimeoutExpired(cmd="steno-diarize", timeout=timeout)
        self.returncode = self._final_returncode
        return self.returncode

    def kill(self):
        self.killed = True


def _patch_popen(**kwargs):
    return patch("subprocess.Popen", return_value=_FakePopen(**kwargs))


def _sidecar_embedding(first: float, second: float) -> list[float]:
    return [first, second] + [0.0] * 254


class RunStenoDiarizeTests(unittest.TestCase):
    """_run_steno_diarize must survive the sidecar's real quirks: a
    diagnostic warning printed to stdout ahead of the JSON payload, and any
    kind of failure (missing binary, timeout, bad exit, bad JSON)."""

    def test_returns_none_when_binary_unresolved(self):
        with patch("src.transcriber._resolve_steno_diarize", return_value=None):
            self.assertIsNone(_run_steno_diarize(Path("/fake/mic.wav"), 60))

    def test_windows_taskkill_failure_falls_back_to_parent_kill(self):
        proc = _FakePopen()
        with patch("src.transcriber.sys.platform", "win32"), \
             patch("src.transcriber.subprocess.run", return_value=Mock(returncode=1)):
            _terminate_process_tree(proc)
        self.assertTrue(proc.killed)

    def test_parses_json_with_e5rt_warning_prefix_on_stdout(self):
        payload = json.dumps({
            "segments": [
                {"speakerId": "SPEAKER_1", "start": 1.0, "end": 2.0},
                {"speakerId": "SPEAKER_0", "start": 0.0, "end": 0.9},
            ],
            "speakers": {
                "SPEAKER_0": _sidecar_embedding(0.1, 0.2),
                "SPEAKER_1": _sidecar_embedding(0.3, 0.4),
            },
        }).encode()
        stdout = b"E5RT encountered an STL exception. msg = unordered_map::at: key not found." + payload
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=stdout, stderr=b"", returncode=0):
            result = _run_steno_diarize(Path("/fake/mic.wav"), 60)
        segments, embeddings = result
        self.assertEqual(
            segments,
            [
                {"start": 0.0, "end": 0.9, "speaker": "SPEAKER_0"},
                {"start": 1.0, "end": 2.0, "speaker": "SPEAKER_1"},
            ],
        )
        self.assertEqual(embeddings, {
            "SPEAKER_0": _sidecar_embedding(0.1, 0.2),
            "SPEAKER_1": _sidecar_embedding(0.3, 0.4),
        })

    def test_cross_speaker_overlap_is_clamped_before_the_result_is_returned(self):
        # Sortformer really does emit overlapping segments on single-mic
        # audio. Returned as-is, the overlapped span counts toward BOTH
        # clusters' speaking time, and that total is what decides whether
        # a channel is treated as one voice or split into "Speaker N".
        payload = json.dumps({
            "segments": [
                {"speakerId": "SPEAKER_0", "start": 0.0, "end": 5.0},
                {"speakerId": "SPEAKER_1", "start": 3.0, "end": 8.0},
            ],
            "speakers": {},
        }).encode()
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=payload, stderr=b"", returncode=0):
            segments, _ = _run_steno_diarize(Path("/fake/mic.wav"), 60)
        self.assertEqual(segments, [
            {"start": 0.0, "end": 5.0, "speaker": "SPEAKER_0"},
            {"start": 5.0, "end": 8.0, "speaker": "SPEAKER_1"},
        ])

    def test_same_speaker_overlap_collapses_into_one_turn(self):
        # Same-speaker overlap is diarizer flicker, not two voices -- it
        # must merge into one turn rather than be clamped into two
        # touching ones.
        payload = json.dumps({
            "segments": [
                {"speakerId": "SPEAKER_0", "start": 0.0, "end": 5.0},
                {"speakerId": "SPEAKER_0", "start": 3.0, "end": 8.0},
            ],
            "speakers": {},
        }).encode()
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=payload, stderr=b"", returncode=0):
            segments, _ = _run_steno_diarize(Path("/fake/mic.wav"), 60)
        self.assertEqual(segments, [{"start": 0.0, "end": 8.0, "speaker": "SPEAKER_0"}])

    def test_parses_json_with_trailing_warning_after_payload(self):
        # A real ~3.5h channel measured a late CoreML/Metal warning printed
        # to stdout AFTER the JSON payload (at teardown) -- json.loads()
        # requires the entire remaining string to be clean JSON and raises
        # "Extra data" on trailing text, discarding an otherwise-successful
        # 18-minute diarization result. raw_decode() must tolerate this.
        payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_0", "start": 0.0, "end": 0.9}],
            "speakers": {"SPEAKER_0": _sidecar_embedding(0.1, 0.2)},
        }).encode()
        stdout = payload + b"\nMetal warning: some late teardown message"
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=stdout, stderr=b"", returncode=0):
            result = _run_steno_diarize(Path("/fake/mic.wav"), 60)
        segments, embeddings = result
        self.assertEqual(segments, [{"start": 0.0, "end": 0.9, "speaker": "SPEAKER_0"}])
        self.assertEqual(embeddings, {"SPEAKER_0": _sidecar_embedding(0.1, 0.2)})

    def test_skips_an_interstitial_json_blob_that_is_not_the_real_payload(self):
        # A real ~18-minute diarization run measured a non-payload JSON-
        # shaped blob (e.g. a status/progress object with no "segments"
        # key) printed BEFORE the real payload -- the version of this
        # function that only ever looked at the first '{' in stdout picked
        # that one and raised KeyError('segments'), discarding an
        # otherwise-successful result. Must skip anything that isn't a
        # dict with a "segments" key and keep scanning for the real one.
        real_payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_0", "start": 0.0, "end": 0.9}],
            "speakers": {"SPEAKER_0": _sidecar_embedding(0.1, 0.2)},
        }).encode()
        stdout = b'{"status": "starting"}\n' + real_payload
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=stdout, stderr=b"", returncode=0):
            result = _run_steno_diarize(Path("/fake/mic.wav"), 60)
        segments, embeddings = result
        self.assertEqual(segments, [{"start": 0.0, "end": 0.9, "speaker": "SPEAKER_0"}])
        self.assertEqual(embeddings, {"SPEAKER_0": _sidecar_embedding(0.1, 0.2)})

    def test_prefers_the_last_matching_payload_when_multiple_exist(self):
        # If more than one JSON blob in stdout DOES have a "segments" key
        # (shouldn't normally happen, but the scan must have a defined,
        # sane tie-break rather than an arbitrary one) -- the real payload
        # is written once, at the end, when diarization actually finishes,
        # so prefer the LAST match.
        first_payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_0", "start": 0.0, "end": 0.9}],
            "speakers": {"SPEAKER_0": _sidecar_embedding(0.1, 0.2)},
        }).encode()
        second_payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_1", "start": 5.0, "end": 6.0}],
            "speakers": {"SPEAKER_1": _sidecar_embedding(0.9, 0.9)},
        }).encode()
        stdout = first_payload + b"\n" + second_payload
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=stdout, stderr=b"", returncode=0):
            result = _run_steno_diarize(Path("/fake/mic.wav"), 60)
        segments, embeddings = result
        self.assertEqual(segments, [{"start": 5.0, "end": 6.0, "speaker": "SPEAKER_1"}])
        self.assertEqual(embeddings, {"SPEAKER_1": _sidecar_embedding(0.9, 0.9)})

    def test_falls_back_to_bare_segments_array_when_no_output_object_exists(self):
        # Traced against a REAL ~3.5h recording via a direct, wrapper-free
        # capture of steno-diarize's raw stdout: on a run this large,
        # embedding extraction can hit an internal FluidAudio/CoreML
        # failure that skips main.swift's normal Output-struct print
        # entirely, leaving only the E5RT warning immediately followed by
        # a BARE JSON ARRAY of the raw segments -- no "segments"/"speakers"
        # wrapper at all. The segments themselves are still real,
        # load-bearing diarization data (main.swift's own comment: they're
        # the load-bearing output, embeddings are best-effort) and must
        # not be discarded just because the wrapper never appeared.
        stdout = (
            b"E5RT encountered an STL exception. msg = unordered_map::at: key not found."
            b'[{"speakerId":"SPEAKER_0","end":1.5999999046325684,"start":0.5600000023841858},'
            b'{"speakerId":"SPEAKER_1","end":11.4399995803833,"start":10.880000114440918}]'
        )
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/mic-real.wav"), \
             _patch_popen(stdout=stdout, stderr=b"", returncode=0):
            result = _run_steno_diarize(Path("/fake/mic-real.wav"), 13131)
        segments, embeddings = result
        self.assertEqual(
            segments,
            [
                {"start": 0.5600000023841858, "end": 1.5999999046325684, "speaker": "SPEAKER_0"},
                {"start": 10.880000114440918, "end": 11.4399995803833, "speaker": "SPEAKER_1"},
            ],
        )
        # Degraded result: real diarization, no voiceprint/embedding data.
        self.assertEqual(embeddings, {})

    def test_object_payload_is_preferred_over_a_bare_array_when_both_exist(self):
        # A proper Output-struct object (with real embeddings) must win
        # over a degraded bare-array fallback, regardless of which one
        # appears first in stdout -- the object is strictly more complete.
        bare_array = b'[{"speakerId":"SPEAKER_0","start":0.0,"end":1.0}]'
        object_payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_1", "start": 5.0, "end": 6.0}],
            "speakers": {"SPEAKER_1": _sidecar_embedding(0.9, 0.9)},
        }).encode()
        stdout = bare_array + b"\n" + object_payload
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/mic.wav"), \
             _patch_popen(stdout=stdout, stderr=b"", returncode=0):
            result = _run_steno_diarize(Path("/fake/mic.wav"), 60)
        segments, embeddings = result
        self.assertEqual(segments, [{"start": 5.0, "end": 6.0, "speaker": "SPEAKER_1"}])
        self.assertEqual(embeddings, {"SPEAKER_1": _sidecar_embedding(0.9, 0.9)})

    def test_missing_speakers_key_returns_empty_embeddings(self):
        payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_0", "start": 0.0, "end": 0.9}],
        }).encode()
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=payload, stderr=b"", returncode=0):
            segments, embeddings = _run_steno_diarize(Path("/fake/mic.wav"), 60)
        self.assertEqual(segments, [{"start": 0.0, "end": 0.9, "speaker": "SPEAKER_0"}])
        self.assertEqual(embeddings, {})

    def test_invalid_segment_shape_falls_back_instead_of_raising(self):
        payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_0", "start": "bad", "end": 0.9}],
            "speakers": {},
        }).encode()
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=payload, stderr=b"", returncode=0):
            self.assertIsNone(_run_steno_diarize(Path("/fake/mic.wav"), 60))

    def test_invalid_embedding_shape_falls_back_instead_of_raising(self):
        payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_0", "start": 0.0, "end": 0.9}],
            "speakers": {"SPEAKER_0": "not-a-vector"},
        }).encode()
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=payload, stderr=b"", returncode=0):
            self.assertIsNone(_run_steno_diarize(Path("/fake/mic.wav"), 60))

    def test_wrong_embedding_dimension_falls_back_instead_of_persisting_it(self):
        payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_0", "start": 0.0, "end": 0.9}],
            "speakers": {"SPEAKER_0": [0.1, 0.2]},
        }).encode()
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=payload, stderr=b"", returncode=0):
            self.assertIsNone(_run_steno_diarize(Path("/fake/mic.wav"), 60))

    def test_nonzero_exit_returns_none(self):
        fake = _FakePopen(stdout=b"", stderr=b"boom", returncode=1)
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             patch("subprocess.Popen", return_value=fake):
            self.assertIsNone(_run_steno_diarize(Path("/fake/mic.wav"), 60))
        self.assertTrue(fake.stdout.closed)
        self.assertTrue(fake.stderr.closed)

    def test_unparseable_json_returns_none(self):
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=b"{not json", stderr=b"", returncode=0):
            self.assertIsNone(_run_steno_diarize(Path("/fake/mic.wav"), 60))

    def test_no_brace_in_stdout_returns_none(self):
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=b"nothing useful", stderr=b"", returncode=0):
            self.assertIsNone(_run_steno_diarize(Path("/fake/mic.wav"), 60))

    def test_timeout_returns_none(self):
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             patch("src.transcriber._terminate_process_tree") as terminate, \
             _patch_popen(stdout=b"", stderr=b"", returncode=0, raise_timeout_once=True):
            self.assertIsNone(_run_steno_diarize(Path("/fake/mic.wav"), 60))
        terminate.assert_called_once()

    def test_sidecar_starts_in_its_own_process_group(self):
        payload = json.dumps({"segments": [], "speakers": {}}).encode()
        fake = _FakePopen(stdout=payload)
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             patch("subprocess.Popen", return_value=fake) as popen:
            self.assertIsNotNone(_run_steno_diarize(Path("/fake/mic.wav"), 60))

        kwargs = popen.call_args.kwargs
        if sys.platform == "win32":
            self.assertEqual(kwargs["creationflags"], subprocess.CREATE_NEW_PROCESS_GROUP)
            self.assertNotIn("start_new_session", kwargs)
        else:
            self.assertIs(kwargs["start_new_session"], True)
            self.assertNotIn("creationflags", kwargs)

    def test_progress_sink_called_with_parsed_embedding_progress(self):
        payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_0", "start": 0.0, "end": 0.9}],
            "speakers": {"SPEAKER_0": _sidecar_embedding(0.1, 0.2)},
        }).encode()
        stderr = b"PROGRESS:embedding:1/3\nPROGRESS:embedding:2/3\nPROGRESS:embedding:3/3\n"
        calls = []
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=payload, stderr=stderr, returncode=0):
            result = _run_steno_diarize(Path("/fake/mic.wav"), 60, progress_sink=lambda i, n: calls.append((i, n)))
        self.assertIsNotNone(result)
        self.assertEqual(calls, [(1, 3), (2, 3), (3, 3)])

    def test_progress_sink_not_required_and_unmatched_stderr_lines_ignored(self):
        payload = json.dumps({
            "segments": [{"speakerId": "SPEAKER_0", "start": 0.0, "end": 0.9}],
            "speakers": {"SPEAKER_0": _sidecar_embedding(0.1, 0.2)},
        }).encode()
        stderr = b"some unrelated diagnostic line\nsteno-diarize: 1 chunk(s) failed embedding extraction\n"
        with patch("src.transcriber._resolve_steno_diarize", return_value="/fake/steno-diarize"), \
             _patch_popen(stdout=payload, stderr=stderr, returncode=0):
            # No progress_sink passed at all -- must not raise.
            result = _run_steno_diarize(Path("/fake/mic.wav"), 60)
        self.assertIsNotNone(result)


if __name__ == '__main__':
    unittest.main()
