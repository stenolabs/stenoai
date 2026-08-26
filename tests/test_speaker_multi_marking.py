"""The "this cluster holds more than one person" marking, and the
multi-excerpt review samples built alongside it.

Both exist for the same reason: a diarized cluster that quietly contains
two people is invisible in every number the system produces. Measured
against a real three-person call, the contaminated cluster sat at cosine
distance 0.8270 from the person who contaminated it -- an ordinary
cross-speaker distance, nowhere near any threshold. So the marking cannot
be derived and has to be witnessed, and the samples are what let a human
witness it (hearing two voices under one row).

The tests that matter most here are the ones asserting what a marked
cluster must NOT do, because those are the failure modes that are silent:
a mixed cluster enrolled as a person poisons that profile for every future
meeting, and nothing in the wrong suggestion months later points back at
this cluster.
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

import simple_recorder
from src.config import Config
from src.speaker_suggestions import (
    MULTI_SPEAKER_KEY,
    REVIEW_STATE_GENERIC,
    REVIEW_STATE_KEY,
    extract_sample_text,
    ClusterContext,
    clusters_from_sidecar_channel,
    extract_segment_samples,
    merge_same_channel_fragments,
    minimum_speaker_count,
    read_speakers_sidecar,
    sample_segments,
    set_cluster_multi_speaker,
    set_cluster_review_state,
    suggest_speaker,
    suggest_speakers_for_meeting,
    write_speakers_sidecar,
)


def _last_json(output):
    line = [ln for ln in output.splitlines() if ln.strip().startswith("{")][-1]
    return json.loads(line)


def _profile(person_id, name, embedding, recording_type="remote", meetings=("m1", "m2")):
    """A person with enough independent evidence to clear every gate, so a
    test asserting "no suggestion" is asserting the marking's effect and
    not some unrelated threshold quietly doing the work."""
    return {
        "person_id": person_id,
        "display_name": name,
        "prototypes": [
            {"embedding_mean": embedding, "recording_type": recording_type, "meeting_id": m}
            for m in meetings
        ],
        "hard_negatives": [],
    }


def _context(sid="SPEAKER_0", **kwargs):
    base = dict(
        meeting_id="mtg001", diarization_speaker_id=sid, recording_type="remote",
        speech_duration_seconds=120.0, segment_count=20,
    )
    base.update(kwargs)
    return ClusterContext(**base)


class MarkingPersistenceTests(unittest.TestCase):
    def _seed(self, tmp, clusters=None):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, "mtg001", {
            "system": {
                "recording_type": "remote",
                "clusters": clusters or {
                    "SPEAKER_0": {
                        "embedding": [1.0, 0.0], "speech_duration_seconds": 60.0,
                        "segment_count": 10, "segments": [{"start": 1.0, "end": 5.0}],
                    },
                },
            },
        }, turn_manifest=[{"start": 1.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"}])
        return output_dir

    def test_marking_round_trips_and_clears(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_0", True)
            sidecar = read_speakers_sidecar(output_dir, "mtg001")
            self.assertTrue(
                sidecar["channels"]["system"]["clusters"]["SPEAKER_0"][MULTI_SPEAKER_KEY]
            )

            set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_0", False)
            sidecar = read_speakers_sidecar(output_dir, "mtg001")
            # Cleared by REMOVING the key, not by writing false -- absent and
            # "not marked" must read identically, or every sidecar written
            # before this feature existed would need a migration.
            self.assertNotIn(
                MULTI_SPEAKER_KEY, sidecar["channels"]["system"]["clusters"]["SPEAKER_0"],
            )

    def test_marking_preserves_embeddings_and_turn_manifest(self):
        # The sidecar carries the only copy of this meeting's voice
        # embeddings; once the source audio is gone they cannot be
        # recomputed. A marking write that dropped them would destroy data
        # silently, so assert the whole payload survives, not just the flag.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            before = read_speakers_sidecar(output_dir, "mtg001")
            set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_0", True)
            after = read_speakers_sidecar(output_dir, "mtg001")

            cluster_after = after["channels"]["system"]["clusters"]["SPEAKER_0"]
            self.assertEqual(cluster_after["embedding"], [1.0, 0.0])
            self.assertEqual(cluster_after["segments"], [{"start": 1.0, "end": 5.0}])
            self.assertEqual(after["transcript_lines"], before["transcript_lines"])
            self.assertEqual(after["created_at"], before["created_at"])

    def test_a_mark_landing_between_read_and_write_is_not_erased(self):
        # From the review: the write is atomic, the read-modify-write is
        # not. Two marks that overlap both start from the same sidecar, and
        # the one that replaces the file second silently discards the
        # other's marking -- along with whatever confirmation cleanup its
        # caller already performed against it.
        #
        # Interleaved deterministically rather than with threads: a
        # COMPLETE second marking lands after the first has read and before
        # it writes, which is exactly the order that loses data.
        import src.speaker_suggestions as ss

        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp, clusters={
                "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 60.0,
                              "segment_count": 10, "segments": []},
                "SPEAKER_1": {"embedding": [0.0, 1.0], "speech_duration_seconds": 40.0,
                              "segment_count": 8, "segments": []},
            })
            real_read = ss.read_speakers_sidecar
            interleaved = {"done": False}

            def read_then_let_someone_else_write(*args, **kwargs):
                data = real_read(*args, **kwargs)
                if not interleaved["done"]:
                    interleaved["done"] = True
                    ss.set_cluster_multi_speaker(
                        output_dir, "mtg001", "system", "SPEAKER_1", True,
                    )
                return data

            with mock.patch.object(
                ss, "read_speakers_sidecar", side_effect=read_then_let_someone_else_write,
            ):
                ss.set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_0", True)

            clusters = read_speakers_sidecar(output_dir, "mtg001")["channels"]["system"]["clusters"]
            self.assertTrue(clusters["SPEAKER_0"].get(MULTI_SPEAKER_KEY))
            self.assertTrue(
                clusters["SPEAKER_1"].get(MULTI_SPEAKER_KEY),
                "the marking that landed in between must survive",
            )

    def test_unknown_cluster_channel_or_meeting_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            self.assertIsNone(
                set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_9", True)
            )
            self.assertIsNone(
                set_cluster_multi_speaker(output_dir, "mtg001", "mic", "SPEAKER_0", True)
            )
            self.assertIsNone(
                set_cluster_multi_speaker(output_dir, "nope", "system", "SPEAKER_0", True)
            )


class MarkedClusterIsWithheldTests(unittest.TestCase):
    def test_marked_cluster_gets_no_suggestion_despite_an_exact_match(self):
        # The embedding is IDENTICAL to the profile's, so without the
        # marking this is an unambiguous "confirmed". Anything short of
        # status "none" here means the guard is not doing its job.
        profiles = [_profile("p1", "Person Alpha", [1.0, 0.0])]
        unmarked = suggest_speaker([1.0, 0.0], _context(), profiles)
        self.assertEqual(unmarked.status, "confirmed")

        marked = suggest_speaker(
            [1.0, 0.0], _context(contains_multiple_speakers=True), profiles,
        )
        self.assertEqual(marked.status, "none")
        self.assertIsNone(marked.suggested_person_id)
        # No candidates either: a ranking computed from a centroid blended
        # across two people is not a weak guess about one person, it is a
        # confident guess about a voice that does not exist. Offering it in
        # a "Change" picker would invite exactly the wrong confirmation.
        self.assertEqual(marked.candidates, [])

    def test_marked_cluster_does_not_consume_the_person_it_resembles(self):
        # Meeting-wide exclusivity means a "confirmed" cluster takes that
        # person off the table for every other cluster. A mixed cluster
        # must not be able to do that -- otherwise marking a contaminated
        # cluster would COST the real cluster its correct suggestion,
        # punishing the user for telling the truth.
        profiles = [_profile("p1", "Person Alpha", [1.0, 0.0])]
        results = suggest_speakers_for_meeting({
            "system": {
                "SPEAKER_0": (
                    [1.0, 0.0], _context("SPEAKER_0", contains_multiple_speakers=True),
                ),
                "SPEAKER_1": ([0.999, 0.045], _context("SPEAKER_1")),
            },
        }, profiles)

        self.assertEqual(results["system"]["SPEAKER_0"].status, "none")
        self.assertEqual(results["system"]["SPEAKER_1"].status, "confirmed")
        self.assertEqual(results["system"]["SPEAKER_1"].suggested_person_id, "p1")

    def test_marking_survives_a_fragment_merge(self):
        # Contamination is a property of the audio, so folding a mixed
        # fragment into a clean one yields a mixed cluster. The merged
        # entry is what the panel and confirm-speaker actually operate on,
        # so a marking that did not propagate would be silently ignored.
        clusters = {
            "SPEAKER_0": ([1.0, 0.0], _context("SPEAKER_0", speech_duration_seconds=90.0)),
            "SPEAKER_1": (
                [1.0, 0.0],
                _context("SPEAKER_1", speech_duration_seconds=10.0,
                         contains_multiple_speakers=True),
            ),
        }
        merged, id_resolution = merge_same_channel_fragments(clusters)
        self.assertEqual(id_resolution["SPEAKER_1"], "SPEAKER_0")
        self.assertTrue(merged["SPEAKER_0"][1].contains_multiple_speakers)

    def test_sidecar_flag_reaches_the_cluster_context(self):
        clusters = clusters_from_sidecar_channel("mtg001", {
            "recording_type": "remote",
            "clusters": {
                "SPEAKER_0": {"embedding": [1.0, 0.0], MULTI_SPEAKER_KEY: True},
                "SPEAKER_1": {"embedding": [0.0, 1.0]},
            },
        })
        self.assertTrue(clusters["SPEAKER_0"][1].contains_multiple_speakers)
        self.assertFalse(clusters["SPEAKER_1"][1].contains_multiple_speakers)


class MinimumSpeakerCountTests(unittest.TestCase):
    def test_counts_the_largest_channel_plus_one_per_marked_cluster(self):
        channels = {
            "system": {"clusters": {
                "SPEAKER_0": {MULTI_SPEAKER_KEY: True},
                "SPEAKER_1": {},
                "SPEAKER_2": {},
                "SPEAKER_3": {},
            }},
            "mic": {"clusters": {"SPEAKER_0": {}}},
        }
        # Four system clusters (Sortformer's hard ceiling) with one of them
        # known-mixed: at least five people were on that channel alone.
        #
        # This assertion used to read 6, adding the owner's mic cluster on
        # top. That was a claim the data does not support: a remote voice
        # coming out of the speakers lands in the microphone too, so the mic
        # cluster may be one of the four already counted. Five is the
        # smallest count consistent with the sidecar, and a minimum that
        # overstates is wrong in a way that understating is not -- it would
        # tell someone to go looking for a person who was never there.
        self.assertEqual(minimum_speaker_count(channels), 5)

    def test_empty_and_absent_channels_are_zero(self):
        self.assertEqual(minimum_speaker_count({}), 0)
        self.assertEqual(minimum_speaker_count({"system": {}}), 0)

    def test_two_fragments_of_one_voice_count_as_one_person(self):
        # From the bot review. The panel collapses diarizer fragments of one
        # voice into a single row (merge_same_channel_fragments), so counting
        # raw sidecar clusters told the user "at least 2 people" while
        # showing them one -- a number that contradicts the list beside it.
        channels = {
            "system": {
                "recording_type": "remote",
                "clusters": {
                    # Pairwise distance far below the merge threshold: one voice.
                    "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 60.0,
                                  "segment_count": 10, "segments": []},
                    "SPEAKER_1": {"embedding": [0.999, 0.045], "speech_duration_seconds": 30.0,
                                  "segment_count": 5, "segments": []},
                },
            },
        }
        self.assertEqual(minimum_speaker_count(channels), 1)

    def test_channels_are_not_summed_because_one_voice_can_be_in_both(self):
        # Also from the review, and the reason the old number could exceed
        # the truth: a remote voice coming out of the speakers is picked up
        # by the microphone too, so a mic cluster and a system cluster can be
        # the SAME person. Nothing in the sidecar says whether they are, so
        # the smallest count consistent with the data is the larger channel,
        # not the sum. A minimum that overstates is simply wrong; one that
        # understates is merely weak.
        channels = {
            "system": {"recording_type": "remote", "clusters": {
                "SPEAKER_0": {"embedding": [1.0, 0.0]},
                "SPEAKER_1": {"embedding": [0.0, 1.0]},
            }},
            "mic": {"recording_type": "local", "clusters": {
                "SPEAKER_0": {"embedding": [1.0, 0.0]},
            }},
        }
        self.assertEqual(minimum_speaker_count(channels), 2)


class SampleSegmentsTests(unittest.TestCase):
    def test_picks_the_longest_turns_but_returns_them_chronologically(self):
        segments = [
            {"start": 100.0, "end": 101.0},   # 1s  - dropped
            {"start": 10.0, "end": 25.0},     # 15s
            {"start": 50.0, "end": 58.0},     # 8s
            {"start": 200.0, "end": 202.0},   # 2s  - dropped
            {"start": 5.0, "end": 15.0},      # 10s
        ]
        chosen = sample_segments(segments, limit=3)
        self.assertEqual(
            [s["start"] for s in chosen], [5.0, 10.0, 50.0],
            "the three longest turns, in the order they occur in the recording",
        )

    def test_fewer_segments_than_the_limit_is_not_padded(self):
        self.assertEqual(sample_segments([{"start": 1.0, "end": 2.0}], limit=5),
                         [{"start": 1.0, "end": 2.0}])
        self.assertEqual(sample_segments([], limit=5), [])

    def test_a_sidecar_without_a_turn_manifest_yields_playable_but_TEXTLESS_samples(self):
        # Every sidecar written by backfill-speaker-embeddings has no
        # transcript_lines, and for those the transcript's [MM:SS] markers
        # came from a DIFFERENT diarization run than the segments here.
        # Measured on a real three-person call: not one of the owner's
        # eleven lines fell inside a mic segment alone, while four of the
        # other participants' lines did -- proximity was inverted, not just
        # noisy. So no text is attributed at all. The timestamps and the
        # audio stay, because those come from the same run as the segments.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Speaker 2] first excerpt here\n"
                "[00:50] [Speaker 2] second excerpt here\n",
                encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript, [{"start": 8.0, "end": 20.0}, {"start": 48.0, "end": 55.0}],
            )
            self.assertEqual(len(samples), 2, "the moments are still offered to listen to")
            self.assertEqual([s["text"] for s in samples], [None, None])
            self.assertEqual([s["start"] for s in samples], [8.0, 48.0])

    def test_a_turn_manifest_attributes_each_line_to_its_own_cluster(self):
        # With exact provenance there is nothing to match: the i-th diarised
        # line pairs with turn_manifest[i]. Crucially this INCLUDES lines
        # labeled "You" -- on the mic channel the owner's own turns are
        # exactly those, and the earlier code skipped them, which left the
        # owner's cluster quoting whoever happened to overlap in time.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [You] the owner speaking\n"
                "[00:20] [Others] someone else speaking\n"
                "[00:30] [You] the owner again\n",
                encoding="utf-8",
            )
            manifest = [
                {"start": 10.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 20.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 30.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
            ]
            mic = extract_segment_samples(
                transcript, [{"start": 8.0, "end": 15.0}, {"start": 28.0, "end": 35.0}],
                turn_manifest=manifest, target_ids={("mic", "SPEAKER_0")},
            )
            self.assertEqual(
                [s["text"] for s in mic],
                ["the owner speaking", "the owner again"],
                "the owner's own lines must reach the owner's own cluster",
            )

            system = extract_segment_samples(
                transcript, [{"start": 18.0, "end": 25.0}],
                turn_manifest=manifest, target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual([s["text"] for s in system], ["someone else speaking"])

    def test_a_line_starting_inside_a_running_segment_plays_from_the_line(self):
        # Measured on a real 37-minute call (system channel, 279 segments,
        # 109 attributed lines): 64 of those lines start in the MIDDLE of one
        # of the cluster's own segments rather than at its beginning, because
        # a diarization segment routinely spans several transcript lines.
        #
        # Selecting only segments that START at or after the line skipped the
        # very segment the line sits in, and the clip jumped to the next one.
        # The two moments the panel actually showed:
        #
        #   line 28.0s  inside own segment 27.28-62.32  -> clip started 63.28 (+35.3s)
        #   line 435.0s inside own segment 415.28-452.40 -> clip started 452.80 (+17.8s)
        #
        # The first misses the 0.5s tolerance by 0.22s. The quote and the
        # audio then describe different moments, which is the one thing this
        # pairing exists to prevent -- and it is worse than a missing clip,
        # because the timestamp shown next to the quote is the CLIP's.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:28] [Others] the line that sits inside a running segment\n"
                "[01:40] [Others] a later line of the same speaker\n",
                encoding="utf-8",
            )
            manifest = [
                {"start": 28.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 100.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
            ]
            samples = extract_segment_samples(
                transcript,
                [
                    {"start": 27.28, "end": 62.32},
                    {"start": 63.28, "end": 83.0},
                    {"start": 100.0, "end": 110.0},
                ],
                turn_manifest=manifest, target_ids={("system", "SPEAKER_0")},
            )
            first = next(s for s in samples if s["text"].startswith("the line that sits"))
            self.assertAlmostEqual(
                first["start"], 28.0, places=2,
                msg="the clip must start at the quoted line, not at the next segment",
            )
            self.assertGreater(first["end"], first["start"])

    def test_the_tail_of_the_previous_turn_does_not_swallow_this_line(self):
        # From the review of the fix above. Admitting a segment that has
        # already ENDED by the line's marker (it fell inside the 0.5s
        # tolerance) made it sort first; the 1.0s gap rule then stopped the
        # range before the line's real speech began, and the moment came back
        # unplayable. _format_timestamp truncates with int(), so a marker is
        # never later than the speech it labels and a finished segment is
        # always the previous turn's tail.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Others] the line whose own speech starts at 10.9\n"
                "[00:12] [Others] the next line\n",
                encoding="utf-8",
            )
            manifest = [
                {"start": 10.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 12.0, "channel": "system", "diarization_speaker_id": "SPEAKER_1"},
            ]
            samples = extract_segment_samples(
                transcript,
                [{"start": 9.0, "end": 9.8}, {"start": 10.9, "end": 11.5}],
                turn_manifest=manifest, target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(len(samples), 1)
            self.assertAlmostEqual(samples[0]["start"], 10.9, places=2)
            self.assertAlmostEqual(samples[0]["end"], 11.5, places=2)

    def test_two_lines_in_the_same_displayed_second_still_reach_their_own_speech(self):
        # Also from review. Markers are truncated to whole seconds, so two
        # turns inside one second carry the same value and next_start ==
        # start. Bounding the search at that value admitted only segments
        # overlapping the marker -- the previous line's tail -- and excluded
        # this line's own speech a fraction of a second later, playing 0.2s
        # of the wrong person.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Others] the earlier line in this second\n"
                "[00:10] [You] the later line in the same second\n",
                encoding="utf-8",
            )
            manifest = [
                {"start": 10.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 10.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
            ]
            samples = extract_segment_samples(
                transcript,
                [{"start": 10.8, "end": 10.9}],
                turn_manifest=manifest, target_ids={("mic", "SPEAKER_0")},
            )
            self.assertEqual(len(samples), 1)
            self.assertGreater(
                samples[0]["end"], samples[0]["start"],
                "the later line's own segment must still be reachable",
            )
            self.assertAlmostEqual(samples[0]["end"], 10.9, places=2)

    def test_a_segment_starting_in_the_marker_second_beats_the_previous_tail(self):
        # Third review finding. A segment spanning the marker is ambiguous:
        # usually it is the one the line sits in, but it can be the previous
        # line's tail reaching past it. Since markers truncate, this line's
        # speech starts within one second of its marker, so a segment
        # STARTING in that window wins over a spanning one. Without this the
        # clip opened on 0.2s of the previous line.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Others] the quoted line, speaking from 10.9\n",
                encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript,
                [{"start": 9.5, "end": 10.2}, {"start": 10.9, "end": 11.5}],
                turn_manifest=[{"start": 10.0, "channel": "system",
                                "diarization_speaker_id": "SPEAKER_0"}],
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertAlmostEqual(samples[0]["start"], 10.9, places=2)
            self.assertAlmostEqual(samples[0]["end"], 11.5, places=2)

    def test_the_manifests_exact_start_beats_the_truncated_marker(self):
        # [MM:SS] is rendered with int(), so two turns inside one second
        # carry the same marker and cannot be told apart by it -- measured on
        # real meetings, 18 of 264 and 34 of 643 lines share a displayed
        # second. The manifest keeps each turn's real start, from the same
        # run as the segments, so the pairing uses that. Here both lines are
        # marked [00:10]; only the manifest says the second one starts at
        # 10.8.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Others] the earlier turn in this second\n"
                "[00:10] [Others] the later turn in the same second\n",
                encoding="utf-8",
            )
            manifest = [
                {"start": 10.1, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 10.8, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
            ]
            samples = extract_segment_samples(
                transcript,
                [{"start": 10.1, "end": 10.2}, {"start": 10.8, "end": 11.5}],
                turn_manifest=manifest, target_ids={("system", "SPEAKER_0")},
            )
            later = next(s for s in samples if s["text"].startswith("the later turn"))
            self.assertAlmostEqual(later["start"], 10.8, places=2)
            self.assertAlmostEqual(later["end"], 11.5, places=2)

    def test_without_manifest_starts_a_shared_second_keeps_its_spanning_segment(self):
        # Fifth review finding, reachable only on the marker fallback:
        # _manifest_describes_lines skips entries with no usable start rather
        # than refusing the manifest, so both lines here fall back to their
        # rendered marker and share it. Preferring the segment that starts
        # later in the truncation window then handed this line the SIBLING's
        # speech. A shared second is itself the evidence that the later
        # segment belongs to the sibling.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Others] the earlier turn in this second\n"
                "[00:10] [Others] the later turn in the same second\n",
                encoding="utf-8",
            )
            manifest = [
                {"channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"channel": "system", "diarization_speaker_id": "SPEAKER_0"},
            ]
            samples = extract_segment_samples(
                transcript,
                [{"start": 9.9, "end": 10.2}, {"start": 10.8, "end": 10.9}],
                turn_manifest=manifest, target_ids={("system", "SPEAKER_0")},
            )
            earlier = next(s for s in samples if s["text"].startswith("the earlier turn"))
            self.assertAlmostEqual(
                earlier["start"], 10.0, places=2,
                msg="the earlier line opens on the segment spanning its marker, not the sibling's",
            )

    def test_a_line_with_no_own_speech_anywhere_near_it_is_not_offered(self):
        # The other half of the same defect. When the cluster genuinely has
        # no segment covering or closely following the line, there is no
        # moment to play: the old code walked forward to the cluster's next
        # segment however far away that was (measured: up to 40s), producing
        # this speaker's voice saying something entirely different from the
        # quote. An unplayable entry is honest; a wrong one is not.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Others] a line this cluster has no audio for\n"
                "[02:00] [Others] a line it does have audio for\n",
                encoding="utf-8",
            )
            manifest = [
                {"start": 10.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 120.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
            ]
            samples = extract_segment_samples(
                transcript, [{"start": 120.0, "end": 140.0}],
                turn_manifest=manifest, target_ids={("system", "SPEAKER_0")},
            )
            orphan = next(s for s in samples if s["text"].startswith("a line this cluster has no"))
            self.assertEqual(
                orphan["start"], orphan["end"],
                "a line 110s from this cluster's nearest speech is not playable",
            )

    def test_a_manifest_that_does_not_line_up_is_refused_rather_than_mispaired(self):
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [You] one\n[00:20] [Others] two\n[00:30] [You] three\n",
                encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript, [{"start": 8.0, "end": 15.0}],
                turn_manifest=[{"start": 10.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"}],
                target_ids={("mic", "SPEAKER_0")},
            )
            self.assertEqual([s["text"] for s in samples], [None])

    def test_a_multi_segment_turn_still_gets_its_text_and_a_matching_clip(self):
        # The defect this pins, reported from real use: "the clips do not
        # match the text 1:1, and often there is no text at all".
        #
        # src.transcriber merges consecutive segments of one speaker into a
        # single TURN carrying only the FIRST segment's timestamp
        # (transcriber.py: `if turns and turns[-1][1] == speaker:
        # turns[-1][2].append(text)`). Selecting the longest SEGMENTS and
        # then hunting for a line starting inside each one therefore misses
        # every segment that is not a turn's first -- which is most of them.
        #
        # Here one turn at 10s spans three segments, the longest of which
        # (30-45s) contains no line start at all. Segment-driven selection
        # would offer that segment with no text; turn-driven selection
        # offers the turn, with its text, and a clip covering the whole turn.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Others] one long uninterrupted turn\n"
                "[01:00] [You] a reply from the owner\n",
                encoding="utf-8",
            )
            segments = [
                {"start": 10.0, "end": 20.0},
                {"start": 21.0, "end": 29.0},
                {"start": 30.0, "end": 45.0},   # longest, and holds no line start
            ]
            manifest = [
                {"start": 10.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 60.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
            ]
            samples = extract_segment_samples(
                transcript, segments,
                turn_manifest=manifest, target_ids={("system", "SPEAKER_0")},
            )

            self.assertEqual(len(samples), 1, "one turn, not three segments")
            self.assertEqual(samples[0]["text"], "one long uninterrupted turn")
            # The clip spans the WHOLE turn, not just one of its segments,
            # so what is heard is what is written beside it.
            self.assertEqual(samples[0]["start"], 10.0)
            self.assertEqual(samples[0]["end"], 30.0)  # capped at SAMPLE_MAX_SECONDS

    def test_a_gap_between_two_of_this_clusters_segments_is_not_spanned(self):
        # Found by review. The range was min(start) to max(end) over every
        # own segment inside the turn's bounds, so two segments with a hole
        # between them produced ONE clip covering the hole as well. The hole
        # is, by definition, time this cluster was NOT speaking; on a mic
        # channel taken without headphones that is exactly where the remote
        # voices sit. next_start and SAMPLE_MAX_SECONDS bound how far this
        # can reach, they do not stop it.
        #
        # Here the cluster speaks 10-12 and again 20-22, and the next line
        # is a minute away, so nothing else clips the range.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Speaker 2] first bit\n[01:00] [You] much later\n",
                encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript,
                [{"start": 10.0, "end": 12.0}, {"start": 20.0, "end": 22.0}],
                turn_manifest=[
                    {"start": 10.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                    {"start": 60.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
                ],
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(samples[0]["text"], "first bit")
            self.assertEqual(
                (samples[0]["start"], samples[0]["end"]), (10.0, 12.0),
                "the clip stops where this cluster stopped speaking",
            )

    def test_a_short_pause_inside_one_turn_is_still_one_clip(self):
        # The counterweight to the test above: a turn IS several consecutive
        # segments of one speaker (src.transcriber merges them), separated
        # by that speaker's own breathing pauses. Cutting at every one of
        # those would leave two-second clips nobody can recognise a voice
        # from -- the point of the panel.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Speaker 2] one continuous turn\n[01:00] [You] much later\n",
                encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript,
                [
                    {"start": 10.0, "end": 15.0},
                    {"start": 15.4, "end": 19.0},   # 0.4s pause
                    {"start": 20.0, "end": 24.0},   # 1.0s pause
                ],
                turn_manifest=[
                    {"start": 10.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                    {"start": 60.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
                ],
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual((samples[0]["start"], samples[0]["end"]), (10.0, 24.0))

    def test_a_stale_manifest_of_the_same_length_is_refused_rather_than_mispaired(self):
        # The length check was the ONLY check, so a manifest that no longer
        # describes this transcript -- written by an earlier transcription,
        # or reordered -- passed it whenever the line count happened to
        # survive, and every line was then attributed positionally to
        # whatever cluster sat at that index. That is a quote from one
        # person shown under another person's name, which is the single
        # thing this panel must never do.
        #
        # Same three lines, same three entries, but the manifest's turns sit
        # at 10/45/70 while the transcript's lines sit at 10/20/30.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [You] one\n[00:20] [Others] two\n[00:30] [You] three\n",
                encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript, [{"start": 8.0, "end": 15.0}],
                turn_manifest=[
                    {"start": 10.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
                    {"start": 45.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                    {"start": 70.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
                ],
                target_ids={("mic", "SPEAKER_0")},
            )
            self.assertEqual(
                [s["text"] for s in samples], [None],
                "an unverifiable pairing yields the textless, audio-only fallback",
            )

    def test_a_manifest_that_still_describes_the_transcript_is_accepted(self):
        # The guard above must not refuse the normal case: manifest starts
        # are floats, the transcript's [MM:SS] is that float truncated to
        # the second, so entry 20.9 legitimately pairs with the line [00:20].
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [You] one\n[00:20] [Others] two\n", encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript, [{"start": 10.0, "end": 15.0}],
                turn_manifest=[
                    {"start": 10.4, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
                    {"start": 20.9, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                ],
                target_ids={("mic", "SPEAKER_0")},
            )
            self.assertEqual([s["text"] for s in samples], ["one"])

    def test_two_adjacent_turns_swapped_in_the_manifest_are_refused(self):
        # Found by the cross-family review of the check above. Half a second
        # of slop on each side made the accepted window two seconds wide for
        # a one-second bucket, so two turns a second apart could be swapped
        # and still pass -- and a swap is exactly what a reordered manifest
        # is. No slop is needed: the manifest's `start` and the line's
        # [MM:SS] are the SAME float, one of them truncated by
        # src.transcriber._format_timestamp, so this can be checked exactly.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Speaker 2] alice speaking\n[00:11] [Speaker 3] bob speaking\n",
                encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript, [{"start": 10.0, "end": 10.9}],
                turn_manifest=[
                    {"start": 11.0, "channel": "system", "diarization_speaker_id": "SPEAKER_1"},
                    {"start": 10.5, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                ],
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(
                [s["text"] for s in samples], [None],
                "a swapped manifest must not put bob's line under alice's cluster",
            )

    def test_two_turns_swapped_inside_one_second_are_refused(self):
        # The narrower version of the test above, from the bot review: two
        # turns at 10.1 and 10.8 BOTH render as [00:10], so comparing each
        # entry against its line's displayed second cannot separate them,
        # however exactly it is done. What still separates them is order --
        # the manifest is built from a list sorted by start, so its starts
        # never decrease. A swap does.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Speaker 2] alice speaking\n[00:10] [Speaker 3] bob speaking\n",
                encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript, [{"start": 10.1, "end": 10.5}],
                turn_manifest=[
                    {"start": 10.8, "channel": "system", "diarization_speaker_id": "SPEAKER_1"},
                    {"start": 10.1, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                ],
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(
                [s["text"] for s in samples], [None],
                "a manifest whose turns run backwards cannot describe this transcript",
            )

    def test_a_manifest_entry_that_is_not_an_object_is_refused_not_raised(self):
        # Also from that review: the sidecar is JSON, so an entry can be
        # anything, while every caller reaches straight for entry.get(...) --
        # and cluster_transcript_lines documents a never-raises contract.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text("[00:10] [Speaker 2] hello\n", encoding="utf-8")
            samples = extract_segment_samples(
                transcript, [{"start": 10.0, "end": 14.0}],
                turn_manifest=[None],
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual([s["text"] for s in samples], [None])

    def test_two_turns_in_the_same_displayed_second_never_widen_the_clip(self):
        # Found by review, and it is the same failure class as the one
        # reported from real use. Transcript timestamps render as [MM:SS],
        # so two turns inside ONE second carry the SAME value -- next_start
        # then equals start, the bounded segment set comes back empty, and
        # an earlier "window of N seconds around the timestamp" fallback
        # took over. That window covered the NEXT speaker, i.e. it played
        # somebody else under this speaker's name.
        #
        # Here Alice speaks 10.1-10.5 and Bob starts at 10.8; both lines
        # render as [00:10]. Alice's clip must stay inside Alice's segment.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Speaker 2] alice speaking\n"
                "[00:10] [Speaker 3] bob speaking\n",
                encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript,
                [{"start": 10.1, "end": 10.5}],
                turn_manifest=[
                    {"start": 10.1, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                    {"start": 10.8, "channel": "system", "diarization_speaker_id": "SPEAKER_1"},
                ],
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(samples[0]["text"], "alice speaking")
            self.assertEqual((samples[0]["start"], samples[0]["end"]), (10.1, 10.5))
            self.assertLess(
                samples[0]["end"], 10.8,
                "the clip must not reach the next speaker's segment",
            )

    def test_a_turn_with_no_segment_of_its_own_yields_no_playable_range(self):
        # When nothing of this cluster sits at or after the line, there is
        # no honest clip to offer. A zero-length range makes
        # extract_speaker_sample_audio refuse (duration <= 0) rather than
        # cutting arbitrary audio around the timestamp.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text("[01:00] [Speaker 2] said something\n", encoding="utf-8")
            samples = extract_segment_samples(
                transcript,
                [{"start": 5.0, "end": 8.0}],   # entirely before the line
                turn_manifest=[
                    {"start": 60.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                ],
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(samples[0]["text"], "said something")
            self.assertEqual(samples[0]["start"], samples[0]["end"])

    def test_the_unplaceable_moment_is_refused_by_the_half_that_plays_it(self):
        # The other half of the test above, and the pairing that has broken
        # twice already: the list says "nothing placeable here" with a
        # zero-length range, and the extractor is what has to honour it. It
        # did not -- its duration check ran after the two 0.3s pads, so the
        # unplaceable moment came back as a 0.6s clip of whoever was
        # actually speaking at that timestamp. Asserting the two functions
        # against each other, not each against its own idea of the contract.
        from src.speaker_suggestions import extract_speaker_sample_audio

        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text("[01:00] [Speaker 2] said something\n", encoding="utf-8")
            segments = [{"start": 5.0, "end": 8.0}]
            samples = extract_segment_samples(
                transcript, segments,
                turn_manifest=[
                    {"start": 60.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                ],
                target_ids={("system", "SPEAKER_0")},
            )
            audio = Path(tmp) / "a.wav"
            audio.write_bytes(b"stub")
            with mock.patch("src.transcriber._resolve_ffmpeg", return_value="/bin/ffmpeg"), \
                 mock.patch("src.speaker_suggestions.subprocess.run") as run_mock:
                played = extract_speaker_sample_audio(
                    audio, "system", segments, Path(tmp) / "out.wav",
                    segment_index=samples[0],
                )
            self.assertFalse(played)
            run_mock.assert_not_called()

    def test_a_clip_never_runs_into_the_next_speakers_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Others] first speaker\n[00:15] [You] second speaker\n",
                encoding="utf-8",
            )
            samples = extract_segment_samples(
                transcript,
                # The segment overruns the next line's start by 10s.
                [{"start": 10.0, "end": 25.0}],
                turn_manifest=[
                    {"start": 10.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                    {"start": 15.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
                ],
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(samples[0]["end"], 15.0,
                             "playing past the next line means playing the other person")

    def test_the_collapsed_quote_is_one_of_the_expanded_excerpts(self):
        # Two independent derivations of "the most representative thing this
        # speaker said" drift apart, and the visible symptom is a collapsed
        # row quoting a moment that expanding never offers.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "t.txt"
            transcript.write_text(
                "[00:10] [Others] short one\n"
                "[00:20] [Others] the substantially longer turn here\n"
                "[02:00] [You] owner\n",
                encoding="utf-8",
            )
            segments = [{"start": 10.0, "end": 12.0}, {"start": 20.0, "end": 40.0}]
            manifest = [
                {"start": 10.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 20.0, "channel": "system", "diarization_speaker_id": "SPEAKER_0"},
                {"start": 120.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_0"},
            ]
            kwargs = dict(turn_manifest=manifest, target_ids={("system", "SPEAKER_0")})
            samples = extract_segment_samples(transcript, segments, **kwargs)
            quote = extract_sample_text(transcript, segments, **kwargs)

            self.assertIn(quote, [s["text"] for s in samples])
            self.assertEqual(quote, "the substantially longer turn here")

    def test_segment_index_selects_the_matching_excerpt_and_refuses_out_of_range(self):
        # The single point where "play excerpt 3" turns into a time range.
        # Getting it wrong is invisible to the person using it -- they hear a
        # different moment than the text beside it and conclude two speakers
        # sound alike -- so an out-of-range index must fail rather than fall
        # back to the longest turn.
        from src.speaker_suggestions import extract_speaker_sample_audio

        segments = [
            {"start": 120.0, "end": 128.0},
            {"start": 10.0, "end": 30.0},
            {"start": 60.0, "end": 62.0},
        ]
        captured = []

        class _Result:
            returncode = 0

        def fake_run(cmd, **kwargs):
            captured.append(cmd)
            Path(cmd[-1]).write_bytes(b"wav")
            return _Result()

        with tempfile.TemporaryDirectory() as tmp:
            audio = Path(tmp) / "a.wav"
            audio.write_bytes(b"stub")
            out = Path(tmp) / "out.wav"

            with mock.patch("src.transcriber._resolve_ffmpeg", return_value="/bin/ffmpeg"), \
                 mock.patch("subprocess.run", side_effect=fake_run):
                # Index 1 is the SECOND entry chronologically (60.0), not the
                # second-longest -- the list is chronological by contract.
                self.assertTrue(
                    extract_speaker_sample_audio(audio, "system", segments, out, segment_index=1)
                )
                start_arg = captured[-1][captured[-1].index("-ss") + 1]
                self.assertAlmostEqual(float(start_arg), 60.0 - 0.3, places=3)

                self.assertFalse(
                    extract_speaker_sample_audio(audio, "system", segments, out, segment_index=9)
                )
                self.assertFalse(
                    extract_speaker_sample_audio(audio, "system", segments, out, segment_index=-1)
                )

    def test_missing_transcript_yields_textless_entries_not_an_error(self):
        samples = extract_segment_samples(
            Path("/nonexistent/t.txt"), [{"start": 1.0, "end": 5.0}],
        )
        self.assertEqual(len(samples), 1)
        self.assertIsNone(samples[0]["text"])


class MarkSpeakerClusterCliTests(unittest.TestCase):
    def _seed(self, tmp, clusters=None):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, "mtg001", {
            "system": {
                "recording_type": "remote",
                "clusters": clusters or {
                    "SPEAKER_0": {
                        "embedding": [1.0, 0.0], "speech_duration_seconds": 60.0,
                        "segment_count": 10, "segments": [{"start": 1.0, "end": 5.0}],
                    },
                    "SPEAKER_1": {
                        "embedding": [0.0, 1.0], "speech_duration_seconds": 40.0,
                        "segment_count": 8, "segments": [{"start": 20.0, "end": 24.0}],
                    },
                },
            },
        })
        return output_dir

    def _run(self, command, args, tmp, cfg=None):
        cfg = cfg or Config(config_path=Path(tmp) / "config.json")
        cfg.set_identity_matching_enabled(True)
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            return CliRunner().invoke(command, args)

    def _seeded_run_id(self, tmp):
        """The seeded sidecar's run id. Tests that hand-build a prototype
        instead of going through `confirm-speaker` have to stamp it, or they
        describe a state the app cannot reach: evidence about a run that is
        not the one on disk, which the withdrawal path deliberately leaves
        alone because its cluster ids mean something else now."""
        return read_speakers_sidecar(Path(tmp) / "output", "mtg001")["diarization_run"]["run_id"]

    def _rediarize(self, tmp):
        """Rewrite the seeded sidecar with a fresh run whose cluster ids are
        reused but whose voices are not, which is what a re-diarization
        produces. Returns the new run id."""
        self._seed(tmp, clusters={
            "SPEAKER_0": {
                "embedding": [0.0, 1.0], "speech_duration_seconds": 55.0,
                "segment_count": 9, "segments": [{"start": 2.0, "end": 6.0}],
            },
            "SPEAKER_1": {
                "embedding": [1.0, 0.0], "speech_duration_seconds": 35.0,
                "segment_count": 7, "segments": [{"start": 21.0, "end": 25.0}],
            },
        })
        return self._seeded_run_id(tmp)

    def test_marking_a_reused_cluster_id_leaves_an_older_runs_confirmation_alone(self):
        # The withdrawal loop's half of the run-scope defect. Marking THIS
        # run's SPEAKER_0 as mixed says nothing about the person confirmed on
        # a previous run's SPEAKER_0: the diarizer reuses the id for an
        # unrelated voice, so unscoped this would withdraw a confirmation
        # nobody questioned and delete the prototype behind it.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            pid = cfg.create_person_profile("Person Alpha")["person_id"]
            run1 = self._seeded_run_id(tmp)
            cfg.add_speaker_prototype(
                pid, [1.0, 0.0], recording_type="remote", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_0", speech_duration_seconds=60.0,
                segment_count=10, created_from="user_confirmed", channel="system",
                diarization_run_id=run1,
            )

            run2 = self._rediarize(tmp)
            self.assertNotEqual(run1, run2)

            result = self._run(
                simple_recorder.mark_speaker_cluster,
                ["mtg001", "system", "SPEAKER_0"], tmp, cfg=cfg,
            )
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(
                data["cleared_confirmation_from"], [],
                "the marking describes this run's cluster, not the one Person Alpha was confirmed on",
            )
            profile = cfg.get_person_profile(pid)
            self.assertEqual(
                [p["diarization_run_id"] for p in profile["prototypes"]], [run1],
            )

    def test_marking_withdraws_this_runs_negatives_and_keeps_an_older_runs(self):
        # The other two removals in the same loop, which the test above never
        # reaches (it stops at a positive removal that matches nothing). A
        # negative recorded against a previous run's SPEAKER_0 is evidence
        # about a different voice, so the marking must leave it standing on
        # both the withdrawn person's profile and everyone else's.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            person_alpha = cfg.create_person_profile("Person Alpha")["person_id"]
            max_id = cfg.create_person_profile("Max")["person_id"]
            run1 = self._seeded_run_id(tmp)
            run2 = self._rediarize(tmp)

            # Person Alpha is the one confirmed on the CURRENT run's SPEAKER_0...
            cfg.add_speaker_prototype(
                person_alpha, [0.0, 1.0], recording_type="remote", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_0", speech_duration_seconds=55.0,
                segment_count=9, created_from="user_confirmed", channel="system",
                diarization_run_id=run2,
            )
            # ...and Max was ruled out for it, in this run and in the last.
            for run_id in (run1, run2):
                cfg.add_speaker_prototype(
                    max_id, [0.0, 1.0], recording_type="remote", meeting_id="mtg001",
                    diarization_speaker_id="SPEAKER_0", speech_duration_seconds=55.0,
                    segment_count=9, created_from="user_confirmed", channel="system",
                    negative=True, diarization_run_id=run_id,
                )
            # Person Alpha carries a stale one of his own from before the re-run.
            cfg.add_speaker_prototype(
                person_alpha, [1.0, 0.0], recording_type="remote", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_0", speech_duration_seconds=60.0,
                segment_count=10, created_from="user_confirmed", channel="system",
                negative=True, diarization_run_id=run1,
            )

            result = self._run(
                simple_recorder.mark_speaker_cluster,
                ["mtg001", "system", "SPEAKER_0"], tmp, cfg=cfg,
            )
            data = _last_json(result.output)
            self.assertEqual(data["cleared_confirmation_from"], ["Person Alpha"])
            self.assertEqual(cfg.get_person_profile(person_alpha)["prototypes"], [])
            self.assertEqual(
                [n["diarization_run_id"] for n in cfg.get_person_profile(person_alpha)["hard_negatives"]],
                [run1],
            )
            self.assertEqual(
                [n["diarization_run_id"] for n in cfg.get_person_profile(max_id)["hard_negatives"]],
                [run1],
            )

    def test_marks_and_reports_the_new_minimum_speaker_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            result = self._run(
                simple_recorder.mark_speaker_cluster, ["mtg001", "system", "SPEAKER_0"], tmp,
            )
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertTrue(data["contains_multiple_speakers"])
            self.assertEqual(data["minimum_speaker_count"], 3)

    def test_marking_one_cluster_keeps_the_negatives_earned_by_the_others(self):
        # From the bot review, and it destroys data. A person's hard
        # negatives are created when OTHER clusters are confirmed as
        # somebody else -- "this voice is not Person Alpha" is evidence about
        # THAT cluster. Marking cluster A as mixed cleared every negative
        # the person had in this meeting and channel, including the ones
        # earned by clusters B and C, which are untouched by the marking
        # and stay true. The loss is silent and only shows up months later
        # as a worse suggestion.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            pid = person["person_id"]
            # Confirmed on SPEAKER_0 (the cluster about to be marked)...
            run_id = self._seeded_run_id(tmp)
            cfg.add_speaker_prototype(
                pid, [1.0, 0.0], recording_type="remote", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_0", speech_duration_seconds=60.0,
                segment_count=10, created_from="user_confirmed", channel="system",
                diarization_run_id=run_id,
            )
            # ...and ruled OUT for SPEAKER_1 by a different confirmation.
            cfg.add_speaker_prototype(
                pid, [0.0, 1.0], recording_type="remote", meeting_id="mtg001",
                diarization_speaker_id="SPEAKER_1", speech_duration_seconds=40.0,
                segment_count=8, created_from="user_confirmed", channel="system",
                negative=True, diarization_run_id=run_id,
            )

            result = self._run(
                simple_recorder.mark_speaker_cluster,
                ["mtg001", "system", "SPEAKER_0"], tmp, cfg=cfg,
            )
            self.assertTrue(_last_json(result.output)["success"])

            profile = cfg.get_person_profile(pid)
            self.assertEqual(
                [p["diarization_speaker_id"] for p in profile["prototypes"]], [],
                "the marked cluster's own prototype must go",
            )
            self.assertEqual(
                [n["diarization_speaker_id"] for n in profile["hard_negatives"]],
                ["SPEAKER_1"],
                "a negative earned by a DIFFERENT cluster is not this marking's to delete",
            )

    def _seed_with_transcript(self, tmp, body, manifest):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, "mtg001", {
            "mic": {
                "recording_type": "in_person",
                "clusters": {
                    "SPEAKER_00": {
                        "embedding": [1.0, 0.0], "speech_duration_seconds": 30.0,
                        "segment_count": 5, "segments": [{"start": 4.0, "end": 6.0}],
                    },
                },
            },
        }, turn_manifest=manifest)
        transcripts_dir = Path(tmp) / "transcripts"
        transcripts_dir.mkdir(parents=True, exist_ok=True)
        path = transcripts_dir / "mtg001_transcript.txt"
        path.write_text(
            "Session: mtg001\n\n" + "=" * 60 + "\n\n" + body, encoding="utf-8",
        )
        return path

    def test_marking_an_unconfirmed_cluster_preserves_its_generic_transcript_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            transcript = self._seed_with_transcript(
                tmp,
                "[00:05] [You] hello there",
                [{
                    "start": 5.2,
                    "channel": "mic",
                    "diarization_speaker_id": "SPEAKER_00",
                }],
            )

            marked = self._run(
                simple_recorder.mark_speaker_cluster,
                ["mtg001", "mic", "SPEAKER_00"],
                tmp,
            )
            marked_data = _last_json(marked.output)
            self.assertTrue(marked_data["success"])
            self.assertEqual(marked_data["transcript_lines_restored"], 0)
            self.assertIn("[00:05] [You] hello there", transcript.read_text())

            cleared = self._run(
                simple_recorder.mark_speaker_cluster,
                ["mtg001", "mic", "SPEAKER_00", "--single"],
                tmp,
            )
            self.assertTrue(_last_json(cleared.output)["success"])
            self.assertIn("[00:05] [You] hello there", transcript.read_text())

    def test_marking_a_confirmed_cluster_takes_the_name_out_of_the_transcript(self):
        # The last of the three P1s from the bot review, and the one a user
        # actually reads. confirm-speaker --relabel-transcript rewrites the
        # cluster's lines to "Person Alpha". Marking it as more than one person
        # afterwards withdraws the profile, the prototype and the
        # participants chip -- but left "Person Alpha" standing in the saved
        # transcript, which is what feeds the summary and every export. The
        # app then knows the cluster holds several people while the
        # artefact keeps naming one of them.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = self._seed_with_transcript(
                tmp,
                "[00:05] [Speaker 2] hello there\n\n[00:20] [You] hi back",
                [
                    {"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_00"},
                    {"start": 20.0, "channel": "mic", "diarization_speaker_id": "SPEAKER_01"},
                ],
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            cfg.set_identity_matching_enabled(True)
            with mock.patch("src.config.get_config", return_value=cfg), \
                 mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
                confirmed = CliRunner().invoke(simple_recorder.confirm_speaker, [
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                    "--relabel-transcript",
                ])
            self.assertTrue(_last_json(confirmed.output)["success"])
            self.assertIn("[00:05] [Person Alpha] hello there", transcript.read_text())

            result = self._run(
                simple_recorder.mark_speaker_cluster,
                ["mtg001", "mic", "SPEAKER_00"], tmp, cfg=cfg,
            )
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["cleared_confirmation_from"], ["Person Alpha"])

            text = transcript.read_text()
            self.assertNotIn("Person Alpha", text, "the withdrawn name must leave the transcript too")
            self.assertIn(
                "[00:05] [Speaker 2] hello there", text,
                "and the label the line carried before the confirmation comes back",
            )
            self.assertIn("[00:20] [You] hi back", text)  # never this cluster's line

    def test_retry_after_sidecar_failure_repairs_transcript_and_participants(self):
        with tempfile.TemporaryDirectory() as tmp:
            transcript = self._seed_with_transcript(
                tmp,
                "[00:05] [Speaker 2] hello there",
                [{
                    "start": 5.2,
                    "channel": "mic",
                    "diarization_speaker_id": "SPEAKER_00",
                }],
            )
            summary = Path(tmp) / "output" / "mtg001_summary.md"
            summary.write_text(
                "---\ntitle: \"Meeting\"\n---\n\n## Summary\n\nText.\n",
                encoding="utf-8",
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            confirmed = self._run(
                simple_recorder.confirm_speaker,
                [
                    "mtg001", "mic", "SPEAKER_00", "--new-person", "Person Alpha",
                    "--relabel-transcript",
                ],
                tmp,
                cfg=cfg,
            )
            self.assertTrue(_last_json(confirmed.output)["success"])
            self.assertIn("Person Alpha", transcript.read_text())
            self.assertIn("Person Alpha", summary.read_text())

            with mock.patch(
                "src.speaker_suggestions.write_sidecar_document",
                side_effect=OSError("disk full"),
            ):
                first = self._run(
                    simple_recorder.mark_speaker_cluster,
                    ["mtg001", "mic", "SPEAKER_00"],
                    tmp,
                    cfg=cfg,
                )
            self.assertFalse(_last_json(first.output)["success"])
            self.assertIn("Person Alpha", transcript.read_text())
            self.assertIn("Person Alpha", summary.read_text())
            self.assertEqual(
                _last_json(first.output).get("cleared_confirmation_from"),
                ["Person Alpha"],
            )

            retry = self._run(
                simple_recorder.mark_speaker_cluster,
                ["mtg001", "mic", "SPEAKER_00"],
                tmp,
                cfg=cfg,
            )
            self.assertTrue(_last_json(retry.output)["success"])
            self.assertNotIn("Person Alpha", transcript.read_text())
            self.assertNotIn("Person Alpha", summary.read_text())

    def test_without_a_recorded_original_the_line_says_multiple_speakers(self):
        # Every meeting confirmed before the original label was recorded has
        # nothing to restore. Putting back "You" or "Speaker 3" would invent
        # an attribution; leaving the person's name would keep the lie. The
        # fallback states exactly what the user just decided.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = self._seed_with_transcript(
                tmp, "[00:05] [Person Alpha] hello there",
                [{"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_00"}],
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            cfg.add_speaker_prototype(
                person["person_id"], [1.0, 0.0], recording_type="in_person",
                meeting_id="mtg001", diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=30.0, segment_count=5,
                created_from="user_confirmed", channel="mic",
                diarization_run_id=self._seeded_run_id(tmp),
            )
            result = self._run(
                simple_recorder.mark_speaker_cluster,
                ["mtg001", "mic", "SPEAKER_00"], tmp, cfg=cfg,
            )
            data = _last_json(result.output)
            self.assertEqual(data["cleared_confirmation_from"], ["Person Alpha"])
            self.assertEqual(data["transcript_lines_restored"], 1)
            self.assertIn("[00:05] [Multiple speakers] hello there", transcript.read_text())

    def test_a_manifest_that_no_longer_fits_leaves_the_transcript_alone(self):
        # The refusal branch. If the manifest cannot be paired with the
        # transcript, the app does not know which lines belong to this
        # cluster -- rewriting any of them would be guessing, and guessing
        # here means putting a label on someone else's words. The file
        # stays as it is, and the count says so instead of claiming a
        # cleanup that never happened.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = self._seed_with_transcript(
                tmp, "[00:05] [Person Alpha] hello there\n\n[00:20] [You] hi back",
                # One entry, two diarised lines: cannot be paired.
                [{"start": 5.2, "channel": "mic", "diarization_speaker_id": "SPEAKER_00"}],
            )
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            cfg.add_speaker_prototype(
                person["person_id"], [1.0, 0.0], recording_type="in_person",
                meeting_id="mtg001", diarization_speaker_id="SPEAKER_00",
                speech_duration_seconds=30.0, segment_count=5,
                created_from="user_confirmed", channel="mic",
                diarization_run_id=self._seeded_run_id(tmp),
            )
            result = self._run(
                simple_recorder.mark_speaker_cluster,
                ["mtg001", "mic", "SPEAKER_00"], tmp, cfg=cfg,
            )
            data = _last_json(result.output)
            self.assertEqual(data["cleared_confirmation_from"], ["Person Alpha"])
            self.assertEqual(
                data["transcript_lines_restored"], 0,
                "a refusal must be reported as zero, not as a silent success",
            )
            self.assertIn("[00:05] [Person Alpha] hello there", transcript.read_text())

    def test_unknown_cluster_fails_loudly_rather_than_marking_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            result = self._run(
                simple_recorder.mark_speaker_cluster, ["mtg001", "system", "SPEAKER_9"], tmp,
            )
            self.assertEqual(result.exit_code, 1)
            self.assertFalse(_last_json(result.output)["success"])

    def test_suggest_speakers_reports_the_marking_and_withholds_the_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            for meeting in ("other1", "other2"):
                cfg.add_speaker_prototype(
                    person["person_id"], [1.0, 0.0], recording_type="remote",
                    meeting_id=meeting, diarization_speaker_id="SPEAKER_0",
                    speech_duration_seconds=120.0, segment_count=20,
                    created_from="user_confirmed", channel="system",
                )

            before = _last_json(
                self._run(simple_recorder.suggest_speakers, ["mtg001"], tmp, cfg=cfg).output
            )
            self.assertEqual(before["channels"]["system"]["SPEAKER_0"]["status"], "confirmed")

            set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_0", True)
            after = _last_json(
                self._run(simple_recorder.suggest_speakers, ["mtg001"], tmp, cfg=cfg).output
            )
            cluster = after["channels"]["system"]["SPEAKER_0"]
            self.assertEqual(cluster["status"], "none")
            self.assertTrue(cluster["contains_multiple_speakers"])
            self.assertEqual(after["minimum_speaker_count"], 3)

    def test_confirm_speaker_refuses_a_marked_cluster(self):
        # The guarantee, as opposed to the panel's convenience: a confirm
        # turns this blended centroid into a stored prototype AND into
        # hard-negative evidence against everyone else in the channel,
        # degrading suggestions in unrelated future meetings with nothing
        # pointing back at the cause.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_0", True)

            result = self._run(
                simple_recorder.confirm_speaker,
                ["mtg001", "system", "SPEAKER_0", "--new-person", "Person Alpha"], tmp, cfg=cfg,
            )
            self.assertEqual(result.exit_code, 1)
            self.assertFalse(_last_json(result.output)["success"])
            # And nothing was half-written on the way to refusing.
            self.assertEqual(
                [p for p in cfg.get_person_profiles() if p.get("prototypes")], [],
            )

    def test_marking_withdraws_a_confirmation_already_made_on_that_cluster(self):
        # The realistic order of events: someone confirms a cluster, then
        # listens to a second excerpt and realises two people are in it. If
        # marking only blocked FUTURE confirms, the blended embedding would
        # stay enrolled as that person -- the exact state this exists to
        # prevent -- and stays reachable from enroll-self-from-person and
        # from every future suggestion scored against that profile.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")

            confirmed = self._run(
                simple_recorder.confirm_speaker,
                ["mtg001", "system", "SPEAKER_0", "--new-person", "Person Alpha"], tmp, cfg=cfg,
            )
            self.assertTrue(_last_json(confirmed.output)["success"])
            person_alpha = next(p for p in cfg.get_person_profiles() if p["display_name"] == "Person Alpha")
            self.assertEqual(len(person_alpha["prototypes"]), 1)

            marked = self._run(
                simple_recorder.mark_speaker_cluster,
                ["mtg001", "system", "SPEAKER_0"], tmp, cfg=cfg,
            )
            data = _last_json(marked.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["cleared_confirmation_from"], ["Person Alpha"])

            person_alpha = next(p for p in cfg.get_person_profiles() if p["display_name"] == "Person Alpha")
            self.assertEqual(
                person_alpha["prototypes"], [],
                "a blended two-voice embedding must not stay enrolled as a person",
            )

    def test_config_save_failure_keeps_profile_and_sidecar_unmarked(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            cfg.set_identity_matching_enabled(True)
            person = cfg.create_person_profile("Person Alpha")
            cfg.add_speaker_prototype(
                person["person_id"], [1.0, 0.0], recording_type="remote",
                meeting_id="mtg001", diarization_speaker_id="SPEAKER_0",
                speech_duration_seconds=60.0, segment_count=10,
                created_from="user_confirmed", channel="system",
                diarization_run_id=self._seeded_run_id(tmp),
            )

            with mock.patch(
                "src.config._atomic_write_json",
                side_effect=OSError("disk full"),
            ), mock.patch("src.config.get_config", return_value=cfg), \
                 mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
                result = CliRunner().invoke(
                    simple_recorder.mark_speaker_cluster,
                    ["mtg001", "system", "SPEAKER_0"],
                )

            self.assertNotEqual(result.exit_code, 0)
            self.assertFalse(_last_json(result.output)["success"])
            stored_cluster = read_speakers_sidecar(
                output_dir, "mtg001",
            )["channels"]["system"]["clusters"]["SPEAKER_0"]
            self.assertNotIn(MULTI_SPEAKER_KEY, stored_cluster)
            reloaded = Config(config_path=Path(tmp) / "config.json")
            self.assertEqual(
                len(reloaded.get_person_profile(person["person_id"])["prototypes"]),
                1,
            )

    def test_a_marked_cluster_is_not_used_as_hard_negative_evidence(self):
        # "Speaker B is not the person in cluster A" is only meaningful when
        # A is one person. If A is a blend of two voices, the negative is
        # recorded against a voice nobody has, and it suppresses real
        # matches for B in unrelated meetings.
        #
        # The marking is applied via set_cluster_multi_speaker DIRECTLY, not
        # via the CLI, and that is the point of the test. The CLI also
        # strips A's confirmation (see the test above), which normally keeps
        # A out of the hard-negative loop for a second reason -- so driving
        # it through the CLI would pass whether or not this filter exists.
        # This reproduces the state the filter alone has to handle: a marked
        # cluster whose confirmation survived, which is reachable for real
        # when remove_speaker_evidence cannot match a legacy prototype that
        # predates the `channel` field.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")

            self._run(
                simple_recorder.confirm_speaker,
                ["mtg001", "system", "SPEAKER_0", "--new-person", "Person Alpha"], tmp, cfg=cfg,
            )
            person_alpha = next(p for p in cfg.get_person_profiles() if p["display_name"] == "Person Alpha")
            self.assertEqual(len(person_alpha["prototypes"]), 1)

            set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_0", True)

            result = self._run(
                simple_recorder.confirm_speaker,
                ["mtg001", "system", "SPEAKER_1", "--new-person", "Person Gamma"], tmp, cfg=cfg,
            )
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(
                data["hard_negatives_added_against"], [],
                "a mixed cluster must not be treated as confirmed-different evidence",
            )

            for person in cfg.get_person_profiles():
                self.assertEqual(
                    person.get("hard_negatives") or [], [],
                    f"{person['display_name']} gained negative evidence from a mixed cluster",
                )

    def test_confirm_speaker_still_accepts_an_unmarked_cluster(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            result = self._run(
                simple_recorder.confirm_speaker,
                ["mtg001", "system", "SPEAKER_1", "--new-person", "Person Alpha"], tmp, cfg=cfg,
            )
            self.assertTrue(_last_json(result.output)["success"])


class SpeakerNamingStatusCliTests(unittest.TestCase):
    """Feeds the one sentence shown before a delete. A CONFIRMED person
    survives the delete (their prototype lives in config.json, bound to no
    meeting); an UNNAMED cluster does not, and cannot be recovered by any
    means once the audio is gone -- naming a voice requires hearing it."""

    def _run(self, args, tmp, cfg=None, *, identity_enabled=True):
        cfg = cfg or Config(config_path=Path(tmp) / "config.json")
        cfg.set_identity_matching_enabled(identity_enabled)
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            return CliRunner().invoke(simple_recorder.speaker_naming_status, args)

    def _seed(self, tmp):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, "mtg001", {
            "system": {
                "recording_type": "remote",
                "clusters": {
                    "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 60.0,
                                  "segment_count": 10, "segments": [{"start": 1.0, "end": 5.0}]},
                    "SPEAKER_1": {"embedding": [0.0, 1.0], "speech_duration_seconds": 40.0,
                                  "segment_count": 8, "segments": [{"start": 20.0, "end": 24.0}]},
                },
            },
        })
        return output_dir

    def _run_id(self, tmp):
        return read_speakers_sidecar(Path(tmp) / "output", "mtg001")["diarization_run"]["run_id"]

    def test_counts_unnamed_clusters(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            data = _last_json(self._run(["mtg001"], tmp).output)
            self.assertTrue(data["has_sidecar"])
            self.assertEqual(data["total_clusters"], 2)
            self.assertEqual(data["unnamed_clusters"], 2)

    def test_disabled_identity_matching_reports_nothing_to_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            data = _last_json(
                self._run(["mtg001"], tmp, identity_enabled=False).output
            )
            self.assertEqual(data, {
                "success": True,
                "meeting_id": "mtg001",
                "has_sidecar": False,
                "total_clusters": 0,
                "named_clusters": 0,
                "unnamed_clusters": 0,
            })

    def test_a_confirmed_cluster_no_longer_counts_as_unnamed(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            cfg.add_speaker_prototype(
                person["person_id"], [1.0, 0.0], recording_type="remote",
                meeting_id="mtg001", diarization_speaker_id="SPEAKER_0",
                speech_duration_seconds=60.0, segment_count=10,
                created_from="user_confirmed", channel="system",
                # Stamped with the sidecar's own run, the way a real confirm
                # against it does -- an unstamped prototype here would
                # describe a state the app cannot reach.
                diarization_run_id=self._run_id(tmp),
            )
            data = _last_json(self._run(["mtg001"], tmp, cfg=cfg).output)
            self.assertEqual(data["named_clusters"], 1)
            self.assertEqual(data["unnamed_clusters"], 1)

    def test_a_name_from_a_superseded_run_does_not_count_as_named(self):
        # This feeds the sentence shown before a delete, and the cost of
        # getting it wrong is one-directional: an unnamed cluster is gone
        # for good once the audio is deleted, and a stale prototype claiming
        # its id is exactly how a cluster nobody has ever heard gets counted
        # as already taken care of.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            cfg = Config(config_path=Path(tmp) / "config.json")
            person = cfg.create_person_profile("Person Alpha")
            cfg.add_speaker_prototype(
                person["person_id"], [1.0, 0.0], recording_type="remote",
                meeting_id="mtg001", diarization_speaker_id="SPEAKER_0",
                speech_duration_seconds=60.0, segment_count=10,
                created_from="user_confirmed", channel="system",
                diarization_run_id=self._run_id(tmp),
            )
            self._seed(tmp)  # re-diarized: same ids, new run, other voices
            data = _last_json(self._run(["mtg001"], tmp, cfg=cfg).output)
            self.assertEqual(data["named_clusters"], 0)
            self.assertEqual(data["unnamed_clusters"], 2)

    def test_a_marked_cluster_is_not_counted_as_waiting_to_be_named(self):
        # It has already been reviewed and ruled out. Counting it would nag
        # about the one row that can never be resolved.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            set_cluster_multi_speaker(output_dir, "mtg001", "system", "SPEAKER_0", True)
            data = _last_json(self._run(["mtg001"], tmp).output)
            self.assertEqual(data["total_clusters"], 1)
            self.assertEqual(data["unnamed_clusters"], 1)

    def test_a_meeting_with_no_sidecar_is_success_with_nothing_at_risk(self):
        # Not an error: a caller deciding whether to show a warning wants
        # "nothing to warn about", and a delete must never be blocked by
        # this check failing.
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "output").mkdir(parents=True, exist_ok=True)
            data = _last_json(self._run(["never-diarised"], tmp).output)
            self.assertTrue(data["success"])
            self.assertFalse(data["has_sidecar"])
            self.assertEqual(data["unnamed_clusters"], 0)


class ExcerptFitTests(unittest.TestCase):
    """A quote and its clip are two views of one turn, and each has its own
    cap: 140 characters and 20 seconds. Nothing related them, so a long turn
    showed a fifth of its text beside half of its audio - measured on a real
    9-minute call, a 40.5 s / 742-character turn showed 19 % of the text and
    played 20 s. The user reads one sentence and hears twenty seconds, which
    reads as a wrong clip even though both start at the same instant."""

    def _write(self, tmp, body):
        path = Path(tmp) / "t.txt"
        path.write_text(body, encoding="utf-8")
        return path

    @staticmethod
    def _manifest(*starts):
        return [
            {"start": s, "channel": "system", "diarization_speaker_id": "SPEAKER_0"}
            for s in starts
        ]

    def test_a_turn_that_fits_both_caps_beats_a_longer_one_that_overflows(self):
        long_text = "wort " * 200  # far past SAMPLE_TEXT_MAX_CHARS
        with tempfile.TemporaryDirectory() as tmp:
            transcript = self._write(
                tmp,
                f"[00:10] [Others] {long_text.strip()}\n"
                "[01:00] [Others] a turn short enough to be shown whole\n"
                "[01:20] [Others] trailing line that bounds the one above\n",
            )
            samples = extract_segment_samples(
                transcript,
                [
                    {"start": 10.0, "end": 55.0},   # 45 s: over the audio cap
                    {"start": 60.0, "end": 68.0},   # 8 s: fits
                    {"start": 80.0, "end": 82.0},
                ],
                limit=1,
                turn_manifest=self._manifest(10.0, 60.0, 80.0),
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(len(samples), 1)
            self.assertIn(
                "short enough", samples[0]["text"],
                "ranking by raw duration prefers exactly the turns that overflow both caps",
            )

    def test_an_overflowing_turn_is_still_offered_when_nothing_else_fits(self):
        long_text = "wort " * 200
        with tempfile.TemporaryDirectory() as tmp:
            transcript = self._write(tmp, f"[00:10] [Others] {long_text.strip()}\n")
            samples = extract_segment_samples(
                transcript, [{"start": 10.0, "end": 55.0}],
                turn_manifest=self._manifest(10.0),
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertEqual(len(samples), 1, "a partial excerpt beats no excerpt")
            self.assertTrue(samples[0]["text"].endswith("…"))


class ExcerptFitBoundaryTests(unittest.TestCase):
    """Both from the review of the fit ranking. Preferring a turn that
    survives both display caps is right, but "fits" is not on its own a
    measure of usefulness: the panel exists so a human can recognise a
    voice, and a fraction of a second cannot carry one however faithfully
    it is quoted."""

    def _write(self, tmp, body):
        path = Path(tmp) / "t.txt"
        path.write_text(body, encoding="utf-8")
        return path

    @staticmethod
    def _manifest(*starts):
        return [
            {"start": s, "channel": "system", "diarization_speaker_id": "SPEAKER_0"}
            for s in starts
        ]

    def test_a_fraction_of_a_second_does_not_beat_a_long_readable_turn(self):
        # A 0.1 s turn quoting one word fits both caps; a 19 s turn misses
        # the character cap by a single character. The short one is useless
        # for recognising a voice and the long one's quote stays readable.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = self._write(
                tmp,
                "[00:10] [Others] Ja\n"
                f"[00:30] [Others] {'a' * 141}\n"
                "[01:00] [Others] trailing line\n",
            )
            samples = extract_segment_samples(
                transcript,
                [
                    {"start": 10.0, "end": 10.1},
                    {"start": 30.0, "end": 49.0},
                    {"start": 60.0, "end": 61.0},
                ],
                limit=1,
                turn_manifest=self._manifest(10.0, 30.0, 60.0),
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertAlmostEqual(samples[0]["start"], 30.0, places=1)

    def test_a_clip_exactly_at_the_audio_cap_counts_as_fitting(self):
        # `< SAMPLE_MAX_SECONDS` classed a turn of exactly the cap as
        # overflowing, while the character cap is compared with `<=`. A turn
        # that ends exactly at the limit survives it whole.
        with tempfile.TemporaryDirectory() as tmp:
            transcript = self._write(
                tmp,
                "[00:10] [Others] a turn that lands exactly on the audio cap\n"
                "[00:40] [Others] Ja\n"
                "[00:50] [Others] trailing line\n",
            )
            samples = extract_segment_samples(
                transcript,
                [
                    {"start": 10.0, "end": 30.0},   # exactly SAMPLE_MAX_SECONDS
                    {"start": 40.0, "end": 40.1},
                    {"start": 50.0, "end": 51.0},
                ],
                limit=1,
                turn_manifest=self._manifest(10.0, 40.0, 50.0),
                target_ids={("system", "SPEAKER_0")},
            )
            self.assertAlmostEqual(samples[0]["start"], 10.0, places=1)


class SetClusterReviewStateCliTests(unittest.TestCase):
    """The CLI behind "Keep generic". It records that a human looked at a
    row and chose to leave it unnamed -- the one review outcome that
    produces no other trace, and therefore the one that a restart silently
    undoes if it is not written down."""

    def _run(self, command, args, tmp, cfg=None):
        cfg = cfg or Config(config_path=Path(tmp) / "config.json")
        cfg.set_identity_matching_enabled(True)
        with mock.patch("src.config.get_config", return_value=cfg), \
             mock.patch.dict("os.environ", {"STENOAI_USER_DATA_DIR": tmp}):
            return CliRunner().invoke(command, args)

    def _seed(self, tmp, clusters=None):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, "mtg001", {
            "system": {
                "recording_type": "remote",
                "clusters": clusters or {
                    "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 60.0,
                                  "segment_count": 10, "segments": [{"start": 1.0, "end": 5.0}]},
                    "SPEAKER_1": {"embedding": [0.0, 1.0], "speech_duration_seconds": 40.0,
                                  "segment_count": 8, "segments": [{"start": 20.0, "end": 24.0}]},
                },
            },
        })
        return output_dir

    def _stored(self, output_dir, sid):
        return read_speakers_sidecar(output_dir, "mtg001")["channels"]["system"]["clusters"][sid]

    def test_marking_generic_round_trips_and_clears(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            result = self._run(simple_recorder.set_cluster_review_state_command,
                               ["mtg001", "system", "SPEAKER_0"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertEqual(data["review_state"], REVIEW_STATE_GENERIC)
            self.assertEqual(self._stored(output_dir, "SPEAKER_0")[REVIEW_STATE_KEY],
                             REVIEW_STATE_GENERIC)

            result = self._run(simple_recorder.set_cluster_review_state_command,
                               ["mtg001", "system", "SPEAKER_0", "--clear"], tmp)
            data = _last_json(result.output)
            self.assertTrue(data["success"])
            self.assertIsNone(data["review_state"])
            self.assertNotIn(REVIEW_STATE_KEY, self._stored(output_dir, "SPEAKER_0"))

    def test_reports_the_merged_reach_not_just_the_id_it_was_handed(self):
        # The reviewer clicked one row; that row may be several raw
        # clusters. Saying which ones it covers keeps the CLI honest about
        # what just happened, the same way mark-speaker-cluster does.
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp, clusters={
                "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 1600.0,
                              "segment_count": 580},
                "SPEAKER_2": {"embedding": [0.995, 0.0999], "speech_duration_seconds": 1538.0,
                              "segment_count": 552},
            })
            result = self._run(simple_recorder.set_cluster_review_state_command,
                               ["mtg001", "system", "SPEAKER_2"], tmp)
            data = _last_json(result.output)
            self.assertEqual(data["diarization_speaker_id"], "SPEAKER_2")
            self.assertEqual(data["resolved_diarization_speaker_id"], "SPEAKER_0")
            self.assertEqual(sorted(data["fragment_ids"]), ["SPEAKER_0", "SPEAKER_2"])

    def test_a_missing_sidecar_fails_as_json_and_never_as_a_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "output").mkdir(parents=True, exist_ok=True)
            result = self._run(simple_recorder.set_cluster_review_state_command,
                               ["never-diarised", "system", "SPEAKER_0"], tmp)
            self.assertEqual(result.exit_code, 1)
            self.assertFalse(_last_json(result.output)["success"])
            self.assertNotIn("Traceback", result.output)

    def test_a_missing_channel_fails_as_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            result = self._run(simple_recorder.set_cluster_review_state_command,
                               ["mtg001", "mic", "SPEAKER_0"], tmp)
            self.assertEqual(result.exit_code, 1)
            self.assertFalse(_last_json(result.output)["success"])
            self.assertNotIn("Traceback", result.output)

    def test_a_missing_cluster_fails_as_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._seed(tmp)
            result = self._run(simple_recorder.set_cluster_review_state_command,
                               ["mtg001", "system", "SPEAKER_99"], tmp)
            self.assertEqual(result.exit_code, 1)
            self.assertFalse(_last_json(result.output)["success"])
            self.assertNotIn("Traceback", result.output)

    def test_confirming_a_cluster_clears_the_marking_from_every_fragment(self):
        # "Generic" means a human chose to stop there. Naming the row is a
        # stronger statement about the same cluster and supersedes it -- and
        # a key left on a fragment would keep the merged row reading generic
        # after the confirm, because the merged view is an any().
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp, clusters={
                "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 1600.0,
                              "segment_count": 580},
                "SPEAKER_2": {"embedding": [0.995, 0.0999], "speech_duration_seconds": 1538.0,
                              "segment_count": 552},
            })
            cfg = Config(config_path=Path(tmp) / "config.json")
            for sid in ("SPEAKER_0", "SPEAKER_2"):
                set_cluster_review_state(output_dir, "mtg001", "system", sid, REVIEW_STATE_GENERIC)

            result = self._run(simple_recorder.confirm_speaker,
                               ["mtg001", "system", "SPEAKER_2", "--new-person", "Person Alpha"],
                               tmp, cfg=cfg)
            self.assertTrue(_last_json(result.output)["success"])
            for sid in ("SPEAKER_0", "SPEAKER_2"):
                self.assertNotIn(REVIEW_STATE_KEY, self._stored(output_dir, sid))

    def test_marking_a_cluster_as_mixed_clears_it_from_every_fragment(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp, clusters={
                "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 1600.0,
                              "segment_count": 580},
                "SPEAKER_2": {"embedding": [0.995, 0.0999], "speech_duration_seconds": 1538.0,
                              "segment_count": 552},
            })
            for sid in ("SPEAKER_0", "SPEAKER_2"):
                set_cluster_review_state(output_dir, "mtg001", "system", sid, REVIEW_STATE_GENERIC)

            result = self._run(simple_recorder.mark_speaker_cluster,
                               ["mtg001", "system", "SPEAKER_0"], tmp)
            self.assertTrue(_last_json(result.output)["success"])
            for sid in ("SPEAKER_0", "SPEAKER_2"):
                self.assertNotIn(REVIEW_STATE_KEY, self._stored(output_dir, sid))

    def test_clearing_a_mixed_marking_does_not_resurrect_a_review_marking(self):
        # --single withdraws the "two people" statement; it says nothing
        # about the reviewer having once kept the row generic, and inventing
        # that back would put a mark on the row nobody set.
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            set_cluster_review_state(output_dir, "mtg001", "system", "SPEAKER_0",
                                     REVIEW_STATE_GENERIC)
            self._run(simple_recorder.mark_speaker_cluster,
                      ["mtg001", "system", "SPEAKER_0"], tmp)
            self._run(simple_recorder.mark_speaker_cluster,
                      ["mtg001", "system", "SPEAKER_0", "--single"], tmp)
            self.assertNotIn(REVIEW_STATE_KEY, self._stored(output_dir, "SPEAKER_0"))

    def _write_raw(self, tmp, payload):
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "mtg001_speakers.json").write_text(json.dumps(payload))
        return output_dir

    def test_a_structurally_wrong_sidecar_fails_as_json_not_as_a_traceback(self):
        # The never-raises contract is not only about missing things. This
        # file is JSON on a user's disk: a half-written copy, a botched
        # restore or a hand-edit can leave any of these keys holding the
        # wrong type, and Electron parses the last JSON line of stdout --
        # a traceback reaches the UI as "something went wrong", with the
        # actual state unreported.
        broken = [
            ["not-a-dict"],
            {"channels": ["not-a-dict"]},
            {"channels": {"system": ["not-a-dict"]}},
            {"channels": {"system": {"clusters": ["not-a-dict"]}}},
            {"channels": {"system": {"clusters": {"SPEAKER_0": "not-a-dict"}}}},
            # Reaches the merge, which needs an embedding per cluster.
            {"channels": {"system": {"clusters": {"SPEAKER_0": {}}}}},
        ]
        for payload in broken:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as tmp:
                self._write_raw(tmp, payload)
                for command in (simple_recorder.set_cluster_review_state_command,
                                simple_recorder.mark_speaker_cluster):
                    result = self._run(command, ["mtg001", "system", "SPEAKER_0"], tmp)
                    self.assertNotIn("Traceback", result.output)
                    self.assertIn(result.exit_code, (0, 1))
                    if result.exit_code == 1:
                        self.assertFalse(_last_json(result.output)["success"])


class PersistSidecarReportsLostMarkingsTests(unittest.TestCase):
    """`reprocess --retranscribe` re-runs the whole transcription, including
    diarization, and overwrites the sidecar through _persist_speaker_sidecar.
    Every human marking on the old clusters goes with it -- correctly, since
    the new run's ids describe different voices -- but this path said nothing
    at all, unlike the backfill next door. A marking is the one thing in that
    file no re-run can reproduce, so its loss has to be greppable afterwards.
    """

    def _seed(self, tmp, multi=False, generic=False):
        from src.speaker_suggestions import (
            REVIEW_STATE_GENERIC, set_cluster_multi_speaker, set_cluster_review_state,
        )
        output_dir = Path(tmp) / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        write_speakers_sidecar(output_dir, "mtg001", {
            "mic": {
                "recording_type": "in_person",
                "clusters": {
                    "SPEAKER_0": {"embedding": [1.0, 0.0], "speech_duration_seconds": 30.0,
                                  "segment_count": 5},
                    "SPEAKER_1": {"embedding": [0.0, 1.0], "speech_duration_seconds": 20.0,
                                  "segment_count": 4},
                },
            },
        })
        if multi:
            set_cluster_multi_speaker(output_dir, "mtg001", "mic", "SPEAKER_0", True)
        if generic:
            set_cluster_review_state(output_dir, "mtg001", "mic", "SPEAKER_1", REVIEW_STATE_GENERIC)
        return output_dir

    _FRESH_RUN = {
        "speaker_clusters": {
            "mic": {
                "recording_type": "in_person",
                "clusters": {
                    "SPEAKER_0": {"embedding": [0.0, 1.0], "speech_duration_seconds": 28.0,
                                  "segment_count": 5},
                },
            },
        },
    }

    def test_overwriting_a_marked_sidecar_reports_both_kinds_of_loss(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp, multi=True, generic=True)
            with mock.patch("simple_recorder.logger") as log:
                self.assertTrue(
                    simple_recorder._persist_speaker_sidecar(output_dir, "mtg001", self._FRESH_RUN))
            warned = " ".join(str(c) for c in log.warning.call_args_list)
            self.assertIn("mtg001", warned)
            self.assertIn("multiple speakers", warned)
            self.assertIn("kept generic", warned)

    def test_says_nothing_when_the_previous_sidecar_carried_no_markings(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = self._seed(tmp)
            with mock.patch("simple_recorder.logger") as log:
                simple_recorder._persist_speaker_sidecar(output_dir, "mtg001", self._FRESH_RUN)
            self.assertEqual(log.warning.call_args_list, [])

    def test_a_first_run_with_no_previous_sidecar_reports_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            with mock.patch("simple_recorder.logger") as log:
                self.assertTrue(
                    simple_recorder._persist_speaker_sidecar(output_dir, "mtg001", self._FRESH_RUN))
            self.assertEqual(log.warning.call_args_list, [])

    def test_a_sidecar_write_failure_does_not_fail_the_meeting(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp) / "output"
            output_dir.mkdir(parents=True, exist_ok=True)
            with mock.patch(
                "src.speaker_suggestions.write_speakers_sidecar",
                side_effect=OSError("lock timed out"),
            ), mock.patch("simple_recorder.logger") as log:
                written = simple_recorder._persist_speaker_sidecar(
                    output_dir, "private-meeting-title", self._FRESH_RUN,
                )

            self.assertFalse(written)
            self.assertNotIn("private-meeting-title", str(log.warning.call_args_list))


if __name__ == '__main__':
    unittest.main()
